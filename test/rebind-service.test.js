'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { GatewayStore } = require('../src/db/store');
const { GatewayService } = require('../src/services/gateway-service');
const { CleanupScheduler } = require('../src/services/cleanup-scheduler');
const { RegistrationStore } = require('../src/registration/store');
const { RegistrationService } = require('../src/registration/service');
const { createHttpServer } = require('../src/http/server');
const path = require('node:path');
const { RebindStore, COOLDOWN_MS } = require('../src/rebind/store');
const { RebindService } = require('../src/rebind/service');
const { SecretBox } = require('../src/security/secret-box');
const { RemoteOutcomeUnknownError } = require('../src/mailcom/adapter');


for (const interruption of ['graceful_close', 'catch_before_first_attempt']) {
  test(`restart recovers checkpointed needs-review without first recovery record after ${interruption}`, async (t) => {
    const f = await recoveryFixture(t);
    let reachedVerify, abortWorker;
    const atVerify = new Promise((resolve) => { reachedVerify = resolve; });
    if (interruption === 'graceful_close') {
      f.options.worker = async (input) => {
        await input.onIdentity('identity');
        await input.onStage('verify');
        return new Promise((_resolve, reject) => { abortWorker = reject; reachedVerify(); });
      };
      f.service.worker.close = async () => { abortWorker?.(Object.assign(new Error('stopped'), { code: 'ABORTED' })); };
    } else {
      f.service.recovery.start = () => null;
    }
    const job = f.create();
    if (interruption === 'graceful_close') { await atVerify; await f.service.close(); }
    else await f.service.waitForIdle();
    const interrupted = f.store.getJob(job.id);
    assert.equal(interrupted.state, 'needs_review');
    assert.equal(interrupted.failed_stage, 'verify');
    assert.equal(interrupted.last_error_code, interruption === 'graceful_close' ? 'ABORTED' : 'NETWORK_TIMEOUT');
    assert.ok(interrupted.encrypted_original_identity);
    assert.equal(f.service.recovery.records.rows(job.id).length, 0);
    assert.equal(f.recoveryCalls(), 0);
    assert.equal(f.registration.getQualifiedAccount('account').credential_ready, false);
    const restarted = new RebindService({ store: f.store, gatewayService: f.gateway, secretBox: f.secretBox,
      registrationStore: f.registration, worker: { ...f.service.worker, close: async () => {} }, clock: f.now });
    try {
      restarted.recoverAfterRestart();
      await restarted.waitForIdle();
      assert.equal(f.calls(), 1);
      assert.equal(f.recoveryCalls(), 1);
      assert.equal(restarted.getJob(job.id).state, 'completed');
      assert.equal(restarted.getJob(job.id).recovery_auto_attempts, 1);
      assert.equal(f.registration.getQualifiedAccount('account').credential_ready, true);
      assert.equal(f.store.db.prepare('SELECT status FROM rebind_proxy_pool WHERE id=?').get(interrupted.proxy_id).status, 'quarantined');
      restarted.recoverAfterRestart();
      await restarted.waitForIdle();
      assert.equal(f.recoveryCalls(), 1);
      assert.equal(restarted.recovery.records.rows(job.id).length, 1);
    } finally { await restarted.close(); }
  });
}

test('a queued interruption does not consume either of the two actual automatic probes', async (t) => {
  const f = await recoveryFixture(t, { poolSize: 1, recover: async (_input, count) => {
    if (count === 1) throw Object.assign(new Error('secret'), { code: 'NETWORK_PROXY' });
  } });
  const job = f.create();
  await f.service.waitForIdle();
  f.store.db.prepare('DELETE FROM rebind_recovery_attempts WHERE job_id=?').run(job.id);
  f.service.importProxies(Array.from({ length: 5 }, (_, i) => `http://127.0.0.1:${8080+i}`));
  f.service.recovery.records.request(job.id, { automatic: true });
  f.service.recoverAfterRestart();
  await f.service.waitForIdle();
  assert.equal(f.recoveryCalls(), 2);
  assert.equal(f.service.getJob(job.id).recovery_auto_attempts, 2);
  assert.equal(f.service.recovery.records.rows(job.id).length, 3);
  assert.equal(f.service.getJob(job.id).state, 'completed');
});


test('restart defers cleanup until synchronous startup completes and fills checkpointed completed trial gap only', async (t) => {
  const f = await recoveryFixture(t, { deleteError: new Error('offline') });
  const job = f.create();
  await f.service.waitForIdle();
  let synchronous = true, cleanups = 0;
  const cleanup = f.service.retryCleanup.bind(f.service);
  f.service.retryCleanup = async (id) => { assert.equal(synchronous, false); cleanups++; return cleanup(id); };
  f.service.recoverAfterRestart();
  assert.equal(cleanups, 0);
  synchronous = false;
  await f.service.waitForIdle();
  assert.equal(cleanups, 1);
  const g = await fixture(t, { worker: async (input) => {
    input.onIdentity('identity');
    input.onStage('completed');
    return { email: input.newEmail, accountId: 'identity', originalAccountId: 'identity', password: 'password', totpSecret: 'totp', sessionToken: 'session', accessToken: 'access', mfaVerified: true };
  } });
  g.service.importProxies(['http://127.0.0.1:8080','http://127.0.0.1:8081']);
  const completed = g.create();
  await g.service.waitForIdle();
  assert.equal(g.service.getJob(completed.id).state, 'completed');
  g.service.worker.runTrial = async (input) => trialResponse(input);
  g.service.recoverAfterRestart();
  await g.service.waitForIdle();
  assert.equal(g.service.getTrialCheck('account').status, 'eligible');
  g.service.recoverAfterRestart();
  await g.service.waitForIdle();
  assert.equal(g.store.db.prepare('SELECT COUNT(*) AS n FROM account_trial_checks').get().n, 1);
});


test('historical archived JWT identity is usable while absent and conflicting sources stop before login', async (t) => {
  for (const mode of ['jwt', 'missing', 'conflict']) {
    const f = await fixture(t, { worker: async ({ onStage }) => {
      onStage('verify');
      throw Object.assign(new Error('secret'), { code: 'NETWORK_TIMEOUT' });
    } });
    f.service.importProxies(['http://127.0.0.1:8080','http://127.0.0.1:8081']);
    const jwt = `header.${Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'identity' } })).toString('base64url')}.signature`;
    if (mode !== 'missing') f.store.db.prepare('UPDATE qualified_accounts SET encrypted_session_json=?,encrypted_result_json=?')
      .run(f.secretBox.seal(JSON.stringify({ accessToken: jwt })), f.secretBox.seal(JSON.stringify(mode === 'conflict' ? { accountId: 'other' } : {})));
    let calls = 0;
    f.service.worker.runRecovery = async (input) => {
      calls++;
      return { email: input.newEmail, accountId: 'identity', originalAccountId: 'identity', password: 'password', totpSecret: 'totp', sessionToken: 'session', accessToken: jwt, mfaVerified: true };
    };
    const job = f.create();
    await f.service.waitForIdle();
    assert.equal(calls, mode === 'jwt' ? 1 : 0);
    assert.equal(f.service.getJob(job.id).state, mode === 'jwt' ? 'completed' : 'needs_review');
    if (mode !== 'jwt') assert.equal(f.service.getJob(job.id).recovery_error_code, mode === 'missing' ? 'RECOVERY_IDENTITY_MISSING' : 'RECOVERY_IDENTITY_CONFLICT');
  }
});

test('recovered cleanup failure still schedules trial and never rolls result back', async (t) => {
  const f = await recoveryFixture(t, { deleteError: new Error('offline') });
  f.service.worker.runTrial = async (input) => trialResponse(input);
  const job = f.create();
  await f.service.waitForIdle();
  assert.equal(f.service.getJob(job.id).state, 'cleanup_pending');
  assert.equal(f.service.getJob(job.id).recovery_state, 'recovered');
  assert.equal(f.service.getTrialCheck('account').status, 'eligible');
  assert.equal(f.registration.getQualifiedAccount('account').credential_ready, true);
});

test('queued restart releases exact lease and bounded scheduling stops repeated crash replenishment', async (t) => {
  const f = await recoveryFixture(t, { poolSize: 1 });
  const job = f.create();
  await f.service.waitForIdle();
  f.store.db.prepare('DELETE FROM rebind_recovery_attempts WHERE job_id=?').run(job.id);
  f.service.importProxies(['http://127.0.0.1:8080','http://127.0.0.1:8081','http://127.0.0.1:8082']);
  const row = f.service.recovery.records.request(job.id, { automatic: true });
  f.service.recoverAfterRestart();
  assert.equal(f.store.db.prepare('SELECT status FROM rebind_proxy_pool WHERE id=?').get(row.proxy_id).status, 'available');
  f.service.recoverAfterRestart();
  await f.service.waitForIdle();
  assert.equal(f.recoveryCalls(), 0);
  assert.equal(f.service.recovery.records.rows(job.id).length, 2);
  f.service.recoverAfterRestart();
  await f.service.waitForIdle();
  assert.equal(f.service.recovery.records.rows(job.id).length, 2);
});


test('recovery restart quarantines only active lease and continues remaining budget once', async (t) => {
  const f = await recoveryFixture(t);
  const original = f.create();
  await f.service.waitForIdle();
  const db = f.store.db;
  const snapshot = JSON.parse(f.secretBox.open(f.store.getJob(original.id).encrypted_original_account));
  db.prepare('UPDATE qualified_accounts SET email=?,encrypted_password=?,encrypted_totp_secret=?,encrypted_session_json=?,encrypted_result_json=? WHERE id=?')
    .run(snapshot.email, snapshot.encrypted_password, snapshot.encrypted_totp_secret, snapshot.encrypted_session_json, snapshot.encrypted_result_json, snapshot.id);
  db.prepare("UPDATE rebind_jobs SET state='needs_review', encrypted_result=NULL WHERE id=?").run(original.id);
  db.prepare("UPDATE aliases SET state='exported', deleted_at=NULL WHERE id=?").run(f.store.getJob(original.id).alias_id);
  db.prepare('UPDATE rebind_alias_claims SET released_at=NULL WHERE job_id=?').run(original.id);
  db.prepare('DELETE FROM rebind_recovery_attempts WHERE job_id=?').run(original.id);
  const row = f.service.recovery.records.request(original.id, { automatic: true });
  db.prepare("UPDATE rebind_recovery_attempts SET state='running',started_at='2026-01-02' WHERE id=?").run(row.id);
  const other = f.store.transaction(() => f.store.proxyPool.reserve(original.id));
  const calls = f.recoveryCalls();
  f.service.recoverAfterRestart();
  await f.service.waitForIdle();
  assert.equal(f.recoveryCalls(), calls + 1);
  assert.equal(f.service.getJob(original.id).recovery_auto_attempts, 2);
  assert.equal(db.prepare('SELECT status FROM rebind_proxy_pool WHERE id=?').get(row.proxy_id).status, 'quarantined');
  assert.equal(db.prepare('SELECT status FROM rebind_proxy_pool WHERE id=?').get(other.id).status, 'reserved');
  f.service.recoverAfterRestart();
  await f.service.waitForIdle();
  assert.equal(f.recoveryCalls(), calls + 1);
});

