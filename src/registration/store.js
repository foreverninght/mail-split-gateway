'use strict';

const { createHash, randomUUID } = require('node:crypto');
const { rebindHistory, rebindMetadata } = require('./rebind-metadata');
const { trialMetadata } = require('./trial-metadata');

const {
  BATCH_EVENTS,
  BATCH_STATES,
  TASK_EVENTS,
  TASK_STATES,
  nextBatchState,
  nextTaskState,
} = require('./state-machine');
const {
  REGISTRATION_PROXIES_PER_MAILBOX,
  MIN_REGISTRATION_PROXIES_PER_MAILBOX,
  MAX_REGISTRATION_PROXIES_PER_MAILBOX,
} = require('./proxy-policy');

function nowIso(clock) {
  return new Date(clock()).toISOString();
}

function normalizeProxy(value, { convertSupplierUrl = false } = {}) {
  const raw = String(value || '').trim();
  if (!raw) throw new Error('proxy endpoint is empty');
  const hostFirstUrl = raw.match(/^([^\s:@/]+):(\d+)@([^\s:]+):(.+)$/);
  if (convertSupplierUrl && hostFirstUrl) {
    const [, host, port, username, password] = hostFirstUrl;
    const endpoint = `http://${encodeURIComponent(username)}:${encodeURIComponent(password)}@${host}:${port}`;
    const url = new URL(endpoint);
    if (!url.hostname || !url.port) throw new Error('proxy URL requires host and port');
    return endpoint;
  }
  if (/^https?:\/\//i.test(raw)) {
    try {
      const url = new URL(raw);
      if (!url.hostname || !url.port) throw new Error('proxy URL requires host and port');
      return raw;
    } catch (error) {
      // Supplier exports commonly prefix the host:port:user:password form with
      // http://. Convert it to the standard URL form before storing it.
      const withoutScheme = raw.replace(/^https?:\/\//i, '');
      const parts = withoutScheme.split(':');
      if (convertSupplierUrl && parts.length === 4 && parts.every(Boolean)) {
        const [host, port, username, password] = parts;
        return `http://${encodeURIComponent(username)}:${encodeURIComponent(password)}@${host}:${port}`;
      }
      throw error;
    }
  }
  const parts = raw.split(':');
  if (parts.length === 2 && parts.every(Boolean)) return raw;
  if (parts.length === 4 && parts.every(Boolean)) return raw;
  throw new Error('proxy must be host:port, host:port:user:password, host:port@user:password, or an HTTP proxy URL');
}

function maskProxy(endpoint) {
  if (/^https?:\/\//i.test(endpoint)) {
    const url = new URL(endpoint);
    const auth = url.username ? `${url.username.slice(0, 3)}***@` : '';
    return `${url.protocol}//${auth}${url.hostname}:${url.port}`;
  }
  const [host, port, user] = endpoint.split(':');
  return user ? `${host}:${port}:${user.slice(0, 3)}***:***` : `${host}:${port}`;
}

function proxyFingerprint(endpoint) {
  return createHash('sha256').update(endpoint).digest('hex');
}

function normalizeProxyList(values, options) {
  const entries = Array.isArray(values)
    ? values.map((value, index) => ({ value, line: index + 1 }))
    : String(values || '').split(/\r?\n/).flatMap((value, index) =>
      value.split(/\s+/).map((entry) => ({ value: entry, line: index + 1 })));
  const unique = new Map();
  const errors = [];
  let duplicates = 0;
  for (const { value, line } of entries) {
    if (!String(value || '').trim()) continue;
    try {
      const endpoint = normalizeProxy(value, options);
      maskProxy(endpoint);
      const fingerprint = proxyFingerprint(endpoint);
      if (unique.has(fingerprint)) duplicates += 1;
      else unique.set(fingerprint, endpoint);
    } catch {
      errors.push({ line });
    }
  }
  if (errors.length) {
    const error = new Error(`代理列表包含 ${errors.length} 条无效记录（行 ${[...new Set(errors.map((entry) => entry.line))].join(', ')}），代理池未变更`);
    error.code = 'INVALID_PROXY_LIST';
    error.details = errors;
    throw error;
  }
  if (!unique.size) {
    const error = new Error('代理列表不能为空，代理池未变更');
    error.code = 'EMPTY_PROXY_LIST';
    throw error;
  }
  return { entries: [...unique.entries()], duplicates };
}

class RegistrationStore {
  constructor({ db, secretBox, clock = Date.now, registrationProxyRefreshMs = 30 * 60 * 1000 }) {
    if (!db) throw new TypeError('database is required');
    if (!secretBox) throw new TypeError('secret box is required');
    if (!Number.isFinite(registrationProxyRefreshMs) || registrationProxyRefreshMs <= 0) {
      throw new TypeError('registration proxy refresh interval must be positive');
    }
    this.db = db;
    this.secretBox = secretBox;
    this.clock = clock;
    this.registrationProxyRefreshMs = registrationProxyRefreshMs;
  }

  createBatch(requestedCount, {
    proxiesPerMailbox = REGISTRATION_PROXIES_PER_MAILBOX,
    mailboxCategory = 'mail',
    mailboxProvider = '',
    id = randomUUID(),
  } = {}) {
    const count = Number(requestedCount);
    const proxyCount = Number(proxiesPerMailbox);
    if (!Number.isInteger(count) || count < 1) throw new Error('count must be a positive integer');
    if (!Number.isInteger(proxyCount)
      || proxyCount < MIN_REGISTRATION_PROXIES_PER_MAILBOX
      || proxyCount > MAX_REGISTRATION_PROXIES_PER_MAILBOX) {
      throw new Error(`proxiesPerMailbox must be between ${MIN_REGISTRATION_PROXIES_PER_MAILBOX} and ${MAX_REGISTRATION_PROXIES_PER_MAILBOX}`);
    }
    if (!['mail', 'ic'].includes(mailboxCategory)) throw new Error('mailboxCategory must be mail or ic');
    const provider = String(mailboxProvider || '').trim().toLowerCase();
    if (mailboxCategory === 'mail' && provider) throw new Error('mail batches cannot select an IC provider');
    const timestamp = nowIso(this.clock);
    this.db.prepare(`
      INSERT INTO registration_batches
        (id, requested_count, proxies_per_mailbox, mailbox_category, mailbox_provider, state, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, count, proxyCount, mailboxCategory, provider, BATCH_STATES.QUEUED, timestamp, timestamp);
    return this.getBatch(id);
  }

  getBatch(id) {
    return this.db.prepare('SELECT * FROM registration_batches WHERE id = ?').get(id) || null;
  }

  listBatches({ limit = 100 } = {}) {
    return this.db.prepare(`
      SELECT * FROM registration_batches ORDER BY created_at DESC LIMIT ?
    `).all(Math.min(500, Math.max(1, Number(limit) || 100)));
  }

  transitionBatch(id, event, { detail = '', lastError = '' } = {}) {
    const current = this.getBatch(id);
    if (!current) return null;
    const next = nextBatchState(current.state, event);
    const timestamp = nowIso(this.clock);
    const acceptedAt = event === BATCH_EVENTS.SUBMIT_ACCEPTED || event === BATCH_EVENTS.RECONCILE_ACCEPTED
      ? timestamp : current.accepted_at;
    const completedAt = [BATCH_STATES.COMPLETED, BATCH_STATES.PARTIAL_COMPLETED, BATCH_STATES.FAILED].includes(next)
      ? timestamp : current.completed_at;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = this.db.prepare(`
        UPDATE registration_batches
        SET state = ?, last_error = ?, updated_at = ?, accepted_at = ?, completed_at = ?
        WHERE id = ? AND state = ?
      `).run(next, String(lastError || ''), timestamp, acceptedAt, completedAt, id, current.state);
      if (result.changes !== 1) throw new Error(`registration batch changed during transition: ${id}`);
      this.db.prepare(`
        INSERT INTO registration_events
          (batch_id, entity, event, from_state, to_state, detail, created_at)
        VALUES (?, 'batch', ?, ?, ?, ?, ?)
      `).run(id, event, current.state, next, String(detail || lastError || ''), timestamp);
      this.db.exec('COMMIT');
    } catch (error) {
      if (this.db.isTransaction) this.db.exec('ROLLBACK');
      throw error;
    }
    return this.getBatch(id);
  }

  setExternalBatch(id, { externalBatchId, encryptedSession }) {
    this.db.prepare(`
      UPDATE registration_batches
      SET external_batch_id = ?, encrypted_external_session = ?, updated_at = ? WHERE id = ?
    `).run(externalBatchId, encryptedSession || null, nowIso(this.clock), id);
    return this.getBatch(id);
  }

  setExternalSession(id, encryptedSession) {
    this.db.prepare(`
      UPDATE registration_batches SET encrypted_external_session = ?, updated_at = ? WHERE id = ?
    `).run(encryptedSession || null, nowIso(this.clock), id);
  }

  setBatchError(id, error) {
    this.db.prepare(`
      UPDATE registration_batches SET last_error = ?, updated_at = ? WHERE id = ?
    `).run(String(error || '').slice(0, 1000), nowIso(this.clock), id);
    return this.getBatch(id);
  }

  refreshBatchCounts(id) {
    const counts = this.db.prepare(`
      SELECT
        COUNT(*) AS alias_count,
        SUM(CASE WHEN tasks.terminal_code = 'register_completed' THEN 1 ELSE 0 END) AS success_count,
        SUM(CASE WHEN EXISTS (
          SELECT 1 FROM qualified_accounts AS accounts WHERE accounts.task_id = tasks.id
        ) THEN 1 ELSE 0 END) AS qualified_count,
        SUM(CASE WHEN tasks.state IN ('unqualified', 'mfa_failed', 'failed')
          OR (tasks.state = 'released' AND NOT EXISTS (
            SELECT 1 FROM qualified_accounts AS accounts WHERE accounts.task_id = tasks.id
          )) THEN 1 ELSE 0 END) AS failed_count
      FROM registration_tasks AS tasks WHERE tasks.batch_id = ?
    `).get(id);
    const proxy = this.db.prepare('SELECT COUNT(*) AS count FROM registration_proxy_allocations WHERE batch_id = ?').get(id);
    this.db.prepare(`
      UPDATE registration_batches SET alias_count = ?, proxy_count = ?, success_count = ?,
        qualified_count = ?, failed_count = ?, updated_at = ? WHERE id = ?
    `).run(
      Number(counts.alias_count || 0), Number(proxy.count || 0), Number(counts.success_count || 0),
      Number(counts.qualified_count || 0), Number(counts.failed_count || 0), nowIso(this.clock), id,
    );
    return this.getBatch(id);
  }

  createTask({
    batchId,
    slot,
    mailboxCategory = 'mail',
    aliasId = null,
    icMailboxId = null,
    email,
    webApi,
    id = randomUUID(),
  }) {
    if (mailboxCategory === 'mail' && (!aliasId || icMailboxId)) throw new Error('mail task requires only aliasId');
    if (mailboxCategory === 'ic' && (!icMailboxId || aliasId)) throw new Error('IC task requires only icMailboxId');
    const timestamp = nowIso(this.clock);
    this.db.prepare(`
      INSERT INTO registration_tasks
        (id, batch_id, slot, mailbox_category, alias_id, ic_mailbox_id, email,
         encrypted_web_api, state, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, batchId, slot, mailboxCategory, aliasId, icMailboxId,
      String(email).toLowerCase(), this.secretBox.seal(webApi),
      TASK_STATES.ALIAS_READY, timestamp, timestamp,
    );
    this.refreshBatchCounts(batchId);
    return this.getTask(id);
  }

  getTask(id) {
    return this.db.prepare('SELECT * FROM registration_tasks WHERE id = ?').get(id) || null;
  }

  setTaskError(id, error) {
    const task = this.getTask(id);
    if (!task) return null;
    this.db.prepare(`
      UPDATE registration_tasks SET last_error = ?, updated_at = ? WHERE id = ?
    `).run(String(error || '').slice(0, 1000), nowIso(this.clock), id);
    this.refreshBatchCounts(task.batch_id);
    return this.getTask(id);
  }

  listTasks(batchId) {
    return this.db.prepare('SELECT * FROM registration_tasks WHERE batch_id = ? ORDER BY slot').all(batchId);
  }

  taskSubmissionLines(batchId) {
    return this.listTasks(batchId).map((task) => `${task.email}----${this.secretBox.open(task.encrypted_web_api)}`);
  }

  transitionTask(id, event, fields = {}) {
    const current = this.getTask(id);
    if (!current) return null;
    const next = nextTaskState(current.state, event);
    const timestamp = nowIso(this.clock);
    const completedAt = [TASK_STATES.UNQUALIFIED, TASK_STATES.MFA_FAILED, TASK_STATES.FAILED, TASK_STATES.SAVED, TASK_STATES.RELEASED].includes(next)
      ? timestamp : current.completed_at;
    const lastError = Object.hasOwn(fields, 'lastError')
      ? String(fields.lastError || '')
      : current.last_error;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = this.db.prepare(`
        UPDATE registration_tasks SET state = ?, external_task_id = COALESCE(?, external_task_id),
          mfa_status = COALESCE(?, mfa_status), trial_qualification = COALESCE(?, trial_qualification),
          terminal_code = COALESCE(?, terminal_code), last_error = ?, updated_at = ?, completed_at = ?
        WHERE id = ? AND state = ?
      `).run(
        next, fields.externalTaskId || null, fields.mfaStatus || null, fields.trialQualification || null,
        fields.terminalCode || null, lastError, timestamp, completedAt, id, current.state,
      );
      if (result.changes !== 1) throw new Error(`registration task changed during transition: ${id}`);
      this.db.prepare(`
        INSERT INTO registration_events
          (batch_id, task_id, entity, event, from_state, to_state, detail, created_at)
        VALUES (?, ?, 'task', ?, ?, ?, ?, ?)
      `).run(current.batch_id, id, event, current.state, next, String(fields.detail || fields.lastError || ''), timestamp);
      this.db.exec('COMMIT');
    } catch (error) {
      if (this.db.isTransaction) this.db.exec('ROLLBACK');
      throw error;
    }
    this.refreshBatchCounts(current.batch_id);
    return this.getTask(id);
  }

  replaceProxyPool(values, table, { mode = 'replace' } = {}) {
    if (!['proxy_pool', 'control_proxy_pool'].includes(table)) throw new Error('invalid proxy pool');
    if (mode !== 'replace') {
      throw Object.assign(new Error('invalid proxy import mode'), { code: 'INVALID_PROXY_MODE' });
    }
    const parsed = normalizeProxyList(values, { convertSupplierUrl: true });
    const previousRows = this.db.prepare(`SELECT fingerprint, active FROM ${table}`).all();
    const previous = new Map(previousRows.map((row) => [row.fingerprint, Number(row.active)]));
    const incoming = new Set(parsed.entries.map(([fingerprint]) => fingerprint));
    const timestamp = nowIso(this.clock);
    const upsert = this.db.prepare(`
      INSERT INTO ${table}
        (fingerprint, encrypted_endpoint, masked_endpoint, active, imported_at)
      VALUES (?, ?, ?, 1, ?)
      ON CONFLICT(fingerprint) DO UPDATE SET
        encrypted_endpoint = excluded.encrypted_endpoint,
        masked_endpoint = excluded.masked_endpoint,
        active = 1,
        imported_at = excluded.imported_at
    `);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare(`UPDATE ${table} SET active = 0 WHERE active = 1`).run();
      for (const [fingerprint, endpoint] of parsed.entries) {
        upsert.run(fingerprint, this.secretBox.seal(endpoint), maskProxy(endpoint), timestamp);
      }
      this.db.exec('COMMIT');
    } catch (error) {
      if (this.db.isTransaction) this.db.exec('ROLLBACK');
      throw error;
    }
    const added = parsed.entries.filter(([fingerprint]) => !previous.has(fingerprint)).length;
    const restored = parsed.entries.filter(([fingerprint]) => previous.get(fingerprint) === 0).length;
    const retained = parsed.entries.length - added - restored;
    const removed = previousRows.filter((row) => Number(row.active) === 1 && !incoming.has(row.fingerprint)).length;
    return {
      mode,
      replaced: true,
      current: Number(this.db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE active = 1`).get().count),
      added,
      restored,
      retained,
      removed,
      duplicates: parsed.duplicates,
      invalid: 0,
    };
  }

  importProxies(values, options) {
    const result = this.replaceProxyPool(values, 'proxy_pool', options);
    return { ...result, stats: this.proxyStats() };
  }

  importControlProxies(values, options) {
    const result = this.replaceProxyPool(values, 'control_proxy_pool', options);
    return { ...result, stats: this.controlProxyStats() };
  }

  poolStats(table) {
    const stats = { total: 0, available: 0, reserved: 0, consumed: 0, quarantined: 0 };
    for (const row of this.db.prepare(`
      SELECT status, COUNT(*) AS count FROM ${table} WHERE active = 1 GROUP BY status
    `).all()) {
      stats[row.status] = Number(row.count);
      stats.total += Number(row.count);
    }
    return stats;
  }

  proxyStats() {
    return this.poolStats('proxy_pool');
  }

  controlProxyStats() {
    return this.poolStats('control_proxy_pool');
  }

  listProxyPool(table, { page = 1, limit = 50, status, q } = {}) {
    if (!['proxy_pool', 'control_proxy_pool'].includes(table)) throw new Error('invalid proxy pool');
    const clauses = ['active = 1'];
    const parameters = [];
    if (status != null && status !== '') {
      if (!['available', 'reserved', 'consumed', 'quarantined'].includes(status)) {
        throw Object.assign(new Error('invalid proxy status'), { code: 'INVALID_PROXY_STATUS' });
      }
      clauses.push('status = ?');
      parameters.push(status);
    }
    if (q != null && String(q).trim()) {
      clauses.push('instr(lower(masked_endpoint), lower(?)) > 0');
      parameters.push(String(q).trim());
    }
    const where = clauses.join(' AND ');
    const pageSize = Math.min(100, Math.max(1, Math.floor(Number(limit)) || 50));
    const total = Number(this.db.prepare(`
      SELECT COUNT(*) AS count FROM ${table} WHERE ${where}
    `).get(...parameters).count);
    const pages = Math.max(1, Math.ceil(total / pageSize));
    const currentPage = Math.min(pages, Math.max(1, Math.floor(Number(page)) || 1));
    const proxies = this.db.prepare(`
      SELECT id, masked_endpoint, status, batch_id, imported_at, reserved_at, consumed_at, last_error
      FROM ${table} WHERE ${where} ORDER BY id DESC LIMIT ? OFFSET ?
    `).all(...parameters, pageSize, (currentPage - 1) * pageSize).map((proxy) => ({
      ...proxy,
      cooldown_until: table === 'proxy_pool' && proxy.status === 'consumed' && proxy.consumed_at
        ? new Date(Date.parse(proxy.consumed_at) + this.registrationProxyRefreshMs).toISOString() : null,
    }));
    return { proxies, pagination: { page: currentPage, limit: pageSize, total, pages } };
  }

  listProxies(options) {
    return this.listProxyPool('proxy_pool', options);
  }

  listControlProxies(options) {
    return this.listProxyPool('control_proxy_pool', options);
  }

  reserveProxies(batchId, count) {
    const required = Number(count);
    this.refreshCooledProxies();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const rows = this.db.prepare(`
        SELECT id, encrypted_endpoint FROM proxy_pool
        WHERE active = 1 AND status = 'available' ORDER BY id LIMIT ?
      `).all(required);
      if (rows.length !== required) throw new Error(`需要 ${required} 条可用代理，当前只有 ${rows.length} 条`);
      const timestamp = nowIso(this.clock);
      const reserve = this.db.prepare(`
        UPDATE proxy_pool SET status = 'reserved', batch_id = ?, reserved_at = ?, consumed_at = NULL, last_error = ''
        WHERE id = ? AND active = 1 AND status = 'available'
      `);
      const assign = this.db.prepare(`
        INSERT INTO registration_batch_proxies (batch_id, proxy_id, ordinal) VALUES (?, ?, ?)
      `);
      const record = this.db.prepare(`
        INSERT INTO registration_proxy_allocations
          (batch_id, proxy_id, ordinal, reserved_at, final_status)
        VALUES (?, ?, ?, ?, 'reserved')
      `);
      rows.forEach((row, index) => {
        if (reserve.run(batchId, timestamp, row.id).changes !== 1) throw new Error('proxy allocation changed concurrently');
        assign.run(batchId, row.id, index + 1);
        record.run(batchId, row.id, index + 1, timestamp);
      });
      this.db.exec('COMMIT');
      return rows.map((row) => this.secretBox.open(row.encrypted_endpoint));
    } catch (error) {
      if (this.db.isTransaction) this.db.exec('ROLLBACK');
      throw error;
    }
  }

  refreshCooledProxies() {
    const cutoff = new Date(this.clock() - this.registrationProxyRefreshMs).toISOString();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const rows = this.db.prepare(`
        SELECT id FROM proxy_pool
        WHERE active = 1 AND status = 'consumed'
          AND consumed_at IS NOT NULL AND consumed_at <= ?
        ORDER BY id
      `).all(cutoff);
      if (rows.length) {
        const ids = rows.map((row) => row.id);
        const placeholders = ids.map(() => '?').join(', ');
        this.db.prepare(`
          DELETE FROM registration_batch_proxies WHERE proxy_id IN (${placeholders})
        `).run(...ids);
        this.db.prepare(`
          UPDATE proxy_pool
          SET status = 'available', batch_id = NULL, reserved_at = NULL,
            consumed_at = NULL, last_error = ''
          WHERE id IN (${placeholders}) AND active = 1 AND status = 'consumed'
        `).run(...ids);
      }
      this.db.exec('COMMIT');
      return rows.length;
    } catch (error) {
      if (this.db.isTransaction) this.db.exec('ROLLBACK');
      throw error;
    }
  }

  resetConsumedCycle(table, removeActiveLinks) {
    const available = Number(this.db.prepare(`
      SELECT COUNT(*) AS count FROM ${table} WHERE active = 1 AND status = 'available'
    `).get().count);
    if (available > 0) return 0;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const rows = this.db.prepare(`
        SELECT id FROM ${table}
        WHERE active = 1 AND status = 'consumed'
        ORDER BY id
      `).all();
      if (rows.length) {
        const ids = rows.map((row) => row.id);
        const placeholders = ids.map(() => '?').join(', ');
        if (removeActiveLinks) {
          this.db.prepare(`DELETE FROM registration_batch_proxies WHERE proxy_id IN (${placeholders})`).run(...ids);
        }
        this.db.prepare(`
          UPDATE ${table}
          SET status = 'available', batch_id = NULL, reserved_at = NULL, last_error = ''
          WHERE id IN (${placeholders}) AND active = 1 AND status = 'consumed'
        `).run(...ids);
      }
      this.db.exec('COMMIT');
      return rows.length;
    } catch (error) {
      if (this.db.isTransaction) this.db.exec('ROLLBACK');
      throw error;
    }
  }

  refreshCooledControlProxies() {
    return this.resetConsumedCycle('control_proxy_pool', false);
  }

  reserveControlProxy(batchId) {
    this.resetConsumedCycle('control_proxy_pool', false);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const row = this.db.prepare(`
        SELECT id, encrypted_endpoint FROM control_proxy_pool
        WHERE active = 1 AND status = 'available' ORDER BY id LIMIT 1
      `).get();
      if (!row) throw new Error('没有可用的公共站请求代理');
      const timestamp = nowIso(this.clock);
      const updated = this.db.prepare(`
        UPDATE control_proxy_pool
        SET status = 'reserved', batch_id = ?, reserved_at = ?, consumed_at = NULL, last_error = ''
        WHERE id = ? AND active = 1 AND status = 'available'
      `).run(batchId, timestamp, row.id);
      if (updated.changes !== 1) throw new Error('公共站请求代理分配发生并发冲突');
      this.db.prepare(`
        INSERT INTO registration_batch_control_proxies
          (batch_id, proxy_id, reserved_at, final_status)
        VALUES (?, ?, ?, 'reserved')
      `).run(batchId, row.id, timestamp);
      this.db.exec('COMMIT');
      return this.secretBox.open(row.encrypted_endpoint);
    } catch (error) {
      if (this.db.isTransaction) this.db.exec('ROLLBACK');
      throw error;
    }
  }

  rotateBatchControlProxy(batchId, lastError = '') {
    const timestamp = nowIso(this.clock);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const allocation = this.db.prepare(`
        SELECT proxy_id FROM registration_batch_control_proxies WHERE batch_id = ?
      `).get(batchId);
      if (!allocation) throw new Error('注册批次没有绑定公共站请求代理');

      this.db.prepare(`
        UPDATE control_proxy_pool
        SET status = 'consumed', consumed_at = ?, last_error = ?
        WHERE id = ? AND batch_id = ? AND status = 'reserved'
      `).run(timestamp, String(lastError || ''), allocation.proxy_id, batchId);

      const replacement = this.db.prepare(`
        SELECT id, encrypted_endpoint FROM control_proxy_pool
        WHERE active = 1 AND status = 'available' ORDER BY id LIMIT 1
      `).get();
      if (!replacement) {
        this.db.prepare(`
          UPDATE registration_batch_control_proxies
          SET final_status = 'consumed', completed_at = ? WHERE batch_id = ?
        `).run(timestamp, batchId);
        this.db.exec('COMMIT');
        return null;
      }

      const updated = this.db.prepare(`
        UPDATE control_proxy_pool
        SET status = 'reserved', batch_id = ?, reserved_at = ?, consumed_at = NULL, last_error = ''
        WHERE id = ? AND active = 1 AND status = 'available'
      `).run(batchId, timestamp, replacement.id);
      if (updated.changes !== 1) throw new Error('公共站请求代理轮换发生并发冲突');
      this.db.prepare(`
        UPDATE registration_batch_control_proxies
        SET proxy_id = ?, reserved_at = ?, final_status = 'reserved', completed_at = NULL
        WHERE batch_id = ?
      `).run(replacement.id, timestamp, batchId);
      this.db.exec('COMMIT');
      return this.secretBox.open(replacement.encrypted_endpoint);
    } catch (error) {
      if (this.db.isTransaction) this.db.exec('ROLLBACK');
      throw error;
    }
  }

  batchControlProxyEndpoint(batchId) {
    const row = this.db.prepare(`
      SELECT pool.encrypted_endpoint
      FROM registration_batch_control_proxies AS allocation
      JOIN control_proxy_pool AS pool ON pool.id = allocation.proxy_id
      WHERE allocation.batch_id = ?
    `).get(batchId);
    return row ? this.secretBox.open(row.encrypted_endpoint) : null;
  }

  markBatchControlProxy(batchId, status, lastError = '') {
    if (!['reserved', 'consumed', 'quarantined'].includes(status)) {
      throw new Error('invalid control proxy release status');
    }
    const timestamp = nowIso(this.clock);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare(`
        UPDATE control_proxy_pool
        SET status = ?, consumed_at = CASE WHEN ? THEN ? ELSE consumed_at END, last_error = ?
        WHERE batch_id = ? AND id = (
          SELECT proxy_id FROM registration_batch_control_proxies WHERE batch_id = ?
        )
      `).run(status, status === 'consumed' ? 1 : 0, timestamp, String(lastError || ''), batchId, batchId);
      this.db.prepare(`
        UPDATE registration_batch_control_proxies
        SET final_status = ?, completed_at = CASE WHEN ? THEN NULL ELSE ? END
        WHERE batch_id = ?
      `).run(status, status === 'reserved' ? 1 : 0, timestamp, batchId);
      this.db.exec('COMMIT');
    } catch (error) {
      if (this.db.isTransaction) this.db.exec('ROLLBACK');
      throw error;
    }
  }

  batchProxyEndpoints(batchId) {
    return this.db.prepare(`
      SELECT p.encrypted_endpoint FROM registration_batch_proxies bp
      JOIN proxy_pool p ON p.id = bp.proxy_id
      WHERE bp.batch_id = ? ORDER BY bp.ordinal
    `).all(batchId).map((row) => this.secretBox.open(row.encrypted_endpoint));
  }

  markBatchProxies(batchId, status, lastError = '') {
    if (!['available', 'consumed', 'quarantined'].includes(status)) throw new Error('invalid proxy release status');
    const timestamp = nowIso(this.clock);
    const clear = status === 'available';
    this.db.prepare(`
      UPDATE proxy_pool SET status = ?, batch_id = CASE WHEN ? THEN NULL ELSE batch_id END,
        reserved_at = CASE WHEN ? THEN NULL ELSE reserved_at END,
        consumed_at = CASE WHEN ? THEN ? ELSE consumed_at END, last_error = ?
      WHERE batch_id = ? AND status = 'reserved'
    `).run(status, clear ? 1 : 0, clear ? 1 : 0, status === 'consumed' ? 1 : 0, timestamp, String(lastError || ''), batchId);
    this.db.prepare(`
      UPDATE registration_proxy_allocations
      SET final_status = ?, completed_at = ?,
        reserved_at = COALESCE(reserved_at, ?)
      WHERE batch_id = ? AND final_status = 'reserved'
    `).run(status === 'available' ? 'released' : status, timestamp, timestamp, batchId);
    if (clear) this.db.prepare('DELETE FROM registration_batch_proxies WHERE batch_id = ?').run(batchId);
    this.refreshBatchCounts(batchId);
  }

  reconcileQuarantinedProxies(batchId, status, lastError = '') {
    if (!['available', 'consumed'].includes(status)) throw new Error('invalid reconciled proxy status');
    const timestamp = nowIso(this.clock);
    const release = status === 'available';
    this.db.prepare(`
      UPDATE proxy_pool SET status = ?, batch_id = CASE WHEN ? THEN NULL ELSE batch_id END,
        reserved_at = CASE WHEN ? THEN NULL ELSE reserved_at END,
        consumed_at = CASE WHEN ? THEN ? ELSE consumed_at END, last_error = ?
      WHERE batch_id = ? AND status = 'quarantined'
    `).run(status, release ? 1 : 0, release ? 1 : 0, status === 'consumed' ? 1 : 0, timestamp, String(lastError || ''), batchId);
    this.db.prepare(`
      UPDATE registration_proxy_allocations
      SET final_status = ?, completed_at = ?
      WHERE batch_id = ? AND final_status = 'quarantined'
    `).run(status === 'available' ? 'released' : status, timestamp, batchId);
    if (release) this.db.prepare('DELETE FROM registration_batch_proxies WHERE batch_id = ?').run(batchId);
    this.refreshBatchCounts(batchId);
  }

  saveQualifiedAccount(taskId, result) {
    const task = this.getTask(taskId);
    if (!task) throw new Error('registration task not found');
    const mfa = result.mfa && typeof result.mfa === 'object' ? result.mfa : {};
    const revealedMfaConfirmed = mfa.status === 'enabled'
      && mfa.factor_type === 'totp'
      && mfa.active_factor_present === true
      && mfa.mutation_started === true
      && mfa.mutation_rejected === false;
    const trialRequirementMet = task.mailbox_category === 'ic'
      || (task.trial_qualification === 'observed_eligible'
        && result.trial_qualification === 'observed_eligible');
    if (task.state !== TASK_STATES.QUALIFIED
      || task.mfa_status !== 'enabled'
      || !revealedMfaConfirmed
      || !trialRequirementMet) {
      throw new Error('revealed result does not meet qualified account requirements');
    }
    const password = result.password || result.account_password;
    const totpSecret = result.totp_secret || result.totpSecret || result.mfa_secret
      || mfa.totp_secret || mfa.totpSecret || mfa.secret || mfa.manual_entry_key;
    if (!password || !totpSecret) throw new Error('revealed result does not contain password and TOTP secret');
    const session = result.session || result.session_json || result.cookies || null;
    const trial = result.trial_qualification;
    const id = randomUUID();
    this.db.prepare(`
      INSERT INTO qualified_accounts
        (id, task_id, email, encrypted_password, encrypted_totp_secret, encrypted_session_json,
         encrypted_result_json, trial_summary, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, taskId, task.email, this.secretBox.seal(password), this.secretBox.seal(totpSecret),
      session == null ? null : this.secretBox.seal(JSON.stringify(session)),
      this.secretBox.seal(JSON.stringify(result)), typeof trial === 'string' ? trial : JSON.stringify(trial), nowIso(this.clock),
    );
    return this.getQualifiedAccount(id, { reveal: false });
  }

  listQualifiedAccounts() {
    return this.db.prepare(`
      SELECT accounts.id, accounts.task_id, accounts.email, accounts.trial_summary, accounts.created_at,
        tasks.mailbox_category, tasks.mfa_status, tasks.trial_qualification
      FROM qualified_accounts AS accounts
      JOIN registration_tasks AS tasks ON tasks.id = accounts.task_id
      ORDER BY accounts.created_at DESC
    `).all().map((row) => ({ ...row, ...rebindMetadata(row, rebindHistory(this.db, row.id)), ...trialMetadata(this.db, row) }));
  }

  getQualifiedAccountRebindHistory(id) {
    const account = this.getQualifiedAccount(id);
    if (!account) return null;
    return { account, history: rebindHistory(this.db, id).map(({ verified, ...job }) => job) };
  }

  getQualifiedAccount(id, { reveal = false } = {}) {
    const columns = reveal ? 'accounts.*' : 'accounts.id, accounts.task_id, accounts.email, accounts.trial_summary, accounts.created_at';
    const row = this.db.prepare(`
      SELECT ${columns}, tasks.mailbox_category, tasks.mfa_status, tasks.trial_qualification
      FROM qualified_accounts AS accounts
      JOIN registration_tasks AS tasks ON tasks.id = accounts.task_id
      WHERE accounts.id = ?
    `).get(id);
    if (!row) return null;
    const metadata = { ...rebindMetadata(row, rebindHistory(this.db, id)), ...trialMetadata(this.db, row) };
    if (!reveal) {
      return {
        id: row.id,
        task_id: row.task_id,
        email: row.email,
        mailbox_category: row.mailbox_category,
        mfa_status: row.mfa_status,
        trial_qualification: row.trial_qualification,
        trial_summary: row.trial_summary,
        created_at: row.created_at,
        ...metadata,
      };
    }
    const { originalQualifiedResult, ...result } = JSON.parse(this.secretBox.open(row.encrypted_result_json));
    return {
      ...metadata,
      mailbox_category: row.mailbox_category,
      id: row.id,
      email: row.email,
      mailboxCategory: row.mailbox_category,
      password: this.secretBox.open(row.encrypted_password),
      totpSecret: this.secretBox.open(row.encrypted_totp_secret),
      session: row.encrypted_session_json ? JSON.parse(this.secretBox.open(row.encrypted_session_json)) : null,
      result,
      mfaStatus: row.mfa_status,
      trialQualification: row.trial_qualification,
      trialSummary: row.trial_summary,
      createdAt: row.created_at,
    };
  }

  listEvents(batchId) {
    return this.db.prepare('SELECT * FROM registration_events WHERE batch_id = ? ORDER BY id').all(batchId);
  }
}

module.exports = { RegistrationStore, maskProxy, normalizeProxy, proxyFingerprint };
