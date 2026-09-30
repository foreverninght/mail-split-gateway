'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { RebindWorker } = require('../src/rebind/worker');
const { TrialService } = require('../src/rebind/trial-service');
const { createFixture } = require('./fixtures/rebind-fault-recovery.fixture');

const python = process.env.REBIND_TEST_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
const scriptPath = path.join(__dirname, 'fixtures', 'trial-network-worker.py');

function realWorker(t, mode, email) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'trial-network-'));
  const statePath = path.join(directory, 'events.jsonl');
  const streams = [];
  const worker = new RebindWorker({ pythonPath: python, scriptPath, timeoutMs: 5000,
    spawnImpl(command, args, config) {
      const output = { text: '' };
      streams.push(output);
      const child = spawn(command, [...args, statePath, mode, email], config);
      child.stdout.on('data', (chunk) => { output.text += chunk.toString(); });
      return child;
    },
  });
  t.after(async () => {
    try {
      await worker.close();
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
      assert.equal(fs.existsSync(directory), false);
    }
  });
  return { worker, streams,
    events: () => fs.existsSync(statePath)
      ? fs.readFileSync(statePath, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [],
    messages: () => streams.flatMap(({ text }) => text.trim().split('\n').filter(Boolean).map(JSON.parse)),
  };
}

async function rebound(t) {
  const fixture = await createFixture(t, {
    async run(input) {
      await input.onIdentity('fixture-account');
      await input.onStage('completed');
      return { email: input.newEmail, accountId: 'fixture-account', originalAccountId: 'fixture-account',
        password: input.credentials.password, totpSecret: input.credentials.totpSecret,
        sessionToken: 'fixture-session', accessToken: 'fixture-access', mfaVerified: true };
    },
    async close() {},
  });
  const job = fixture.service.createJob({ accountId: 'account', mailboxId: fixture.mailbox.id });
  await fixture.service.waitForIdle();
  assert.equal(fixture.service.getJob(job.id).state, 'completed');
  assert.equal(fixture.service.getTrialCheck('account'), null);
  return { ...fixture, job: fixture.store.getJob(job.id) };
}

function assertAccount(f, before, refreshed) {
  const after = f.store.db.prepare('SELECT * FROM qualified_accounts WHERE id = ?').get('account');
  if (!refreshed) return assert.deepEqual(after, before);
  const fields = ['encrypted_session_json', 'encrypted_result_json'];
  const rest = (row) => Object.fromEntries(Object.entries(row).filter(([key]) => !fields.includes(key)));
  assert.deepEqual(rest(after), rest(before));
  for (const field of fields) {
    const previous = before[field] ? JSON.parse(f.secretBox.open(before[field])) : {};
    const current = JSON.parse(f.secretBox.open(after[field]));
    const { accessToken, sessionToken, ...others } = current;
    const { accessToken: oldAccess, sessionToken: oldSession, ...oldOthers } = previous;
    assert.deepEqual(others, oldOthers);
    assert.equal(sessionToken, 'fixture-refreshed-session');
    assert.match(accessToken, /^fixture\.[^.]+\.refreshed$/);
    const claims = JSON.parse(Buffer.from(accessToken.split('.')[1], 'base64url').toString());
    assert.equal(claims['https://api.openai.com/auth'].chatgpt_account_id, 'fixture-account');
    assert.notEqual(accessToken, oldAccess);
    assert.notEqual(sessionToken, oldSession);
  }
}