test('checkpoint conflict blocks before mutation and archive drift stops recovery before login', async (t) => {
  const f = await fixture(t, { worker: async (input) => {
    await input.onIdentity('wrong');
    assert.fail('checkpoint should fail');
  } });
  f.store.db.prepare('UPDATE qualified_accounts SET encrypted_result_json=?').run(f.secretBox.seal(JSON.stringify({ accountId: 'identity' })));
  const job = f.create();
  await f.service.waitForIdle();
  assert.equal(f.service.getJob(job.id).last_error_code, 'RECOVERY_IDENTITY_CONFLICT');
  assert.equal(f.service.getJob(job.id).recovery_attempts, 0);
  const g = await recoveryFixture(t, { recover: async (_input, _count, current) => {
    current.store.db.prepare("UPDATE qualified_accounts SET trial_summary='changed'").run();
  } });
  const changed = g.create();
  await g.service.waitForIdle();
  assert.equal(g.recoveryCalls(), 1);
  assert.equal(g.service.getJob(changed.id).recovery_error_code, 'RECOVERY_SNAPSHOT_CONFLICT');
  assert.equal(g.service.getJob(changed.id).can_reconcile, false);
  assert.equal(g.store.getJob(changed.id).encrypted_result, null);
});

test('recovery diagnostics describe the latest probe and bounded retries respect transport classification and rate limiting', async (t) => {
  for (const [code, category, httpStatus, expectedCalls] of [
    ['MFA_FAILED', 'tls', null, 2], ['MFA_FAILED', 'timeout', null, 2], ['MFA_FAILED', 'proxy', null, 2],
    ['NETWORK_FAILED', 'proxy', 429, 1], ['MFA_FAILED', 'timeout', 429, 1],
    ['ACCOUNT_MISMATCH', 'tls', null, 1], ['RECOVERY_SNAPSHOT_CONFLICT', 'timeout', null, 1],
    ['PROTOCOL_ERROR', 'tls', null, 1], ['LOGIN_FAILED', 'protocol', null, 1],
  ]) {
    const f = await recoveryFixture(t, { recover: async () => {
      throw Object.assign(new Error('SECRET_MESSAGE'), { code, diagnostic: { category, httpStatus, curlCode: 35, body: 'SECRET_BODY' } });
    } });
    const job = f.create();
    await f.service.waitForIdle();
    assert.equal(f.recoveryCalls(), expectedCalls, `${code}/${category}/${httpStatus}`);
    const summary = f.service.getReconciliation(job.id).recovery;
    assert.equal(summary.recovery_error_code, code);
    assert.equal(summary.recovery_error_category, category);
    assert.equal(summary.recovery_http_status, httpStatus);
    assert.equal(summary.recovery_curl_code, 35);
    assert.equal(f.service.getJob(job.id).error_category, 'timeout');
    assert.equal(f.service.getJob(job.id).http_status, 503);
    assert.doesNotMatch(JSON.stringify(summary), /SECRET/);
  }
});

async function recoveryFixture(t, options = {}) {
  const f = await fixture(t, { ...options, worker: async (input) => {
    await input.onIdentity('identity');
    await input.onStage('verify');
    throw Object.assign(new Error('SECRET_BODY_TOKEN'), { code: 'NETWORK_TIMEOUT', diagnostic: { category: 'timeout', httpStatus: 503, curlCode: 28, token: 'SECRET' } });
  } });
  f.service.importProxies(Array.from({ length: options.poolSize || 6 }, (_, i) => `http://127.0.0.1:${8080 + i}`));
  let recoveryCalls = 0;
  f.service.worker.runRecovery = async (input) => {
    recoveryCalls++;
    assert.equal(input.credentials.email, 'old@example.com');
    assert.equal(input.expectedAccountId, 'identity');
    assert.equal(input.waitForCode, undefined);
    assert.ok(input.timeoutMs <= 180000);
    if (options.recover) await options.recover(input, recoveryCalls, f);
    return { email: input.newEmail, accountId: 'identity', originalAccountId: 'identity', password: 'password', totpSecret: 'totp', sessionToken: 'new-session', accessToken: 'new-access', mfaVerified: true };
  };
  return { ...f, recoveryCalls: () => recoveryCalls };
}

test('verify timeout reconciles once without replay, preserves archive and schedules trial after cleanup', async (t) => {
  const f = await recoveryFixture(t);
  f.service.worker.runTrial = async (input) => trialResponse(input);
  const job = f.create();
  const original = f.store.getJob(job.id).encrypted_original_account;
  await f.service.waitForIdle();
  assert.equal(f.calls(), 1);
  assert.equal(f.recoveryCalls(), 1);
  const final = f.service.getJob(job.id);
  assert.equal(final.state, 'completed');
  assert.equal(final.recovery_state, 'recovered');
  assert.equal(final.recovery_auto_attempts, 1);
  assert.equal(final.failed_stage, 'verify');
  assert.equal(final.last_error_code, 'NETWORK_TIMEOUT');
  assert.equal(final.http_status, 503);
  assert.equal(f.store.getJob(job.id).encrypted_original_account, original);
  assert.equal(f.registration.getQualifiedAccount('account').credential_ready, true);
  assert.equal(f.service.getTrialCheck('account').status, 'eligible');
  assert.equal(f.store.db.prepare('SELECT status FROM rebind_proxy_pool WHERE id = ?').get(f.store.getJob(job.id).proxy_id).status, 'quarantined');
  assert.doesNotMatch(JSON.stringify(final), /SECRET|encrypted_original_identity|new-session/);
  assert.ok(final.events.some((e) => e.event === 'remote_identity_reconciled'));
});

test('network recovery failure consumes one attempt then uses a fresh proxy', async (t) => {
  const proxies = [];
  const f = await recoveryFixture(t, { recover: async (input, count) => {
    proxies.push(input.proxy);
    if (count === 1) throw Object.assign(new Error('secret'), { code: 'NETWORK_TLS' });
  } });
  const job = f.create();
  await f.service.waitForIdle();
  assert.equal(f.recoveryCalls(), 2);
  assert.equal(new Set(proxies).size, 2);
  assert.equal(f.service.getJob(job.id).state, 'completed');
  assert.equal(f.service.getJob(job.id).recovery_auto_attempts, 2);
});

test('two failures keep credentials gated and explicit manual key permits only one additional probe', async (t) => {
  const f = await recoveryFixture(t, { recover: async (_input, count) => {
    if (count <= 2) throw Object.assign(new Error('secret'), { code: 'NETWORK_TIMEOUT' });
  } });
  const job = f.create();
  await f.service.waitForIdle();
  assert.equal(f.service.getJob(job.id).recovery_state, 'exhausted');
  assert.equal(f.registration.getQualifiedAccount('account').credential_ready, false);
  assert.equal(f.store.getJob(job.id).encrypted_result, null);
  f.service.reconcile(job.id, { idempotencyKey: 'manual-once' });
  f.service.reconcile(job.id, { idempotencyKey: 'manual-once' });
  assert.throws(() => f.service.reconcile(job.id, { idempotencyKey: 'other-key' }), { code: 'RECOVERY_ACTIVE' });
  await f.service.waitForIdle();
  f.service.reconcile(job.id, { idempotencyKey: 'manual-once' });
  await f.service.waitForIdle();
  assert.equal(f.recoveryCalls(), 3);
  assert.equal(f.service.getJob(job.id).recovery_attempts, 3);
  assert.equal(f.service.getJob(job.id).recovery_auto_attempts, 2);
  assert.equal(f.service.getJob(job.id).recovery_mode, 'manual');
});

test('identity mismatch stops automatic probes and never replaces account or releases alias', async (t) => {
  const f = await recoveryFixture(t, { recover: async () => { throw Object.assign(new Error('secret'), { code: 'ACCOUNT_MISMATCH' }); } });
  const before = { ...f.store.db.prepare('SELECT * FROM qualified_accounts').get() };
  const job = f.create();
  await f.service.waitForIdle();
  assert.equal(f.recoveryCalls(), 1);
  assert.equal(f.service.getJob(job.id).recovery_error_code, 'ACCOUNT_MISMATCH');
  assert.deepEqual({ ...f.store.db.prepare('SELECT * FROM qualified_accounts').get() }, before);
  assert.equal(f.gateway.isAliasClaimed(f.store.getJob(job.id).alias_id), true);
  f.service.recoverAfterRestart();
  await f.service.waitForIdle();
  assert.equal(f.recoveryCalls(), 1);
});

test('pool exhaustion records a non-started attempt without burning automatic budget or restart looping', async (t) => {
  const f = await recoveryFixture(t, { poolSize: 1 });
  const job = f.create();
  await f.service.waitForIdle();
  assert.equal(f.recoveryCalls(), 0);
  assert.equal(f.service.getJob(job.id).recovery_error_code, 'REBIND_PROXY_POOL_EXHAUSTED');
  assert.equal(f.service.getJob(job.id).recovery_auto_attempts, 0);
  f.service.recoverAfterRestart(); f.service.recoverAfterRestart();
  await f.service.waitForIdle();
  assert.equal(f.service.recovery.records.rows(job.id).length, 1);
});


test('legacy active index migrates and historical recovery remains credential-free', async (t) => {
  const f = await fixture(t, { createError: new Error('failed') });
  const job = f.store.createJob({ accountId: 'account', mailboxId: f.mailbox.id });
  f.store.update(job.id, { state: 'running' });
  await f.gateway.createBatch(f.mailbox.id, 1, { owner: 'rebind', jobId: job.id });
  f.store.update(job.id, { state: 'needs_review' });
  f.store.proxyPool.finish(job.id, 'available');
  f.store.db.exec(`DROP INDEX rebind_active_account;
    CREATE UNIQUE INDEX rebind_active_account ON rebind_jobs(account_id) WHERE state != 'completed';
    ALTER TABLE rebind_jobs DROP COLUMN encrypted_original_account;`);
  const migrated = new RebindStore({ db: f.store.db, clock: f.now, secretBox: {
    open() { throw new Error('must not read credentials'); },
    seal() { throw new Error('must not write credentials'); },
  } });
  assert.equal(migrated.recoverPreparationFailure(job.id).state, 'preparation_failed');
  assert.equal(migrated.listAccounts()[0].eligible, true);
  const next = f.store.createJob({ accountId: 'account', mailboxId: f.mailbox.id, idempotencyKey: 'next' });
  assert.notEqual(next.id, job.id);
  assert.equal(migrated.getJob(job.id).encrypted_original_account, null);
});


test('reconciled existing conflict succeeds while unknown conflict stays protected', async (t) => {
  const { MailComAdapter } = require('../src/mailcom/adapter');
  for (const outcome of ['exists', 'unknown']) {
    const f = await fixture(t);
    let address;
    const client = {
      async addAddress(_mailbox, email) {
        address = email;
        throw Object.assign(new Error('conflict'), { code: 'MAIL_COM_ALIAS_CREATE_CONFLICT' });
      },
      async listAddresses() {
        if (outcome === 'unknown') throw new Error('network');
        return [{ address }];
      },
    };
    const adapter = new MailComAdapter({ client });
    f.gateway.adapter.createAlias = adapter.createAlias.bind(adapter);
    const job = f.create();
    await f.service.waitForIdle();
    assert.equal(f.gatewayStore.getMailbox(f.mailbox.id).creation_blocked, 0);
    assert.equal(f.store.getJob(job.id).state, outcome === 'exists' ? 'completed' : 'needs_review');
    assert.equal(f.calls(), outcome === 'exists' ? 1 : 0);
    if (outcome === 'unknown') assert.equal(f.gateway.isAliasClaimed(f.store.getJob(job.id).alias_id), true);
  }
});


function trialResponse(input, status = 'eligible') {
  return { email: input.credentials.email, accountId: input.expectedAccountId, mfaVerified: true,
    status, campaignId: 'plus-1-month-free', amountMinor: status === 'error' ? null : 0,
    currency: status === 'error' ? null : 'USD', billingCountry: status === 'error' ? null : 'US',
    errorCode: status === 'error' ? 'TRIAL_PROBE_FAILED' : null, password: 'DO_NOT_EXPOSE' };
}

async function rebound(t, options = {}) {
  const f = await fixture(t, options);
  f.create();
  await f.service.waitForIdle();
  f.service.importProxies(['http://127.0.0.1:8080', 'http://127.0.0.1:8081', 'http://127.0.0.1:8082']);
  f.service.worker.runTrial = async (input) => trialResponse(input);
  return f;
}

