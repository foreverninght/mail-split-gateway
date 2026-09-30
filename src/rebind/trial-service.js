'use strict';
const { randomUUID } = require('node:crypto');
const { trialResult, trialSession, trialDiagnostic } = require('./trial-result');
const ERROR_CODES = new Set(['LOGIN_FAILED', 'LOGIN_INCOMPLETE', 'MFA_FAILED', 'MFA_INVALID_CODE',
  'ACCOUNT_MISMATCH', 'SESSION_EMAIL_MISMATCH', 'WORKER_TIMEOUT', 'WORKER_START_FAILED',
  'TRIAL_INTERRUPTED', 'TRIAL_STALE_RESULT', 'NETWORK_TIMEOUT', 'NETWORK_TLS', 'NETWORK_PROXY',
  'NETWORK_FAILED', 'PROTOCOL_ERROR', 'TRIAL_PROBE_FAILED', 'REBIND_PROXY_POOL_EXHAUSTED', 'TRIAL_WORKER_UNAVAILABLE']);
const MAX_ATTEMPTS = 3;
function diagnostic(error) {
  const d = error?.diagnostic || {};
  const number = (value, min, max) => Number.isInteger(value) && value >= min && value <= max ? value : null;
  const code = error?.code === 'ABORTED' ? 'TRIAL_INTERRUPTED' : ERROR_CODES.has(error?.code) ? error.code : 'TRIAL_PROBE_FAILED';
  const http = number(d.httpStatus, 100, 599), curl = number(d.curlCode, 1, 99);
  const category = ['timeout', 'tls', 'proxy', 'http', 'protocol', 'unknown'].includes(d.category)
    ? d.category : ({ NETWORK_TIMEOUT: 'timeout', NETWORK_TLS: 'tls', NETWORK_PROXY: 'proxy', PROTOCOL_ERROR: 'protocol', INVALID_RESULT: 'protocol' }[error?.code] || 'unknown');
  const retry = http === null && ((['timeout', 'tls', 'proxy'].includes(category)
    && ['NETWORK_TIMEOUT', 'NETWORK_TLS', 'NETWORK_PROXY'].includes(code))
    || (code === 'NETWORK_FAILED' && ['unknown', 'timeout', 'tls', 'proxy'].includes(category)
      && [5, 6, 7, 18, 52, 55, 56].includes(curl)));
  return { code, category, http, curl, retry, ...trialDiagnostic(d) };
}
const PUBLIC_FIELDS = ['id', 'account_id', 'source_rebind_job_id', 'checked_email', 'state', 'status', 'stage',
  'campaign_id', 'amount_minor', 'currency', 'billing_country', 'error_code', 'created_at', 'started_at', 'checked_at', 'idempotency_key'];
function publicCheck(row) {
  return row ? { ...Object.fromEntries([...PUBLIC_FIELDS, 'error_category', 'error_phase', 'error_reason', 'http_status', 'curl_code', 'attempt_count']
    .map((key) => [key, row[key]])), max_attempts: MAX_ATTEMPTS } : null;
}
function problem(code, statusCode = 409) { return Object.assign(new Error(code), { code, statusCode }); }

