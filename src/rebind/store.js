'use strict';

const { randomUUID } = require('node:crypto');
const { RebindProxyStore } = require('./proxy-store');
const { rebindHistory, rebindMetadata } = require('../registration/rebind-metadata');
const { trialMetadata } = require('../registration/trial-metadata');
const COOLDOWN_MS = 86400000;

function initializeRebindSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS rebind_jobs (
      id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES qualified_accounts(id),
      mailbox_id TEXT NOT NULL REFERENCES mailboxes(id), state TEXT NOT NULL,
      alias_id TEXT REFERENCES aliases(id), new_email TEXT, original_email TEXT, encrypted_proxy TEXT,
      encrypted_result TEXT, idempotency_key TEXT UNIQUE, stage TEXT NOT NULL DEFAULT '',
      last_error TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    DROP INDEX IF EXISTS rebind_active_account;
    CREATE UNIQUE INDEX rebind_active_account ON rebind_jobs(account_id) WHERE state NOT IN ('completed', 'preparation_failed');
    CREATE TABLE IF NOT EXISTS rebind_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, job_id TEXT NOT NULL REFERENCES rebind_jobs(id),
      event TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS rebind_alias_claims (
      alias_id TEXT PRIMARY KEY REFERENCES aliases(id), job_id TEXT NOT NULL UNIQUE REFERENCES rebind_jobs(id),
      owner TEXT NOT NULL, created_at TEXT NOT NULL, released_at TEXT
    );
    CREATE TABLE IF NOT EXISTS rebind_login_attempts (
      id INTEGER PRIMARY KEY AUTOINCREMENT, job_id TEXT NOT NULL REFERENCES rebind_jobs(id),
      ordinal INTEGER NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('preflight','login')),
      proxy_id INTEGER NOT NULL REFERENCES rebind_proxy_pool(id), state TEXT NOT NULL,
      error_code TEXT, error_category TEXT, http_status INTEGER, curl_code INTEGER,
      started_at TEXT NOT NULL, finished_at TEXT
    );
    CREATE INDEX IF NOT EXISTS rebind_login_attempts_job ON rebind_login_attempts(job_id, ordinal);
  `);
  for (const [name, type] of Object.entries({ encrypted_original_identity: 'TEXT', last_error_code: 'TEXT', failed_stage: 'TEXT', error_category: 'TEXT', http_status: 'INTEGER', curl_code: 'INTEGER' })) {
    if (!db.prepare('PRAGMA table_info(rebind_jobs)').all().some((column) => column.name === name)) db.exec(`ALTER TABLE rebind_jobs ADD COLUMN ${name} ${type}`);
  }
  if (!db.prepare('PRAGMA table_info(rebind_jobs)').all().some((column) => column.name === 'encrypted_original_account')) {
    db.exec('ALTER TABLE rebind_jobs ADD COLUMN encrypted_original_account TEXT');
  }
}

class RebindStore {
  constructor({ db, secretBox, clock = Date.now, proxyRefreshMs }) {
    this.db = db;
    this.secretBox = secretBox;
    this.clock = clock;
    initializeRebindSchema(db);
    this.proxyPool = new RebindProxyStore({ db, secretBox, clock, proxyRefreshMs, transaction: (fn) => this.transaction(fn) });
    if (!db.prepare('PRAGMA table_info(rebind_jobs)').all().some((column) => column.name === 'proxy_id')) {
      db.exec('ALTER TABLE rebind_jobs ADD COLUMN proxy_id INTEGER REFERENCES rebind_proxy_pool(id)');
    }
  }

  proxyOverview(options) { return this.proxyPool.overview(options); }
  importProxies(values, options) { return this.proxyPool.importProxies(values, options); }

  beginLoginAttempt(jobId, proxyId, kind = 'login') {
    return this.transaction(() => {
      const job = this.getJob(jobId);
      if (!job || job.proxy_id !== proxyId || job.state !== 'running') throw new Error('invalid login attempt lease');
      const ordinal = Number(this.db.prepare('SELECT COALESCE(MAX(ordinal), 0) + 1 AS n FROM rebind_login_attempts WHERE job_id = ?').get(jobId).n);
      return this.db.prepare(`INSERT INTO rebind_login_attempts
        (job_id, ordinal, kind, proxy_id, state, started_at) VALUES (?, ?, ?, ?, 'running', ?) RETURNING *`)
        .get(jobId, ordinal, kind, proxyId, new Date(this.clock()).toISOString());
    });
  }

  finishLoginAttempt(id, { state, error } = {}) {
    const d = error?.diagnostic || {};
    return this.transaction(() => this.db.prepare(`UPDATE rebind_login_attempts SET state = ?, error_code = ?,
      error_category = ?, http_status = ?, curl_code = ?, finished_at = ? WHERE id = ? AND state = 'running'`)
      .run(state, error?.code || null, d.category || null, d.httpStatus || null, d.curlCode || null,
        new Date(this.clock()).toISOString(), id));
  }

  loginAttempts(jobId) { return this.db.prepare('SELECT * FROM rebind_login_attempts WHERE job_id = ? ORDER BY ordinal').all(jobId); }

  replaceProxy(jobId, previousProxyId) {
    return this.transaction(() => {
      this.proxyPool.finish(jobId, 'quarantined', previousProxyId);
      const next = this.proxyPool.reserve(jobId);
      this.db.prepare('UPDATE rebind_jobs SET proxy_id = ?, encrypted_proxy = ?, updated_at = ? WHERE id = ?')
        .run(next.id, next.encrypted_endpoint, new Date(this.clock()).toISOString(), jobId);
      return next;
    });
  }
  interrupt(id, { workerStarted = true, lastError = '操作未完成，远端结果待人工核查' } = {}) {
    return this.transaction(() => {
      const job = this.getJob(id);
      if (!job || ['completed', 'preparation_failed'].includes(job.state)) return job;
      if (!workerStarted && this.hasPreparationFailureEvidence(job)) return this.finishPreparationFailure(job);
      if (!job.encrypted_result) this.proxyPool.finish(id, workerStarted ? 'quarantined' : 'available', job.proxy_id);
      this.db.prepare('UPDATE rebind_jobs SET state = ?, last_error = ?, updated_at = ? WHERE id = ?')
        .run(job.encrypted_result ? 'cleanup_pending' : 'needs_review', lastError, new Date(this.clock()).toISOString(), id);
      this.event(id, job.encrypted_result ? 'cleanup_pending' : 'needs_review');
      return this.getJob(id);
    });
  }

  hasPreparationFailureEvidence(job, { requireFailedAlias = false } = {}) {
    if (!job || job.encrypted_result || !['', 'preparing', 'creating_alias'].includes(job.stage || '')) return false;
    const allowedEvents = new Set(['created', 'running', 'preparing', 'creating_alias', 'alias_claimed', 'needs_review']);
    if (this.listEvents(job.id).some((row) => !allowedEvents.has(row.event))) return false;
    const claims = this.db.prepare('SELECT * FROM rebind_alias_claims WHERE job_id = ?').all(job.id);
    if (claims.some((claim) => claim.alias_id !== job.alias_id || claim.owner !== 'rebind')) return false;
    if (!job.alias_id) return !requireFailedAlias && !job.new_email && !claims.length;
    const alias = this.db.prepare('SELECT * FROM aliases WHERE id = ?').get(job.alias_id);
    if (!alias || alias.state !== 'create_failed' || alias.mailbox_id !== job.mailbox_id
        || alias.email !== job.new_email || alias.token_hash || alias.exported_at || alias.first_accessed_at
        || alias.delivered_at || alias.deleted_at || claims.length !== 1) return false;
    const events = this.db.prepare('SELECT event, from_state, to_state FROM alias_events WHERE alias_id = ?').all(alias.id);
    return events.length > 0 && events.every((event) => event.event === 'create_failed'
      && event.from_state === 'creating' && event.to_state === 'create_failed');
  }

  finishPreparationFailure(job) {
    const now = new Date(this.clock()).toISOString();
    this.db.prepare('UPDATE rebind_alias_claims SET released_at = ? WHERE job_id = ? AND released_at IS NULL').run(now, job.id);
    this.proxyPool.finish(job.id, 'available', job.proxy_id);
    this.db.prepare(`UPDATE rebind_jobs SET state = 'preparation_failed', stage = 'preparation_failed',
      last_error = ?, updated_at = ? WHERE id = ?`).run(
      job.alias_id ? '准备失败：别名创建已确认失败，换绑执行器未启动；已释放占用与代理，原账号保持不变'
        : '准备失败：尚未创建别名或启动换绑执行器；已回收代理，原账号保持不变', now, job.id);
    this.event(job.id, 'preparation_failed');
    return this.getJob(job.id);
  }

  recoverPreparationFailure(jobId) {
    return this.transaction(() => {
      const job = this.getJob(jobId);
      if (job?.state !== 'needs_review' || !this.hasPreparationFailureEvidence(job, { requireFailedAlias: true })) {
        throw Object.assign(new Error('历史任务缺少确定的准备失败证据，保留人工核查状态'), { code: 'REBIND_RECOVERY_NOT_PROVEN' });
      }
      const proxy = this.db.prepare('SELECT status FROM rebind_proxy_pool WHERE job_id = ?').get(jobId);
      if (proxy && proxy.status !== 'reserved') throw Object.assign(new Error('代理状态存在执行痕迹，保留人工核查状态'),
        { code: 'REBIND_RECOVERY_NOT_PROVEN' });
      return this.finishPreparationFailure(job);
    });
  }

  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { if (this.db.isTransaction) this.db.exec('ROLLBACK'); throw error; }
  }

  getJob(id) { return this.db.prepare('SELECT * FROM rebind_jobs WHERE id = ?').get(id) || null; }
  listJobs() { return this.db.prepare('SELECT * FROM rebind_jobs ORDER BY created_at DESC, id').all(); }
  listEvents(id) { return this.db.prepare('SELECT * FROM rebind_events WHERE job_id = ? ORDER BY id').all(id); }
  listAccounts() {
    return this.db.prepare(`SELECT accounts.id, accounts.email, accounts.created_at, tasks.mailbox_category
      FROM qualified_accounts AS accounts JOIN registration_tasks AS tasks ON tasks.id = accounts.task_id
      ORDER BY accounts.created_at DESC`).all().map((row) => {
      const created = Date.parse(row.created_at);
      const valid = Number.isFinite(created);
      const active = this.db.prepare("SELECT id FROM rebind_jobs WHERE account_id = ? AND state NOT IN ('completed', 'preparation_failed')").get(row.id);
      const completed = this.db.prepare("SELECT id FROM rebind_jobs WHERE account_id = ? AND state = 'completed'").get(row.id);
      const history = rebindHistory(this.db, row.id);
      const verified = history.find((job) => job.verified);
      return { ...row, ...rebindMetadata(row, history), ...trialMetadata(this.db, row), verified: Boolean(verified),
        verified_job_id: verified?.job_id || null,
        eligible_at: valid ? new Date(created + COOLDOWN_MS).toISOString() : null,
        eligible: valid && this.clock() >= created + COOLDOWN_MS && !active && !completed,
        active_job_id: active?.id || null, completed_job_id: completed?.id || null };
    });
  }

  createJob({ accountId, mailboxId, proxy, idempotencyKey }) {
    if (proxy !== undefined) throw Object.assign(new Error('per-job proxy is unsupported; import the rebind proxy pool'), { code: 'REBIND_PROXY_OVERRIDE', statusCode: 400 });
    return this.transaction(() => {
      if (idempotencyKey) {
        const previous = this.db.prepare('SELECT * FROM rebind_jobs WHERE idempotency_key = ?').get(idempotencyKey);
        if (previous) {
          if (previous.account_id !== accountId || previous.mailbox_id !== mailboxId) throw new Error('idempotency key conflict');
          return previous;
        }
      }
      const account = this.listAccounts().find((row) => row.id === accountId);
      if (!account) throw new Error('qualified account not found');
      if (account.active_job_id) {
        const active = this.getJob(account.active_job_id);
        if (active.mailbox_id !== mailboxId) throw Object.assign(new Error('active job uses another mailbox'), { statusCode: 409 });
        return active;
      }
      if (!account.eligible) throw Object.assign(new Error('account is not eligible for manual rebind'), { code: 'REBIND_NOT_ELIGIBLE', statusCode: 409 });
      const mailbox = this.db.prepare('SELECT * FROM mailboxes WHERE id = ?').get(mailboxId);
      if (!mailbox) throw new Error('mailbox not found');
      if (mailbox.creation_blocked) throw Object.assign(new Error('该主邮箱已暂停创建别名，请选择其他主邮箱'),
        { code: 'MAILBOX_CREATION_BLOCKED', statusCode: 409 });
      const id = randomUUID();
      const now = new Date(this.clock()).toISOString();
      this.db.prepare(`INSERT INTO rebind_jobs
        (id, account_id, mailbox_id, original_email, state, encrypted_proxy, idempotency_key, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'queued', ?, ?, ?, ?)`).run(id, accountId, mailboxId, account.email,
        null, idempotencyKey || null, now, now);
      const allocated = this.proxyPool.reserve(id);
      this.db.prepare('UPDATE rebind_jobs SET proxy_id = ?, encrypted_proxy = ? WHERE id = ?')
        .run(allocated.id, allocated.encrypted_endpoint, id);
      const snapshot = this.db.prepare('SELECT * FROM qualified_accounts WHERE id = ?').get(accountId);
      this.db.prepare('UPDATE rebind_jobs SET encrypted_original_account = ? WHERE id = ?')
        .run(this.secretBox.seal(JSON.stringify(snapshot)), id);
      this.event(id, 'created');
      return this.getJob(id);
    });
  }

  event(id, event) {
    this.db.prepare('INSERT INTO rebind_events(job_id,event,created_at) VALUES (?,?,?)')
      .run(id, event, new Date(this.clock()).toISOString());
  }

  update(id, fields) {
    const allowed = ['state', 'stage', 'last_error', 'encrypted_result', 'last_error_code', 'failed_stage', 'error_category', 'http_status', 'curl_code'];
    const entries = Object.entries(fields).filter(([key]) => allowed.includes(key));
    return this.transaction(() => {
      this.db.prepare(`UPDATE rebind_jobs SET ${entries.map(([key]) => `${key} = ?`).join(', ')}, updated_at = ? WHERE id = ?`)
        .run(...entries.map(([, value]) => value), new Date(this.clock()).toISOString(), id);
      if (fields.state || fields.stage || fields.last_error !== undefined) this.event(id, fields.state || fields.stage || 'updated');
      return this.getJob(id);
    });
  }

  claimAlias(alias, { owner, jobId }) {
    return this.transaction(() => {
      const job = this.getJob(jobId);
      if (owner !== 'rebind' || !job || job.state !== 'running' || job.mailbox_id !== alias.mailbox_id) throw new Error('invalid alias claim');
      this.db.prepare('INSERT INTO rebind_alias_claims(alias_id,job_id,owner,created_at) VALUES (?,?,?,?)')
        .run(alias.id, jobId, owner, new Date(this.clock()).toISOString());
      this.db.prepare('UPDATE rebind_jobs SET alias_id = ?, new_email = ? WHERE id = ?').run(alias.id, alias.email, jobId);
      this.event(jobId, 'alias_claimed');
    });
  }

  complete(id) {
    return this.transaction(() => {
      const job = this.getJob(id);
      if (!job?.encrypted_result) throw new Error('verified result is required');
      const now = new Date(this.clock()).toISOString();
      this.db.prepare('UPDATE rebind_alias_claims SET released_at = ? WHERE job_id = ?').run(now, id);
      this.db.prepare("UPDATE rebind_jobs SET state = 'completed', last_error = '', updated_at = ? WHERE id = ?").run(now, id);
      this.event(id, 'completed');
    });
  }

  persistResult(id, result) {
    return this.transaction(() => {
      const job = this.getJob(id);
      if (job.state !== 'running') throw new Error('job is not running');
      this.writeResult(job, result);
    });
  }

  writeResult(job, result, { reconciled = false } = {}) {
      const id = job.id;
      const account = this.db.prepare('SELECT * FROM qualified_accounts WHERE id = ?').get(job.account_id);
      const currentResult = Object.fromEntries(['email', 'accountId', 'originalAccountId', 'password', 'totpSecret',
        'sessionToken', 'accessToken', 'mfaVerified'].map((key) => [key, result[key]]));
      const encrypted = this.secretBox.seal(JSON.stringify(currentResult));
      if (!job.encrypted_original_account) {
        this.db.prepare('UPDATE rebind_jobs SET encrypted_original_account = ? WHERE id = ?')
          .run(this.secretBox.seal(JSON.stringify(account)), id);
      }
      this.db.prepare(`UPDATE qualified_accounts SET email = ?, encrypted_password = ?, encrypted_totp_secret = ?,
        encrypted_session_json = ?, encrypted_result_json = ? WHERE id = ?`).run(result.email,
        reconciled ? account.encrypted_password : this.secretBox.seal(result.password), reconciled ? account.encrypted_totp_secret : this.secretBox.seal(result.totpSecret),
        this.secretBox.seal(JSON.stringify({ sessionToken: result.sessionToken, accessToken: result.accessToken })), encrypted, job.account_id);
      this.db.prepare("UPDATE rebind_jobs SET encrypted_result = ?, state = 'cleanup_pending', updated_at = ? WHERE id = ?")
        .run(encrypted, new Date(this.clock()).toISOString(), id);
      if (reconciled) this.event(id, 'remote_identity_reconciled');
      else this.proxyPool.finish(id, 'consumed', job.proxy_id);
      this.event(id, 'result_persisted');
  }

  recoverAfterRestart() {
    const interrupted = this.listJobs().filter((job) => ['queued', 'running'].includes(job.state));
    for (const job of interrupted) this.interrupt(job.id, { workerStarted: job.state === 'running', lastError: '进程中断，远端结果尚未确认；保留资源待人工核查' });
    return { jobs: interrupted.length };
  }
}

module.exports = { RebindStore, initializeRebindSchema, COOLDOWN_MS };