test('post-rebind trial is independent, private and idempotent with one active check', async (t) => {
  const f = await rebound(t);
  const db = f.store.db;
  const accountBefore = { ...db.prepare('SELECT * FROM qualified_accounts').get() };
  const taskBefore = { ...db.prepare('SELECT * FROM registration_tasks').get() };
  const parentBefore = { ...db.prepare('SELECT * FROM rebind_jobs').get() };
  let calls = 0, release;
  f.service.worker.runTrial = async (input) => {
    calls++;
    assert.equal(input.credentials.email, accountBefore.email);
    assert.equal(input.expectedAccountId, 'identity');
    assert.equal(input.waitForCode, undefined);
    await new Promise((resolve) => { release = resolve; });
    return trialResponse(input);
  };
  const check = f.service.startTrialCheck({ accountId: 'account', idempotencyKey: 'first' });
  assert.equal(check.idempotency_key, 'first');
  assert.equal(check.state, 'queued');
  assert.equal(f.registration.getQualifiedAccount('account').post_rebind_trial_status, 'checking');
  assert.equal(f.service.startTrialCheck({ accountId: 'account', idempotencyKey: 'first' }).id, check.id);
  assert.equal(f.service.startTrialCheck({ accountId: 'account' }).id, check.id);
  assert.throws(() => f.service.startTrialCheck({ accountId: 'account', idempotencyKey: 'second' }), { code: 'TRIAL_CHECK_ACTIVE' });
  await new Promise(setImmediate);
  assert.equal(calls, 1);
  release();
  await f.service.waitForIdle();
  const result = f.service.getTrialCheck('account');
  assert.equal(result.status, 'eligible');
  assert.equal(result.state, 'completed');
  assert.equal(f.service.startTrialCheck({ accountId: 'account', idempotencyKey: 'first' }).id, check.id);
  assert.doesNotMatch(JSON.stringify(result), /encrypted_|password|totp|proxy|DO_NOT_EXPOSE/);
  assert.deepEqual({ ...db.prepare('SELECT * FROM qualified_accounts').get() }, accountBefore);
  assert.deepEqual({ ...db.prepare('SELECT * FROM registration_tasks').get() }, taskBefore);
  assert.deepEqual({ ...db.prepare('SELECT * FROM rebind_jobs').get() }, parentBefore);
  for (const account of [f.registration.getQualifiedAccount('account'), f.registration.listQualifiedAccounts()[0], f.service.listAccounts()[0]]) {
    assert.equal(account.post_rebind_trial_status, 'eligible');
    assert.equal(account.post_rebind_trial_amount_minor, 0);
    assert.equal(account.post_rebind_trial_currency, 'USD');
    assert.equal(account.post_rebind_trial_check_id, check.id);
    assert.doesNotMatch(JSON.stringify(account), /encrypted_|DO_NOT_EXPOSE/);
  }
  assert.equal(f.service.proxyOverview().stats.consumed, 2);
});

test('trial passes only current saved tokens and persists verified refresh without changing credentials or archives', async (t) => {
  const f = await rebound(t);
  const db = f.store.db;
  const stored = db.prepare('SELECT * FROM qualified_accounts').get();
  const priorResult = JSON.parse(f.secretBox.open(stored.encrypted_result_json));
  priorResult.retained = { private: 'retained-field' };
  db.prepare('UPDATE qualified_accounts SET encrypted_session_json = ?, encrypted_result_json = ?').run(
    f.secretBox.seal(JSON.stringify({ accessToken: 'access', sessionToken: 'session', email: 'OLD_IDENTITY', retained: 1 })),
    f.secretBox.seal(JSON.stringify(priorResult)));
  const before = { ...db.prepare('SELECT * FROM qualified_accounts').get() };
  const parent = { ...db.prepare('SELECT * FROM rebind_jobs').get() };
  f.service.worker.runTrial = async (input) => {
    assert.deepEqual(input.session, { accessToken: 'access', sessionToken: 'session' });
    assert.equal(input.mfaPreviouslyVerified, true);
    assert.doesNotMatch(JSON.stringify(input.credentials), /OLD_IDENTITY/);
    input.onStage('session_trial');
    assert.equal(f.service.getTrialCheck('account').stage, 'session_trial');
    return { ...trialResponse(input), session: { accessToken: 'fresh-access', sessionToken: 'fresh-session',
      email: 'OLD_IDENTITY', password: 'MUST_NOT_CHANGE' } };
  };
  f.service.startTrialCheck({ accountId: 'account' });
  await f.service.waitForIdle();
  const after = { ...db.prepare('SELECT * FROM qualified_accounts').get() };
  const { encrypted_session_json: oldSession, encrypted_result_json: oldResult } = before;
  assert.deepEqual({ ...after, encrypted_session_json: oldSession, encrypted_result_json: oldResult }, before);
  assert.deepEqual(JSON.parse(f.secretBox.open(after.encrypted_session_json)), {
    accessToken: 'fresh-access', sessionToken: 'fresh-session', email: 'OLD_IDENTITY', retained: 1 });
  assert.deepEqual(JSON.parse(f.secretBox.open(after.encrypted_result_json)), {
    ...priorResult, accessToken: 'fresh-access', sessionToken: 'fresh-session' });
  assert.deepEqual({ ...db.prepare('SELECT * FROM rebind_jobs').get() }, parent);
  assert.doesNotMatch(JSON.stringify([f.service.getTrialCheck('account'), f.registration.getQualifiedAccount('account')]),
    /fresh-access|fresh-session|OLD_IDENTITY|retained-field/);
});

for (const mode of ['session', 'session_rewrapped', 'email', 'identity', 'job', 'unverified', 'error', 'malformed']) {
  test(`trial refreshed session preserves current credentials for ${mode} guard`, async (t) => {
    const f = await rebound(t);
    const db = f.store.db;
    let expected;
    f.service.worker.runTrial = async (input) => {
      const row = db.prepare('SELECT * FROM qualified_accounts').get();
      if (mode === 'session') db.prepare('UPDATE qualified_accounts SET encrypted_session_json = ?')
        .run(f.secretBox.seal(JSON.stringify({ accessToken: 'concurrent-access', sessionToken: 'concurrent-session' })));
      if (mode === 'session_rewrapped') db.prepare('UPDATE qualified_accounts SET encrypted_session_json = ?')
        .run(f.secretBox.seal(f.secretBox.open(row.encrypted_session_json)));
      if (mode === 'email') db.prepare("UPDATE qualified_accounts SET email = 'changed@example.test'").run();
      if (mode === 'identity') db.prepare('UPDATE qualified_accounts SET encrypted_result_json = ?')
        .run(f.secretBox.seal(JSON.stringify({ ...JSON.parse(f.secretBox.open(row.encrypted_result_json)), accountId: 'changed' })));
      if (mode === 'job') db.prepare("UPDATE rebind_jobs SET state = 'needs_review'").run();
      expected = { ...db.prepare('SELECT * FROM qualified_accounts').get() };
      const result = { ...trialResponse(input, mode === 'error' ? 'error' : 'eligible'),
        session: { accessToken: 'fresh-access', sessionToken: 'fresh-session' } };
      if (mode === 'unverified') result.mfaVerified = false;
      if (mode === 'malformed') result.session.sessionToken = ' ';
      return result;
    };
    f.service.startTrialCheck({ accountId: 'account' });
    await f.service.waitForIdle();
    assert.deepEqual({ ...db.prepare('SELECT * FROM qualified_accounts').get() }, expected);
    assert.equal(f.service.getTrialCheck('account').state, 'failed');
  });
}

test('trial session refresh rolls back when qualification completion fails', async (t) => {
  const f = await rebound(t);
  const db = f.store.db;
  const before = { ...db.prepare('SELECT * FROM qualified_accounts').get() };
  db.exec(`CREATE TRIGGER reject_trial_completion BEFORE UPDATE ON account_trial_checks
    WHEN NEW.state = 'completed' BEGIN SELECT RAISE(ABORT, 'fixture completion failure'); END`);
  f.service.worker.runTrial = async (input) => ({ ...trialResponse(input),
    session: { accessToken: 'fresh-access', sessionToken: 'fresh-session' } });
  f.service.startTrialCheck({ accountId: 'account' });
  await f.service.waitForIdle();
  assert.deepEqual({ ...db.prepare('SELECT * FROM qualified_accounts').get() }, before);
  assert.equal(f.service.getTrialCheck('account').state, 'failed');
});

test('trial saved-session MFA attestation requires literal verified current result', async (t) => {
  for (const flag of [false, 'true', undefined]) {
    const f = await rebound(t);
    const row = f.store.db.prepare('SELECT encrypted_result_json FROM qualified_accounts').get();
    const result = { ...JSON.parse(f.secretBox.open(row.encrypted_result_json)), mfaVerified: flag };
    f.store.db.prepare('UPDATE qualified_accounts SET encrypted_result_json = ?').run(f.secretBox.seal(JSON.stringify(result)));
    let calls = 0;
    f.service.worker.runTrial = async (input) => {
      calls++;
      assert.equal(input.mfaPreviouslyVerified, false);
      return trialResponse(input);
    };
    f.service.startTrialCheck({ accountId: 'account' });
    await f.service.waitForIdle();
    assert.equal(calls, 1);
  }
});

test('trial login diagnostic whitelist persists on checks and attempts without changing HTTP stop rules', async (t) => {
  for (const [phase, reason, accepted] of [
    ['password_verify', 'LOGIN_CREDENTIALS_REJECTED', true],
    ['session', 'LOGIN_SESSION_MISSING', true],
    ['private-token', 'LOGIN_STEP_FAILED', false],
    ['mfa_verify', 'private-token', false],
    ['mfa_verify', undefined, false],
  ]) {
    const f = await rebound(t);
    let calls = 0;
    f.service.worker.runTrial = async () => {
      calls++;
      throw Object.assign(new Error('private-token'), { code: 'LOGIN_FAILED',
        diagnostic: { category: 'http', httpStatus: 429, phase, reason, message: 'private-token' } });
    };
    const check = f.service.startTrialCheck({ accountId: 'account' });
    await f.service.waitForIdle();
    const result = f.service.getTrialCheck('account');
    const attempt = f.service.trials.attempt(check.id);
    for (const row of [result, attempt]) {
      assert.equal(row.error_phase, accepted ? phase : null);
      assert.equal(row.error_reason, accepted ? reason : null);
      assert.equal(row.http_status, 429);
      assert.doesNotMatch(JSON.stringify(row), /private-token/);
    }
    assert.equal(calls, 1);
    const { TrialService } = require('../src/rebind/trial-service');
    const reloaded = new TrialService({ store: f.store, registrationStore: f.registration,
      worker: f.service.worker, secretBox: f.secretBox });
    assert.equal(reloaded.get('account').error_phase, result.error_phase);
  }
});

test('trial active uniqueness is enforced in SQLite and invalid idempotency keys fail early', async (t) => {
  const f = await rebound(t);
  const check = f.service.startTrialCheck({ accountId: 'account', idempotencyKey: 'first' });
  assert.throws(() => f.store.db.prepare(`INSERT INTO account_trial_checks
    (id,account_id,source_rebind_job_id,checked_email,state,created_at)
    VALUES ('another','account',?,'email','queued','now')`).run(check.source_rebind_job_id), /UNIQUE/);
  for (const key of [null, {}, '', 'a'.repeat(201)]) assert.throws(
    () => f.service.startTrialCheck({ accountId: 'account', idempotencyKey: key }), { code: 'INVALID_IDEMPOTENCY_KEY' });
  await f.service.waitForIdle();
});

