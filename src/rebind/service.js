'use strict';

const { RegistrationStore } = require('../registration/store');
const { COOLDOWN_MS } = require('./store');
const { ALIAS_STATES } = require('../domain/state-machine');
const { TrialService } = require('./trial-service');
const { RecoveryService } = require('./recovery-service');
const { diagnostic, problem } = require('./recovery-store');

function publicJob(job) {
  if (!job) return null;
  const safe = Object.fromEntries(Object.entries(job).filter(([key]) => !key.startsWith('encrypted_')));
  return { ...safe, has_result: Boolean(job.encrypted_result), verified: Boolean(job.encrypted_result),
    cleanup_pending: Boolean(job.encrypted_result && job.state !== 'completed') };
}

class RebindService {
  constructor({ store, gatewayService, worker, secretBox, registrationStore, clock = Date.now,
    pollIntervalMs = 1000, codeTimeoutMs = 120000 }) {
    Object.assign(this, { store, gatewayService, worker, secretBox, clock, pollIntervalMs, codeTimeoutMs });
    this.registrationStore = registrationStore || new RegistrationStore({ db: store.db, secretBox, clock });
    this.trials = new TrialService({ store, registrationStore: this.registrationStore, worker, secretBox, clock });
    this.running = new Map();
    this.cleanups = new Map();
    this.closed = false;
    this.recovery = new RecoveryService({ parent: this });
  }

  listAccounts() { return this.store.listAccounts(); }
  listJobs() { return this.store.listJobs().map((job) => ({ ...publicJob(job), ...this.recovery.records.summary(job.id) })); }
  getJob(id) { const job = publicJob(this.store.getJob(id)); return job ? { ...job, ...this.recovery.records.summary(id), events: this.store.listEvents(id) } : null; }
  getReconciliation(id) {
    const job = this.getJob(id);
    if (!job) throw problem('JOB_NOT_FOUND', 404);
    return { job, recovery: this.recovery.records.summary(id) };
  }
  reconcile(id, { idempotencyKey } = {}) {
    this.recovery.start(id, { idempotencyKey });
    return this.getReconciliation(id);
  }
  recoverAfterRestart() {
    const newlyInterrupted = this.store.listJobs().filter((job) => {
      if (job.encrypted_result) return false;
      if (job.state === 'running') return ['verify','login_new','completed'].includes(job.stage);
      return job.state === 'needs_review' && job.encrypted_original_identity
        && ['verify','login_new','completed'].includes(job.failed_stage || job.stage)
        && this.recovery.records.rows(job.id).length === 0;
    }).map((job) => job.id);
    const trialChecks = this.trials.recoverAfterRestart();
    const result = this.store.recoverAfterRestart();
    const recoveryChecks = this.recovery.recoverAfterRestart();
    for (const id of newlyInterrupted) this.recovery.start(id, { automatic: true });
    for (const job of this.store.listJobs()) {
      if (job.encrypted_result && (job.state === 'cleanup_pending' || (job.encrypted_original_identity && !this.trials.latest(job.account_id)) || this.recovery.records.rows(job.id).some((row) => row.state === 'completed'))) {
        const operation = Promise.resolve().then(() => this.finishVerified(job.id));
        this.running.set(`resume:${job.id}`, operation);
        operation.finally(() => this.running.delete(`resume:${job.id}`)).catch(() => {});
      }
    }
    return { ...result, ...(trialChecks ? { trialChecks } : {}), ...(recoveryChecks ? { recoveryChecks } : {}) };
  }
  async finishVerified(id) {
    try { await this.retryCleanup(id); } catch {}
    if (!this.closed && typeof this.worker?.runTrial === 'function') {
      try { this.startTrialCheck({ accountId: this.store.getJob(id).account_id, automatic: true }); } catch {}
    }
  }
  startTrialCheck(options) { return this.trials.start(options); }
  getTrialCheck(accountId) { return this.trials.get(accountId); }
  proxyOverview(options) { return this.store.proxyOverview(options); }
  importProxies(values, options) { return this.store.importProxies(values, options); }