class TrialService {
  constructor({ store, registrationStore, worker, secretBox, clock = Date.now }) {
    Object.assign(this, { store, registrationStore, worker, secretBox, clock });
    this.db = store.db;
    this.running = new Map();
    this.closed = false;
    this.db.exec(`CREATE TABLE IF NOT EXISTS account_trial_checks (
      id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES qualified_accounts(id),
      source_rebind_job_id TEXT NOT NULL REFERENCES rebind_jobs(id), checked_email TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('queued','running','completed','failed')),
      status TEXT CHECK(status IN ('eligible','ineligible','error')), stage TEXT NOT NULL DEFAULT '',
      campaign_id TEXT, amount_minor INTEGER, currency TEXT, billing_country TEXT, error_code TEXT,
      created_at TEXT NOT NULL, started_at TEXT, checked_at TEXT,
      proxy_id INTEGER REFERENCES rebind_proxy_pool(id), encrypted_proxy TEXT, idempotency_key TEXT UNIQUE
    );
    CREATE UNIQUE INDEX IF NOT EXISTS account_trial_checks_active ON account_trial_checks(account_id)
      WHERE state IN ('queued','running');`);
    const columns = new Set(this.db.prepare('PRAGMA table_info(account_trial_checks)').all().map((row) => row.name));
    for (const [name, type] of Object.entries({ error_category: 'TEXT', error_phase: 'TEXT', error_reason: 'TEXT', http_status: 'INTEGER', curl_code: 'INTEGER', attempt_count: 'INTEGER NOT NULL DEFAULT 0' })) {
      if (!columns.has(name)) this.db.exec(`ALTER TABLE account_trial_checks ADD COLUMN ${name} ${type}`);
    }
    this.db.exec(`CREATE TABLE IF NOT EXISTS account_trial_attempts (
      check_id TEXT NOT NULL REFERENCES account_trial_checks(id) ON DELETE CASCADE,
      attempt_number INTEGER NOT NULL CHECK(attempt_number BETWEEN 1 AND 3),
      proxy_id INTEGER NOT NULL REFERENCES rebind_proxy_pool(id),
      state TEXT NOT NULL CHECK(state IN ('reserved','running','completed','failed','interrupted','released')),
      error_code TEXT, error_category TEXT, http_status INTEGER, curl_code INTEGER,
      created_at TEXT NOT NULL, started_at TEXT, finished_at TEXT,
      PRIMARY KEY(check_id, attempt_number)
    )`);
    const attemptColumns = new Set(this.db.prepare('PRAGMA table_info(account_trial_attempts)').all().map((row) => row.name));
    for (const name of ['error_phase', 'error_reason']) {
      if (!attemptColumns.has(name)) this.db.exec(`ALTER TABLE account_trial_attempts ADD COLUMN ${name} TEXT`);
    }
  }
  reserve(id) {
    if (this.closed) throw problem('TRIAL_INTERRUPTED');
    const row = this.row(id);
    const n = this.db.prepare('SELECT COUNT(*) AS n FROM account_trial_attempts WHERE check_id = ?').get(id).n;
    if (n >= MAX_ATTEMPTS || row.attempt_count >= MAX_ATTEMPTS) throw problem('TRIAL_PROBE_FAILED');
    const proxy = this.store.proxyPool.reserve(row.source_rebind_job_id);
    this.db.prepare(`INSERT INTO account_trial_attempts (check_id, attempt_number, proxy_id, state, created_at)
      VALUES (?, ?, ?, 'reserved', ?)`).run(id, n + 1, proxy.id, this.now());
    this.db.prepare('UPDATE account_trial_checks SET proxy_id = ?, encrypted_proxy = ? WHERE id = ?')
      .run(proxy.id, proxy.encrypted_endpoint, id);
  }
  attempt(id) {
    return this.db.prepare('SELECT * FROM account_trial_attempts WHERE check_id = ? ORDER BY attempt_number DESC LIMIT 1').get(id);
  }
  finishAttempt(row, state, leaseStatus, d = {}) {
    const attempt = this.attempt(row.id);
    if (attempt) {
      const changed = this.db.prepare(`UPDATE account_trial_attempts SET state = ?, error_code = ?, error_category = ?,
        http_status = ?, curl_code = ?, error_phase = ?, error_reason = ?, finished_at = ? WHERE check_id = ? AND attempt_number = ? AND state IN ('reserved','running')`)
        .run(state, d.code || null, d.category || null, d.http ?? null, d.curl ?? null, d.phase || null, d.reason || null,
          this.now(), row.id, attempt.attempt_number);
      if (!changed.changes) return;
      this.store.proxyPool.finish(row.source_rebind_job_id, leaseStatus, attempt.proxy_id);
    } else this.finishProxy(row, leaseStatus);
  }
  now() { return new Date(this.clock()).toISOString(); }
  row(id) { return this.db.prepare('SELECT * FROM account_trial_checks WHERE id = ?').get(id); }
  latest(accountId) {
    return this.db.prepare('SELECT * FROM account_trial_checks WHERE account_id = ? ORDER BY rowid DESC LIMIT 1').get(accountId);
  }
  get(accountId) {
    if (!this.registrationStore.getQualifiedAccount(accountId)) throw problem('ACCOUNT_NOT_FOUND', 404);
    return publicCheck(this.latest(accountId));
  }
  context(accountId) {
    const account = this.registrationStore.getQualifiedAccount(accountId, { reveal: true });
    if (!account) throw problem('ACCOUNT_NOT_FOUND', 404);
    const job = this.store.getJob(account.last_rebind_job_id);
    if (account.rebind_status !== 'rebound' || !account.credential_ready || !job?.encrypted_result
      || !['completed', 'cleanup_pending'].includes(job.state)
      || job.new_email?.trim().toLowerCase() !== account.email.trim().toLowerCase()
      || !account.password || !account.totpSecret || !account.result?.accountId) throw problem('TRIAL_ACCOUNT_NOT_READY');
    return { account, job };
  }
  start({ accountId, idempotencyKey, automatic = false } = {}) {
    if (this.closed) throw problem('TRIAL_SERVICE_CLOSED', 503);
    if (idempotencyKey !== undefined && (typeof idempotencyKey !== 'string' || !idempotencyKey.trim()
      || idempotencyKey.length > 200)) throw problem('INVALID_IDEMPOTENCY_KEY', 400);
    const row = this.store.transaction(() => {
      const { account, job } = this.context(accountId);
      if (automatic && this.latest(accountId)) return this.latest(accountId);
      if (idempotencyKey) {
        const previous = this.db.prepare('SELECT * FROM account_trial_checks WHERE idempotency_key = ?').get(idempotencyKey);
        if (previous) {
          if (previous.account_id !== accountId) throw problem('IDEMPOTENCY_CONFLICT');
          return previous;
        }
      }
      const active = this.db.prepare("SELECT * FROM account_trial_checks WHERE account_id = ? AND state IN ('queued','running')").get(accountId);
      if (active) {
        if (idempotencyKey && active.idempotency_key !== idempotencyKey) throw problem('TRIAL_CHECK_ACTIVE');
        return active;
      }
      const id = randomUUID();
      this.db.prepare(`INSERT INTO account_trial_checks
        (id, account_id, source_rebind_job_id, checked_email, state, created_at, idempotency_key)
        VALUES (?, ?, ?, ?, 'queued', ?, ?)`).run(id, accountId, job.id, account.email, this.now(), idempotencyKey || null);
      try {
        if (typeof this.worker?.runTrial !== 'function') throw problem('TRIAL_WORKER_UNAVAILABLE', 503);
        this.reserve(id);
      } catch (error) {
        this.fail(id, error.code === 'REBIND_PROXY_POOL_EXHAUSTED' ? error.code : 'TRIAL_WORKER_UNAVAILABLE');
      }
      return this.row(id);
    });
    if (row.state === 'queued' && !this.running.has(row.id)) {
      const operation = Promise.resolve().then(() => this.run(row.id));
      this.running.set(row.id, operation);
      operation.finally(() => this.running.delete(row.id)).catch(() => {});
    }
    return publicCheck(row);
  }
  fail(id, code = 'TRIAL_PROBE_FAILED', d = diagnostic({ code })) {
    this.db.prepare(`UPDATE account_trial_checks SET state = 'failed', status = 'error', error_code = ?,
      error_category = ?, http_status = ?, curl_code = ?, error_phase = ?, error_reason = ?,
      checked_at = ?, campaign_id = 'plus-1-month-free', amount_minor = NULL, currency = NULL, billing_country = NULL
      WHERE id = ?`).run(code, d.category, d.http, d.curl, d.phase || null, d.reason || null, this.now(), id);
  }
  finishProxy(row, status) {
    if (row.proxy_id !== null) this.store.proxyPool.finish(row.source_rebind_job_id, status, row.proxy_id);
  }
  async run(id) {
    while (true) {
      const row = this.row(id);
      if (row?.state !== 'queued') return;
      let workerStarted = false, workerReturned = false;
      try {
        if (this.closed) throw problem('TRIAL_INTERRUPTED');
        const { account, job, sessionSnapshot } = this.store.transaction(() => ({
          ...this.context(row.account_id),
          sessionSnapshot: this.db.prepare('SELECT encrypted_session_json FROM qualified_accounts WHERE id = ?')
            .get(row.account_id).encrypted_session_json,
        }));
        if (job.id !== row.source_rebind_job_id || account.email !== row.checked_email) throw problem('TRIAL_STALE_RESULT');
        const proxy = this.secretBox.open(row.encrypted_proxy);
        const claimed = this.store.transaction(() => {
          const attempt = this.attempt(id);
          if (!attempt || attempt.state !== 'reserved') return false;
          const changed = this.db.prepare(`UPDATE account_trial_checks SET state = 'running', started_at = COALESCE(started_at, ?),
            attempt_count = attempt_count + 1 WHERE id = ? AND state = 'queued' AND attempt_count < ?`).run(this.now(), id, MAX_ATTEMPTS);
          if (!changed.changes) return false;
          this.db.prepare("UPDATE account_trial_attempts SET state = 'running', started_at = ? WHERE check_id = ? AND attempt_number = ?")
            .run(this.now(), id, attempt.attempt_number);
          return true;
        });
        if (!claimed) return;
        workerStarted = true;
        const result = await this.worker.runTrial({
          credentials: { email: account.email, password: account.password, totpSecret: account.totpSecret },
          expectedAccountId: String(account.result.accountId), proxy,
          session: trialSession(account.session), mfaPreviouslyVerified: account.result.mfaVerified === true,
          timeoutMs: Math.min(this.worker.timeoutMs > 0 ? this.worker.timeoutMs : 180000, 180000),
          onStage: (stage) => {
            if (this.closed || this.row(id)?.state !== 'running') throw problem('TRIAL_INTERRUPTED');
            if (['session_trial', 'login_trial', 'trial_qualification'].includes(stage)) this.db.prepare(
              "UPDATE account_trial_checks SET stage = ? WHERE id = ? AND state = 'running'").run(stage, id);
          },
        });
        const clean = trialResult(result, row.checked_email, String(account.result.accountId));
        workerReturned = true;
        this.store.transaction(() => {
          if (this.row(id).state !== 'running') return;
          if (this.closed) throw problem('TRIAL_INTERRUPTED');
          let current;
          try { current = this.context(row.account_id); } catch { throw problem('TRIAL_STALE_RESULT'); }
          if (current.account.email !== row.checked_email || current.job.id !== row.source_rebind_job_id
            || String(current.account.result.accountId) !== clean.accountId) throw problem('TRIAL_STALE_RESULT');
          if (clean.session && clean.status !== 'error') {
            const stored = this.db.prepare('SELECT encrypted_session_json, encrypted_result_json FROM qualified_accounts WHERE id = ?')
              .get(row.account_id);
            if (stored.encrypted_session_json !== sessionSnapshot) throw problem('TRIAL_STALE_RESULT');
            const currentResult = JSON.parse(this.secretBox.open(stored.encrypted_result_json));
            const updated = this.db.prepare(`UPDATE qualified_accounts SET encrypted_session_json = ?, encrypted_result_json = ?
              WHERE id = ? AND email = ? AND encrypted_session_json IS ?`).run(
              this.secretBox.seal(JSON.stringify({ ...current.account.session, ...clean.session })),
              this.secretBox.seal(JSON.stringify({ ...currentResult, ...clean.session })),
              row.account_id, row.checked_email, sessionSnapshot);
            if (updated.changes !== 1) throw problem('TRIAL_STALE_RESULT');
          }
          this.db.prepare(`UPDATE account_trial_checks SET state = ?, status = ?, stage = 'trial_qualification',
            error_category = NULL, http_status = NULL, curl_code = NULL, error_phase = NULL, error_reason = NULL,
            campaign_id = ?, amount_minor = ?, currency = ?, billing_country = ?, error_code = ?, checked_at = ?
            WHERE id = ? AND state = 'running'`).run(clean.status === 'error' ? 'failed' : 'completed', clean.status,
            clean.campaignId, clean.amountMinor, clean.currency, clean.billingCountry, clean.errorCode, this.now(), id);
          this.finishAttempt(row, clean.status === 'error' ? 'failed' : 'completed', 'consumed',
            clean.status === 'error' ? diagnostic({ code: clean.errorCode }) : {});
        });
        return;
      } catch (error) {
        const d = diagnostic(this.closed ? { code: 'TRIAL_INTERRUPTED' } : error);
        const retry = this.store.transaction(() => {
          if (!['queued', 'running'].includes(this.row(id).state)) return false;
          const released = !workerStarted || error.code === 'WORKER_START_FAILED';
          this.finishAttempt(row, d.code === 'TRIAL_INTERRUPTED' ? 'interrupted' : released ? 'released' : 'failed',
            workerReturned ? 'consumed' : released ? 'available' : 'quarantined', d);
          this.fail(id, d.code, d);
          return !this.closed && workerStarted && !workerReturned && d.retry && this.row(id).attempt_count < MAX_ATTEMPTS;
        });
        if (!retry) return;
        const reserved = this.store.transaction(() => {
          try {
            this.reserve(id);
            this.db.prepare("UPDATE account_trial_checks SET state = 'queued', status = NULL, checked_at = NULL WHERE id = ?").run(id);
            return true;
          } catch (error) {
            const exhausted = diagnostic(error);
            this.fail(id, exhausted.code, exhausted);
            return false;
          }
        });
        if (!reserved) return;
      }
    }
  }
  recoverAfterRestart() {
    return this.store.transaction(() => {
      const rows = this.db.prepare("SELECT * FROM account_trial_checks WHERE state IN ('queued','running')").all();
      for (const row of rows) {
        this.fail(row.id, 'TRIAL_INTERRUPTED');
        this.finishAttempt(row, 'interrupted', row.state === 'queued' ? 'available' : 'quarantined', diagnostic({ code: 'TRIAL_INTERRUPTED' }));
      }
      return rows.length;
    });
  }
  async waitForIdle() { while (this.running.size) await Promise.all([...this.running.values()]); }
}
module.exports = { TrialService, publicCheck };
