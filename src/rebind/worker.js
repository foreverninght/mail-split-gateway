'use strict';

const { spawn } = require('node:child_process');
const path = require('node:path');
const { trialResult, trialSession, trialDiagnostic } = require('./trial-result');

const STAGES = new Set(['login_old', 'eligibility', 'begin', 'verify', 'login_new', 'completed']);
const CODES = new Set(['INVALID_INPUT', 'INVALID_CODE', 'PROTOCOL_ERROR', 'NOT_ELIGIBLE',
  'LOGIN_FAILED', 'LOGIN_INCOMPLETE', 'MFA_FAILED', 'MFA_INVALID_CODE', 'BEGIN_FAILED',
  'VERIFY_FAILED', 'REAUTH_FAILED', 'RELOGIN_FAILED', 'ACCOUNT_MISMATCH', 'SESSION_EMAIL_MISMATCH',
  'NETWORK_TIMEOUT', 'NETWORK_TLS', 'NETWORK_PROXY', 'NETWORK_FAILED']);

function diagnostic(value, trial = false) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  if (!['timeout', 'tls', 'proxy', 'http', 'protocol', 'unknown'].includes(value.category)) return undefined;
  const number = (v, min, max) => Number.isInteger(v) && v >= min && v <= max ? v : null;
  return { category: value.category, httpStatus: number(value.httpStatus, 100, 599), curlCode: number(value.curlCode, 1, 99),
    ...(trial ? trialDiagnostic(value) : {}) };
}

function failure(code) {
  return Object.assign(new Error(code), { code });
}

class RebindWorker {
  constructor({ pythonPath = 'python3', nodePath = process.execPath, timeoutMs = 300000,
    maxOutputBytes = 1024 * 1024, maxLineBytes = 256 * 1024, spawnImpl = spawn,
    scriptPath = path.resolve(__dirname, '../../python/rebind_worker/worker.py') } = {}) {
    Object.assign(this, { pythonPath, nodePath, timeoutMs, maxOutputBytes, maxLineBytes, spawnImpl, scriptPath });
    this.active = new Map();
  }

  async run({ credentials, newEmail, proxy, waitForCode, onStage, onIdentity, signal, timeoutMs = this.timeoutMs }) {
    return this.execute({ credentials, newEmail, proxy, waitForCode, onStage, onIdentity, signal, timeoutMs });
  }

  async runRecovery({ credentials, newEmail, expectedAccountId, proxy, onStage, signal, timeoutMs = this.timeoutMs }) {
    return this.execute({ credentials, newEmail, expectedAccountId, proxy, onStage, signal, timeoutMs, recovery: true });
  }

  async runTrial({ credentials, proxy, expectedAccountId, session, mfaPreviouslyVerified, onStage, signal, timeoutMs = this.timeoutMs }) {
    return this.execute({ credentials, proxy, expectedAccountId, session, mfaPreviouslyVerified, onStage, signal, timeoutMs, trial: true });
  }

