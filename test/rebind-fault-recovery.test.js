'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { RebindWorker } = require('../src/rebind/worker');
const { createFixture } = require('./fixtures/rebind-fault-recovery.fixture');

const python = process.env.REBIND_TEST_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
const scriptPath = path.join(__dirname, 'fixtures', 'rebind-fault-worker.py');
const { spawn } = require('node:child_process');
const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'rebind-fault-'));
const statePath = path.join(temporaryDirectory, 'platform.json');
test.after(() => fs.rmSync(temporaryDirectory, { recursive: true, force: true }));
const credentials = { email: 'old@example.test', password: 'fixture-password', totpSecret: 'fixture-totp' };
const input = { credentials, newEmail: 'new@example.test', proxy: 'http://fixture.invalid:8001' };

function resetState() {
  try { fs.unlinkSync(statePath); } catch (error) { if (error.code !== 'ENOENT') throw error; }
}
function state() { return JSON.parse(fs.readFileSync(statePath, 'utf8')); }
function worker() {
  return new RebindWorker({ pythonPath: python, scriptPath, timeoutMs: 5000,
    spawnImpl(command, args, config) { return spawn(command, [...args, statePath], config); } });
}

async function trialResult(input) {
  return { email: input.credentials.email, accountId: input.expectedAccountId, mfaVerified: true,
    status: 'eligible', campaignId: 'plus-1-month-free', amountMinor: 0, currency: 'USD', billingCountry: 'US', errorCode: null };
}

test('真实 Node/Python 协议：verify 提交后超时，recover 仅登录目标邮箱并返回同身份结果', async (t) => {
  resetState();
  t.after(resetState);
  const stages = [];
  await assert.rejects(worker().run({ ...input, waitForCode: async () => '123456',
    onIdentity: async (accountId) => assert.equal(accountId, 'fixture-account'),
    onStage: async (stage) => stages.push(stage) }), (error) => {
    assert.equal(error.code, 'NETWORK_TIMEOUT');
    assert.equal(error.diagnostic.category, 'timeout');
    return true;
  });
  assert.deepEqual(stages, ['login_old', 'eligibility', 'begin', 'verify']);
  assert.deepEqual(state(), { remote_email: 'new@example.test', logins: ['old@example.test'], begin: 1, verify: 1 });

  const recoveryStages = [];
  const recovered = await worker().runRecovery({ ...input, expectedAccountId: 'fixture-account',
    onStage: async (stage) => recoveryStages.push(stage) });
  assert.equal(recovered.email, 'new@example.test');
  assert.equal(recovered.accountId, 'fixture-account');
  assert.deepEqual(recoveryStages, ['login_recovery']);
  assert.deepEqual(state(), { remote_email: 'new@example.test', logins: ['old@example.test', 'new@example.test'], begin: 1, verify: 1 });
});

test('真实 RebindService 自动恢复只跑一次 verify，保存已验证结果、cleanup 与独立 trial', async (t) => {
  resetState();
  t.after(resetState);
  const rebindWorker = worker();
  const fixture = await createFixture(t, rebindWorker);
  const registrationBefore = fixture.store.db.prepare('SELECT * FROM registration_tasks').all();
  let trialCalls = 0;
  rebindWorker.runTrial = async (request) => {
    trialCalls += 1;
    const parent = fixture.store.listJobs()[0];
    assert.equal(parent.state, 'completed');
    assert.ok(parent.encrypted_result);
    assert.equal(request.credentials.email, parent.new_email);
    assert.equal(request.expectedAccountId, 'fixture-account');
    assert.equal(request.waitForCode, undefined);
    assert.notEqual(request.proxy, fixture.secretBox.open(parent.encrypted_proxy));
    return trialResult(request);
  };
  const job = fixture.service.createJob({ accountId: 'account', mailboxId: fixture.mailbox.id });
  await fixture.service.waitForIdle();
  const result = fixture.service.getJob(job.id);
  const account = fixture.registration.getQualifiedAccount('account', { reveal: true });
  const checks = fixture.service.getTrialCheck('account');
  assert.equal(result.state, 'completed');
  assert.equal(result.verified, true);
  assert.equal(result.recovery_state, 'recovered');
  assert.equal(result.recovery_attempts, 1);
  assert.equal(account.email, result.new_email);
  assert.equal(account.result.email, result.new_email);
  assert.equal(fixture.gateway.isAliasClaimed(result.alias_id), false);
  assert.equal(fixture.gateway.store.getAlias(result.alias_id).state, 'deleted');
  assert.equal(checks.status, 'eligible');
  assert.equal(checks.state, 'completed');
  assert.deepEqual(state(), { remote_email: result.new_email, logins: ['old@example.test', result.new_email], begin: 1, verify: 1 });
  const attempts = fixture.store.db.prepare('SELECT mode, state FROM rebind_recovery_attempts WHERE job_id = ?').all(job.id);
  assert.deepEqual(attempts.map((row) => ({ ...row })), [{ mode: 'automatic', state: 'completed' }]);
  assert.equal(trialCalls, 1);
  assert.equal(fixture.store.db.prepare('SELECT trial_summary FROM qualified_accounts').get().trial_summary, 'eligible');
  assert.deepEqual(fixture.store.db.prepare('SELECT * FROM registration_tasks').all(), registrationBefore);
  const recoveryProxy = fixture.store.db.prepare('SELECT proxy_id FROM rebind_recovery_attempts WHERE job_id = ?').get(job.id);
  assert.notEqual(recoveryProxy.proxy_id, fixture.store.getJob(job.id).proxy_id);
  assert.equal(result.last_error_code, 'NETWORK_TIMEOUT');
  assert.equal(result.failed_stage, 'verify');
  assert.equal(result.error_category, 'timeout');
  const events = fixture.store.listEvents(job.id).map((event) => event.event);
  assert.ok(events.indexOf('original_identity_checkpoint') >= 0);
  assert.ok(events.indexOf('original_identity_checkpoint') < events.indexOf('begin'));
  assert.ok(events.indexOf('remote_identity_reconciled') < events.indexOf('result_persisted'));
  assert.ok(events.indexOf('result_persisted') < events.indexOf('completed'));
  assert.equal(account.result.accountId, 'fixture-account');
  assert.equal(account.result.mfaVerified, true);
  assert.doesNotMatch(JSON.stringify(result), /fixture-password|fixture-totp|fixture-session|response lost/);
  assert.equal(fixture.service.proxyOverview().stats.quarantined, 1);
  assert.equal(fixture.service.proxyOverview().stats.consumed, 2);
});

for (const failurePoint of ['identity', 'verify']) {
  test(`真实 ACK callback ${failurePoint} 失败时 Python 不执行 verify`, async (t) => {
    resetState();
    t.after(resetState);
    const bridge = worker();
    t.after(() => bridge.close());
    await assert.rejects(bridge.run({ ...input, waitForCode: async () => '123456',
      onIdentity: async () => { if (failurePoint === 'identity') throw new Error('fixture-secret-checkpoint'); },
      onStage: async (stage) => { if (stage === failurePoint) throw new Error('fixture-secret-stage'); },
    }), { code: failurePoint === 'identity' ? 'IDENTITY_CALLBACK_FAILED' : 'STAGE_CALLBACK_FAILED' });
    assert.deepEqual(state(), { remote_email: 'old@example.test', logins: ['old@example.test'],
      begin: failurePoint === 'identity' ? 0 : 1, verify: 0 });
    assert.equal(bridge.active.size, 0);
  });
}
