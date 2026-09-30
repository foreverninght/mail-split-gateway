'use strict';

const { randomUUID } = require('node:crypto');

function nowIso(clock) {
  return new Date(clock()).toISOString();
}

class IcMailboxStore {
  constructor({ db, clock = Date.now } = {}) {
    if (!db) throw new TypeError('database is required');
    this.db = db;
    this.clock = clock;
  }

  create({ id = randomUUID(), email, encryptedUpstreamUrl, pickupHostname, adapterKey, tokenHash }) {
    const timestamp = nowIso(this.clock);
    this.db.prepare(`
      INSERT INTO ic_mailboxes
        (id, email, encrypted_upstream_url, pickup_hostname, adapter_key, token_hash, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, email, encryptedUpstreamUrl, pickupHostname, adapterKey, tokenHash, timestamp, timestamp);
    this.recordEvent(id, 'imported', pickupHostname);
    return this.get(id);
  }

  get(id) {
    return this.db.prepare('SELECT * FROM ic_mailboxes WHERE id = ?').get(id) || null;
  }

  findByEmail(email) {
    return this.db.prepare('SELECT * FROM ic_mailboxes WHERE email = ? COLLATE NOCASE').get(email) || null;
  }

  findByTokenHash(tokenHash) {
    return this.db.prepare('SELECT * FROM ic_mailboxes WHERE token_hash = ?').get(tokenHash) || null;
  }

  list() {
    return this.db.prepare('SELECT * FROM ic_mailboxes ORDER BY created_at DESC, id DESC').all();
  }

  countAvailable(pickupHostname = '') {
    const hostname = String(pickupHostname || '').trim().toLowerCase();
    const row = hostname
      ? this.db.prepare(`
          SELECT COUNT(*) AS count FROM ic_mailboxes AS mailbox
          WHERE mailbox.state = 'available' AND mailbox.pickup_hostname = ? COLLATE NOCASE
            AND NOT EXISTS (
              SELECT 1 FROM registration_tasks AS task WHERE task.ic_mailbox_id = mailbox.id
            )
            AND NOT EXISTS (
              SELECT 1 FROM ic_mailbox_events AS event
              WHERE event.mailbox_id = mailbox.id AND event.event = 'allocated_for_registration'
            )
        `).get(hostname)
      : this.db.prepare(`
          SELECT COUNT(*) AS count FROM ic_mailboxes AS mailbox
          WHERE mailbox.state = 'available'
            AND NOT EXISTS (
              SELECT 1 FROM registration_tasks AS task WHERE task.ic_mailbox_id = mailbox.id
            )
            AND NOT EXISTS (
              SELECT 1 FROM ic_mailbox_events AS event
              WHERE event.mailbox_id = mailbox.id AND event.event = 'allocated_for_registration'
            )
        `).get();
    return Number(row.count || 0);
  }

  allocate({ count, pickupHostname = '', issueCredential }) {
    const requested = Number(count);
    if (!Number.isInteger(requested) || requested < 1) throw new Error('IC allocation count must be a positive integer');
    if (typeof issueCredential !== 'function') throw new TypeError('issueCredential is required');
    const hostname = String(pickupHostname || '').trim().toLowerCase();
    const rows = hostname
      ? this.db.prepare(`
          SELECT mailbox.* FROM ic_mailboxes AS mailbox
          WHERE mailbox.state = 'available' AND mailbox.pickup_hostname = ? COLLATE NOCASE
            AND NOT EXISTS (
              SELECT 1 FROM registration_tasks AS task WHERE task.ic_mailbox_id = mailbox.id
            )
            AND NOT EXISTS (
              SELECT 1 FROM ic_mailbox_events AS event
              WHERE event.mailbox_id = mailbox.id AND event.event = 'allocated_for_registration'
            )
          ORDER BY mailbox.created_at, mailbox.id LIMIT ?
        `).all(hostname, requested)
      : this.db.prepare(`
          SELECT mailbox.* FROM ic_mailboxes AS mailbox
          WHERE mailbox.state = 'available'
            AND NOT EXISTS (
              SELECT 1 FROM registration_tasks AS task WHERE task.ic_mailbox_id = mailbox.id
            )
            AND NOT EXISTS (
              SELECT 1 FROM ic_mailbox_events AS event
              WHERE event.mailbox_id = mailbox.id AND event.event = 'allocated_for_registration'
            )
          ORDER BY mailbox.created_at, mailbox.id LIMIT ?
        `).all(requested);
    if (rows.length !== requested) {
      throw new Error(`可用 IC 邮箱不足：需要 ${requested} 个，当前 ${rows.length} 个`);
    }
    const timestamp = nowIso(this.clock);
    const allocated = [];
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const row of rows) {
        const credential = issueCredential(row);
        const result = this.db.prepare(`
          UPDATE ic_mailboxes
          SET state = 'allocated', token_hash = ?, version = version + 1,
              last_error = '', registration_baseline_code_hash = NULL,
              registration_allocated_at = ?, updated_at = ?
          WHERE id = ? AND state = 'available' AND version = ?
        `).run(credential.tokenHash, timestamp, timestamp, row.id, row.version);
        if (result.changes !== 1) throw new Error(`IC mailbox changed during allocation: ${row.id}`);
        this.db.prepare(`
          INSERT INTO ic_mailbox_events (mailbox_id, event, detail, created_at)
          VALUES (?, 'allocated_for_registration', ?, ?)
        `).run(row.id, hostname, timestamp);
        allocated.push({ ...this.get(row.id), token: credential.token });
      }
      this.db.exec('COMMIT');
    } catch (error) {
      if (this.db.isTransaction) this.db.exec('ROLLBACK');
      throw error;
    }
    return allocated;
  }

  transitionRegistrationState(id, fromStates, toState, event, detail = '') {
    const allowed = Array.isArray(fromStates) ? fromStates : [fromStates];
    const row = this.get(id);
    if (!row) return null;
    if (!allowed.includes(row.state)) {
      if (row.state === toState) return row;
      throw new Error(`invalid IC mailbox transition: ${row.state} -> ${toState}`);
    }
    const timestamp = nowIso(this.clock);
    const placeholders = allowed.map(() => '?').join(', ');
    const result = this.db.prepare(`
      UPDATE ic_mailboxes
      SET state = ?, version = version + 1, updated_at = ?, last_error = ?,
          registration_baseline_code_hash = CASE WHEN ? = 'available' THEN NULL ELSE registration_baseline_code_hash END,
          registration_allocated_at = CASE WHEN ? = 'available' THEN NULL ELSE registration_allocated_at END
      WHERE id = ? AND state IN (${placeholders}) AND version = ?
    `).run(
      toState, timestamp, String(detail || '').slice(0, 500), toState, toState,
      id, ...allowed, row.version,
    );
    if (result.changes !== 1) throw new Error(`IC mailbox changed during transition: ${id}`);
    this.recordEvent(id, event, detail);
    return this.get(id);
  }

  markRunning(id) {
    const row = this.get(id);
    if (row?.state === 'used') return row;
    return this.transitionRegistrationState(id, 'allocated', 'running', 'registration_started');
  }

  markUsed(id, detail = '') {
    return this.transitionRegistrationState(id, ['allocated', 'running'], 'used', 'registration_consumed', detail);
  }

  releaseAllocation(id, detail = '') {
    const row = this.get(id);
    if (row?.state === 'used') return row;
    return this.transitionRegistrationState(id, 'allocated', 'available', 'registration_allocation_released', detail);
  }

  setRegistrationBaseline(id, codeHash) {
    const timestamp = nowIso(this.clock);
    const result = this.db.prepare(`
      UPDATE ic_mailboxes
      SET registration_baseline_code_hash = ?, version = version + 1, updated_at = ?
      WHERE id = ? AND state = 'allocated'
    `).run(codeHash || null, timestamp, id);
    if (result.changes !== 1) throw new Error(`IC mailbox is not allocated: ${id}`);
    this.recordEvent(id, 'registration_baseline_captured', codeHash ? 'code_present' : 'empty');
    return this.get(id);
  }

  clearRegistrationBaseline(id) {
    const timestamp = nowIso(this.clock);
    this.db.prepare(`
      UPDATE ic_mailboxes
      SET registration_baseline_code_hash = NULL, version = version + 1, updated_at = ?
      WHERE id = ?
    `).run(timestamp, id);
    this.recordEvent(id, 'registration_new_code_observed');
    return this.get(id);
  }

  rotateToken(id, tokenHash) {
    const timestamp = nowIso(this.clock);
    const result = this.db.prepare(`
      UPDATE ic_mailboxes SET token_hash = ?, version = version + 1, updated_at = ?, last_error = '' WHERE id = ?
    `).run(tokenHash, timestamp, id);
    if (!result.changes) return null;
    this.recordEvent(id, 'token_rotated');
    return this.get(id);
  }

  recordPickup(id, { status, error = '' }) {
    const timestamp = nowIso(this.clock);
    const result = this.db.prepare(`
      UPDATE ic_mailboxes
      SET first_accessed_at = COALESCE(first_accessed_at, ?), last_accessed_at = ?,
          last_code_at = CASE WHEN ? = 'code' THEN ? ELSE last_code_at END,
          last_error = ?, updated_at = ?, version = version + 1
      WHERE id = ?
    `).run(timestamp, timestamp, status, timestamp, String(error).slice(0, 500), timestamp, id);
    if (result.changes) this.recordEvent(id, `pickup_${status}`, String(error).slice(0, 500));
    return result.changes ? this.get(id) : null;
  }

  recordEvent(mailboxId, event, detail = '') {
    this.db.prepare(`
      INSERT INTO ic_mailbox_events (mailbox_id, event, detail, created_at) VALUES (?, ?, ?, ?)
    `).run(mailboxId, event, detail, nowIso(this.clock));
  }

  listEvents(mailboxId) {
    return this.db.prepare('SELECT * FROM ic_mailbox_events WHERE mailbox_id = ? ORDER BY id').all(mailboxId);
  }
}

module.exports = { IcMailboxStore };