test('trial rejects original, running and needs-review accounts without changing parent', async (t) => {
  const f = await fixture(t);
  assert.throws(() => f.service.startTrialCheck({ accountId: 'account' }), { code: 'TRIAL_ACCOUNT_NOT_READY' });
  const job = f.create();
  assert.throws(() => f.service.startTrialCheck({ accountId: 'account' }), { code: 'TRIAL_ACCOUNT_NOT_READY' });
  await f.service.waitForIdle();
  f.store.update(job.id, { state: 'needs_review' });
  assert.throws(() => f.service.startTrialCheck({ accountId: 'account' }), { code: 'TRIAL_ACCOUNT_NOT_READY' });
  assert.equal(f.service.getTrialCheck('account'), null);
  assert.throws(() => f.service.getTrialCheck('missing'), { statusCode: 404 });
});

for (const cleanupFails of [false, true]) {
  test(`automatic trial persists after rebind and cleanup failure=${cleanupFails}`, async (t) => {
    const f = await fixture(t, cleanupFails ? { deleteError: new Error('cleanup failed') } : {});
    f.service.importProxies(['http://127.0.0.1:8080', 'http://127.0.0.1:8081']);
    let calls = 0;
    f.service.worker.runTrial = async (input) => {
      calls++;
      assert.equal(f.registration.getQualifiedAccount('account').email, input.credentials.email);
      assert.ok(f.store.listJobs()[0].encrypted_result);
      return trialResponse(input, 'ineligible');
    };
    const job = f.create();
    await f.service.waitForIdle();
    assert.equal(calls, 1);
    assert.equal(f.store.getJob(job.id).state, cleanupFails ? 'cleanup_pending' : 'completed');
    assert.equal(f.service.getTrialCheck('account').status, 'ineligible');
    assert.equal(f.registration.getQualifiedAccount('account').trial_summary, 'eligible');
    f.service.startTrialCheck({ accountId: 'account', automatic: true });
    await f.service.waitForIdle();
    assert.equal(calls, 1);
  });
}

test('manual check during parent cleanup suppresses automatic replay', async (t) => {
  const f = await fixture(t);
  f.service.importProxies(['http://127.0.0.1:8080', 'http://127.0.0.1:8081']);
  let calls = 0;
  f.service.worker.runTrial = async (input) => { calls++; return trialResponse(input); };
  const cleanup = f.service.retryCleanup.bind(f.service);
  f.service.retryCleanup = async (id) => {
    f.service.startTrialCheck({ accountId: 'account', idempotencyKey: 'manual-first' });
    await f.service.trials.waitForIdle();
    return cleanup(id);
  };
  f.create();
  await f.service.waitForIdle();
  assert.equal(calls, 1);
  assert.equal(f.service.getTrialCheck('account').idempotency_key, 'manual-first');
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM account_trial_checks').get().n, 1);
});

test('automatic pool exhaustion and manual unavailable worker persist errors without hurting rebind', async (t) => {
  const f = await fixture(t);
  f.service.worker.runTrial = async () => { throw new Error('must not execute'); };
  const job = f.create();
  await f.service.waitForIdle();
  assert.equal(f.service.getTrialCheck('account').error_code, 'REBIND_PROXY_POOL_EXHAUSTED');
  assert.equal(f.store.getJob(job.id).state, 'completed');
  assert.equal(f.registration.getQualifiedAccount('account').email, f.store.getJob(job.id).new_email);
  delete f.service.worker.runTrial;
  const next = f.service.startTrialCheck({ accountId: 'account', idempotencyKey: 'unavailable' });
  assert.equal(next.error_code, 'TRIAL_WORKER_UNAVAILABLE');
  assert.equal(next.status, 'error');
});

test('trial network errors quarantine only its own lease and probe errors consume without ineligible', async (t) => {
  const f = await rebound(t);
  f.service.worker.runTrial = async () => { throw new Error('secret network details'); };
  const check = f.service.startTrialCheck({ accountId: 'account' });
  const other = f.store.transaction(() => f.store.proxyPool.reserve(check.source_rebind_job_id));
  await f.service.waitForIdle();
  assert.equal(f.service.getTrialCheck('account').status, 'error');
  assert.equal(f.service.getTrialCheck('account').error_code, 'TRIAL_PROBE_FAILED');
  assert.equal(f.store.db.prepare('SELECT status FROM rebind_proxy_pool WHERE id = ?').get(other.id).status, 'reserved');
  assert.equal(f.service.proxyOverview().stats.quarantined, 1);
  f.store.proxyPool.finish(check.source_rebind_job_id, 'available', other.id);
  f.service.worker.runTrial = async (input) => trialResponse(input, 'error');
  f.service.startTrialCheck({ accountId: 'account' });
  await f.service.waitForIdle();
  assert.equal(f.service.getTrialCheck('account').state, 'failed');
  assert.equal(f.service.getTrialCheck('account').status, 'error');
  assert.equal(f.service.proxyOverview().stats.consumed, 2);
});

test('trial preparation and process-start failure release proxy, stale results never become current', async (t) => {
  const f = await rebound(t);
  f.service.worker.runTrial = async () => { throw Object.assign(new Error('start failed'), { code: 'WORKER_START_FAILED' }); };
  f.service.startTrialCheck({ accountId: 'account' });
  await f.service.waitForIdle();
  assert.equal(f.service.proxyOverview().stats.available, 2);
  const queued = f.service.startTrialCheck({ accountId: 'account' });
  f.store.db.prepare('UPDATE account_trial_checks SET encrypted_proxy = ? WHERE id = ?').run('broken', queued.id);
  await f.service.waitForIdle();
  assert.equal(f.service.proxyOverview().stats.available, 2);
  f.service.worker.runTrial = async (input) => {
    f.store.db.prepare("UPDATE qualified_accounts SET email = 'changed@example.test'").run();
    return trialResponse(input);
  };
  f.service.startTrialCheck({ accountId: 'account' });
  await f.service.waitForIdle();
  assert.equal(f.service.getTrialCheck('account').error_code, 'TRIAL_STALE_RESULT');
  assert.equal(f.registration.getQualifiedAccount('account').post_rebind_trial_status, 'not_checked');
  assert.equal(f.store.listJobs()[0].state, 'completed');
});

test('restart interrupts queued and running checks without replay and respects exact leases', async (t) => {
  for (const state of ['queued', 'running']) {
    const f = await rebound(t);
    let calls = 0;
    f.service.worker.runTrial = async (input) => { calls++; return trialResponse(input); };
    const check = f.service.startTrialCheck({ accountId: 'account' });
    f.store.db.prepare('UPDATE account_trial_checks SET state = ? WHERE id = ?').run(state, check.id);
    const other = f.store.transaction(() => f.store.proxyPool.reserve(check.source_rebind_job_id));
    assert.equal(f.service.recoverAfterRestart().trialChecks, 1);
    await f.service.waitForIdle();
    assert.equal(calls, 0);
    assert.equal(f.service.getTrialCheck('account').error_code, 'TRIAL_INTERRUPTED');
    assert.equal(f.service.trials.attempt(check.id).state, 'interrupted');
    assert.ok(f.service.trials.attempt(check.id).finished_at);
    assert.equal(f.service.getTrialCheck('account').attempt_count, 0);
    assert.equal(f.service.proxyOverview().stats[state === 'queued' ? 'available' : 'quarantined'], 1);
    assert.equal(f.store.db.prepare('SELECT status FROM rebind_proxy_pool WHERE id = ?').get(other.id).status, 'reserved');
    assert.equal(f.service.recoverAfterRestart().trialChecks, undefined);
  }
});

test('trial metadata tolerates historical missing table', async (t) => {
  const f = await rebound(t);
  f.store.db.exec('DROP TABLE account_trial_checks');
  for (const account of [f.registration.getQualifiedAccount('account'), f.registration.listQualifiedAccounts()[0], f.store.listAccounts()[0]]) {
    assert.equal(account.post_rebind_trial_status, 'not_checked');
    assert.equal(account.post_rebind_trial_check_id, null);
  }
});

test('trial shutdown releases queued leases and waits for active worker cancellation', async (t) => {
  const queued = await rebound(t);
  queued.service.startTrialCheck({ accountId: 'account' });
  await queued.service.close();
  assert.equal(queued.service.getTrialCheck('account').error_code, 'TRIAL_INTERRUPTED');
  assert.equal(queued.service.proxyOverview().stats.available, 2);
  assert.throws(() => queued.service.startTrialCheck({ accountId: 'account' }), { code: 'TRIAL_SERVICE_CLOSED' });
  const f = await rebound(t);
  let rejectWorker, started;
  const reached = new Promise((resolve) => { started = resolve; });
  f.service.worker.runTrial = () => new Promise((_resolve, reject) => { rejectWorker = reject; started(); });
  f.service.worker.close = async () => { rejectWorker?.(Object.assign(new Error('stopped'), { code: 'ABORTED' })); };
  f.service.startTrialCheck({ accountId: 'account' });
  await reached;
  let idle = false;
  const waiting = f.service.waitForIdle().then(() => { idle = true; });
  await new Promise(setImmediate);
  assert.equal(idle, false);
  await f.service.close();
  await waiting;
  assert.equal(idle, true);
  assert.equal(f.service.getTrialCheck('account').error_code, 'TRIAL_INTERRUPTED');
  assert.equal(f.service.proxyOverview().stats.quarantined, 1);
});

test('trial preserves only allowlisted errors and verifies worker identity again at service boundary', async (t) => {
  for (const [mode, expected] of [['MFA_FAILED', 'MFA_FAILED'], ['WORKER_TIMEOUT', 'WORKER_TIMEOUT'],
    ['SECRET_CUSTOM_CODE', 'TRIAL_PROBE_FAILED'], ['identity', 'TRIAL_PROBE_FAILED']]) {
    const f = await rebound(t);
    f.service.worker.runTrial = async (input) => {
      if (mode === 'identity') return { ...trialResponse(input), accountId: 'other' };
      throw Object.assign(new Error('SECRET_MESSAGE'), { code: mode });
    };
    f.service.startTrialCheck({ accountId: 'account' });
    await f.service.waitForIdle();
    const check = f.service.getTrialCheck('account');
    assert.equal(check.error_code, expected);
    assert.equal(check.status, 'error');
    assert.doesNotMatch(JSON.stringify(check), /SECRET/);
    assert.equal(f.store.listJobs()[0].state, 'completed');
  }
});

test('trial TLS retry keeps check identity, credentials and exact attempt leases', async (t) => {
  const f = await rebound(t);
  const before = { ...f.store.db.prepare('SELECT * FROM qualified_accounts').get() };
  const inputs = [];
  f.service.worker.runTrial = async (input) => {
    inputs.push(input);
    assert.equal(input.timeoutMs, 180000);
    if (inputs.length === 1) throw Object.assign(new Error('SECRET_MESSAGE'), {
      code: 'NETWORK_TLS', diagnostic: { category: 'tls', curlCode: 35, body: 'SECRET_BODY' },
    });
    return trialResponse(input);
  };
  const check = f.service.startTrialCheck({ accountId: 'account', idempotencyKey: 'tls-same-check' });
  assert.equal(f.service.startTrialCheck({ accountId: 'account', idempotencyKey: 'tls-same-check' }).id, check.id);
  await f.service.waitForIdle();
  const result = f.service.getTrialCheck('account');
  assert.equal(result.id, check.id);
  assert.equal(result.state, 'completed');
  assert.equal(result.attempt_count, 2);
  assert.equal(result.max_attempts, 3);
  assert.equal(result.error_category, null);
  assert.equal(inputs.length, 2);
  assert.notEqual(inputs[0].proxy, inputs[1].proxy);
  assert.deepEqual(inputs[0].credentials, inputs[1].credentials);
  assert.deepEqual({ ...f.store.db.prepare('SELECT * FROM qualified_accounts').get() }, before);
  const attempts = f.store.db.prepare('SELECT * FROM account_trial_attempts WHERE check_id = ? ORDER BY attempt_number').all(check.id);
  assert.deepEqual(attempts.map((a) => a.state), ['failed', 'completed']);
  assert.equal(attempts[0].error_category, 'tls');
  assert.equal(attempts[0].curl_code, 35);
  assert.ok(attempts.every((a) => a.started_at && a.finished_at));
  assert.deepEqual(attempts.map((a) => f.store.db.prepare('SELECT status FROM rebind_proxy_pool WHERE id = ?').get(a.proxy_id).status), ['quarantined', 'consumed']);
  assert.doesNotMatch(JSON.stringify({ result, attempts }), /SECRET|encrypted_|password|totpSecret/);
  assert.equal(f.service.startTrialCheck({ accountId: 'account', idempotencyKey: 'tls-same-check' }).id, check.id);
  await f.service.waitForIdle();
  assert.equal(inputs.length, 2);
});