  async execute({ credentials, newEmail, proxy, waitForCode, onStage, onIdentity, signal, timeoutMs, trial = false, recovery = false, expectedAccountId, session, mfaPreviouslyVerified }) {
    if (!credentials || ['email', 'password', 'totpSecret'].some((key) => typeof credentials[key] !== 'string' || !credentials[key].trim())
      || (!trial && (typeof newEmail !== 'string' || !newEmail.trim() || (!recovery && typeof waitForCode !== 'function')))
      || (recovery && (typeof expectedAccountId !== 'string' || !expectedAccountId.trim() || expectedAccountId.length > 200))
      || (onIdentity !== undefined && typeof onIdentity !== 'function')
      || (trial && (typeof expectedAccountId !== 'string' || !expectedAccountId.trim()))
      || typeof proxy !== 'string' || !proxy.trim() || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw failure('INVALID_INPUT');
    }
    if (signal?.aborted) throw failure('ABORTED');
    const requireIdentityCheckpoint = !trial && !recovery && typeof onIdentity === 'function';
    const request = JSON.stringify({ type: trial ? 'trial' : recovery ? 'recover' : 'run', credentials: {
      email: credentials.email, password: credentials.password, totpSecret: credentials.totpSecret,
    }, ...(trial ? { expectedAccountId, session: trialSession(session), mfaPreviouslyVerified: mfaPreviouslyVerified === true } : { newEmail }), ...(recovery ? { expectedAccountId } : {}),
    ...(requireIdentityCheckpoint ? { requireIdentityCheckpoint: true, requireStageAck: true } : {}), proxy }) + '\n';
    if (Buffer.byteLength(request) > 65536) throw failure('INVALID_INPUT');
    return new Promise((resolve, reject) => {
      const controller = new AbortController();
      let child, timer, killTimer, settled = false, stopping = false, closed = false;
      let buffer = '', bytes = 0, result, pendingError, codeRequested = false;
      let stageChain = Promise.resolve(), release;
      let identityReceived = false, identityAcknowledged = false, checkpointAccountId;
      const drain = () => { stageChain.then(finish); };
      const done = new Promise((resolveDone) => { release = resolveDone; });
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearTimeout(killTimer);
        signal?.removeEventListener('abort', abort);
        this.active.delete(stop);
        release();
        controller.abort();
        if (pendingError) reject(pendingError);
        else resolve(result);
      };
      const killTree = (force = false) => {
        if (!child?.pid) return;
        if (process.platform === 'win32') {
          const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
          killer.on('error', () => child.kill());
        } else {
          try { process.kill(-child.pid, force ? 'SIGKILL' : 'SIGTERM'); } catch { child.kill(force ? 'SIGKILL' : 'SIGTERM'); }
        }
      };
      const stop = (code = 'ABORTED', detail) => {
        if (settled || stopping) return;
        stopping = true;
        pendingError = failure(code);
        if (detail) pendingError.diagnostic = detail;
        controller.abort();
        if (!child || closed) return drain();
        child.stdin.destroy();
        killTree();
        killTimer = setTimeout(() => { killTree(true); drain(); }, 1000);
      };
      const abort = () => stop('ABORTED');
      this.active.set(stop, done);
      try {
        child = this.spawnImpl(this.pythonPath, ['-B', '-u', this.scriptPath], {
          stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, detached: process.platform !== 'win32',
          env: {
            ...Object.fromEntries(Object.entries(process.env).filter(([key]) =>
              /^(PATH|SYSTEMROOT|WINDIR|COMSPEC|PATHEXT|TEMP|TMP|TMPDIR|LANG|LC_ALL|LC_CTYPE)$/i.test(key))),
            PYTHONDONTWRITEBYTECODE: '1', PYTHONIOENCODING: 'utf-8',
            OPENAI_SENTINEL_NODE_PATH: this.nodePath,
          },
        });
      } catch { stop('WORKER_START_FAILED'); return; }
      const send = (value) => {
        if (stopping || settled) return;
        try { child.stdin.write(value); } catch { stop('WORKER_PIPE_FAILED'); }
      };
      const message = (value) => {
        if (!value || typeof value !== 'object' || Array.isArray(value) || result) return stop('PROTOCOL_ERROR');
        if (requireIdentityCheckpoint && !identityAcknowledged
          && ((value.type === 'stage' && value.stage !== 'login_old') || ['need_code', 'result'].includes(value.type))) return stop('PROTOCOL_ERROR');
        if (value.type === 'stage' && (trial ? ['session_trial', 'login_trial', 'trial_qualification'].includes(value.stage)
          : recovery ? value.stage === 'login_recovery' : STAGES.has(value.stage))) {
          stageChain = stageChain.then(async () => {
            await onStage?.(value.stage);
            if (requireIdentityCheckpoint) send(JSON.stringify({ type: 'stage_ack', stage: value.stage }) + '\n');
          }).catch(() => stop('STAGE_CALLBACK_FAILED'));
        } else if (value.type === 'identity' && requireIdentityCheckpoint && !identityReceived
          && typeof value.accountId === 'string' && value.accountId.trim() && value.accountId.length <= 200) {
          identityReceived = true;
          checkpointAccountId = value.accountId;
          stageChain = stageChain.then(async () => {
            if (stopping || settled || closed) return;
            await onIdentity(value.accountId);
            if (stopping || settled || closed) return;
            identityAcknowledged = true;
            send(JSON.stringify({ type: 'identity_ack' }) + '\n');
          }).catch(() => stop('IDENTITY_CALLBACK_FAILED'));
        } else if (!trial && !recovery && value.type === 'need_code' && !codeRequested && Number.isSafeInteger(value.issuedAfter) && value.issuedAfter > 0) {
          codeRequested = true;
          Promise.resolve().then(() => waitForCode({ issuedAfter: value.issuedAfter, signal: controller.signal }))
            .then((code) => {
              if (typeof code !== 'string' || !/^\d{4,10}$/.test(code)) return stop('INVALID_CODE');
              send(JSON.stringify({ type: 'code', code }) + '\n');
            }).catch(() => stop('CODE_WAIT_FAILED'));
        } else if (value.type === 'result') {
          const r = value.result;
          if (trial) {
            try { result = trialResult(r, credentials.email, expectedAccountId); }
            catch { return stop('INVALID_RESULT'); }
            child.stdin.end();
            return;
          }
          if (!r || ['email', 'accountId', 'originalAccountId', 'password', 'totpSecret', 'sessionToken', 'accessToken']
            .some((key) => typeof r[key] !== 'string' || !r[key].trim()) || r.mfaVerified !== true
            || r.accountId !== r.originalAccountId || r.email.trim().toLowerCase() !== newEmail.trim().toLowerCase()
            || r.password !== credentials.password || r.totpSecret !== credentials.totpSecret
            || (recovery ? r.accountId !== expectedAccountId || r.originalAccountId !== expectedAccountId : !codeRequested)
            || (requireIdentityCheckpoint && r.originalAccountId !== checkpointAccountId)) return stop('INVALID_RESULT');
          result = Object.fromEntries(['email', 'accountId', 'originalAccountId', 'password', 'totpSecret', 'sessionToken', 'accessToken', 'mfaVerified'].map((key) => [key, r[key]]));
          child.stdin.end();
        } else if (value.type === 'error') stop(CODES.has(value.code) || (trial && value.code === 'TRIAL_PROBE_FAILED') ? value.code : 'WORKER_FAILED', diagnostic(value.diagnostic, trial));
        else stop('PROTOCOL_ERROR');
      };
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk) => {
        if (stopping || settled) return;
        bytes += Buffer.byteLength(chunk);
        if (bytes > this.maxOutputBytes) return stop('OUTPUT_LIMIT');
        buffer += chunk;
        let index;
        while ((index = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, index);
          buffer = buffer.slice(index + 1);
          if (Buffer.byteLength(line) > this.maxLineBytes) return stop('OUTPUT_LIMIT');
          try { message(JSON.parse(line)); } catch { return stop('PROTOCOL_ERROR'); }
          if (stopping) return;
        }
        if (Buffer.byteLength(buffer) > this.maxLineBytes) stop('OUTPUT_LIMIT');
      });
      child.stderr.on('data', (chunk) => {
        bytes += chunk.length;
        if (bytes > this.maxOutputBytes) stop('OUTPUT_LIMIT');
      });
      child.stdin.on('error', () => stop('WORKER_PIPE_FAILED'));
      child.once('error', () => stop('WORKER_START_FAILED'));
      child.once('close', (code) => {
        closed = true;
        if (stopping && process.platform !== 'win32') killTree(true);
        if (!pendingError && (code !== 0 || !result || buffer.trim())) pendingError = failure('WORKER_EXIT_FAILED');
        drain();
      });
      timer = setTimeout(() => stop('WORKER_TIMEOUT'), timeoutMs);
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
      send(request);
    });
  }

  async close() {
    const entries = [...this.active.entries()];
    for (const [stop] of entries) stop('ABORTED');
    await Promise.all(entries.map(([, done]) => done));
  }
}

module.exports = { RebindWorker };