for (const scenario of [
  { mode: 'cacheValid', attempts: 1, probes: 1, logins: 0, success: true },
  { mode: 'cache401', attempts: 1, probes: 2, logins: 1, success: true },
  { mode: 'cacheTLS', attempts: 2, probes: 2, logins: 0, success: true },
  { mode: 'cache429', attempts: 1, probes: 1, logins: 0, code: 'TRIAL_PROBE_FAILED', http: 429 },
  { mode: 'cache403', attempts: 1, probes: 1, logins: 0, code: 'TRIAL_PROBE_FAILED', http: 403 },
  { mode: 'cacheMismatch', attempts: 1, probes: 1, logins: 0, code: 'ACCOUNT_MISMATCH' },
  { mode: 'cacheTLSAlways', attempts: 3, probes: 3, logins: 0, code: 'NETWORK_TLS' },
]) {
  test(`real cached trial IPC and TrialService: ${scenario.mode}`, { timeout: 25000 }, async (t) => {
    const f = await rebound(t);
    f.service.importProxies([8001, 8002, 8003, 8004, 8005].map((port) => `http://fixture.invalid:${port}`));
    const before = f.store.db.prepare('SELECT * FROM qualified_accounts WHERE id = ?').get('account');
    const tasksBefore = f.store.db.prepare('SELECT * FROM registration_tasks').all();
    const jobBefore = f.store.getJob(f.job.id);
    const parentBefore = f.store.db.prepare('SELECT * FROM rebind_proxy_pool WHERE id = ?').get(f.job.proxy_id);
    const bridge = realWorker(t, scenario.mode, f.job.new_email);
    f.service.trials.worker = bridge.worker;
    assert.ok(f.service.trials instanceof TrialService);
    assert.equal(bridge.worker.runTrial, RebindWorker.prototype.runTrial);
    const started = f.service.startTrialCheck({ accountId: 'account', idempotencyKey: scenario.mode });
    await f.service.waitForIdle();
    const check = f.service.getTrialCheck('account');
    const attempts = f.store.db.prepare('SELECT * FROM account_trial_attempts WHERE check_id = ? ORDER BY attempt_number').all(started.id);
    const events = bridge.events();
    const messages = bridge.messages();
    const probes = events.filter((event) => event.event === 'auth_session');
    const logins = events.filter((event) => event.event === 'login');
    assert.equal(check.id, started.id);
    assert.equal(check.source_rebind_job_id, f.job.id);
    assert.equal(check.attempt_count, scenario.attempts);
    assert.equal(check.max_attempts, 3);
    assert.equal(check.state, scenario.success ? 'completed' : 'failed');
    assert.equal(check.status, scenario.success ? 'eligible' : 'error');
    assert.equal(check.error_code, scenario.code || null);
    assert.equal(check.http_status, scenario.http || null);
    assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM account_trial_checks').get().n, 1);
    assert.equal(attempts.length, scenario.attempts);
    assert.deepEqual(attempts.map((attempt) => attempt.attempt_number), Array.from({ length: scenario.attempts }, (_, i) => i + 1));
    assert.equal(new Set(attempts.map((attempt) => attempt.proxy_id)).size, scenario.attempts);
    assert.ok(attempts.every((attempt) => attempt.check_id === started.id && attempt.proxy_id !== f.job.proxy_id));
    assert.equal(bridge.streams.length, scenario.attempts);
    assert.equal(bridge.worker.active.size, 0);
    assert.equal(probes.length, scenario.probes);
    assert.equal(logins.length, scenario.logins);
    assert.ok(logins.every((event) => event.email === f.job.new_email && event.credentials_match));
    assert.equal(events.filter((event) => event.event === 'coupon').length, scenario.success ? 1 : 0);
    assert.equal(events.filter((event) => event.event === 'auth_open').length,
      events.filter((event) => event.event === 'close').length);
    assert.ok(events.every((event) => !['change_email', 'forbidden_network'].includes(event.event)));
    assert.equal(messages.filter((message) => message.stage === 'session_trial').length, scenario.attempts);
    assert.equal(messages.filter((message) => message.stage === 'login_trial').length, scenario.logins);
    assert.equal(messages.filter((message) => message.type === 'result').length, scenario.success ? 1 : 0);
    const errors = messages.filter((message) => message.type === 'error');
    assert.equal(errors.length, scenario.attempts - (scenario.success ? 1 : 0));
    if (scenario.http) {
      assert.equal(errors[0].diagnostic.httpStatus, scenario.http);
      assert.equal(errors[0].diagnostic.category, 'http');
    }
    if (scenario.mode === 'cacheTLSAlways') assert.equal(f.service.proxyOverview().stats.available, 1);
    assert.doesNotMatch(JSON.stringify(messages), /fixture-password|fixture-totp|fixture-session|fixture-access|private/);
    assert.doesNotMatch(JSON.stringify(check), /fixture-refreshed-session|accessToken|sessionToken/);
    for (const [index, attempt] of attempts.entries()) {
      const completed = scenario.success && index === attempts.length - 1;
      assert.equal(attempt.state, completed ? 'completed' : 'failed');
      assert.equal(f.store.db.prepare('SELECT status FROM rebind_proxy_pool WHERE id = ?').get(attempt.proxy_id).status,
        completed ? 'consumed' : 'quarantined');
      if (!completed && scenario.mode.startsWith('cacheTLS')) {
        assert.equal(attempt.error_code, 'NETWORK_TLS');
        assert.equal(attempt.error_category, 'tls');
        assert.equal(attempt.curl_code, 35);
        assert.equal(attempt.http_status, null);
      }
      if (scenario.http) {
        assert.equal(attempt.http_status, scenario.http);
        assert.equal(attempt.error_category, 'http');
      }
    }
    if (scenario.mode === 'cache401') {
      assert.deepEqual(events.map((event) => event.event),
        ['auth_open', 'auth_session', 'close', 'login', 'auth_open', 'auth_session', 'coupon', 'close']);
      assert.equal(probes[0].proxy, logins[0].proxy);
      assert.deepEqual(probes.map((event) => event.fresh), [false, true]);
    } else {
      assert.ok(probes.every((event) => event.fresh === false));
      assert.equal(new Set(probes.map((event) => event.proxy)).size, scenario.attempts);
    }
    assertAccount(f, before, scenario.success);
    assert.deepEqual(f.store.db.prepare('SELECT * FROM registration_tasks').all(), tasksBefore);
    assert.deepEqual(f.store.getJob(f.job.id), jobBefore);
    assert.deepEqual(f.store.db.prepare('SELECT * FROM rebind_proxy_pool WHERE id = ?').get(f.job.proxy_id), parentBefore);
  });
}