test('trial stops at three persistent executions and restart never refreshes budget', async (t) => {
  const f = await rebound(t);
  f.service.importProxies(Array.from({ length: 5 }, (_, i) => `http://127.0.0.2:${8100 + i}`));
  let calls = 0;
  f.service.worker.runTrial = async () => {
    calls++;
    throw Object.assign(new Error('SECRET'), { code: 'NETWORK_TIMEOUT', diagnostic: { category: 'timeout', curlCode: 28 } });
  };
  const check = f.service.startTrialCheck({ accountId: 'account', idempotencyKey: 'budget' });
  await f.service.waitForIdle();
  assert.equal(calls, 3);
  assert.equal(f.service.getTrialCheck('account').attempt_count, 3);
  assert.equal(f.service.getTrialCheck('account').error_code, 'NETWORK_TIMEOUT');
  assert.equal(f.service.proxyOverview().stats.quarantined, 3);
  assert.equal(f.service.proxyOverview().stats.available, 2);
  const { TrialService } = require('../src/rebind/trial-service');
  const restarted = new TrialService({ store: f.store, registrationStore: f.registration, worker: f.service.worker, secretBox: f.secretBox });
  assert.equal(restarted.recoverAfterRestart(), 0);
  assert.equal(restarted.start({ accountId: 'account', idempotencyKey: 'budget' }).id, check.id);
  await restarted.waitForIdle();
  assert.equal(calls, 3);
  assert.equal(restarted.get('account').attempt_count, 3);
});

test('trial transport classification stops HTTP, credential, identity and protocol failures', async (t) => {
  for (const [code, category, httpStatus, curlCode, expected] of [
    ['NETWORK_TLS', 'tls', 401, 35, 1], ['NETWORK_TLS', 'tls', 403, 35, 1],
    ['NETWORK_TIMEOUT', 'timeout', 429, 28, 1], ['NETWORK_TIMEOUT', 'timeout', 503, 28, 1],
    ['MFA_FAILED', 'timeout', null, 28, 1], ['LOGIN_FAILED', 'tls', null, 35, 1],
    ['ACCOUNT_MISMATCH', 'tls', null, 35, 1], ['SESSION_EMAIL_MISMATCH', 'tls', null, 35, 1],
    ['PROTOCOL_ERROR', 'protocol', null, 7, 1], ['WORKER_TIMEOUT', 'timeout', null, 28, 1],
    ['NETWORK_FAILED', 'unknown', null, null, 1], ['NETWORK_FAILED', 'http', null, 7, 1],
    ['NETWORK_FAILED', 'unknown', 429, 7, 1], ['NETWORK_FAILED', 'unknown', null, 7, 2],
  ]) {
    const f = await rebound(t);
    let calls = 0;
    f.service.worker.runTrial = async (input) => {
      if (++calls > 1) return trialResponse(input);
      throw Object.assign(new Error('SECRET'), { code, diagnostic: { category, httpStatus, curlCode, raw: 'SECRET' } });
    };
    f.service.startTrialCheck({ accountId: 'account' });
    await f.service.waitForIdle();
    const result = f.service.getTrialCheck('account');
    assert.equal(calls, expected, `${code}/${category}/${httpStatus}/${curlCode}`);
    assert.equal(result.attempt_count, expected);
    if (expected === 1) {
      assert.equal(result.error_category, category);
      assert.equal(result.http_status, httpStatus);
      assert.equal(result.curl_code, curlCode);
    }
    assert.doesNotMatch(JSON.stringify(result), /SECRET/);
  }
});

test('trial exhausted replacement pool preserves failed attempt diagnostic and quarantine', async (t) => {
  const f = await rebound(t);
  f.service.importProxies(['http://127.0.0.3:9000']);
  let calls = 0;
  f.service.worker.runTrial = async () => {
    calls++;
    throw Object.assign(new Error('SECRET'), { code: 'NETWORK_PROXY', diagnostic: { category: 'proxy', curlCode: 5 } });
  };
  const check = f.service.startTrialCheck({ accountId: 'account' });
  await f.service.waitForIdle();
  assert.equal(calls, 1);
  const result = f.service.getTrialCheck('account');
  assert.equal(result.error_code, 'REBIND_PROXY_POOL_EXHAUSTED');
  assert.equal(result.attempt_count, 1);
  const attempt = f.service.trials.attempt(check.id);
  assert.equal(attempt.error_code, 'NETWORK_PROXY');
  assert.equal(attempt.curl_code, 5);
  assert.equal(attempt.state, 'failed');
  assert.equal(f.service.proxyOverview().stats.quarantined, 1);
  assert.equal(f.service.proxyOverview().stats.reserved, 0);
});

test('trial close blocks replacement and restart interrupts running attempt without late consumption', async (t) => {
  for (const mode of ['close', 'restart']) {
    const f = await rebound(t);
    let rejectWorker, started, lateStage;
    const reached = new Promise((resolve) => { started = resolve; });
    let calls = 0;
    f.service.worker.runTrial = (input) => new Promise((_resolve, reject) => { calls++; lateStage = input.onStage; rejectWorker = reject; started(); });
    const check = f.service.startTrialCheck({ accountId: 'account', idempotencyKey: mode });
    await reached;
    let idle = false;
    const waiting = f.service.waitForIdle().then(() => { idle = true; });
    await new Promise(setImmediate);
    assert.equal(idle, false);
    if (mode === 'restart') {
      const { TrialService } = require('../src/rebind/trial-service');
      const restarted = new TrialService({ store: f.store, registrationStore: f.registration, worker: f.service.worker, secretBox: f.secretBox });
      assert.equal(restarted.recoverAfterRestart(), 1);
      assert.equal(restarted.recoverAfterRestart(), 0);
      assert.equal(restarted.start({ accountId: 'account', idempotencyKey: mode }).attempt_count, 1);
    } else {
      f.service.worker.close = async () => rejectWorker(Object.assign(new Error('SECRET'), { code: 'NETWORK_TLS' }));
      await f.service.close();
    }
    assert.throws(() => lateStage('trial_qualification'), { code: 'TRIAL_INTERRUPTED' });
    if (mode === 'restart') rejectWorker(Object.assign(new Error('SECRET'), { code: 'NETWORK_TLS' }));
    await waiting;
    assert.equal(calls, 1);
    assert.equal(f.service.getTrialCheck('account').error_code, 'TRIAL_INTERRUPTED');
    assert.equal(f.service.trials.attempt(check.id).state, 'interrupted');
    assert.equal(f.service.proxyOverview().stats.quarantined, 1);
    assert.equal(f.service.proxyOverview().stats.available, 1);
    assert.equal(f.service.proxyOverview().stats.reserved, 0);
  }
});

function registrationService(f) {
  return Object.assign(Object.create(RegistrationService.prototype), { store: f.registration });
}


test('confirmed create conflict blocks only creation and keeps original credentials usable', async (t) => {
  const f = await fixture(t, { createError: Object.assign(new Error('HTTP 409 urn:problem:mam:cats:request-conflict'),
    { code: 'MAIL_COM_ALIAS_CREATE_CONFLICT' }) });
  const before = { ...f.store.db.prepare('SELECT * FROM qualified_accounts').get() };
  const args = { accountId: 'account', mailboxId: f.mailbox.id, idempotencyKey: 'failed-key' };
  const job = f.service.createJob(args);
  await f.service.waitForIdle();
  assert.equal(f.store.getJob(job.id).state, 'preparation_failed');
  const mailbox = f.gateway.listMailboxes()[0];
  assert.equal(mailbox.creation_blocked, 1);
  assert.equal(mailbox.state, 'ready');
  assert.ok(mailbox.creation_blocked_at);
  assert.ok(mailbox.creation_blocked_reason);
  assert.deepEqual({ ...f.store.db.prepare('SELECT * FROM qualified_accounts').get() }, before);
  assert.equal(f.service.createJob(args).id, job.id);
  assert.throws(() => f.service.createJob({ ...args, idempotencyKey: 'new-key' }), { code: 'MAILBOX_CREATION_BLOCKED' });
  f.gateway.adapter.listAliases = async () => { throw new Error('unexpected remote call'); };
  await assert.rejects(f.gateway.createBatch(f.mailbox.id, 1), { code: 'MAILBOX_CREATION_BLOCKED' });
  assert.equal(f.store.listJobs().length, 1);
  assert.equal(f.service.proxyOverview().stats.available, 1);
  assert.equal(f.service.listAccounts()[0].eligible, true);
  const history = registrationService(f).getQualifiedAccountRebindHistory('account');
  assert.equal(history.account.rebind_status, 'original');
  assert.equal(history.account.credential_ready, true);
  assert.equal(history.account.mailbox_receiving, 'not_applicable');
  assert.equal(history.history[0].mailbox_receiving, 'not_applicable');
  assert.match(history.history[0].last_error, /准备失败/);
  assert.equal(history.account.email, before.email);
  assert.notEqual(history.history[0].target_email, before.email);
  assert.equal(registrationService(f).revealQualifiedAccount('account').password, 'password');
  assert.equal(f.calls(), 0);
});

test('preparation failure permits a new key but never replays the old key', async (t) => {
  const f = await fixture(t, { createError: new Error('validation address occupied') });
  const args = { accountId: 'account', mailboxId: f.mailbox.id, idempotencyKey: 'first' };
  const first = f.service.createJob(args);
  await f.service.waitForIdle();
  assert.equal(f.gatewayStore.getMailbox(f.mailbox.id).creation_blocked, 0);
  assert.equal(f.service.createJob(args).state, 'preparation_failed');
  f.options.createError = null;
  const second = f.service.createJob({ ...args, idempotencyKey: 'second' });
  assert.notEqual(second.id, first.id);
  await f.service.waitForIdle();
  assert.equal(f.service.getJob(second.id).state, 'completed');
  assert.equal(f.calls(), 1);
});

