'use strict';

const { randomUUID, randomInt } = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const {
  ALIAS_STATES,
  MAILBOX_STATES,
  nextAliasState,
  nextMailboxState,
} = require('../domain/state-machine');
const { SCHEMA, migrateSchema } = require('./schema');

function nowIso(clock) {
  return new Date(clock()).toISOString();
}

class ConcurrentTransitionError extends Error {
  constructor(entity, id) {
    super(`${entity} changed during transition: ${id}`);
    this.name = 'ConcurrentTransitionError';
    this.code = 'CONCURRENT_STATE_TRANSITION';
  }
}

class GatewayStore {
  constructor({ filename, clock = Date.now, randomDomainIndex = randomInt } = {}) {
    if (!filename) throw new TypeError('database filename is required');
    this.clock = clock;
    if (typeof randomDomainIndex !== 'function') throw new TypeError('randomDomainIndex must be a function');
    this.randomDomainIndex = randomDomainIndex;
    this.db = new DatabaseSync(filename);
    this.db.exec(SCHEMA);
    migrateSchema(this.db);
  }

  close() {
    this.db.close();
  }

  createMailbox({ id = randomUUID(), email, encryptedPassword }) {
    const timestamp = nowIso(this.clock);
    this.db.prepare(`
      INSERT INTO mailboxes (id, email, encrypted_password, state, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, String(email).trim().toLowerCase(), encryptedPassword, MAILBOX_STATES.CLOSED, timestamp, timestamp);
    return this.getMailbox(id);
  }

  getMailbox(id) {
    return this.db.prepare('SELECT * FROM mailboxes WHERE id = ?').get(id) || null;
  }

  findMailboxByEmail(email) {
    return this.db.prepare('SELECT * FROM mailboxes WHERE email = ? COLLATE NOCASE')
      .get(String(email || '').trim().toLowerCase()) || null;
  }

  listMailboxes() {
    return this.db.prepare('SELECT * FROM mailboxes ORDER BY created_at, id').all();
  }

  markMailboxCreationBlocked(id, reason = '远端创建别名冲突，已确认目标地址不存在；该主邮箱暂停创建，收信与清理不受影响') {
    const timestamp = nowIso(this.clock);
    this.db.prepare(`UPDATE mailboxes SET creation_blocked = 1,
      creation_blocked_reason = ?, creation_blocked_at = COALESCE(creation_blocked_at, ?),
      updated_at = ? WHERE id = ?`).run(reason, timestamp, timestamp, id);
    return this.getMailbox(id);
  }

  assertMailboxCreationAllowed(id) {
    const mailbox = this.getMailbox(id);
    if (!mailbox) throw Object.assign(new Error('主邮箱不存在'), { code: 'MAILBOX_NOT_FOUND', statusCode: 404 });
    if (mailbox.creation_blocked) throw Object.assign(new Error('该主邮箱已暂停创建别名，请选择其他主邮箱；收信与清理仍可使用'),
      { code: 'MAILBOX_CREATION_BLOCKED', statusCode: 409 });
    return mailbox;
  }


  transitionMailbox(id, event, { lastError = '' } = {}) {
    const current = this.getMailbox(id);
    if (!current) return null;
    const state = nextMailboxState(current.state, event);
    const timestamp = nowIso(this.clock);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = this.db.prepare(`
        UPDATE mailboxes
        SET state = ?, version = version + 1, last_error = ?, updated_at = ?
        WHERE id = ? AND version = ?
      `).run(state, lastError, timestamp, id, current.version);
      if (result.changes !== 1) throw new ConcurrentTransitionError('mailbox', id);
      this.db.prepare(`
        INSERT INTO mailbox_events (mailbox_id, event, from_state, to_state, detail, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(id, event, current.state, state, String(lastError || ''), timestamp);
      const updated = this.getMailbox(id);
      this.db.exec('COMMIT');
      return updated;
    } catch (error) {
      if (this.db.isTransaction) this.db.exec('ROLLBACK');
      throw error;
    }
  }

  updateRemoteAliasCount(id, count) {
    this.db.prepare(`
      UPDATE mailboxes SET remote_alias_count = ?, updated_at = ? WHERE id = ?
    `).run(Math.max(0, Number(count) || 0), nowIso(this.clock), id);
    return this.getMailbox(id);
  }

  replaceDomains(mailboxId, domains) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const timestamp = nowIso(this.clock);
      const existing = new Map(this.db.prepare(
        'SELECT domain, kind FROM mailbox_domains WHERE mailbox_id = ?',
      ).all(mailboxId).map((row) => [row.domain.toLowerCase(), row.kind]));
      this.db.prepare(`
        UPDATE mailbox_domains SET remote_state = 'MISSING', updated_at = ? WHERE mailbox_id = ?
      `).run(timestamp, mailboxId);
      const upsert = this.db.prepare(`
        INSERT INTO mailbox_domains (mailbox_id, domain, kind, remote_state, updated_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(mailbox_id, domain) DO UPDATE SET
          remote_state = excluded.remote_state,
          updated_at = excluded.updated_at
      `);
      for (const entry of domains) {
        const domain = String(entry.domain || '').trim().toLowerCase();
        if (!domain) continue;
        upsert.run(mailboxId, domain, existing.get(domain) || 'hidden', entry.state || 'UNKNOWN', timestamp);
      }
      this.db.exec('COMMIT');
    } catch (error) {
      if (this.db.isTransaction) this.db.exec('ROLLBACK');
      throw error;
    }
    return this.listDomains(mailboxId);
  }

  listDomains(mailboxId, { kind } = {}) {
    if (kind) {
      return this.db.prepare(`
        SELECT * FROM mailbox_domains WHERE mailbox_id = ? AND kind = ? ORDER BY domain
      `).all(mailboxId, kind);
    }
    return this.db.prepare('SELECT * FROM mailbox_domains WHERE mailbox_id = ? ORDER BY kind, domain').all(mailboxId);
  }

  setDomainKind(mailboxId, domain, kind) {
    const result = this.db.prepare(`
      UPDATE mailbox_domains SET kind = ?, updated_at = ? WHERE mailbox_id = ? AND domain = ?
    `).run(kind, nowIso(this.clock), mailboxId, String(domain).trim().toLowerCase());
    return result.changes === 1;
  }

  importDomainCatalog(domains, { source = 'import' } = {}) {
    const timestamp = nowIso(this.clock);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const upsert = this.db.prepare(`
        INSERT INTO domain_catalog (
          domain, kind, remote_state, consecutive_otp_timeouts, source, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(domain) DO UPDATE SET
          kind = excluded.kind,
          remote_state = excluded.remote_state,
          consecutive_otp_timeouts = excluded.consecutive_otp_timeouts,
          source = excluded.source,
          updated_at = excluded.updated_at
      `);
      for (const entry of domains) {
        const domain = String(entry.domain || '').trim().toLowerCase();
        if (!domain) continue;
        const kind = entry.blacklisted
          ? 'blacklist'
          : String(entry.state || '').toUpperCase() === 'HIDDEN' ? 'hidden' : 'explicit';
        upsert.run(
          domain,
          kind,
          String(entry.state || 'UNKNOWN').toUpperCase(),
          Math.max(0, Number(entry.consecutiveOtpTimeoutTasks || entry.consecutive_otp_timeouts) || 0),
          source,
          timestamp,
        );
      }
      this.db.exec('COMMIT');
    } catch (error) {
      if (this.db.isTransaction) this.db.exec('ROLLBACK');
      throw error;
    }
    return this.domainCatalogCounts();
  }

  mergeRemoteDomains(domains, { source = 'mail.com' } = {}) {
    const timestamp = nowIso(this.clock);
    const upsert = this.db.prepare(`
      INSERT INTO domain_catalog (domain, kind, remote_state, source, updated_at)
      VALUES (?, 'explicit', ?, ?, ?)
      ON CONFLICT(domain) DO UPDATE SET
        remote_state = excluded.remote_state,
        updated_at = excluded.updated_at
    `);
    for (const entry of domains) {
      const domain = String(entry.domain || '').trim().toLowerCase();
      if (domain) upsert.run(domain, String(entry.state || 'UNKNOWN').toUpperCase(), source, timestamp);
    }
    return this.domainCatalogCounts();
  }

  listCatalogDomains({ kind } = {}) {
    if (kind) {
      return this.db.prepare('SELECT * FROM domain_catalog WHERE kind = ? ORDER BY domain').all(kind);
    }
    return this.db.prepare('SELECT * FROM domain_catalog ORDER BY kind, domain').all();
  }

  setCatalogDomainKind(domain, kind) {
    const result = this.db.prepare(`
      UPDATE domain_catalog SET kind = ?, source = 'manual', updated_at = ? WHERE domain = ?
    `).run(kind, nowIso(this.clock), String(domain || '').trim().toLowerCase());
    return result.changes === 1;
  }

  domainCatalogCounts() {
    const rows = this.db.prepare(`
      SELECT kind, COUNT(*) AS count FROM domain_catalog GROUP BY kind
    `).all();
    const counts = { total: 0, hidden: 0, explicit: 0, blacklist: 0 };
    for (const row of rows) {
      counts[row.kind] = Number(row.count);
      counts.total += Number(row.count);
    }
    return counts;
  }

  createAlias({ id = randomUUID(), mailboxId, email }) {
    const timestamp = nowIso(this.clock);
    this.db.prepare(`
      INSERT INTO aliases (id, mailbox_id, email, state, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, mailboxId, String(email).trim().toLowerCase(), ALIAS_STATES.CREATING, timestamp, timestamp);
    return this.getAlias(id);
  }

  createAliasWithDomainLimit({
    id = randomUUID(), mailboxId, localPart, domains, maxUses = 3, windowMs = 60 * 60 * 1000,
  }) {
    const candidates = [...new Set((domains || []).map((value) => String(value).trim().toLowerCase()).filter(Boolean))];
    if (!candidates.length) throw new Error('no domains are available');
    const timestamp = nowIso(this.clock);
    const cutoff = new Date(this.clock() - windowMs).toISOString();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const placeholders = candidates.map(() => '?').join(', ');
      const rows = this.db.prepare(`
        SELECT domain,
          COUNT(*) AS recent_count
        FROM alias_domain_usage
        WHERE domain IN (${placeholders})
          AND state IN ('reserved', 'confirmed', 'uncertain')
          AND reserved_at > ?
        GROUP BY domain
      `).all(...candidates, cutoff);
      const usage = new Map(rows.map((row) => [row.domain, row]));
      const available = candidates.filter((domain) => Number(usage.get(domain)?.recent_count || 0) < maxUses);
      if (!available.length) throw new Error(`all hidden suffixes reached the limit of ${maxUses} per hour`);
      const index = this.randomDomainIndex(available.length);
      if (!Number.isInteger(index) || index < 0 || index >= available.length) throw new Error('invalid random domain index');
      const domain = available[index];
      const email = `${String(localPart).trim().toLowerCase()}@${domain}`;
      this.db.prepare(`
        INSERT INTO aliases (id, mailbox_id, email, state, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(id, mailboxId, email, ALIAS_STATES.CREATING, timestamp, timestamp);
      this.db.prepare(`
        INSERT INTO alias_domain_usage (alias_id, domain, state, reserved_at)
        VALUES (?, ?, 'reserved', ?)
      `).run(id, domain, timestamp);
      this.db.exec('COMMIT');
      return this.getAlias(id);
    } catch (error) {
      if (this.db.isTransaction) this.db.exec('ROLLBACK');
      throw error;
    }
  }

  availableAliasDomainCapacity(domains, { maxUses = 3, windowMs = 60 * 60 * 1000 } = {}) {
    const candidates = [...new Set((domains || []).map((value) => String(value).trim().toLowerCase()).filter(Boolean))];
    if (!candidates.length) return 0;
    const cutoff = new Date(this.clock() - windowMs).toISOString();
    const placeholders = candidates.map(() => '?').join(', ');
    const rows = this.db.prepare(`
      SELECT domain, COUNT(*) AS recent_count
      FROM alias_domain_usage
      WHERE domain IN (${placeholders})
        AND state IN ('reserved', 'confirmed', 'uncertain')
        AND reserved_at > ?
      GROUP BY domain
    `).all(...candidates, cutoff);
    const counts = new Map(rows.map((row) => [row.domain, Number(row.recent_count)]));
    return candidates.reduce((total, domain) => total + Math.max(0, maxUses - (counts.get(domain) || 0)), 0);
  }

  markAliasDomainUsage(aliasId, state) {
    if (!['confirmed', 'uncertain', 'released'].includes(state)) throw new Error('invalid alias domain usage state');
    const result = this.db.prepare(`
      UPDATE alias_domain_usage
      SET state = ?, released_at = CASE WHEN ? = 'released' THEN ? ELSE NULL END
      WHERE alias_id = ?
    `).run(state, state, nowIso(this.clock), aliasId);
    return result.changes === 1;
  }

  aliasDomainUsage({ domain } = {}) {
    if (domain) {
      return this.db.prepare(`SELECT * FROM alias_domain_usage WHERE domain = ? ORDER BY reserved_at, alias_id`)
        .all(String(domain).trim().toLowerCase());
    }
    return this.db.prepare('SELECT * FROM alias_domain_usage ORDER BY reserved_at, alias_id').all();
  }

  discoverAlias({ id = randomUUID(), mailboxId, email }) {
    const normalizedEmail = String(email || '').trim().toLowerCase();
    const existing = this.findAliasByMailboxEmail(mailboxId, normalizedEmail);
    if (existing) return existing;
    const timestamp = nowIso(this.clock);
    this.db.prepare(`
      INSERT INTO aliases (id, mailbox_id, email, state, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, mailboxId, normalizedEmail, ALIAS_STATES.DISCOVERED, timestamp, timestamp);
    return this.getAlias(id);
  }

  getAlias(id) {
    return this.db.prepare('SELECT * FROM aliases WHERE id = ?').get(id) || null;
  }

  findAliasByMailboxEmail(mailboxId, email) {
    return this.db.prepare(`
      SELECT * FROM aliases WHERE mailbox_id = ? AND email = ? COLLATE NOCASE
    `).get(mailboxId, String(email || '').trim().toLowerCase()) || null;
  }

  listAliases({ mailboxId, states } = {}) {
    const clauses = [];
    const values = [];
    if (mailboxId) {
      clauses.push('mailbox_id = ?');
      values.push(mailboxId);
    }
    if (Array.isArray(states) && states.length) {
      clauses.push(`state IN (${states.map(() => '?').join(', ')})`);
      values.push(...states);
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    return this.db.prepare(`SELECT * FROM aliases ${where} ORDER BY created_at, id`).all(...values);
  }

  findAliasByTokenHash(tokenHash) {
    return this.db.prepare('SELECT * FROM aliases WHERE token_hash = ?').get(tokenHash) || null;
  }

  transitionAlias(id, event, fields = {}) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const current = this.getAlias(id);
      if (!current) {
        this.db.exec('ROLLBACK');
        return null;
      }
      const state = nextAliasState(current.state, event);
      const timestamp = nowIso(this.clock);
      const allowed = {
        tokenHash: 'token_hash',
        exportedAt: 'exported_at',
        firstAccessedAt: 'first_accessed_at',
        lastAccessedAt: 'last_accessed_at',
        deliveredAt: 'delivered_at',
        releaseAfter: 'release_after',
        deletedAt: 'deleted_at',
        lastError: 'last_error',
      };
      const updates = ['state = ?', 'version = version + 1', 'updated_at = ?'];
      const values = [state, timestamp];
      for (const [key, column] of Object.entries(allowed)) {
        if (!Object.hasOwn(fields, key)) continue;
        updates.push(`${column} = ?`);
        values.push(fields[key]);
      }
      values.push(id, current.version);
      const result = this.db.prepare(`
        UPDATE aliases SET ${updates.join(', ')} WHERE id = ? AND version = ?
      `).run(...values);
      if (result.changes !== 1) throw new ConcurrentTransitionError('alias', id);
      this.db.prepare(`
        INSERT INTO alias_events (alias_id, event, from_state, to_state, detail, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(id, event, current.state, state, String(fields.detail || ''), timestamp);
      const updated = this.getAlias(id);
      this.db.exec('COMMIT');
      return updated;
    } catch (error) {
      if (this.db.isTransaction) this.db.exec('ROLLBACK');
      throw error;
    }
  }

  listAliasEvents(aliasId) {
    return this.db.prepare('SELECT * FROM alias_events WHERE alias_id = ? ORDER BY id').all(aliasId);
  }

  recordOtp({ aliasId, remoteMessageId, code, receivedAt }) {
    const timestamp = nowIso(this.clock);
    this.db.prepare(`
      INSERT INTO otp_messages (alias_id, remote_message_id, code, received_at, first_seen_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(alias_id, remote_message_id, code) DO NOTHING
    `).run(aliasId, remoteMessageId, code, receivedAt || timestamp, timestamp);
    return this.latestOtp(aliasId);
  }

  latestOtp(aliasId) {
    return this.db.prepare(`
      SELECT * FROM otp_messages WHERE alias_id = ? ORDER BY received_at DESC, id DESC LIMIT 1
    `).get(aliasId) || null;
  }

  markOtpDelivered(otpId) {
    const timestamp = nowIso(this.clock);
    this.db.prepare(`
      UPDATE otp_messages
      SET delivered_count = delivered_count + 1, last_delivered_at = ?
      WHERE id = ?
    `).run(timestamp, otpId);
  }

  touchAliasAccess(aliasId, { firstAccessedAt, lastAccessedAt }) {
    this.db.prepare(`
      UPDATE aliases
      SET first_accessed_at = COALESCE(first_accessed_at, ?), last_accessed_at = ?, updated_at = ?
      WHERE id = ?
    `).run(firstAccessedAt || lastAccessedAt, lastAccessedAt, nowIso(this.clock), aliasId);
    return this.getAlias(aliasId);
  }
}

module.exports = {
  ConcurrentTransitionError,
  GatewayStore,
};