  createJob({ accountId, mailboxId, proxy, idempotencyKey } = {}) {
    if (this.closed) throw new Error('rebind service is closed');
    if (proxy !== undefined) throw Object.assign(new Error('per-job proxy is unsupported; import the rebind proxy pool'), { code: 'REBIND_PROXY_OVERRIDE', statusCode: 400 });
    if (!this.worker?.run) throw new Error('rebind worker is unavailable');
    const job = this.store.createJob({ accountId, mailboxId, idempotencyKey });
    if (job.state === 'queued' && !this.running.has(job.id)) {
      const operation = Promise.resolve().then(() => this.runJob(job.id));
      this.running.set(job.id, operation);
      operation.finally(() => this.running.delete(job.id)).catch(() => {});
    }
    return publicJob(job);
  }

  async waitForIdle() {
    while (this.running.size || this.cleanups.size || this.recovery.running.size) await Promise.all([...this.running.values(), ...this.cleanups.values(), ...this.recovery.running.values()]);
    await this.trials.waitForIdle();
  }
  async close() {
    this.closed = true;
    this.trials.closed = true;
    this.recovery.closed = true;
    await this.worker?.close?.();
    await this.waitForIdle();
  }

  async waitForCode(id, { issuedAfter, issued_after, timeoutMs = this.codeTimeoutMs, signal } = {}) {
    const baseline = issuedAfter ?? issued_after;
    const time = typeof baseline === 'number' ? baseline : Date.parse(baseline);
    const job = this.store.getJob(id);
    if (!Number.isFinite(time) || time < Date.parse(job.created_at)) throw new Error('fresh issuedAfter baseline is required');
    const timeout = Math.min(this.codeTimeoutMs, Math.max(1, Number(timeoutMs) || this.codeTimeoutMs));
    const deadline = Date.now() + timeout;
    do {
      if (signal?.aborted || this.closed) throw new Error('verification wait stopped');
      if (this.store.getJob(id).state !== 'running') throw new Error('job is no longer running');
      const code = await this.gatewayService.readInternalCode(job.alias_id, new Date(time).toISOString(), { jobId: id });
      if (code) return code;
      await new Promise((resolve) => setTimeout(resolve, Math.min(this.pollIntervalMs, timeout)));
    } while (Date.now() < deadline);
    throw new Error('verification code timeout');
  }

  retryCleanup(id) {
    if (this.cleanups.has(id)) return this.cleanups.get(id);
    const operation = this.cleanupOnce(id);
    this.cleanups.set(id, operation);
    operation.finally(() => this.cleanups.delete(id)).catch(() => {});
    return operation;
  }

  async cleanupOnce(id) {
    const job = this.store.getJob(id);
    if (!job) throw new Error('job not found');
    if (job.state === 'completed') return this.getJob(id);
    if (job.state !== 'cleanup_pending' || !job.encrypted_result) throw new Error('verified result is required for cleanup');
    const alias = this.gatewayService.store.getAlias(job.alias_id);
    if (alias?.state === ALIAS_STATES.DELETE_UNKNOWN) await this.gatewayService.reconcileAlias(alias.id);
    const released = await this.gatewayService.releaseAlias(job.alias_id, 'rebind_verified', { owner: 'rebind', jobId: id });
    if (released?.state === ALIAS_STATES.DELETED) this.store.complete(id);
    else this.store.update(id, { state: 'cleanup_pending', last_error: 'alias cleanup requires retry' });
    return this.getJob(id);
  }