test('single historical preparation recovery validates evidence and preserves accounts', async (t) => {
  const f = await fixture(t, { createError: new Error('creation rejected') });
  const job = f.store.createJob({ accountId: 'account', mailboxId: f.mailbox.id });
  f.store.update(job.id, { state: 'running' });
  await f.gateway.createBatch(f.mailbox.id, 1, { owner: 'rebind', jobId: job.id });
  f.store.update(job.id, { state: 'needs_review' });
  const before = { ...f.store.db.prepare('SELECT * FROM qualified_accounts').get() };
  const aliasId = f.store.getJob(job.id).alias_id;
  for (const stage of ['worker_started', 'login', 'preparation_failed']) {
    f.store.db.prepare('UPDATE rebind_jobs SET stage = ? WHERE id = ?').run(stage, job.id);
    assert.throws(() => f.store.recoverPreparationFailure(job.id), { code: 'REBIND_RECOVERY_NOT_PROVEN' });
  }
  f.store.db.prepare("UPDATE rebind_jobs SET stage = '' WHERE id = ?").run(job.id);
  for (const state of ['create_unknown', 'creating', 'ready']) {
    f.store.db.prepare('UPDATE aliases SET state = ? WHERE id = ?').run(state, aliasId);
    assert.throws(() => f.store.recoverPreparationFailure(job.id), { code: 'REBIND_RECOVERY_NOT_PROVEN' });
  }
  f.store.db.prepare("UPDATE aliases SET state = 'create_failed' WHERE id = ?").run(aliasId);
  f.store.event(job.id, 'worker_started');
  assert.throws(() => f.store.recoverPreparationFailure(job.id), { code: 'REBIND_RECOVERY_NOT_PROVEN' });
  f.store.db.prepare("DELETE FROM rebind_events WHERE job_id = ? AND event = 'worker_started'").run(job.id);
  f.store.db.prepare("INSERT INTO alias_events(alias_id,event,from_state,to_state,created_at) VALUES (?,'create_confirmed','creating','ready','now')").run(aliasId);
  assert.throws(() => f.store.recoverPreparationFailure(job.id), { code: 'REBIND_RECOVERY_NOT_PROVEN' });
  f.store.db.prepare("DELETE FROM alias_events WHERE alias_id = ? AND event = 'create_confirmed'").run(aliasId);
  f.store.db.prepare("UPDATE rebind_jobs SET encrypted_result = 'result' WHERE id = ?").run(job.id);
  assert.throws(() => f.store.recoverPreparationFailure(job.id), { code: 'REBIND_RECOVERY_NOT_PROVEN' });
  f.store.db.prepare('UPDATE rebind_jobs SET encrypted_result = NULL WHERE id = ?').run(job.id);
  assert.equal(f.store.recoverPreparationFailure(job.id).state, 'preparation_failed');
  assert.equal(f.gateway.isAliasClaimed(aliasId), false);
  assert.equal(f.service.proxyOverview().stats.available, 1);
  assert.deepEqual({ ...f.store.db.prepare('SELECT * FROM qualified_accounts').get() }, before);
  assert.throws(() => f.store.recoverPreparationFailure(job.id), { code: 'REBIND_RECOVERY_NOT_PROVEN' });
  assert.throws(() => f.store.recoverPreparationFailure('missing'), { code: 'REBIND_RECOVERY_NOT_PROVEN' });
  assert.equal(f.calls(), 0);
});

async function historyRequest(t, f) {
  const server = createHttpServer({ service: f.gateway, store: f.gatewayStore,
    registrationService: registrationService(f), adminApiKey: 'test-key',
    publicDir: path.join(__dirname, '..', 'public'), logger: { error() {} } });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return (suffix, options = {}) => fetch(`http://127.0.0.1:${server.address().port}/api/admin/qualified-accounts/${suffix}`, options);
}

async function fixture(t, options = {}) {
  let now = Date.parse('2026-01-02T00:00:00Z');
  const clock = () => now;
  const gatewayStore = new GatewayStore({ filename: ':memory:', clock });
  const secretBox = new SecretBox(Buffer.alloc(32, 7).toString('base64'));
  const remote = [];
  let calls = 0;
  const adapter = {
    async open() {}, async listDomains() { return []; },
    async listAliases() { return remote.map((address) => ({ address })); },
    async createAlias(_mailbox, email) {
      const alias = gatewayStore.findAliasByMailboxEmail(mailbox.id, email);
      assert.equal(gateway.isAliasClaimed(alias.id), true);
      if (options.createError) throw options.createError;
      remote.push(email);
    },
    async deleteAlias(_mailbox, email) {
      const job = store.listJobs().find((entry) => entry.new_email === email);
      assert.ok(job.encrypted_result);
      if (options.deleteError) throw options.deleteError;
      remote.splice(remote.indexOf(email), 1);
    },
    async aliasExists(_mailbox, email) { return remote.includes(email); },
    async fetchInbox() { return options.messages || []; },
    async fetchMessageBody() { return { ok: false }; },
  };
  const gateway = new GatewayService({ store: gatewayStore, secretBox, adapter, clock,
    ...(options.realPoller ? {} : { poller: { async refresh() {} } }) });
  const mailbox = gateway.addMailbox({ email: 'main@example.com', password: 'mail-password' });
  await gateway.openMailbox(mailbox.id);
  gateway.importDomainCatalog([{ domain: 'example.com', state: 'HIDDEN', blacklisted: false }], 'test');
  const registration = new RegistrationStore({ db: gatewayStore.db, secretBox, clock });
  const originalAlias = gatewayStore.discoverAlias({ mailboxId: mailbox.id, email: 'old@example.com' });
  const batch = registration.createBatch(1);
  const task = registration.createTask({ batchId: batch.id, slot: 0, aliasId: originalAlias.id, email: originalAlias.email, webApi: 'test' });
  gatewayStore.db.prepare(`INSERT INTO qualified_accounts
    (id, task_id, email, encrypted_password, encrypted_totp_secret, encrypted_result_json, trial_summary, created_at)
    VALUES ('account', ?, ?, ?, ?, ?, 'eligible', ?)`).run(task.id, originalAlias.email,
    secretBox.seal('password'), secretBox.seal('totp'), secretBox.seal('{"trial_qualification":"observed_eligible"}'), new Date(now - COOLDOWN_MS).toISOString());
  const store = new RebindStore({ db: gatewayStore.db, secretBox, clock });
  const worker = { async run(input) {
    calls += 1;
    if (options.worker) return options.worker(input);
    if (options.fail) throw new Error('password secret must not leak');
    return { email: input.newEmail, accountId: 'identity', originalAccountId: 'identity', password: 'password',
      totpSecret: 'totp', sessionToken: 'session', accessToken: 'access', mfaVerified: true };
  } };
  const service = new RebindService({ store, gatewayService: gateway, secretBox, registrationStore: registration,
    worker, clock });
  service.importProxies(['http://127.0.0.1:8080']);
  t.after(async () => { await service.close(); gatewayStore.close(); });
  return { service, store, gateway, gatewayStore, mailbox, registration, secretBox, options,
    calls: () => calls, setNow: (value) => { now = value; }, now: () => now,
    create: () => service.createJob({ accountId: 'account', mailboxId: mailbox.id }) };
}

test('24h is an exact server-side eligibility boundary and creates no automatic jobs', async (t) => {
  const f = await fixture(t);
  f.setNow(f.now() - 1);
  assert.equal(f.service.listAccounts()[0].eligible, false);
  assert.throws(f.create, { code: 'REBIND_NOT_ELIGIBLE' });
  f.setNow(f.now() + 1);
  assert.equal(f.service.listAccounts()[0].eligible, true);
  assert.deepEqual(f.service.listJobs(), []);
  const job = f.create();
  assert.equal(f.create().id, job.id);
  await f.service.waitForIdle();
  assert.equal(f.calls(), 1);
  assert.equal(f.service.getJob(job.id).state, 'completed');
  assert.equal(f.service.listAccounts()[0].eligible, false);
  assert.throws(f.create, { code: 'REBIND_NOT_ELIGIBLE' });
});

test('verified result updates qualified account and is encrypted before alias release', async (t) => {
  const f = await fixture(t);
  const job = f.create();
  await f.service.waitForIdle();
  const result = f.service.getJob(job.id);
  assert.equal(result.state, 'completed');
  assert.equal(result.original_email, 'old@example.com');
  assert.equal(f.gateway.isAliasClaimed(result.alias_id), false);
  assert.equal(f.gatewayStore.getAlias(result.alias_id).state, 'deleted');
  const account = f.registration.getQualifiedAccount('account', { reveal: true });
  assert.equal(account.email, result.new_email);
  assert.equal(account.result.email, result.new_email);
  assert.equal(account.result.originalQualifiedResult, undefined);
  const snapshot = JSON.parse(f.secretBox.open(f.store.getJob(job.id).encrypted_original_account));
  assert.equal(snapshot.email, 'old@example.com');
  assert.equal(JSON.parse(f.secretBox.open(snapshot.encrypted_result_json)).trial_qualification, 'observed_eligible');
  assert.equal(result.encrypted_original_account, undefined);
  assert.equal(account.session.sessionToken, 'session');
  assert.equal(result.encrypted_result, undefined);
  assert.equal(result.encrypted_proxy, undefined);
  assert.equal(JSON.parse(f.secretBox.open(f.store.getJob(job.id).encrypted_result)).accessToken, 'access');
});

test('worker failure retains claim through manual release, bulk clear and cleanup', async (t) => {
  const f = await fixture(t, { fail: true });
  const job = f.create();
  await f.service.waitForIdle();
  const failed = f.service.getJob(job.id);
  assert.equal(failed.state, 'needs_review');
  assert.equal(f.gateway.isAliasClaimed(failed.alias_id), true);
  await assert.rejects(f.gateway.releaseAlias(failed.alias_id), { code: 'ALIAS_CLAIMED' });
  assert.equal((await f.gateway.clearRemoteAliases(f.mailbox.id)).deleted, 0);
  f.setNow(f.now() + COOLDOWN_MS);
  const scheduler = new CleanupScheduler({ store: f.gatewayStore, service: f.gateway, clock: f.now });
  assert.equal((await scheduler.sweep()).due, 0);
  assert.equal(f.create().id, job.id);
  await f.service.waitForIdle();
  assert.equal(f.calls(), 1);
  assert.doesNotMatch(failed.last_error, /password/);
});

test('cleanup-only retries never repeat a verified remote rebind', async (t) => {
  const f = await fixture(t, { deleteError: new Error('delete failed') });
  const job = f.create();
  await f.service.waitForIdle();
  assert.equal(f.service.getJob(job.id).state, 'cleanup_pending');
  assert.equal(f.gateway.isAliasClaimed(f.store.getJob(job.id).alias_id), true);
  assert.equal(f.service.recoverAfterRestart().jobs, 0);
  f.options.deleteError = null;
  await Promise.all([f.service.retryCleanup(job.id), f.service.retryCleanup(job.id)]);
  assert.equal(f.service.getJob(job.id).state, 'completed');
  assert.equal(f.calls(), 1);
});

test('unknown alias creation retains claim and never calls worker', async (t) => {
  const f = await fixture(t, { createError: new RemoteOutcomeUnknownError('uncertain') });
  const job = f.create();
  await f.service.waitForIdle();
  const failed = f.store.getJob(job.id);
  assert.equal(failed.state, 'needs_review');
  assert.equal(f.gatewayStore.getAlias(failed.alias_id).state, 'create_unknown');
  assert.equal(f.gateway.isAliasClaimed(failed.alias_id), true);
  assert.equal(f.calls(), 0);
});

test('recovery marks interrupted jobs for review without remote replay', async (t) => {
  const f = await fixture(t);
  const job = f.store.createJob({ accountId: 'account', mailboxId: f.mailbox.id });
  f.store.update(job.id, { state: 'running' });
  const [created] = await f.gateway.createBatch(f.mailbox.id, 1, { owner: 'rebind', jobId: job.id });
  assert.deepEqual(f.service.recoverAfterRestart(), { jobs: 1 });
  assert.equal(f.store.getJob(job.id).state, 'needs_review');
  assert.equal(f.gateway.isAliasClaimed(created.alias.id), true);
  assert.equal(f.create().id, job.id);
  await f.service.waitForIdle();
  assert.equal(f.calls(), 0);
});