for (const mode of ['curl35', 'http429']) {
  test(`real trial IPC and TrialService: ${mode}`, { timeout: 25000 }, async (t) => {
    const f = await rebound(t);
    f.store.db.prepare('UPDATE qualified_accounts SET encrypted_session_json = NULL WHERE id = ?').run('account');
    const accountBefore = f.store.db.prepare('SELECT * FROM qualified_accounts WHERE id = ?').get('account');
    const tasksBefore = f.store.db.prepare('SELECT * FROM registration_tasks').all();
    const jobBefore = f.store.getJob(f.job.id);
    const parentProxyBefore = f.store.db.prepare('SELECT * FROM rebind_proxy_pool WHERE id = ?').get(f.job.proxy_id);
    const diagnostic = mode === 'curl35'
      ? { category: 'tls', httpStatus: null, curlCode: 35 }
      : { category: 'http', httpStatus: 429, curlCode: null };
    const code = mode === 'curl35' ? 'NETWORK_TLS' : 'LOGIN_FAILED';
    const direct = realWorker(t, mode, f.job.new_email);
    let rejection;
    await assert.rejects(direct.worker.runTrial({
      credentials: { email: f.job.new_email, password: 'fixture-password', totpSecret: 'fixture-totp' },
      expectedAccountId: 'fixture-account', proxy: 'http://fixture.invalid:8002',
    }), (error) => { rejection = error; return true; });

    const bridge = realWorker(t, mode, f.job.new_email);
    assert.equal(bridge.worker.runTrial, RebindWorker.prototype.runTrial);
    assert.ok(f.service.trials instanceof TrialService);
    f.service.trials.worker = bridge.worker;
    const started = f.service.startTrialCheck({ accountId: 'account', idempotencyKey: `network-${mode}` });
    assert.equal(started.state, 'queued');
    await f.service.waitForIdle();
    const check = f.service.getTrialCheck('account');
    const attempts = f.store.db.prepare('SELECT * FROM account_trial_attempts WHERE check_id = ? ORDER BY attempt_number').all(started.id);
    const events = bridge.events();
    const logins = events.filter((event) => event.event === 'login');
    const messages = bridge.messages();
    const errors = messages.filter((message) => message.type === 'error');
    t.diagnostic(JSON.stringify({ check: { state: check.state, status: check.status, attempts: check.attempt_count }, errors }));
    assert.equal(check.id, started.id);
    assert.equal(check.source_rebind_job_id, f.job.id);
    assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM account_trial_checks').get().n, 1);
    assertAccount(f, accountBefore, mode === 'curl35');
    assert.equal(accountBefore.trial_summary, 'eligible');
    assert.deepEqual(f.store.db.prepare('SELECT * FROM registration_tasks').all(), tasksBefore);
    assert.deepEqual(f.store.getJob(f.job.id), jobBefore);
    assert.deepEqual(f.store.db.prepare('SELECT * FROM rebind_proxy_pool WHERE id = ?').get(f.job.proxy_id), parentProxyBefore);
    assert.ok(events.every((event) => !['change_email', 'forbidden_network'].includes(event.event)));
    assert.ok(logins.every((event) => event.email === f.job.new_email && event.credentials_match));
    assert.equal(bridge.worker.active.size, 0);
    assert.equal(direct.worker.active.size, 0);
    assert.deepEqual(rejection.diagnostic, diagnostic);
    assert.equal(rejection.code, code);
    assert.deepEqual(direct.messages().filter((message) => message.type === 'error'), [{ type: 'error', code, diagnostic }]);
    assert.deepEqual(errors, [{ type: 'error', code, diagnostic }]);
    assert.doesNotMatch(JSON.stringify(messages), /fixture-password|fixture-totp|fixture-session|fixture-access|private/);
    assert.equal(attempts[0].error_code, code);
    assert.equal(attempts[0].error_category, diagnostic.category);
    assert.equal(attempts[0].curl_code, diagnostic.curlCode);
    assert.equal(attempts[0].http_status, diagnostic.httpStatus);
    assert.ok(attempts.every((attempt) => attempt.check_id === check.id && attempt.proxy_id !== f.job.proxy_id));
    const proxyStatus = (id) => f.store.db.prepare('SELECT status FROM rebind_proxy_pool WHERE id = ?').get(id).status;
    assert.equal(proxyStatus(attempts[0].proxy_id), 'quarantined');
    if (mode === 'curl35') {
      assert.equal(check.state, 'completed');
      assert.equal(check.status, 'eligible');
      assert.equal(check.attempt_count, 2);
      assert.equal(attempts.length, 2);
      assert.deepEqual(attempts.map((attempt) => attempt.attempt_number), [1, 2]);
      assert.deepEqual(attempts.map((attempt) => attempt.state), ['failed', 'completed']);
      assert.notEqual(attempts[0].proxy_id, attempts[1].proxy_id);
      assert.equal(proxyStatus(attempts[1].proxy_id), 'consumed');
      assert.deepEqual(logins.map((event) => event.proxy), ['http://fixture.invalid:8002', 'http://fixture.invalid:8003']);
      assert.deepEqual(events.map((event) => event.event), ['login', 'login', 'auth_open', 'auth_session', 'coupon', 'close']);
      assert.deepEqual(messages.filter((message) => message.type === 'result').map((message) => {
        const { session, ...result } = message.result;
        assert.equal(session.sessionToken, 'fixture-refreshed-session');
        return result;
      }), [{
        email: f.job.new_email, accountId: 'fixture-account', mfaVerified: true, status: 'eligible',
        campaignId: 'plus-1-month-free', amountMinor: 0, currency: 'USD', billingCountry: 'US', errorCode: null,
      }]);
      assert.equal(check.error_code, null);
      assert.equal(check.curl_code, null);
    } else {
      assert.equal(check.state, 'failed');
      assert.equal(check.status, 'error');
      assert.equal(check.error_code, code);
      assert.equal(check.http_status, 429);
      assert.equal(check.error_category, 'http');
      assert.equal(check.attempt_count, 1);
      assert.equal(attempts.length, 1);
      assert.equal(attempts[0].state, 'failed');
      assert.equal(bridge.streams.length, 1);
      assert.deepEqual(events.map((event) => event.event), ['login']);
      assert.equal(f.service.proxyOverview().stats.available, 1);
      assert.equal(messages.filter((message) => message.type === 'result').length, 0);
    }
  });
}
