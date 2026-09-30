'use strict';
const { randomUUID } = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');
const CODES = new Set(['INVALID_INPUT', 'INVALID_CODE', 'PROTOCOL_ERROR', 'NOT_ELIGIBLE', 'LOGIN_FAILED', 'LOGIN_INCOMPLETE', 'MFA_FAILED', 'MFA_INVALID_CODE', 'BEGIN_FAILED', 'VERIFY_FAILED', 'REAUTH_FAILED', 'RELOGIN_FAILED', 'ACCOUNT_MISMATCH', 'SESSION_EMAIL_MISMATCH', 'WORKER_TIMEOUT', 'WORKER_START_FAILED', 'ABORTED', 'NETWORK_TIMEOUT', 'NETWORK_TLS', 'NETWORK_PROXY', 'NETWORK_FAILED', 'RECOVERY_INTERRUPTED', 'RECOVERY_IDENTITY_MISSING', 'RECOVERY_IDENTITY_CONFLICT', 'RECOVERY_SNAPSHOT_CONFLICT', 'RECOVERY_NOT_ELIGIBLE', 'RECOVERY_WORKER_UNAVAILABLE', 'REBIND_PROXY_POOL_EXHAUSTED', 'RECOVERY_FAILED']);
for (const code of ['WORKER_PIPE_FAILED', 'STAGE_CALLBACK_FAILED', 'IDENTITY_CALLBACK_FAILED', 'CODE_WAIT_FAILED', 'INVALID_RESULT', 'WORKER_FAILED', 'OUTPUT_LIMIT', 'WORKER_EXIT_FAILED']) CODES.add(code);
const RETRY = new Set(['LOGIN_FAILED', 'LOGIN_INCOMPLETE', 'REAUTH_FAILED', 'RELOGIN_FAILED', 'WORKER_TIMEOUT', 'NETWORK_TIMEOUT', 'NETWORK_TLS', 'NETWORK_PROXY', 'NETWORK_FAILED', 'RECOVERY_INTERRUPTED']);
function retryable(attempt) {
  if (attempt.http_status === 429 || attempt.error_category === 'protocol') return false;
  return RETRY.has(attempt.error_code) || (attempt.error_code === 'MFA_FAILED' && ['timeout', 'tls', 'proxy'].includes(attempt.error_category));
}
function problem(code, statusCode = 409) { return Object.assign(new Error(code), { code, statusCode }); }
function diagnostic(error) {
  const d = error?.diagnostic;
  return { last_error_code: CODES.has(error?.code) ? error.code : 'RECOVERY_FAILED',
    error_category: ['timeout', 'tls', 'proxy', 'http', 'protocol', 'unknown'].includes(d?.category) ? d.category : 'unknown',
    http_status: Number.isInteger(d?.httpStatus) && d.httpStatus >= 100 && d.httpStatus <= 599 ? d.httpStatus : null,
    curl_code: Number.isInteger(d?.curlCode) && d.curlCode >= 1 && d.curlCode <= 99 ? d.curlCode : null };
}
function identitySources(result, session) {
  const values = [result?.accountId, result?.account_id, session?.account?.id];
  for (const token of [session?.accessToken, result?.accessToken]) {
    if (typeof token !== 'string' || token.split('.').length !== 3) continue;
    try { values.push(JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString())['https://api.openai.com/auth']?.chatgpt_account_id); } catch {}
  }
  if (values.some((v) => v !== undefined && v !== null && (typeof v !== 'string' || v.length > 200))) throw problem('RECOVERY_IDENTITY_CONFLICT');
  return values.filter((v) => typeof v === 'string' && v.trim()).map((v) => v.trim());
}
class RecoveryStore {
  constructor({ store }) {
    this.store = store; this.db = store.db; this.secretBox = store.secretBox;
    this.db.exec(`CREATE TABLE IF NOT EXISTS rebind_recovery_attempts (
      id TEXT PRIMARY KEY, job_id TEXT NOT NULL REFERENCES rebind_jobs(id), mode TEXT NOT NULL,
      state TEXT NOT NULL, idempotency_key TEXT UNIQUE, proxy_id INTEGER REFERENCES rebind_proxy_pool(id),
      encrypted_proxy TEXT, started_at TEXT, created_at TEXT NOT NULL, finished_at TEXT,
      error_code TEXT, error_category TEXT, http_status INTEGER, curl_code INTEGER);
      CREATE INDEX IF NOT EXISTS rebind_recovery_job ON rebind_recovery_attempts(job_id);
      CREATE UNIQUE INDEX IF NOT EXISTS rebind_recovery_active ON rebind_recovery_attempts(job_id)
        WHERE state IN ('queued','running');`);
    if (!this.db.prepare('PRAGMA table_info(rebind_recovery_attempts)').all().some((column) => column.name === 'encrypted_context')) this.db.exec('ALTER TABLE rebind_recovery_attempts ADD COLUMN encrypted_context TEXT');
  }
  now() { return new Date(this.store.clock()).toISOString(); }
  rows(id) { return this.db.prepare('SELECT * FROM rebind_recovery_attempts WHERE job_id = ? ORDER BY rowid').all(id); }
  row(id) { return this.db.prepare('SELECT * FROM rebind_recovery_attempts WHERE id = ?').get(id); }
  eligible(job) { return job?.state === 'needs_review' && !job.encrypted_result && ['verify', 'login_new', 'completed'].includes(job.failed_stage || job.stage); }
  summary(id) {
    const rows = this.rows(id), last = rows.at(-1), job = this.store.getJob(id);
    const active = rows.some((r) => ['queued','running'].includes(r.state));
    let reason = null;
    try { this.context(id); } catch (error) { reason = diagnostic(error).last_error_code; }
    if (['ACCOUNT_MISMATCH', 'SESSION_EMAIL_MISMATCH'].includes(last?.error_code)) reason = last.error_code;
    return { recovery_state: job?.encrypted_result && rows.length ? 'recovered' : active ? 'checking' : rows.length ? 'exhausted' : 'not_started',
      recovery_attempts: rows.filter((r) => r.started_at).length, recovery_max_auto_attempts: 2,
      recovery_error_code: last?.error_code || null, recovery_mode: last?.mode || null,
      recovery_error_category: last?.error_category || null,
      recovery_http_status: last?.http_status ?? null, recovery_curl_code: last?.curl_code ?? null,
      recovery_auto_attempts: rows.filter((r) => r.mode === 'automatic' && r.started_at).length,
      can_reconcile: !reason && !active, reconcile_block_reason: active ? 'RECOVERY_ACTIVE' : reason };
  }
  snapshot(job) {
    if (!job?.encrypted_original_account) throw problem('RECOVERY_IDENTITY_MISSING');
    let snapshot;
    try { snapshot = JSON.parse(this.secretBox.open(job.encrypted_original_account)); } catch { throw problem('RECOVERY_SNAPSHOT_CONFLICT'); }
    const current = this.db.prepare('SELECT * FROM qualified_accounts WHERE id = ?').get(job.account_id);
    if (!current || !isDeepStrictEqual({ ...current }, snapshot) || current.email !== job.original_email || snapshot.id !== job.account_id) throw problem('RECOVERY_SNAPSHOT_CONFLICT');
    return snapshot;
  }
  identity(job, checkpoint) {
    const snapshot = this.snapshot(job);
    let values;
    try {
      values = identitySources(JSON.parse(this.secretBox.open(snapshot.encrypted_result_json)), snapshot.encrypted_session_json ? JSON.parse(this.secretBox.open(snapshot.encrypted_session_json)) : null);
      if (job.encrypted_original_identity) values.push(JSON.parse(this.secretBox.open(job.encrypted_original_identity)).accountId);
    } catch { throw problem('RECOVERY_IDENTITY_CONFLICT'); }
    if (checkpoint !== undefined) {
      if (typeof checkpoint !== 'string' || !checkpoint.trim() || checkpoint.length > 200) throw problem('RECOVERY_IDENTITY_CONFLICT');
      values.push(checkpoint);
    }
    if (!values.length) throw problem('RECOVERY_IDENTITY_MISSING');
    if (values.some((v) => typeof v !== 'string' || !v.trim()) || new Set(values).size !== 1) throw problem('RECOVERY_IDENTITY_CONFLICT');
    return values[0];
  }
  checkpoint(id, accountId) {
    return this.store.transaction(() => {
      const job = this.store.getJob(id);
      if (job?.state !== 'running' || ['begin','verify','login_new','completed'].includes(job.stage)) throw problem('RECOVERY_NOT_ELIGIBLE');
      const identity = this.identity(job, accountId);
      this.db.prepare('UPDATE rebind_jobs SET encrypted_original_identity = ? WHERE id = ?').run(this.secretBox.seal(JSON.stringify({ accountId: identity })), id);
      this.store.event(id, 'original_identity_checkpoint');
    });
  }
  context(id) {
    const job = this.store.getJob(id);
    if (!this.eligible(job)) throw problem('RECOVERY_NOT_ELIGIBLE');
    const expectedAccountId = this.identity(job), snapshot = this.snapshot(job);
    const claim = this.db.prepare('SELECT * FROM rebind_alias_claims WHERE job_id = ?').get(id);
    const alias = this.db.prepare('SELECT * FROM aliases WHERE id = ?').get(job.alias_id);
    const other = this.db.prepare("SELECT id FROM rebind_jobs WHERE account_id = ? AND id != ? AND state NOT IN ('completed','preparation_failed')").get(job.account_id, id);
    if (!alias || alias.email !== job.new_email || alias.mailbox_id !== job.mailbox_id || alias.deleted_at
      || !['exported','active','delivered'].includes(alias.state) || !alias.token_hash
      || !claim || claim.alias_id !== alias.id || claim.owner !== 'rebind' || claim.released_at || other
      || this.db.prepare('SELECT id FROM qualified_accounts WHERE lower(email) = lower(?) AND id != ?').get(job.new_email, job.account_id)) throw problem('RECOVERY_SNAPSHOT_CONFLICT');
    return { job, alias: { ...alias }, claim: { ...claim }, expectedAccountId, credentials: { email: snapshot.email, password: this.secretBox.open(snapshot.encrypted_password), totpSecret: this.secretBox.open(snapshot.encrypted_totp_secret) } };
  }
  assertLease(attempt) {
    const lease = this.db.prepare('SELECT * FROM rebind_proxy_pool WHERE id = ?').get(attempt.proxy_id);
    if (!lease || lease.status !== 'reserved' || lease.job_id !== attempt.job_id || lease.encrypted_endpoint !== attempt.encrypted_proxy) throw problem('RECOVERY_SNAPSHOT_CONFLICT');
  }
  fail(id, error) {
    const d = diagnostic(error);
    this.db.prepare(`UPDATE rebind_recovery_attempts SET state = 'failed', finished_at = ?, error_code = ?, error_category = ?, http_status = ?, curl_code = ? WHERE id = ?`).run(this.now(), d.last_error_code, d.error_category, d.http_status, d.curl_code, id);
  }
  request(id, { automatic = false, idempotencyKey, workerAvailable = true } = {}) {
    return this.store.transaction(() => {
      const job = this.store.getJob(id);
      if (!job) throw problem('JOB_NOT_FOUND', 404);
      if (job.encrypted_result) return null;
      if (!automatic && (typeof idempotencyKey !== 'string' || !idempotencyKey.trim() || idempotencyKey.length > 200)) throw problem('INVALID_IDEMPOTENCY_KEY', 400);
      if (idempotencyKey) {
        const previous = this.db.prepare('SELECT * FROM rebind_recovery_attempts WHERE idempotency_key = ?').get(idempotencyKey);
        if (previous) { if (previous.job_id !== id) throw problem('IDEMPOTENCY_CONFLICT'); return previous; }
      }
      const rows = this.rows(id), active = rows.find((r) => ['queued','running'].includes(r.state));
      if (active) { if (!automatic && active.idempotency_key !== idempotencyKey) throw problem('RECOVERY_ACTIVE'); return active; }
      if (!this.eligible(job)) { if (automatic) return null; throw problem('RECOVERY_NOT_ELIGIBLE'); }
      if (automatic && (rows.filter((r) => r.mode === 'automatic' && r.started_at).length >= 2
        || rows.filter((r) => r.mode === 'automatic' && !r.started_at && r.error_code === 'RECOVERY_INTERRUPTED').length >= 2
        || (rows.length && (rows.at(-1).mode !== 'automatic' || !retryable(rows.at(-1)))))) return null;
      if (!automatic && ['ACCOUNT_MISMATCH', 'SESSION_EMAIL_MISMATCH'].includes(rows.at(-1)?.error_code)) throw problem(rows.at(-1).error_code);
      const attemptId = randomUUID();
      this.db.prepare(`INSERT INTO rebind_recovery_attempts(id,job_id,mode,state,idempotency_key,created_at) VALUES (?,?,?,'queued',?,?)`).run(attemptId, id, automatic ? 'automatic' : 'manual', idempotencyKey || null, this.now());
      try {
        if (automatic && ['ACCOUNT_MISMATCH', 'SESSION_EMAIL_MISMATCH', 'RECOVERY_IDENTITY_MISSING', 'RECOVERY_IDENTITY_CONFLICT', 'RECOVERY_SNAPSHOT_CONFLICT', 'INVALID_RESULT'].includes(job.last_error_code)) throw problem(job.last_error_code);
        this.context(id);
        if (!workerAvailable) throw problem('RECOVERY_WORKER_UNAVAILABLE');
        const proxy = this.store.proxyPool.reserve(id);
        this.db.prepare('UPDATE rebind_recovery_attempts SET proxy_id = ?, encrypted_proxy = ? WHERE id = ?').run(proxy.id, proxy.encrypted_endpoint, attemptId);
      } catch (error) { this.fail(attemptId, error); }
      return this.row(attemptId);
    });
  }
  persistReconciledResult(id, attemptId, result) {
    return this.store.transaction(() => {
      const context = this.context(id), { job, credentials, expectedAccountId } = context, attempt = this.row(attemptId);
      if (attempt?.job_id !== id || attempt.state !== 'running') throw problem('RECOVERY_NOT_ELIGIBLE');
      this.assertLease(attempt);
      if (!attempt.encrypted_context || !isDeepStrictEqual(JSON.parse(JSON.stringify(context)), JSON.parse(this.secretBox.open(attempt.encrypted_context)))) throw problem('RECOVERY_SNAPSHOT_CONFLICT');
      if (typeof result?.email !== 'string' || result.email.toLowerCase() !== job.new_email.toLowerCase()) throw problem('SESSION_EMAIL_MISMATCH');
      if (result.accountId !== expectedAccountId || result.originalAccountId !== expectedAccountId || result.mfaVerified !== true || result.password !== credentials.password || result.totpSecret !== credentials.totpSecret || typeof result.sessionToken !== 'string' || !result.sessionToken.trim() || typeof result.accessToken !== 'string' || !result.accessToken.trim()) throw problem('ACCOUNT_MISMATCH');
      if (identitySources(result, result.session).some((v) => v !== expectedAccountId)) throw problem('ACCOUNT_MISMATCH');
      if (result.session?.user?.email && result.session.user.email.toLowerCase() !== job.new_email.toLowerCase()) throw problem('SESSION_EMAIL_MISMATCH');
      this.store.writeResult(job, result, { reconciled: true });
      this.db.prepare("UPDATE rebind_recovery_attempts SET state = 'completed', finished_at = ? WHERE id = ?").run(this.now(), attemptId);
      this.store.proxyPool.finish(id, 'consumed', attempt.proxy_id);
    });
  }
}
module.exports = { RecoveryStore, diagnostic, problem, RETRY };