test('internal OTP uses alias and issue baseline; public access cannot read claims', async (t) => {
  const f = await fixture(t);
  const job = f.store.createJob({ accountId: 'account', mailboxId: f.mailbox.id });
  f.store.update(job.id, { state: 'running' });
  const [created] = await f.gateway.createBatch(f.mailbox.id, 1, { owner: 'rebind', jobId: job.id });
  const aliasId = created.alias.id;
  const baseline = new Date(f.now()).toISOString();
  f.gatewayStore.recordOtp({ aliasId, remoteMessageId: 'old', code: '111111', receivedAt: new Date(f.now() - 1).toISOString() });
  assert.equal(await f.gateway.readInternalCode(aliasId, baseline, { jobId: job.id }), null);
  f.gatewayStore.recordOtp({ aliasId, remoteMessageId: 'fresh', code: '222222', receivedAt: baseline });
  assert.deepEqual(await f.gateway.accessPublicToken(created.token), { found: false, code: null });
  await assert.rejects(f.gateway.readInternalCode(aliasId, baseline, { jobId: 'other' }), /claim mismatch/);
  assert.equal(await f.gateway.readInternalCode(aliasId, baseline, { jobId: job.id }), '222222');
  assert.equal(await f.gateway.readInternalCode(aliasId, baseline, { jobId: job.id }), null);
  assert.equal(f.gatewayStore.latestOtp(aliasId).code, '222222');
  assert.equal(f.gatewayStore.getAlias(aliasId).state, 'active');
});

test('identity mismatch retains claim and original qualified account', async (t) => {
  const f = await fixture(t, { worker: async ({ newEmail }) => ({ email: newEmail,
    accountId: 'wrong', originalAccountId: 'original', password: 'password', totpSecret: 'totp',
    sessionToken: 'session', accessToken: 'access', mfaVerified: true }) });
  const job = f.create();
  await f.service.waitForIdle();
  assert.equal(f.service.getJob(job.id).state, 'needs_review');
  assert.equal(f.gateway.isAliasClaimed(f.store.getJob(job.id).alias_id), true);
  assert.equal(f.registration.getQualifiedAccount('account').email, 'old@example.com');
});

test('explicit proxy override is rejected; active account uniqueness and mailbox conflicts are enforced', async (t) => {
  const f = await fixture(t);
  assert.throws(() => f.service.createJob({ accountId: 'account', mailboxId: f.mailbox.id, proxy: 'host:8080' }), { code: 'REBIND_PROXY_OVERRIDE', statusCode: 400 });
  const job = f.store.createJob({ accountId: 'account', mailboxId: f.mailbox.id, idempotencyKey: 'request' });
  assert.equal(f.store.createJob({ accountId: 'account', mailboxId: f.mailbox.id, idempotencyKey: 'request' }).id, job.id);
  assert.throws(() => f.store.createJob({ accountId: 'account', mailboxId: 'other' }), /another mailbox/);
  assert.throws(() => f.gatewayStore.db.prepare(`INSERT INTO rebind_jobs
    (id,account_id,mailbox_id,state,created_at,updated_at) VALUES ('duplicate','account',?,'queued','now','now')`).run(f.mailbox.id), /UNIQUE/);
});

test('closing before queued execution marks preparation failure and performs no remote work', async (t) => {
  const f = await fixture(t);
  const job = f.create();
  await f.service.close();
  assert.equal(f.service.getJob(job.id).state, 'preparation_failed');
  assert.equal(f.store.getJob(job.id).alias_id, null);
  assert.equal(f.calls(), 0);
});

test('unknown delete can be reconciled and cleaned without replaying worker', async (t) => {
  const f = await fixture(t, { deleteError: new RemoteOutcomeUnknownError('uncertain') });
  const job = f.create();
  await f.service.waitForIdle();
  assert.equal(f.gatewayStore.getAlias(f.store.getJob(job.id).alias_id).state, 'delete_unknown');
  f.options.deleteError = null;
  await f.service.retryCleanup(job.id);
  assert.equal(f.service.getJob(job.id).state, 'completed');
  assert.equal(f.calls(), 1);
});

test('creation failure preserves claim and invalid account timestamps fail closed', async (t) => {
  const f = await fixture(t, { createError: new Error('creation rejected') });
  f.gatewayStore.db.prepare("UPDATE qualified_accounts SET created_at = 'invalid' WHERE id = 'account'").run();
  assert.equal(f.service.listAccounts()[0].eligible, false);
  assert.throws(f.create, { code: 'REBIND_NOT_ELIGIBLE' });
  f.gatewayStore.db.prepare('UPDATE qualified_accounts SET created_at = ? WHERE id = ?')
    .run(new Date(f.now() - COOLDOWN_MS).toISOString(), 'account');
  const job = f.create();
  await f.service.waitForIdle();
  const failed = f.store.getJob(job.id);
  assert.equal(failed.state, 'preparation_failed');
  assert.equal(f.gateway.isAliasClaimed(failed.alias_id), false);
  assert.equal(f.calls(), 0);
});

test('real poller activates claimed exported aliases and accepts fresh same-second mail', async (t) => {
  const f = await fixture(t, { realPoller: true });
  f.options.worker = async ({ newEmail, credentials, waitForCode }) => {
    const alias = f.gatewayStore.findAliasByMailboxEmail(f.mailbox.id, newEmail);
    assert.equal(alias.state, 'exported');
    assert.equal(f.gatewayStore.latestOtp(alias.id), null);
    f.setNow(f.now() + 1500);
    const issuedAfter = f.now();
    f.options.messages = [
      { id: 'older', to: [newEmail], sender: 'OpenAI <noreply@openai.com>',
        subject: 'Your ChatGPT verification code is 123456', receivedAt: new Date(issuedAfter - 1500).toISOString() },
      { id: 'other-alias', to: ['other@example.com'], sender: 'OpenAI <noreply@openai.com>',
        subject: 'Your ChatGPT verification code is 345678', receivedAt: new Date(issuedAfter).toISOString() },
      { id: 'fresh', to: [newEmail], sender: 'OpenAI <noreply@openai.com>',
        subject: 'Your ChatGPT verification code is 234567', receivedAt: new Date(Math.floor(issuedAfter / 1000) * 1000).toISOString() },
    ];
    assert.equal(await waitForCode({ issuedAfter, timeoutMs: 50 }), '234567');
    assert.equal(f.gatewayStore.getAlias(alias.id).state, 'active');
    assert.equal(f.gatewayStore.latestOtp(alias.id).delivered_count, 1);
    return { ...credentials, email: newEmail, accountId: 'identity', originalAccountId: 'identity',
      sessionToken: 'session', accessToken: 'access', mfaVerified: true };
  };
  const job = f.create();
  await f.service.waitForIdle();
  assert.equal(f.service.getJob(job.id).state, 'completed');
});

test('real poller retains second-precision mail in the alias creation second', async (t) => {
  const f = await fixture(t, { realPoller: true });
  f.setNow(f.now() + 450);
  const job = f.store.createJob({ accountId: 'account', mailboxId: f.mailbox.id });
  f.store.update(job.id, { state: 'running' });
  const [created] = await f.gateway.createBatch(f.mailbox.id, 1, { owner: 'rebind', jobId: job.id });
  assert.match(created.alias.created_at, /.450Z$/);
  f.setNow(f.now() + 100);
  const issuedAfter = new Date(f.now()).toISOString();
  const receivedAt = new Date(Math.floor(f.now() / 1000) * 1000).toISOString().replace('.000Z', 'Z');
  f.options.messages = [
    { id: 'same-second', to: [created.alias.email], sender: 'OpenAI <noreply@openai.com>',
      subject: 'Your ChatGPT verification code is 456789', receivedAt },
    { id: 'previous-second', to: [created.alias.email], sender: 'OpenAI <noreply@openai.com>',
      subject: 'Your ChatGPT verification code is 987654', receivedAt: new Date(Date.parse(receivedAt) - 1000).toISOString() },
  ];
  assert.equal(await f.gateway.readInternalCode(created.alias.id, issuedAfter, { jobId: job.id }), '456789');
  const rows = f.gatewayStore.db.prepare('SELECT remote_message_id FROM otp_messages WHERE alias_id = ?').all(created.alias.id);
  assert.deepEqual(rows.map((row) => row.remote_message_id), ['same-second']);
});

test('same-second OTP seen before the precise issue baseline remains excluded', async (t) => {
  const f = await fixture(t);
  const job = f.store.createJob({ accountId: 'account', mailboxId: f.mailbox.id });
  f.store.update(job.id, { state: 'running' });
  const [created] = await f.gateway.createBatch(f.mailbox.id, 1, { owner: 'rebind', jobId: job.id });
  const timestamp = new Date(f.now()).toISOString();
  f.gatewayStore.recordOtp({ aliasId: created.alias.id, remoteMessageId: 'previous', code: '111111', receivedAt: timestamp });
  f.setNow(f.now() + 500);
  const baseline = new Date(f.now()).toISOString();
  assert.equal(await f.gateway.readInternalCode(created.alias.id, baseline, { jobId: job.id }), null);
  f.gatewayStore.recordOtp({ aliasId: created.alias.id, remoteMessageId: 'new', code: '222222', receivedAt: timestamp });
  assert.equal(await f.gateway.readInternalCode(created.alias.id, baseline, { jobId: job.id }), '222222');
});



test('pool result consumption precedes cleanup and cleanup retries keep its timestamp', async (t) => {
  const f = await fixture(t, { deleteError: new Error('delete failed') });
  const job = f.create();
  await f.service.waitForIdle();
  const consumed = f.service.proxyOverview().proxies[0];
  assert.equal(consumed.status, 'consumed');
  assert.equal(consumed.job_id, job.id);
  f.setNow(f.now() + 1000);
  f.options.deleteError = null;
  await f.service.retryCleanup(job.id);
  await f.service.retryCleanup(job.id);
  assert.equal(f.service.proxyOverview().proxies[0].consumed_at, consumed.consumed_at);
  assert.equal(f.calls(), 1);
});

test('worker failures quarantine while pre-worker failures release only the proxy', async (t) => {
  const failed = await fixture(t, { fail: true });
  const job = failed.create();
  await failed.service.waitForIdle();
  assert.equal(failed.service.proxyOverview().stats.quarantined, 1);
  assert.equal(failed.gateway.isAliasClaimed(failed.store.getJob(job.id).alias_id), true);
  const preWorker = await fixture(t, { createError: new Error('alias failed') });
  const pending = preWorker.create();
  await preWorker.service.waitForIdle();
  assert.equal(preWorker.service.proxyOverview().stats.available, 1);
  assert.equal(preWorker.gateway.isAliasClaimed(preWorker.store.getJob(pending.id).alias_id), false);
  assert.equal(preWorker.calls(), 0);
});

test('replacement after reservation never changes the worker exit proxy', async (t) => {
  const f = await fixture(t, { worker: async (input) => {
    assert.equal(input.proxy, 'http://127.0.0.1:8080');
    return { ...input.credentials, email: input.newEmail, accountId: 'identity', originalAccountId: 'identity',
      sessionToken: 'session', accessToken: 'access', mfaVerified: true };
  } });
  const job = f.create();
  f.service.importProxies(['http://127.0.0.2:8080']);
  await f.service.waitForIdle();
  assert.equal(f.service.getJob(job.id).state, 'completed');
  const removed = f.store.db.prepare('SELECT status, active FROM rebind_proxy_pool WHERE id = ?').get(f.store.getJob(job.id).proxy_id);
  assert.equal(removed.active, 0);
  assert.equal(removed.status, 'consumed');
  assert.equal(f.service.proxyOverview().stats.available, 1);
});