  async runJob(id) {
    if (this.store.getJob(id)?.state !== 'queued') return;
    if (this.closed) {
      this.store.interrupt(id, { workerStarted: false, lastError: 'service stopped before execution' });
      return;
    }
    this.store.update(id, { state: 'running' });
    let workerStarted = false, callbackError, retryExhausted = false;
    try {
      let job = this.store.getJob(id);
      const credentials = this.registrationStore.getQualifiedAccount(job.account_id, { reveal: true });
      const createdAt = Date.parse(credentials?.createdAt);
      if (!Number.isFinite(createdAt) || this.clock() < createdAt + COOLDOWN_MS) throw new Error('cooldown has not elapsed');
      await this.gatewayService.ensureMailboxReady(job.mailbox_id);
      if (this.closed) throw new Error('service stopped before alias creation');
      const [created] = await this.gatewayService.createBatch(job.mailbox_id, 1, { owner: 'rebind', jobId: id });
      if (!created?.ok) throw new Error('alias creation requires review');
      job = this.store.getJob(id);
      if (this.closed) throw new Error('service stopped before worker execution');
      this.store.update(id, { stage: 'worker_started' });
      workerStarted = true;
      let result;
      let retryCount = this.store.loginAttempts(id).filter((attempt) => attempt.kind === 'login' && attempt.state === 'failed').length;
      while (!result) {
        job = this.store.getJob(id);
        const proxy = this.secretBox.open(job.encrypted_proxy);
        const attempt = this.store.beginLoginAttempt(id, job.proxy_id, 'login');
        try {
          if (typeof this.worker.preflight === 'function') {
            this.store.update(id, { stage: 'login_old' });
            const preflight = this.store.beginLoginAttempt(id, job.proxy_id, 'preflight');
            try {
              await this.worker.preflight({ proxy, timeoutMs: 10000 });
              this.store.finishLoginAttempt(preflight.id, { state: 'succeeded' });
            } catch (error) {
              this.store.finishLoginAttempt(preflight.id, { state: 'failed', error });
              throw error;
            }
          }
          result = await this.worker.run({
            credentials: { email: credentials.email, password: credentials.password, totpSecret: credentials.totpSecret },
            newEmail: job.new_email, proxy,
            waitForCode: (options) => { this.store.event(id, 'need_code'); return this.waitForCode(id, options); },
            onIdentity: (accountId) => {
              try { return this.recovery.records.checkpoint(id, accountId); }
              catch (error) { callbackError = error; throw error; }
            },
            onStage: (stage) => {
              if (this.store.getJob(id)?.state !== 'running') throw problem('RECOVERY_NOT_ELIGIBLE');
              const value = typeof stage === 'string' ? stage : stage?.stage;
              if (/^[a-z][a-z0-9_]{0,63}$/.test(value || '')) this.store.update(id, { stage: value });
            },
          });
          this.store.finishLoginAttempt(attempt.id, { state: 'succeeded' });
        } catch (error) {
          this.store.finishLoginAttempt(attempt.id, { state: 'failed', error });
          const current = this.store.getJob(id);
          const network = ['NETWORK_TLS', 'NETWORK_PROXY', 'NETWORK_TIMEOUT', 'NETWORK_FAILED'].includes(error?.code);
          const events = this.store.listEvents(id).map((event) => event.event);
          const eligible = network && current?.stage === 'login_old' && !current.encrypted_original_identity
            && !events.some((event) => ['begin', 'verify', 'need_code'].includes(event));
          if (!eligible || retryCount >= 2) { retryExhausted = eligible; throw error; }
          retryCount += 1;
          try { this.store.replaceProxy(id, current.proxy_id); }
          catch (replacementError) { retryExhausted = true; throw error; }
        }
      }
      if (!result || result.email?.toLowerCase() !== job.new_email.toLowerCase()
          || !result.accountId || String(result.accountId) !== String(result.originalAccountId)
          || result.mfaVerified !== true || result.password !== credentials.password
          || result.totpSecret !== credentials.totpSecret || !result.sessionToken || !result.accessToken) {
        throw problem('ACCOUNT_MISMATCH');
      }
      const checkpointJob = this.store.getJob(id);
      const knownId = checkpointJob.encrypted_original_identity ? this.recovery.records.identity(checkpointJob) : credentials.result?.accountId || credentials.result?.account_id;
      if (knownId && String(knownId) !== String(result.originalAccountId)) throw problem('ACCOUNT_MISMATCH');
      this.store.persistResult(id, result);
      await this.retryCleanup(id);
    } catch (error) {
      const job = this.store.getJob(id);
      this.store.update(id, { ...diagnostic(callbackError || error), failed_stage: job.stage });
      this.store.interrupt(id, { workerStarted,
        lastError: retryExhausted ? '代理连接失败：login_old 阶段所有代理均失败，未进入远端结果对账'
          : job.encrypted_result ? '换绑已验证，目标别名清理待重试'
            : workerStarted ? '换绑执行器已启动，远端结果待人工核查；原账号凭据尚未确认更新'
              : '准备阶段未完成，别名资源或远端结果尚未确认，保留占用待人工核查' });
      if (!this.closed && !retryExhausted) this.recovery.start(id, { automatic: true });
    } finally {
      if (typeof this.worker?.runTrial === 'function' && !this.closed) {
        const job = this.store.getJob(id);
        if (job?.encrypted_result) {
          try { this.startTrialCheck({ accountId: job.account_id, automatic: true }); } catch {}
        }
      }
    }
  }
}

module.exports = { RebindService, publicJob };