test('account lifecycle separates verified credentials from cleanup and preserves encrypted full snapshot', async (t) => {
  const f = await fixture(t, { deleteError: new Error('delete failed') });
  f.store.db.prepare(`INSERT INTO ic_mailboxes
    (id, email, encrypted_upstream_url, pickup_hostname, adapter_key, token_hash, created_at, updated_at)
    VALUES ('ic-original', 'old@example.com', 'encrypted', 'example.com', 'test', 'hash', ?, ?)`)
    .run(new Date(f.now()).toISOString(), new Date(f.now()).toISOString());
  f.store.db.prepare("UPDATE registration_tasks SET mailbox_category = 'ic', alias_id = NULL, ic_mailbox_id = 'ic-original'").run();
  f.store.db.prepare('UPDATE qualified_accounts SET encrypted_session_json = ?').run(f.secretBox.seal('{"oldToken":"OLD_SESSION"}'));
  const before = { ...f.store.db.prepare('SELECT * FROM qualified_accounts').get() };
  const service = registrationService(f);
  const job = f.create();
  assert.equal(f.registration.getQualifiedAccount('account').rebind_status, 'rebinding');
  assert.throws(() => service.revealQualifiedAccount('account'), { statusCode: 409, code: 'ACCOUNT_CREDENTIALS_UNCONFIRMED' });
  await f.service.waitForIdle();
  const verifiedAt = new Date(f.now()).toISOString();
  const pending = service.revealQualifiedAccount('account');
  assert.equal(pending.rebind_status, 'rebound');
  assert.equal(pending.credential_ready, true);
  assert.equal(pending.cleanup_pending, true);
  assert.equal(pending.mailbox_receiving, 'protected');
  const aliasId = f.store.getJob(job.id).alias_id;
  const aliasState = f.store.db.prepare('SELECT state FROM aliases WHERE id = ?').get(aliasId).state;
  f.store.db.prepare("UPDATE aliases SET state = 'delete_unknown' WHERE id = ?").run(aliasId);
  assert.equal(service.getQualifiedAccountRebindHistory('account').account.mailbox_receiving, 'unknown');
  assert.equal(service.revealQualifiedAccount('account').credential_ready, true);
  f.store.db.prepare('UPDATE aliases SET state = ? WHERE id = ?').run(aliasState, aliasId);
  assert.equal(pending.mailbox_category, 'ic');
  assert.equal(pending.current_mailbox_category, 'mail');
  assert.equal(pending.session.sessionToken, 'session');
  assert.equal(pending.rebound_at, verifiedAt);
  f.store.event(job.id, 'completed');
  assert.equal(service.getQualifiedAccountRebindHistory('account').history[0].completed_at, null);
  assert.equal(pending.original_email, 'old@example.com');
  assert.equal(pending.last_rebind_job_id, job.id);
  assert.doesNotMatch(JSON.stringify(pending), /OLD_SESSION|originalQualifiedResult/);
  assert.deepEqual(JSON.parse(f.secretBox.open(f.store.getJob(job.id).encrypted_original_account)), before);
  assert.equal(f.registration.listQualifiedAccounts().length, 1);
  assert.equal(f.registration.listQualifiedAccounts()[0].id, 'account');
  assert.equal(f.service.listAccounts()[0].verified, true);
  assert.equal(f.service.listAccounts()[0].cleanup_pending, true);
  assert.equal(f.service.listAccounts()[0].completed_job_id, null);
  f.setNow(f.now() + 60000);
  f.options.deleteError = null;
  await f.service.retryCleanup(job.id);
  const { account, history } = service.getQualifiedAccountRebindHistory('account');
  assert.equal(account.rebound_at, verifiedAt);
  assert.equal(account.cleanup_pending, false);
  assert.equal(account.mailbox_receiving, 'released');
  assert.equal(history[0].verified_at, verifiedAt);
  assert.equal(history[0].completed_at, new Date(f.now()).toISOString());
  assert.equal(history[0].original_email, 'old@example.com');
  assert.equal(history[0].target_email, account.email);
  f.store.db.prepare("UPDATE registration_tasks SET state = 'released'").run();
  const task = f.registration.getTask(before.task_id);
  await service.collectTaskResult(task.batch_id, task, {}, null, null, () => { throw new Error('must not reveal old credentials'); });
  assert.equal(f.registration.listQualifiedAccounts().length, 1);
  assert.equal(f.registration.getQualifiedAccount('account').email, account.email);
  assert.doesNotMatch(JSON.stringify({ account, history, jobs: f.service.listJobs(), job: f.service.getJob(job.id) }),
    /encrypted_|OLD_SESSION|sessionToken|accessToken|totpSecret|originalQualifiedResult/);
});

test('failed and running attempts preserve current data and block only public credential reveal', async (t) => {
  const f = await fixture(t, { fail: true });
  const before = { ...f.store.db.prepare('SELECT * FROM qualified_accounts').get() };
  const job = f.create();
  await f.service.waitForIdle();
  assert.deepEqual({ ...f.store.db.prepare('SELECT * FROM qualified_accounts').get() }, before);
  const { account, history } = registrationService(f).getQualifiedAccountRebindHistory('account');
  assert.equal(account.rebind_status, 'needs_review');
  assert.equal(account.email, 'old@example.com');
  assert.notEqual(history[0].target_email, account.email);
  assert.equal(history[0].verified_at, null);
  assert.equal(account.rebound_at, null);
  assert.equal(account.credential_ready, false);
  assert.equal(account.cleanup_pending, false);
  assert.equal(f.registration.getQualifiedAccount('account', { reveal: true }).password, 'password');
  assert.throws(() => registrationService(f).revealQualifiedAccount('account'), { statusCode: 409, code: 'ACCOUNT_CREDENTIALS_UNCONFIRMED' });
  assert.equal(f.store.getJob(job.id).encrypted_result, null);
  assert.equal(f.service.listAccounts()[0].verified, false);
});

test('history and reveal HTTP use admin authentication even when rebind service is disabled', async (t) => {
  const f = await fixture(t, { fail: true });
  const request = await historyRequest(t, f);
  const headers = { 'x-api-key': 'test-key' };
  assert.equal((await request('account/rebind-history')).status, 401);
  assert.equal((await request('missing/rebind-history', { headers })).status, 404);
  const original = await (await request('account/rebind-history', { headers })).json();
  assert.deepEqual(original.history, []);
  assert.equal(original.account.rebind_status, 'original');
  f.create();
  await f.service.waitForIdle();
  const blocked = await request('account/reveal', { method: 'POST', headers });
  assert.equal(blocked.status, 409);
  assert.equal((await blocked.json()).error, 'ACCOUNT_CREDENTIALS_UNCONFIRMED');
  const history = await (await request('account/rebind-history', { headers })).json();
  assert.equal(history.history.length, 1);
  assert.equal(history.account.email, 'old@example.com');
  assert.doesNotMatch(JSON.stringify(history), /encrypted_|sessionToken|accessToken|password|totpSecret/);
  f.store.db.exec('PRAGMA foreign_keys = OFF; DROP TABLE rebind_alias_claims; DROP TABLE rebind_events; DROP TABLE rebind_proxy_pool; DROP TABLE rebind_jobs; PRAGMA foreign_keys = ON;');
  const legacy = await (await request('account/rebind-history', { headers })).json();
  assert.deepEqual(legacy.history, []);
  assert.equal(legacy.account.rebind_status, 'original');
  assert.equal((await request('account/reveal', { method: 'POST', headers })).status, 200);
});

test('history includes every attempt in descending order and ignores unverified completed labels', async (t) => {
  const f = await fixture(t);
  f.store.db.prepare(`INSERT INTO rebind_jobs
    (id, account_id, mailbox_id, state, original_email, new_email, created_at, updated_at)
    VALUES ('old-attempt', 'account', ?, 'completed', 'old@example.com', 'attempt@example.com', ?, ?)`)
    .run(f.mailbox.id, new Date(f.now() - 1000).toISOString(), new Date(f.now()).toISOString());
  f.store.db.prepare(`INSERT INTO rebind_jobs
    (id, account_id, mailbox_id, state, original_email, new_email, created_at, updated_at)
    VALUES ('new-attempt', 'account', ?, 'needs_review', 'old@example.com', 'attempt2@example.com', ?, ?)`)
    .run(f.mailbox.id, new Date(f.now()).toISOString(), new Date(f.now()).toISOString());
  const { account, history } = registrationService(f).getQualifiedAccountRebindHistory('account');
  assert.deepEqual(history.map((row) => row.job_id), ['new-attempt', 'old-attempt']);
  assert.equal(account.rebind_status, 'needs_review');
  assert.equal(account.current_mailbox_category, 'mail');
  assert.equal(account.mailbox_receiving, 'unknown');
  assert.equal(account.rebound_at, null);
  assert.ok(history.every((row) => row.verified_at === null));
});

test('legacy embedded original result is omitted from current revealed credentials without rewriting storage', async (t) => {
  const f = await fixture(t);
  const raw = f.secretBox.seal(JSON.stringify({ accountId: 'identity', originalQualifiedResult: { session: 'OLD_SESSION' } }));
  f.store.db.prepare('UPDATE qualified_accounts SET encrypted_result_json = ?').run(raw);
  assert.deepEqual(registrationService(f).revealQualifiedAccount('account').result, { accountId: 'identity' });
  assert.equal(f.store.db.prepare('SELECT encrypted_result_json FROM qualified_accounts').get().encrypted_result_json, raw);
});

test('closing before execution releases reservation without creating alias', async (t) => {
  const f = await fixture(t);
  const job = f.create();
  await f.service.close();
  assert.equal(f.service.proxyOverview().stats.available, 1);
  assert.equal(f.store.getJob(job.id).alias_id, null);
  assert.equal(f.calls(), 0);
});


test('preflight HTTP 403 is recorded but does not block login worker', async (t) => {
  const f = await fixture(t);
  let preflights = 0;
  f.service.worker.preflight = async () => { preflights += 1; return { status: 403 }; };
  const job = f.create();
  await f.service.waitForIdle();
  assert.equal(f.service.getJob(job.id).state, 'completed');
  assert.equal(preflights, 1);
  assert.equal(f.calls(), 1);
  assert.equal(f.store.db.prepare("SELECT state FROM rebind_login_attempts WHERE job_id=? AND kind='preflight'").get(job.id).state, 'succeeded');
});


test('login_old TLS failure quarantines proxy, retries with one replacement, and creates one alias', async (t) => {
  const seen = [];
  const f = await fixture(t, { worker: async (input) => {
    seen.push(input.proxy);
    await input.onStage('login_old');
    if (seen.length === 1) throw Object.assign(new Error('tls'), { code: 'NETWORK_TLS', diagnostic: { category: 'tls', curlCode: 35 } });
    return { email: input.newEmail, accountId: 'identity', originalAccountId: 'identity', password: 'password',
      totpSecret: 'totp', sessionToken: 'session', accessToken: 'access', mfaVerified: true };
  } });
  f.service.importProxies(['http://127.0.0.1:8080', 'http://127.0.0.1:8081']);
  const job = f.create();
  await f.service.waitForIdle();
  const final = f.service.getJob(job.id);
  assert.equal(final.state, 'completed');
  assert.deepEqual(seen, ['http://127.0.0.1:8080', 'http://127.0.0.1:8081']);
  assert.equal(f.store.db.prepare("SELECT COUNT(*) AS n FROM rebind_login_attempts WHERE job_id=? AND kind='login'").get(job.id).n, 2);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM rebind_alias_claims WHERE job_id=?').get(job.id).n, 1);
  assert.equal(f.calls(), 2);
});

test('login_old network failures stop after two replacements and skip reconciliation', async (t) => {
  const f = await fixture(t, { worker: async (input) => {
    await input.onStage('login_old');
    throw Object.assign(new Error('proxy'), { code: 'NETWORK_PROXY', diagnostic: { category: 'proxy', curlCode: 5 } });
  } });
  f.service.importProxies(['http://127.0.0.1:8080', 'http://127.0.0.1:8081', 'http://127.0.0.1:8082']);
  const job = f.create();
  await f.service.waitForIdle();
  const final = f.service.getJob(job.id);
  assert.equal(final.state, 'needs_review');
  assert.equal(final.last_error_code, 'NETWORK_PROXY');
  assert.match(final.last_error, /代理连接失败/);
  assert.equal(final.recovery_state, 'not_started');
  assert.equal(f.calls(), 3);
  assert.equal(f.store.db.prepare("SELECT COUNT(*) AS n FROM rebind_login_attempts WHERE job_id=? AND kind='login'").get(job.id).n, 3);
});