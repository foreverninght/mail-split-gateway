'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium } = require('playwright');

async function fixture(t, clock = false) {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.TEST_BROWSER_EXECUTABLE || undefined });
  t.after(() => browser.close());
  const page = await browser.newPage();
  if (clock) await page.clock.install();
  const assets = Object.fromEntries(await Promise.all(['index.html', 'app.js', 'styles.css'].map(async (name) => [name, await fs.readFile(path.join(__dirname, '../public', name), 'utf8')])));
  const calls = [];
  const errors = [];
  const config = { rebindStatus: 200, available: 2, importStatus: 200, failAfterImport: false, imported: false, jobStatus: 202, jobsFail: false,
    mailboxes: [{ id: 'mail-1', email: 'fixture@example.test', state: 'ready', remote_alias_count: 0 }], jobs: [], jobError: '' };
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('http://ui.test/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (!url.pathname.startsWith('/api/')) {
      const name = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
      return route.fulfill({ status: 200, contentType: name.endsWith('.js') ? 'text/javascript' : name.endsWith('.css') ? 'text/css' : 'text/html', body: assets[name] || '' });
    }
    calls.push({ path: url.pathname, search: url.search, method: request.method(), body: request.postDataJSON() });
    let status = 200;
    let body = {};
    if (url.pathname.endsWith('/import')) {
      status = config.importStatus;
      config.imported = status === 200;
      body = status === 200 ? { current: 1, added: 1 } : { message: 'raw-secret-password', error: 'INVALID_PROXY_LIST' };
    } else if (/\/proxies$|\/control-proxies$/.test(url.pathname)) {
      status = url.pathname.includes('/rebind/') ? config.rebindStatus : 200;
      if (config.failAfterImport && config.imported) status = 500;
      const query = url.searchParams.get('q');
      if (query === 'old') await new Promise((resolve) => setTimeout(resolve, 160));
      body = { stats: { total: 2, available: config.available, reserved: 0, consumed: 0, quarantined: 0 }, cooldownMs: 86400000, proxies: [{ id: 1, masked_endpoint: query || 'host:8080:us***:***', status: 'available', imported_at: '2026-01-01', last_error: 'raw-secret-password' }], pagination: { page: 1, pages: 2, total: 60 } };
    } else if (url.pathname === '/api/admin/mailboxes') body = { mailboxes: config.mailboxes };
    else if (/\/mailboxes\/[^/]+\/aliases$/.test(url.pathname)) body = { aliases: [{ id: 'alias-1', email: 'existing@example.test', state: 'ready' }] };
    else if (/\/mailboxes\/[^/]+\/domains$/.test(url.pathname)) body = { domains: [] };
    else if (url.pathname === '/api/admin/rebind/accounts') body = { accounts: config.rebindAccounts || [{ id: 'account-1', email: 'account@example.test', eligible: true, eligible_at: '2020-01-01T00:00:00Z' }] };
    else if (url.pathname === '/api/admin/rebind/jobs') {
      status = request.method() === 'POST' ? config.jobStatus : config.jobsFail ? 500 : 200;
      body = request.method() === 'POST' ? { id: 'job-1', error: config.jobError, message: 'raw-secret-password' } : { jobs: config.jobs };
    } else if (url.pathname === '/api/admin/registration-batches') body = { batches: [] };
    return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  });
  await page.goto('http://ui.test/');
  await page.evaluate(() => { state.apiKey = 'fixture'; elements.mainNav.hidden = false; });
  t.after(() => assert.deepEqual(errors, []));
  return { page, config, calls };
}

async function openPools(page) {
  await page.evaluate(() => switchView('proxies'));
  await page.locator('[data-pool-panel="task"] summary').click();
}

function recoveryJob(overrides = {}) {
  return { id: 'recover-1', account_id: 'review', state: 'needs_review', stage: 'login_new', failed_stage: 'login_new',
    recovery_state: 'checking', recovery_attempts: 1, recovery_auto_attempts: 1, recovery_mode: 'automatic',
    recovery_max_auto_attempts: 2, error_category: 'timeout', can_reconcile: true,
    last_error_code: 'NEVER_SHOW', last_error: 'token=NEVER_SHOW', ...overrides };
}

test('recovery checking and exhausted are read-only and distinct from qualification', async (t) => {
  const { page, config, calls } = await fixture(t, true);
  config.jobs = [recoveryJob()];
  await page.evaluate(() => switchView('rebind'));
  assert.match(await page.locator('#rebindJobRows').innerText(), /正在核对远端结果（第1\/2次）/);
  assert.match(await page.locator('#rebindJobRows').innerText(), /重登验证失败：网络超时/);
  assert.equal(await page.locator('[data-rebind-reconcile]').isDisabled(), true);
  config.jobs[0].recovery_auto_attempts = 2;
  await page.clock.runFor(5000);
  await page.waitForFunction(() => !rebindState.loading && rebindState.jobs[0]?.recovery_auto_attempts === 2);
  assert.match(await page.locator('#rebindJobRows').innerText(), /第2\/2次/);
  config.jobs[0].recovery_state = 'exhausted';
  await page.locator('#refreshRebindButton').click();
  await page.waitForFunction(() => !rebindState.loading);
  assert.match(await page.locator('#rebindJobRows').innerText(), /自动核对未确认，可手动核对/);
  assert.match(await page.locator('#rebindJobRows').innerText(), /只登录目标邮箱核验身份，不再次提交邮箱变更/);
  assert.equal(await page.locator('[data-rebind-reconcile]').isEnabled(), true);
  assert.doesNotMatch(await page.locator('#rebindJobRows').innerText(), /NEVER_SHOW/);
  assert.equal(calls.filter((call) => call.method === 'POST').length, 0);
  config.jobs[0].recovery_mode = 'manual';
  config.jobs[0].recovery_state = 'checking';
  config.jobs[0].recovery_attempts = 3;
  await page.evaluate(() => loadRebind());
  assert.match(await page.locator('#rebindJobRows').innerText(), /正在手动核对/);
  assert.doesNotMatch(await page.locator('#rebindJobRows').innerText(), /第3\/2次/);
});

test('recovery preserves unknown request key and prevents concurrent and automatic submissions', async (t) => {
  const { page, config, calls } = await fixture(t);
  config.jobs = [recoveryJob({ recovery_state: 'exhausted' })];
  const requests = [];
  let fail = true;
  let release;
  await page.route('**/rebind/jobs/recover-1/reconcile', async (route) => {
    if (route.request().method() === 'GET') return route.fulfill({ json: { job: config.jobs[0], recovery: {} } });
    requests.push(route.request().postDataJSON());
    await new Promise((resolve) => { release = resolve; });
    if (fail) return route.fulfill({ status: 502, json: { message: 'token=NEVER_SHOW' } });
    return route.fulfill({ status: 202, json: { job: config.jobs[0], recovery: { state: 'exhausted' } } });
  });
  await page.evaluate(() => switchView('rebind'));
  const clickTwice = () => page.evaluate(() => {
    const button = document.querySelector('[data-rebind-reconcile]');
    button.click(); button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  await clickTwice();
  await page.waitForFunction(() => rebindState.recoveries.get('recover-1')?.busy);
  while (!release) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(requests.length, 1);
  release();
  await page.waitForFunction(() => !rebindState.loading && !rebindState.recoveries.get('recover-1').busy);
  assert.match(await page.locator('#rebindJobRows').innerText(), /结果未知/);
  assert.doesNotMatch(await page.locator('#rebindJobRows').innerText(), /NEVER_SHOW/);
  await page.evaluate(() => loadRebind());
  assert.equal(requests.length, 1);
  fail = false;
  release = null;
  await clickTwice();
  while (!release) await new Promise((resolve) => setTimeout(resolve, 10));
  release();
  await page.waitForFunction(() => !rebindState.loading && !rebindState.recoveries.get('recover-1').busy);
  assert.deepEqual(requests[0], requests[1]);
  assert.deepEqual(Object.keys(requests[0]), ['idempotencyKey']);
  release = null;
  await clickTwice();
  while (!release) await new Promise((resolve) => setTimeout(resolve, 10));
  release();
  await page.waitForFunction(() => !rebindState.loading && !rebindState.recoveries.get('recover-1').busy);
  assert.notEqual(requests[2].idempotencyKey, requests[1].idempotencyKey);
  assert.equal(calls.filter((call) => call.method === 'POST').length, 0);
});

test('recovery excludes preparation stages and blocks identity problems with sanitized reasons', async (t) => {
  const { page, config } = await fixture(t);
  config.jobs = [recoveryJob({ stage: 'creating_alias', failed_stage: 'creating_alias', recovery_state: 'not_started' })];
  await page.evaluate(() => switchView('rebind'));
  assert.equal(await page.locator('[data-rebind-reconcile]').count(), 0);
  assert.doesNotMatch(await page.locator('#rebindJobRows').innerText(), /重跑|手动核对/);
  for (const code of ['ACCOUNT_MISMATCH', 'RECOVERY_IDENTITY_MISSING', 'RECOVERY_IDENTITY_CONFLICT', 'RECOVERY_SNAPSHOT_CONFLICT']) {
    config.jobs = [recoveryJob({ recovery_state: 'exhausted', recovery_error_code: code, can_reconcile: false })];
    await page.evaluate(() => loadRebind());
    assert.match(await page.locator('#rebindJobRows').innerText(), /人工核查/);
    assert.doesNotMatch(await page.locator('#rebindJobRows').innerText(), /自动核对未确认，可手动核对|NEVER_SHOW/);
    assert.equal(await page.locator('[data-rebind-reconcile]').isDisabled(), true);
  }
  for (const [error_category, label] of [['tls', 'TLS 安全连接失败'], ['proxy', '代理连接失败'], ['http', '远端服务响应异常'], ['protocol', '远端响应格式异常']]) {
    config.jobs = [recoveryJob({ error_category })];
    await page.evaluate(() => loadRebind());
    assert.ok((await page.locator('#rebindJobRows').innerText()).includes(label));
  }
});

test('recovery diagnoses latest login and transport errors separately from original failure', async (t) => {
  const { page, config } = await fixture(t);
  config.jobs = [recoveryJob({ recovery_state: 'exhausted', failed_stage: 'verify',
    last_error_code: 'NETWORK_TIMEOUT', recovery_error_code: 'RECOVERY_FAILED',
    recovery_error_category: 'tls', recovery_http_status: null, recovery_curl_code: 35 })];
  await page.evaluate(() => switchView('rebind'));
  let text = await page.locator('#rebindJobRows').innerText();
  assert.match(text, /原失败阶段：验证邮箱；最近核对结果：TLS 安全连接失败/);
  assert.doesNotMatch(text, /网络超时|RECOVERY_FAILED|NEVER_SHOW/);
  for (const [code, label] of [['LOGIN_FAILED', '目标邮箱登录未通过'], ['LOGIN_INCOMPLETE', '目标邮箱登录未通过'],
    ['MFA_FAILED', '双重验证未通过'], ['MFA_INVALID_CODE', '双重验证未通过'], ['VERIFY_FAILED', '邮箱验证码验证请求未确认']]) {
    Object.assign(config.jobs[0], { recovery_error_code: code, recovery_error_category: 'unknown' });
    await page.evaluate(() => loadRebind());
    text = await page.locator('#rebindJobRows').innerText();
    assert.ok(text.includes(`最近核对结果：${label}`));
    assert.doesNotMatch(text, /网络超时|账号未换绑|NEVER_SHOW/);
    assert.ok(!text.includes(code));
  }
  Object.assign(config.jobs[0], { recovery_error_code: null, recovery_error_category: 'proxy' });
  await page.evaluate(() => loadRebind());
  assert.match(await page.locator('#rebindJobRows').innerText(), /最近核对结果：代理连接失败/);
  Object.assign(config.jobs[0], { recovery_state: 'recovered', state: 'completed' });
  await page.evaluate(() => loadRebind());
  text = await page.locator('#rebindJobRows').innerText();
  assert.match(text, /已核对恢复/);
  assert.doesNotMatch(text, /原失败阶段|最近核对结果|代理连接失败|网络超时/);
});

async function accountFixture(t, clock = false) {
  const fixtureResult = await fixture(t, clock);
  const { page } = fixtureResult;
  const base = { created_at: '2026-01-01T00:00:00Z', mailbox_category: 'ic', mfa_status: 'enabled', trial_qualification: 'observed_eligible' };
  const data = { accounts: [
    { ...base, id: 'old', email: 'original@test.local', created_at: '2026-06-01T00:00:00Z' },
    { ...base, id: 'done', email: 'new@test.local', original_email: 'old@test.local', rebind_status: 'rebound', credential_ready: true, cleanup_pending: true, rebound_at: '2026-06-02T00:00:00Z' },
    { ...base, id: 'review', email: 'uncertain@test.local', rebind_status: 'needs_review', credential_ready: false },
    { ...base, id: 'running', email: 'running@test.local', rebind_status: 'rebinding', credential_ready: false },
  ], revealDelay: 0, revealStatus: 200, reveals: 0, reads: 0 };
  await page.route('http://ui.test/api/admin/qualified-accounts**', async (route) => {
    const url = route.request().url();
    if (url.endsWith('/rebind-history')) return route.fulfill({ json: { account: data.accounts[1], history: [
      { job_id: 'failed', original_email: 'old@test.local', target_email: 'failed@test.local', state: 'failed', mailbox_receiving: 'released', created_at: '2026-06-01', password: 'NEVER_SHOW', session: 'NEVER_SHOW' },
      { job_id: 'success', original_email: 'old@test.local', target_email: 'new@test.local', state: 'cleanup_pending', verified_at: '2026-06-02', mailbox_receiving: 'protected', cleanup_pending: true },
    ] } });
    if (url.endsWith('/reveal')) {
      ++data.reveals;
      const email = url.includes('/old/') ? 'original@test.local' : 'new@test.local';
      const status = data.revealStatus;
      await new Promise((resolve) => setTimeout(resolve, data.revealDelay));
      return route.fulfill({ status, json: status === 409 ? { error: 'ACCOUNT_CREDENTIALS_UNCONFIRMED' } : { account: { email, password: 'fresh-' + data.reveals, totpSecret: 'secret', totp: '123456', session: { token: 'fresh' }, result: { oldSession: 'NEVER_SHOW' } } } });
    }
    ++data.reads;
    return route.fulfill({ json: { accounts: [...data.accounts, data.accounts[1]] } });
  });
  await page.evaluate(() => switchView('accounts'));
  return { ...fixtureResult, data };
}

test('recovery completion refreshes locked account and leaves qualification independent', async (t) => {
  const { page, config, data, calls } = await accountFixture(t, true);
  config.jobs = [recoveryJob()];
  await page.locator('[data-account-status="needs_review"]').click();
  assert.equal(await page.locator('[data-account-id="review"] [data-action="reveal-account"]').isDisabled(), true);
  assert.equal(await page.locator('[data-account-id="review"] [data-action="trial-check"]').count(), 0);
  await page.evaluate(() => switchView('rebind'));
  Object.assign(config.jobs[0], { state: 'completed', recovery_state: 'recovered', stage: 'completed' });
  Object.assign(data.accounts[2], { rebind_status: 'rebound', credential_ready: true, email: 'recovered@test.local',
    post_rebind_trial_status: 'not_checked' });
  await page.clock.runFor(5000);
  await page.waitForFunction(() => !rebindState.loading && state.accounts.find((account) => account.id === 'review').rebind_status === 'rebound');
  assert.equal(await page.locator('[data-rebind-reconcile]').count(), 0);
  assert.match(await page.locator('#rebindJobRows').innerText(), /已核对恢复/);
  assert.doesNotMatch(await page.locator('#rebindJobRows').innerText(), /失败|网络超时|NEVER_SHOW/);
  await page.locator('#rebindJobRows [data-managed-account]').first().click();
  await page.waitForFunction(() => document.activeElement.dataset.accountId === 'review');
  const row = page.locator('[data-account-id="review"]');
  assert.match(await row.innerText(), /recovered@test.local/);
  assert.match(await row.innerText(), /换绑后：待检测/);
  assert.equal(await row.locator('[data-action="reveal-account"]').isEnabled(), true);
  assert.equal(await row.locator('[data-action="trial-check"]').isEnabled(), true);
  assert.equal(calls.filter((call) => call.method === 'POST').length, 0);
});

test('manual recovery handles definite rejection then refreshes completed job and account without rebind creation', async (t) => {
  const { page, config, data, calls } = await accountFixture(t);
  config.jobs = [recoveryJob({ recovery_state: 'exhausted' })];
  const requests = [];
  await page.route('**/rebind/jobs/recover-1/reconcile', async (route) => {
    if (route.request().method() === 'POST') {
      requests.push(route.request().postDataJSON());
      if (requests.length === 1) return route.fulfill({ status: 409, json: { error: 'REBIND_PROXY_POOL_EXHAUSTED', message: 'token=NEVER_SHOW' } });
      Object.assign(config.jobs[0], { state: 'completed', stage: 'reconciled', recovery_state: 'recovered' });
      Object.assign(data.accounts[2], { rebind_status: 'rebound', credential_ready: true, email: 'manual@test.local', post_rebind_trial_status: 'not_checked' });
    }
    return route.fulfill({ status: route.request().method() === 'POST' ? 202 : 200, json: { job: config.jobs[0], recovery: { recovery_state: config.jobs[0].recovery_state } } });
  });
  await page.evaluate(() => switchView('rebind'));
  await page.locator('[data-rebind-reconcile]').click();
  await page.waitForFunction(() => !rebindState.loading && !rebindState.recoveries.get('recover-1').busy);
  assert.match(await page.locator('#rebindJobRows').innerText(), /暂无可用代理/);
  assert.doesNotMatch(await page.locator('#rebindJobRows').innerText(), /NEVER_SHOW/);
  await page.locator('[data-rebind-reconcile]').click();
  await page.waitForFunction(() => !rebindState.loading && state.accounts.find((account) => account.id === 'review').email === 'manual@test.local');
  assert.notEqual(requests[0].idempotencyKey, requests[1].idempotencyKey);
  assert.match(await page.locator('#rebindJobRows').innerText(), /结果已核对.*已核对恢复/s);
  assert.doesNotMatch(await page.locator('#rebindJobRows').innerText(), /失败|网络超时/);
  assert.equal(await page.locator('[data-rebind-reconcile]').count(), 0);
  assert.equal(await page.evaluate(() => state.accounts.find((account) => account.id === 'review').post_rebind_trial_status), 'not_checked');
  assert.equal(calls.filter((call) => call.method === 'POST').length, 0);
});

test('post-rebind trial is independent of registration results and filters count only definite outcomes', async (t) => {
  const { page, data } = await accountFixture(t);
  Object.assign(data.accounts[1], { trial_qualification: 'observed_ineligible', post_rebind_trial_status: 'not_checked' });
  await page.evaluate(() => loadAccounts());
  await page.locator('[data-account-status="rebound"]').click();
  assert.match(await page.locator('#accountRows').innerText(), /换绑后：待检测/);
  assert.match(await page.locator('#accountRows').innerText(), /原注册资格：无试用资格（独立保留）/);
  assert.match(await page.locator('#accountRows').innerText(), /其中 0 个有试用资格/);
  await page.locator('#accountTrialFilter').selectOption('observed_ineligible');
  assert.equal(await page.locator('[data-account-id]').count(), 0);
  for (const status of ['eligible', 'ineligible', 'checking', 'error']) {
    Object.assign(data.accounts[1], { post_rebind_trial_status: status, post_rebind_trial_checked_at: '2026-06-03T01:02:03Z', post_rebind_trial_error_code: 'token=NEVER_SHOW' });
    await page.evaluate(() => loadAccounts());
    await page.locator('#accountTrialFilter').selectOption('all');
    assert.match(await page.locator('#accountRows').innerText(), new RegExp(`其中 ${status === 'eligible' ? 1 : 0} 个有试用资格`));
    assert.doesNotMatch(await page.locator('#accountRows').innerText(), /NEVER_SHOW/);
    assert.equal(await page.locator('[data-action="trial-check"]').isDisabled(), status === 'checking');
    await page.locator('#accountTrialFilter').selectOption('observed_ineligible');
    assert.equal(await page.locator('[data-account-id]').count(), status === 'ineligible' ? 1 : 0);
    await page.locator('#accountTrialFilter').selectOption('observed_eligible');
    assert.equal(await page.locator('[data-account-id]').count(), status === 'eligible' ? 1 : 0);
  }
});

test('trial check is click-only, deduplicates concurrent clicks and polling never repeats POST', async (t) => {
  const { page, data, calls } = await accountFixture(t, true);
  const checks = [];
  await page.route('http://ui.test/api/admin/qualified-accounts/done/trial-check', async (route) => {
    checks.push({ method: route.request().method(), body: route.request().postDataJSON() });
    Object.assign(data.accounts[1], { post_rebind_trial_status: 'checking', post_rebind_trial_check_id: 'check-1' });
    await route.fulfill({ status: 202, json: { check: { id: 'check-1', status: 'checking' } } });
  });
  await page.locator('[data-account-status="rebound"]').click();
  await page.evaluate(() => {
    const button = document.querySelector('[data-action="trial-check"]');
    button.click(); button.click();
    checkAccountTrial('done');
  });
  await page.waitForFunction(() => !state.trialRequests.get('done')?.busy);
  assert.equal(checks.length, 1);
  assert.equal(checks[0].method, 'POST');
  assert.deepEqual(Object.keys(checks[0].body), ['idempotencyKey']);
  assert.ok(checks[0].body.idempotencyKey);
  assert.equal(await page.locator('[data-action="trial-check"]').isDisabled(), true);
  await page.clock.runFor(10000);
  await page.evaluate(async () => { await loadAccounts(); await switchView('mail'); await switchView('accounts'); });
  assert.equal(checks.length, 1);
  assert.equal(calls.filter((call) => call.method !== 'GET').length, 0);
  Object.assign(data.accounts[1], { post_rebind_trial_status: 'error', post_rebind_trial_error_code: 'TRIAL_CHECK_TIMEOUT' });
  await page.evaluate(() => loadAccounts(true));
  assert.equal(await page.locator('[data-action="trial-check"]').isEnabled(), true);
  assert.match(await page.locator('#accountRows').innerText(), /检测超时/);
});

test('uncertain trial requests retain keys across refresh; latest lookup permits an explicit new check', async (t) => {
  const { page, data, calls } = await accountFixture(t);
  const requests = [];
  let fail = true;
  let latestCheck = null;
  await page.route('http://ui.test/api/admin/qualified-accounts/done/trial-check', async (route) => {
    const request = route.request();
    requests.push({ method: request.method(), body: request.postDataJSON() });
    if (request.method() === 'GET') return route.fulfill({ json: { check: latestCheck } });
    if (fail) return route.fulfill({ status: 502, json: { error: 'SECRET_CODE', message: 'token=NEVER_SHOW', details: 'NEVER_SHOW' } });
    data.accounts[1].post_rebind_trial_status = 'error';
    return route.fulfill({ status: 202, json: { check: { id: 'check-2', status: 'error' } } });
  });
  await page.locator('[data-account-status="rebound"]').click();
  for (let i = 0; i < 2; i++) {
    await page.locator('[data-action="trial-check"]').click();
    await page.waitForFunction(() => !state.trialRequests.get('done')?.busy);
    assert.doesNotMatch(await page.locator('#accountRows').innerText(), /SECRET_CODE|NEVER_SHOW/);
    await page.evaluate(() => loadAccounts());
  }
  assert.equal(requests[0].body.idempotencyKey, requests[1].body.idempotencyKey);
  await page.locator('[data-action="trial-latest"]').click();
  await page.waitForFunction(() => !state.trialRequests.get('done')?.busy);
  assert.equal(requests[2].method, 'GET');
  assert.equal(await page.evaluate(() => state.trialRequests.get('done').key), requests[0].body.idempotencyKey);
  assert.match(await page.locator('#accountRows').innerText(), /当前请求尚未确认/);
  latestCheck = { id: 'old-check', idempotency_key: 'different-key', status: 'eligible' };
  await page.locator('[data-action="trial-latest"]').click();
  await page.waitForFunction(() => !state.trialRequests.get('done')?.busy);
  assert.equal(await page.evaluate(() => state.trialRequests.get('done').key), requests[0].body.idempotencyKey);
  await page.locator('[data-action="trial-check"]').click();
  await page.waitForFunction(() => !state.trialRequests.get('done')?.busy);
  assert.equal(requests[4].body.idempotencyKey, requests[0].body.idempotencyKey);
  latestCheck = { id: 'matched-check', idempotency_key: requests[0].body.idempotencyKey, status: 'error' };
  await page.locator('[data-action="trial-latest"]').click();
  await page.waitForFunction(() => !state.trialRequests.get('done')?.busy);
  assert.equal(await page.evaluate(() => state.trialRequests.get('done').key), null);
  fail = false;
  await page.locator('[data-action="trial-check"]').click();
  await page.waitForFunction(() => !state.trialRequests.get('done')?.busy);
  assert.notEqual(requests[6].body.idempotencyKey, requests[0].body.idempotencyKey);
  await page.locator('[data-action="trial-check"]').click();
  await page.waitForFunction(() => !state.trialRequests.get('done')?.busy);
  assert.notEqual(requests[7].body.idempotencyKey, requests[6].body.idempotencyKey);
  assert.equal(calls.filter((call) => call.method !== 'GET').length, 0);
  assert.equal(data.accounts[1].email, 'new@test.local');
});

test('definite trial rejection clears keys and concurrent 409 refreshes active check without another POST', async (t) => {
  const { page, data, calls } = await accountFixture(t, true);
  const requests = [];
  let code = 'TRIAL_ACCOUNT_NOT_READY';
  await page.route('http://ui.test/api/admin/qualified-accounts/done/trial-check', async (route) => {
    requests.push({ method: route.request().method(), body: route.request().postDataJSON() });
    if (code === 'TRIAL_CHECK_ACTIVE') Object.assign(data.accounts[1], { post_rebind_trial_status: 'checking', post_rebind_trial_check_id: 'existing-check' });
    return route.fulfill({ status: code === 'INVALID_IDEMPOTENCY_KEY' ? 400 : 409,
      json: { error: code, message: 'token=NEVER_SHOW', details: 'NEVER_SHOW' } });
  });
  await page.locator('[data-account-status="rebound"]').click();
  for (const nextCode of ['TRIAL_ACCOUNT_NOT_READY', 'IDEMPOTENCY_CONFLICT', 'INVALID_IDEMPOTENCY_KEY', 'TRIAL_CHECK_ACTIVE']) {
    code = nextCode;
    const reads = data.reads;
    await page.locator('[data-action="trial-check"]').click();
    await page.waitForFunction(() => !state.trialRequests.get('done')?.busy);
    assert.equal(await page.evaluate(() => state.trialRequests.get('done').key), null);
    assert.ok(data.reads > reads);
    assert.doesNotMatch(await page.locator('#accountRows').innerText(), /结果未确认|NEVER_SHOW|TRIAL_|IDEMPOTENCY/);
  }
  assert.equal(new Set(requests.map((request) => request.body.idempotencyKey)).size, 4);
  assert.match(await page.locator('#accountRows').innerText(), /换绑后：检测中/);
  assert.match(await page.locator('#accountRows').innerText(), /已有资格检测正在进行/);
  assert.equal(await page.locator('[data-action="trial-check"]').isDisabled(), true);
  await page.evaluate(() => checkAccountTrial('done'));
  await page.clock.runFor(10000);
  await page.evaluate(() => loadAccounts());
  assert.equal(requests.length, 4);
  assert.equal(calls.filter((call) => call.method !== 'GET').length, 0);
});

test('trial history shows latest failure separately from email-matched confirmation without leaking errors', async (t) => {
  const { page, data } = await accountFixture(t);
  Object.assign(data.accounts[1], { post_rebind_trial_status: 'error', post_rebind_trial_checked_at: '2026-06-04',
    post_rebind_trial_error_code: 'LOGIN_FAILED', post_rebind_trial_error_category: 'NETWORK_TLS',
    post_rebind_trial_last_confirmed_status: 'eligible', post_rebind_trial_last_confirmed_email: 'NEW@test.local',
    post_rebind_trial_last_confirmed_checked_at: '2026-06-03', error: 'token=NEVER_SHOW' });
  await page.evaluate(() => loadAccounts());
  await page.locator('[data-account-status="rebound"]').click();
  await page.locator('[data-action="account-history"]').click();
  await page.waitForFunction(() => document.querySelector('#accountHistoryContent').textContent.includes('上次成功确认'));
  const text = await page.locator('#accountHistoryContent').innerText();
  assert.match(text, /最近检测失败，当前资格未确认/);
  assert.match(text, /登录未完成/);
  assert.doesNotMatch(text, /原因未确认/);
  assert.match(text, /网络 TLS 连接失败/);
  assert.match(text, /2026-06-04/);
  assert.match(text, /上次成功确认：有资格 · 2026-06-03/);
  assert.doesNotMatch(text, /NEVER_SHOW|核对账号凭据/);
  assert.equal(await page.evaluate(() => accountTrialFilter(state.accounts.find((a) => a.id === 'done'))), 'error');
  data.accounts[1].email = 'changed@test.local';
  data.accounts[1].post_rebind_trial_error_code = 'token=NEVER_SHOW';
  data.accounts[1].post_rebind_trial_error_category = 'token=NEVER_SHOW';
  await page.evaluate(() => loadAccounts(true));
  assert.doesNotMatch(await page.locator('#accountHistoryContent').innerText(), /上次成功确认|NEVER_SHOW/);
  Object.assign(data.accounts[1], { email: 'new@test.local', post_rebind_trial_error_code: 'NETWORK_TLS', post_rebind_trial_error_category: 'NETWORK_TLS' });
  await page.evaluate(() => loadAccounts(true));
  assert.equal((await page.locator('#accountHistoryContent').innerText()).match(/网络 TLS 连接失败/g).length, 1);
  data.accounts[1].post_rebind_trial_status = 'eligible';
  await page.evaluate(() => loadAccounts(true));
  assert.doesNotMatch(await page.locator('#accountHistoryContent').innerText(), /上次成功确认/);
  Object.assign(data.accounts[1], { post_rebind_trial_status: 'checking', post_rebind_trial_attempts: 2 });
  await page.evaluate(() => loadAccounts(true));
  assert.match(await page.locator('#accountHistoryContent').innerText(), /检测中第2\/3次/);
  data.accounts[1].post_rebind_trial_attempts = 0;
  await page.evaluate(() => loadAccounts(true));
  assert.doesNotMatch(await page.locator('#accountHistoryContent').innerText(), /第0\/3次|未尝试/);
});

test('trial stages and login diagnostics localize controlled fields without implying ineligibility', async (t) => {
  const { page, data } = await accountFixture(t);
  const account = data.accounts[1];
  const render = async () => {
    await page.evaluate(() => loadAccounts());
    return page.evaluate(() => accountTrialHtml(state.accounts.find((a) => a.id === 'done')));
  };
  Object.assign(account, { post_rebind_trial_status: 'checking', post_rebind_trial_stage: 'session_trial' });
  assert.match(await render(), /核验已有会话（失效后重新登录），资格查询尚未开始/);
  Object.assign(account, { post_rebind_trial_status: 'error', post_rebind_trial_stage: 'login_trial',
    post_rebind_trial_error_code: 'LOGIN_FAILED', post_rebind_trial_error_category: 'unknown',
    post_rebind_trial_error_phase: 'password_verify', post_rebind_trial_error_reason: 'LOGIN_CREDENTIALS_REJECTED' });
  let html = await render();
  assert.match(html, /重新登录，资格查询尚未开始/);
  assert.match(html, /登录步骤：验证密码：登录凭据校验未通过/);
  assert.doesNotMatch(html, /原因未确认|unknown|换绑后：无资格/);
  account.post_rebind_trial_error_category = 'tls';
  html = await render();
  assert.match(html, /登录凭据校验未通过/);
  assert.doesNotMatch(html, /原因未确认|TLS/);
  Object.assign(account, { post_rebind_trial_error_phase: 'bootstrap', post_rebind_trial_error_reason: 'LOGIN_STEP_FAILED' });
  html = await render();
  assert.match(html, /认证初始化：TLS连接失败/);
  assert.doesNotMatch(html, /登录步骤执行失败|原因未确认|凭据|密码/);
  Object.assign(account, { post_rebind_trial_error_category: 'unknown', post_rebind_trial_error_code: 'NETWORK_TLS' });
  html = await render();
  assert.match(html, /认证初始化：TLS连接失败/);
  assert.doesNotMatch(html, /登录步骤执行失败|原因未确认/);
  Object.assign(account, { post_rebind_trial_error_code: 'LOGIN_FAILED', post_rebind_trial_error_category: 'unknown' });
  html = await render();
  assert.match(html, /认证初始化：登录步骤执行失败/);
  assert.doesNotMatch(html, /原因未确认|凭据|密码/);
  account.post_rebind_trial_error_category = 'tls';
  Object.assign(account, { post_rebind_trial_stage: 'token=NEVER_SHOW',
    post_rebind_trial_error_phase: '<img src=x onerror=NEVER_SHOW>', post_rebind_trial_error_reason: 'token=NEVER_SHOW' });
  html = await render();
  assert.match(html, /网络 TLS 连接失败/);
  assert.doesNotMatch(html, /NEVER_SHOW|原因未确认/);
  Object.assign(account, { post_rebind_trial_status: 'checking', post_rebind_trial_stage: 'trial_qualification' });
  html = await render();
  assert.match(html, /检测阶段：查询试用资格/);
  assert.doesNotMatch(html, /资格查询尚未开始|登录步骤/);
});

test('trial login HTTP diagnostics explain validated statuses without guessing credentials or exposing raw values', async (t) => {
  const { page, data } = await accountFixture(t);
  const account = data.accounts[1];
  Object.assign(account, { post_rebind_trial_status: 'error', post_rebind_trial_stage: 'login_trial',
    post_rebind_trial_error_code: 'LOGIN_FAILED', post_rebind_trial_error_category: 'http',
    post_rebind_trial_error_phase: 'bootstrap', post_rebind_trial_error_reason: 'LOGIN_HTTP_ERROR' });
  const render = async () => {
    await page.evaluate(() => loadAccounts());
    return page.evaluate(() => accountTrialHtml(state.accounts.find((a) => a.id === 'done')));
  };
  for (const [status, label] of [[429, '登录服务限流（HTTP 429），本次已停止自动重试'],
    [403, '登录请求被服务端拦截（HTTP 403）'], [401, '登录认证未通过（HTTP 401）'],
    [500, '登录服务响应异常（HTTP 500）'], [100, '登录服务响应异常（HTTP 100）'],
    [599, '登录服务响应异常（HTTP 599）']]) {
    account.post_rebind_trial_http_status = status;
    const html = await render();
    assert.ok(html.includes(label));
    assert.doesNotMatch(html, /密码|凭据|原因未确认/);
    assert.equal((html.match(/HTTP/g) || []).length, 1);
  }
  for (const status of ['429', '<img src=x onerror=NEVER_SHOW>', null, 99, 600, 429.5, { code: 429 }]) {
    account.post_rebind_trial_http_status = status;
    const html = await render();
    assert.doesNotMatch(html, /HTTP|NEVER_SHOW|已停止自动重试|密码|凭据/);
  }
  Object.assign(account, { post_rebind_trial_http_status: 401, post_rebind_trial_error_reason: 'LOGIN_CREDENTIALS_REJECTED' });
  assert.match(await render(), /登录凭据校验未通过（HTTP 401）/);
  Object.assign(account, { post_rebind_trial_http_status: null, post_rebind_trial_error_reason: 'LOGIN_STEP_FAILED',
    post_rebind_trial_error_category: 'tls' });
  const html = await render();
  assert.match(html, /认证初始化：TLS连接失败/);
  assert.doesNotMatch(html, /HTTP|已停止自动重试/);
});

test('trial history real clicks use fresh account outside list, deduplicate POST and refresh by GET', async (t) => {
  const { page, data } = await accountFixture(t, true);
  const requests = [];
  let release;
  await page.route('**/done/trial-check', async (route) => {
    requests.push(route.request().method());
    await new Promise((resolve) => { release = resolve; });
    data.accounts[1].post_rebind_trial_status = 'checking';
    await route.fulfill({ status: 202, json: { check: { id: 'one', status: 'checking' } } });
  });
  await page.locator('[data-account-status="rebound"]').click();
  await page.locator('[data-action="account-history"]').click();
  const button = page.locator('#accountHistoryContent [data-action="trial-check"]');
  await button.waitFor();
  await page.evaluate(() => { state.accounts = []; renderAccounts(); });
  await button.click();
  await page.evaluate(() => document.querySelector('#accountHistoryContent [data-action="trial-check"]').dispatchEvent(new MouseEvent('click', { bubbles: true })));
  while (!release) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(await button.isDisabled(), true);
  assert.deepEqual(requests, ['POST']);
  release();
  await page.waitForFunction(() => !state.trialRequests.get('done')?.busy && document.querySelector('#accountHistoryContent').textContent.includes('检测中'));
  data.accounts[1].post_rebind_trial_status = 'error';
  data.accounts[1].post_rebind_trial_error_code = 'TIMEOUT';
  await page.clock.runFor(5000);
  await page.waitForFunction(() => document.querySelector('#accountHistoryContent').textContent.includes('检测超时'));
  assert.equal(await button.isEnabled(), true);
  assert.deepEqual(requests, ['POST']);
  data.accounts[1].rebind_status = 'needs_review';
  data.accounts[1].credential_ready = false;
  await button.click();
  await page.waitForFunction(() => !state.trialRequests.get('done')?.busy);
  assert.deepEqual(requests, ['POST']);
});

test('trial request for one account leaves another account history buttons enabled', async (t) => {
  const { page, data } = await accountFixture(t);
  const other = { ...data.accounts[1], id: 'other', email: 'other@test.local' };
  data.accounts.push(other);
  await page.route('**/other/rebind-history', (route) => route.fulfill({ json: { account: other, history: [] } }));
  let release;
  await page.route('**/done/trial-check', async (route) => {
    await new Promise((resolve) => { release = resolve; });
    await route.fulfill({ status: 502, json: { message: 'NEVER_SHOW' } });
  });
  await page.evaluate(() => loadAccounts());
  await page.locator('[data-account-status="rebound"]').click();
  await page.locator('[data-account-id="other"] [data-action="account-history"]').click();
  const otherButton = page.locator('#accountHistoryContent [data-action="trial-check"][data-id="other"]');
  await otherButton.waitFor();
  await page.locator('[data-account-id="done"] [data-action="trial-check"]').click();
  while (!release) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(await otherButton.isEnabled(), true);
  assert.equal(await page.evaluate(() => state.historyAccountId), 'other');
  release();
  await page.waitForFunction(() => !state.trialRequests.get('done')?.busy);
  assert.equal(await otherButton.isEnabled(), true);
  assert.equal(await page.evaluate(() => state.historyAccountId), 'other');
});

test('trial history unknown requests retain idempotency key across GET refresh and retry', async (t) => {
  const { page } = await accountFixture(t);
  const keys = [];
  await page.route('**/done/trial-check', async (route) => {
    if (route.request().method() === 'GET') return route.fulfill({ json: { check: null } });
    keys.push(route.request().postDataJSON().idempotencyKey);
    return route.fulfill({ status: 502, json: { message: 'token=NEVER_SHOW' } });
  });
  await page.locator('[data-account-status="rebound"]').click();
  await page.locator('[data-action="account-history"]').click();
  const button = page.locator('#accountHistoryContent [data-action="trial-check"]');
  await button.click();
  await page.waitForFunction(() => !state.trialRequests.get('done')?.busy && document.querySelector('#accountHistoryContent').textContent.includes('请求结果未确认'));
  await page.evaluate(() => loadAccounts(true));
  await page.locator('#accountHistoryContent [data-action="trial-latest"]').click();
  await page.waitForFunction(() => !state.trialRequests.get('done')?.busy && document.querySelector('#accountHistoryContent').textContent.includes('当前请求尚未确认'));
  await button.click();
  await page.waitForFunction(() => !state.trialRequests.get('done')?.busy && document.querySelector('#accountHistoryContent').textContent.includes('请求结果未确认'));
  assert.equal(keys.length, 2);
  assert.equal(keys[0], keys[1]);
  assert.doesNotMatch(await page.locator('#accountHistoryContent').innerText(), /NEVER_SHOW/);
});

test('account status counts deduplicate IDs; rebound clears date and searches both emails with safe history', async (t) => {
  const { page } = await accountFixture(t);
  assert.match(await page.locator('[data-account-status="all"]').innerText(), /全部 4/);
  await page.locator('[data-account-status="rebound"]').click();
  assert.equal(await page.locator('#accountDateFilter').inputValue(), 'all');
  assert.equal(await page.locator('#accountRows [data-account-id]').count(), 1);
  assert.match(await page.locator('#accountRows').innerText(), /old@test.local → new@test.local/);
  assert.match(await page.locator('#accountRows').innerText(), /已换绑·清理待重试/);
  for (const query of ['old@test', 'new@test']) {
    await page.locator('#accountSearchInput').fill(query);
    assert.equal(await page.locator('#accountRows [data-account-id]').count(), 1);
  }
  await page.locator('[data-action="account-history"]').click();
  await page.waitForFunction(() => document.querySelector('#accountHistoryContent').textContent.includes('failed@test.local'));
  const history = await page.locator('#accountHistoryContent').innerText();
  assert.match(history, /当前登录邮箱：new@test.local/);
  assert.match(history, /尝试目标邮箱：failed@test.local/);
  assert.match(history, /尚未验证/);
  assert.match(history, /后续收码不可用/);
  assert.match(history, /仍保护/);
  assert.doesNotMatch(history, /NEVER_SHOW/);
  await page.locator('#accountSearchInput').fill('');
  await page.locator('[data-account-status="needs_review"]').click();
  assert.equal(await page.locator('[data-action="reveal-account"]').isDisabled(), true);
  assert.match(await page.locator('#accountRows').innerText(), /上次确认邮箱/);
  await page.locator('[data-account-status="original"]').click();
  assert.equal(await page.locator('[data-action="reveal-account"]').isEnabled(), true);
});

test('refresh invalidates delayed reveal, copy revalidates and 409 clears credentials in Chinese', async (t) => {
  const { page, data } = await accountFixture(t);
  await page.locator('[data-account-status="rebound"]').click();
  data.revealDelay = 180;
  await page.locator('[data-action="reveal-account"]').click();
  await page.locator('#refreshAccountsButton').click();
  await page.waitForTimeout(240);
  assert.equal(await page.locator('#accountReveal').isHidden(), true);
  assert.equal(await page.locator('#revealedPassword').inputValue(), '');
  data.revealDelay = 0;
  await page.locator('[data-action="reveal-account"]').click();
  await page.waitForFunction(() => !document.querySelector('#accountReveal').hidden);
  const before = data.reveals;
  data.revealStatus = 409;
  await page.locator('[data-copy="revealedPassword"]').click();
  await page.waitForFunction(() => document.querySelector('#notice').textContent.includes('凭据尚未确认'));
  assert.equal(data.reveals, before + 1);
  assert.equal(await page.locator('#accountReveal').isHidden(), true);
  assert.equal(await page.locator('#revealedSession').inputValue(), '');
});

test('task navigation clears conflicting filters and locates account; passive refresh clears changed credentials', async (t) => {
  const { page, data, calls } = await accountFixture(t);
  await page.locator('#accountSearchInput').fill('not-found');
  await page.locator('#accountTrialFilter').selectOption('observed_ineligible');
  await page.evaluate(() => {
    rebindState.jobs = [{ id: 'job', account_id: 'done', original_email: 'old@test.local', target_email: 'new@test.local', state: 'completed' }];
    renderRebind();
    document.querySelector('#rebindJobRows [data-managed-account]').click();
  });
  await page.waitForFunction(() => document.activeElement.dataset.accountId === 'done');
  assert.equal(await page.locator('#accountSearchInput').inputValue(), '');
  await page.locator('[data-account-id="done"] [data-action="reveal-account"]').click();
  await page.waitForFunction(() => !document.querySelector('#accountReveal').hidden);
  data.accounts[1].rebind_status = 'needs_review';
  data.accounts[1].credential_ready = false;
  await page.evaluate(() => loadAccounts(true));
  assert.equal(await page.locator('#accountReveal').isHidden(), true);
  assert.equal(await page.locator('[data-account-id="done"] [data-action="reveal-account"]').isDisabled(), true);
  assert.equal(calls.filter((call) => call.method === 'POST').length, 0);
});

test('switching accounts drops delayed old reveal; successful copy fetches fresh credentials', async (t) => {
  const { page, data } = await accountFixture(t);
  await page.locator('[data-account-status="all"]').click();
  data.revealDelay = 200;
  await page.locator('[data-account-id="old"] [data-action="reveal-account"]').click();
  await page.waitForFunction(() => state.revealRequest > 0);
  data.revealDelay = 0;
  await page.locator('[data-account-id="done"] [data-action="reveal-account"]').click();
  await page.waitForFunction(() => document.querySelector('#revealedEmail').textContent === 'new@test.local');
  await page.waitForTimeout(240);
  assert.equal(await page.locator('#revealedEmail').textContent(), 'new@test.local');
  await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (text) => { window.copiedCredential = text; } } }));
  const before = data.reveals;
  await page.locator('[data-copy="revealedPassword"]').click();
  await page.waitForFunction(() => Boolean(window.copiedCredential));
  assert.equal(data.reveals, before + 1);
  assert.equal(await page.evaluate(() => window.copiedCredential), 'fresh-' + data.reveals);
});

test('visible account polling preserves focus and history; hidden page does not poll or submit work', async (t) => {
  const { page, data, calls } = await accountFixture(t, true);
  await page.locator('[data-account-status="rebound"]').click();
  await page.locator('[data-action="account-history"]').click();
  await page.waitForFunction(() => document.querySelector('#accountHistoryContent').textContent.includes('failed@test.local'));
  await page.locator('#accountSearchInput').fill('new@test');
  const before = data.reads;
  await page.clock.runFor(5000);
  await page.waitForFunction(() => !state.accountLoading);
  assert.ok(data.reads > before);
  assert.equal(await page.locator('#accountSearchInput').inputValue(), 'new@test');
  assert.equal(await page.locator('#accountSearchInput').evaluate((input) => input === document.activeElement), true);
  assert.equal(await page.locator('#accountHistory').isVisible(), true);
  await page.evaluate(() => Object.defineProperty(document, 'hidden', { configurable: true, value: true }));
  const hiddenReads = data.reads;
  await page.clock.runFor(10000);
  assert.equal(data.reads, hiddenReads);
  assert.equal(calls.filter((call) => call.method === 'POST').length, 0);
});

test('rebound ordering follows confirmation time across registration dates and list responses cannot regress state', async (t) => {
  const { page, data } = await accountFixture(t);
  data.accounts.push({ ...data.accounts[1], id: 'latest', email: 'latest@test.local', created_at: '2025-01-01T00:00:00Z', rebound_at: '2026-06-03T00:00:00Z' });
  await page.evaluate(() => loadAccounts());
  await page.locator('[data-account-status="rebound"]').click();
  assert.deepEqual(await page.locator('#accountRows [data-account-id]').evaluateAll((rows) => rows.map((row) => row.dataset.accountId)), ['latest', 'done']);
  assert.match(await page.locator('[data-account-id="latest"]').innerText(), /2025-01-01/);
  const stale = JSON.parse(JSON.stringify(data.accounts));
  data.accounts[1].rebind_status = 'needs_review';
  data.accounts[1].credential_ready = false;
  let count = 0;
  await page.route('http://ui.test/api/admin/qualified-accounts', async (route) => {
    const first = ++count === 1;
    if (first) await new Promise((resolve) => setTimeout(resolve, 180));
    await route.fulfill({ json: { accounts: first ? stale : data.accounts } });
  });
  await page.evaluate(() => Promise.all([loadAccounts(), loadAccounts()]));
  await page.locator('[data-account-status="needs_review"]').click();
  assert.equal(await page.locator('[data-account-id="done"] [data-action="reveal-account"]').isDisabled(), true);
});

test('three pools isolate feature-off, keep drafts and reject invalid or empty batches', async (t) => {
  const { page, config, calls } = await fixture(t);
  config.rebindStatus = 404;
  await openPools(page);
  assert.equal(await page.locator('#proxyForm button').isEnabled(), true);
  await page.locator('#proxyInput').fill('host:8080:user:secret\nbad\nhost:8080:user:secret');
  await page.locator('#proxyForm button').click();
  assert.match(await page.locator('#proxyPreview').textContent(), /无效行 1（行号：2）/);
  assert.equal(calls.filter((call) => call.method === 'POST').length, 0);
  await page.locator('[data-pool="rebind"]').click();
  await page.waitForFunction(() => poolState.rebind.disabled);
  assert.equal(await page.locator('#rebindProxyForm button').isDisabled(), true);
  await page.locator('[data-pool="task"]').click();
  assert.match(await page.locator('#proxyInput').inputValue(), /secret/);
  await page.locator('#proxyInput').fill('');
  await page.locator('#proxyForm').evaluate((form) => form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
  assert.equal(calls.filter((call) => call.method === 'POST').length, 0);
  assert.equal(await page.locator('body').innerText().then((text) => text.includes('raw-secret-password')), false);
});

test('replace confirmation, import success with failed refresh, and sanitized failure preserve expected draft', async (t) => {
  const { page, config, calls } = await fixture(t);
  await openPools(page);
  await page.locator('#proxyInput').fill('host:8080:user:secret');
  page.once('dialog', async (dialog) => { assert.match(dialog.message(), /当前库存：2 条；新有效记录：1 条/); await dialog.dismiss(); });
  await page.locator('#proxyForm button').click();
  assert.equal(calls.filter((call) => call.method === 'POST').length, 0);
  assert.equal(await page.locator('#proxyInput').inputValue(), 'host:8080:user:secret');
  config.importStatus = 400;
  page.once('dialog', (dialog) => dialog.accept());
  await page.locator('#proxyForm button').click();
  await page.waitForFunction(() => document.getElementById('proxyPreview').textContent.includes('格式'));
  assert.equal(await page.locator('#proxyInput').inputValue(), 'host:8080:user:secret');
  assert.equal(await page.locator('body').innerText().then((text) => text.includes('raw-secret-password')), false);
  config.importStatus = 200;
  config.failAfterImport = true;
  page.once('dialog', (dialog) => dialog.accept());
  await page.locator('#proxyForm button').click();
  await page.waitForFunction(() => document.getElementById('proxyPreview').textContent.includes('无需重复导入'));
  assert.equal(await page.locator('#proxyInput').inputValue(), '');
  assert.deepEqual(calls.filter((call) => call.method === 'POST').at(-1).body, { text: 'host:8080:user:secret', mode: 'replace' });
});

test('out-of-order search responses do not replace newest rows or steal input focus', async (t) => {
  const { page } = await fixture(t);
  await openPools(page);
  await page.locator('#poolSearch').fill('old');
  await page.locator('#poolSearch').fill('new');
  await page.waitForFunction(() => document.getElementById('proxyRows').textContent.includes('new'));
  await page.waitForTimeout(220);
  assert.match(await page.locator('#proxyRows').innerText(), /new/);
  assert.equal(await page.locator('#poolSearch').evaluate((node) => node === document.activeElement), true);
  await page.locator('#poolStatus').selectOption('consumed');
  await page.locator('[data-pool="control"]').click();
  assert.equal(await page.locator('#poolStatus option[value="consumed"]').textContent(), '已用');
  await page.locator('[data-pool="task"]').click();
  assert.equal(await page.locator('#poolStatus').inputValue(), 'consumed');
  assert.equal(await page.locator('#poolSearch').inputValue(), 'new');
});

test('TXT decoding, draft replacement cancellation and 4MB limit', async (t) => {
  const { page } = await fixture(t);
  await openPools(page);
  await page.locator('#proxyInput').fill('old:8080');
  page.once('dialog', (dialog) => dialog.dismiss());
  await page.locator('#proxyFile').setInputFiles({ name: 'fixture.txt', mimeType: 'text/plain', buffer: Buffer.from('\uFEFFnew:8080') });
  await page.waitForFunction(() => !poolState.task.busy);
  assert.equal(await page.locator('#proxyInput').inputValue(), 'old:8080');
  page.once('dialog', (dialog) => dialog.accept());
  await page.locator('#proxyFile').setInputFiles({ name: 'fixture.txt', mimeType: 'text/plain', buffer: Buffer.from('\uFEFFnew:8080', 'utf16le') });
  await page.waitForFunction(() => document.getElementById('proxyInput').value === 'new:8080');
  await page.locator('#proxyFile').setInputFiles({ name: 'large.txt', mimeType: 'text/plain', buffer: Buffer.alloc(4 * 1024 * 1024 + 1) });
  await page.waitForFunction(() => document.getElementById('proxyPreview').textContent.includes('文件读取失败'));
  assert.equal(await page.locator('#proxyInput').inputValue(), 'new:8080');
  const result = await page.evaluate(() => Object.keys(POOLS).map((kind) => preflightProxy('host:8080@user:pass\nhttp://host:8080:user:pass', kind)));
  assert.ok(result.every((item) => item.invalid.length === 0 && item.unique === 1));
});

test('rebind empty pool blocks manual creation; retry retains key without per-job proxy or automatic POST', async (t) => {
  const { page, config, calls } = await fixture(t);
  config.available = 0;
  await page.evaluate(() => switchView('rebind'));
  await page.locator('#rebindMailbox').selectOption('mail-1');
  assert.equal(await page.locator('[data-rebind-account]').isDisabled(), true);
  assert.match(await page.locator('#rebindPoolSummary').innerText(), /暂无可用代理/);
  config.available = 2;
  await page.evaluate(() => loadRebind());
  await page.evaluate(() => Object.defineProperty(crypto, 'randomUUID', { value: undefined, configurable: true }));
  config.jobStatus = 409;
  await page.locator('[data-rebind-account]').click();
  await page.waitForFunction(() => !rebindState.busy);
  const first = calls.filter((call) => call.method === 'POST').at(-1).body;
  assert.equal(first.idempotencyKey.length, 32);
  assert.equal('proxy' in first, false);
  await page.evaluate(() => loadRebind());
  config.jobStatus = 202;
  config.jobsFail = true;
  await page.locator('[data-rebind-account]').click();
  await page.waitForFunction(() => !rebindState.busy);
  assert.deepEqual(calls.filter((call) => call.method === 'POST').at(-1).body, first);
  assert.match(await page.locator('#rebindStatus').innerText(), /任务已提交.*保留已有任务/);
  assert.equal(calls.filter((call) => call.method === 'POST').length, 2);
  config.jobsFail = false;
  await page.evaluate(() => loadRebind());
  await page.locator('#rebindMailbox').focus();
  const sameNode = await page.evaluate(async () => {
    const row = document.querySelector('[data-rebind-account]');
    await loadRebind();
    return row === document.querySelector('[data-rebind-account]');
  });
  assert.equal(sameNode, true);
  assert.equal(await page.locator('#rebindMailbox').evaluate((node) => node === document.activeElement), true);
  assert.equal(calls.filter((call) => call.method === 'POST').length, 2);
});

test('blocked and disabled mailboxes clear selection and prevent creation while sync and cleanup remain available', async (t) => {
  const { page, config, calls } = await fixture(t);
  config.mailboxes.push({ id: 'mail-2', email: 'other@example.test', state: 'ready', remote_alias_count: 0 },
    { id: 'mail-off', email: 'off@example.test', state: 'disabled', remote_alias_count: 0 });
  await page.evaluate(() => switchView('rebind'));
  await page.locator('#rebindMailbox').selectOption('mail-1');
  assert.equal(await page.locator('[data-rebind-account]').isEnabled(), true);
  Object.assign(config.mailboxes[0], { creation_blocked: 1, creation_blocked_reason: '别名创建失败', creation_blocked_at: '2026-06-02T12:00:00Z' });
  await page.evaluate(() => loadRebind());
  assert.equal(await page.locator('#rebindMailbox').inputValue(), '');
  assert.equal(await page.locator('[data-rebind-account]').isDisabled(), true);
  for (const id of ['mail-1', 'mail-off']) {
    const option = page.locator(`#rebindMailbox option[value="${id}"]`);
    assert.equal(await option.evaluate((node) => node.disabled), true, await option.evaluate((node) => node.outerHTML));
    assert.match(await option.textContent(), /不可创建/);
  }
  await page.locator('#rebindMailbox').selectOption('mail-2');
  assert.equal(await page.locator('[data-rebind-account]').isEnabled(), true);
  await page.evaluate(async () => { await switchView('mail'); await loadMailboxes(); await selectMailbox('mail-1'); });
  assert.match(await page.locator('#mailboxRows').innerText(), /ready[\s\S]*创建不可用[\s\S]*别名创建失败[\s\S]*2026-06-02T12:00:00Z/);
  assert.equal(await page.locator('#createButton').isDisabled(), true);
  for (const selector of ['#syncButton', '#clearAliasesButton', '[data-action="release"]']) assert.equal(await page.locator(selector).isEnabled(), true);
  await page.locator('#syncButton').click();
  await page.waitForFunction(() => document.querySelector('#notice').textContent.includes('sync 完成'));
  assert.equal(calls.filter((call) => call.method === 'POST').length, 1);
  assert.match(calls.find((call) => call.method === 'POST').path, /\/sync$/);
  await page.locator('[data-action="release"]').click();
  await page.waitForFunction(() => document.querySelector('#notice').textContent.includes('release 完成'));
  assert.equal(calls.filter((call) => call.method === 'POST').length, 2);
  assert.equal(calls.filter((call) => call.method === 'POST').at(-1).path, '/api/admin/aliases/alias-1/release');
  await page.evaluate(() => switchView('registration'));
  assert.match(await page.locator('#registrationMailboxAvailability').innerText(), /可创建主邮箱：1/);
});

test('MAILBOX_CREATION_BLOCKED is Chinese and blocks only the selected mailbox without auto retry', async (t) => {
  const { page, config, calls } = await fixture(t);
  config.mailboxes.push({ id: 'mail-2', email: 'other@example.test', state: 'ready', remote_alias_count: 0 });
  config.jobStatus = 409;
  config.jobError = 'MAILBOX_CREATION_BLOCKED';
  await page.evaluate(() => switchView('rebind'));
  await page.locator('#rebindMailbox').selectOption('mail-1');
  await page.locator('[data-rebind-account]').click();
  await page.waitForFunction(() => !rebindState.busy);
  assert.match(await page.locator('#rebindStatus').innerText(), /主邮箱创建不可用.*其它主邮箱/);
  assert.doesNotMatch(await page.locator('#rebindStatus').innerText(), /raw-secret|MAILBOX_CREATION_BLOCKED/);
  assert.equal(await page.locator('#rebindMailbox').inputValue(), '');
  await page.locator('#rebindMailbox').selectOption('mail-2');
  assert.equal(await page.locator('[data-rebind-account]').isEnabled(), true);
  assert.equal(calls.filter((call) => call.method === 'POST').length, 1);
});

test('manual alias creation 409 disables creation while preserving mailbox management', async (t) => {
  const { page, config, calls } = await fixture(t);
  await page.evaluate(async () => { await loadMailboxes(); await selectMailbox('mail-1'); });
  let creates = 0;
  await page.route('http://ui.test/api/admin/mailboxes/mail-1/aliases', async (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    ++creates;
    Object.assign(config.mailboxes[0], { creation_blocked: 1, creation_blocked_reason: '创建失败', creation_blocked_at: '2026-06-03' });
    return route.fulfill({ status: 409, json: { code: 'MAILBOX_CREATION_BLOCKED', message: 'HTTP 409 password=NEVER_SHOW' } });
  });
  await page.locator('#createButton').click();
  await page.waitForFunction(() => document.querySelector('#createButton').disabled);
  assert.match(await page.locator('#notice').innerText(), /主邮箱创建不可用/);
  assert.doesNotMatch(await page.locator('#notice').innerText(), /HTTP|NEVER_SHOW/);
  assert.equal(await page.locator('#syncButton').isEnabled(), true);
  assert.equal(await page.locator('#clearAliasesButton').isEnabled(), true);
  assert.equal(creates, 1);
  assert.equal(calls.filter((call) => call.method === 'POST').length, 0);
});

test('preparation failure keeps original credentials and candidate history without automatic POST', async (t) => {
  const { page, config, calls, data } = await accountFixture(t, true);
  Object.assign(data.accounts[0], { rebind_status: 'original', credential_ready: true });
  config.rebindAccounts = [{ ...data.accounts[0], eligible: true, eligible_at: '2020-01-01T00:00:00Z' }];
  config.jobs = [{ id: 'prep', account_id: 'old', state: 'preparation_failed', stage: 'preparation_failed', new_email: 'candidate@example.test', last_error: 'HTTP 409 password=NEVER_SHOW' }];
  await page.route('http://ui.test/api/admin/qualified-accounts/old/rebind-history', (route) => route.fulfill({ json: {
    account: data.accounts[0], history: [
      { ...config.jobs[0], original_email: data.accounts[0].email, target_email: 'candidate@example.test', mailbox_receiving: 'create_failed' },
      { state: 'failed', stage: 'alias_create_failed', target_email: 'legacy@example.test', last_error: 'NEVER_SHOW' },
    ],
  } }));
  await page.evaluate(() => switchView('rebind'));
  await page.locator('#rebindMailbox').selectOption('mail-1');
  assert.equal(await page.locator('[data-rebind-account]').isEnabled(), true);
  assert.match(await page.locator('#rebindJobRows').innerText(), /准备邮箱失败（账号未换绑）/);
  assert.match(await page.locator('#rebindJobRows').innerText(), /尝试目标邮箱：candidate@example.test/);
  assert.doesNotMatch(await page.locator('#rebindJobRows').innerText(), /HTTP|NEVER_SHOW/);
  await page.clock.fastForward(16000);
  assert.equal(calls.filter((call) => call.method === 'POST').length, 0);
  await page.locator('#rebindJobRows [data-history]').click();
  await page.waitForFunction(() => document.querySelector('#accountHistoryContent').textContent.includes('legacy@example.test'));
  const history = await page.locator('#accountHistoryContent').innerText();
  assert.match(history, /当前登录邮箱：original@test.local · 未换绑/);
  assert.match(history, /目标邮箱未创建成功/);
  assert.match(history, /候选地址不可用于收信/);
  assert.doesNotMatch(history, /NEVER_SHOW|HTTP 409/);
  assert.equal(await page.locator('[data-action="reveal-account"][data-id="old"]').isEnabled(), true);
  assert.equal(data.reveals, 0);
  await page.locator('[data-action="reveal-account"][data-id="old"]').click();
  await page.waitForFunction(() => !document.querySelector('#accountReveal').hidden);
  assert.equal(await page.locator('#revealedEmail').innerText(), 'original@test.local');
  assert.equal(data.reveals, 1);
  assert.equal(calls.filter((call) => call.method === 'POST').length, 0);
});

test('mobile pool workspace remains within viewport', async (t) => {
  const { page } = await fixture(t);
  await page.setViewportSize({ width: 390, height: 844 });
  await openPools(page);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
});

test('original account without a separate session retains its current result display', async (t) => {
  const { page } = await accountFixture(t);
  await page.route('http://ui.test/api/admin/qualified-accounts/old/reveal', route => route.fulfill({ json: { account: {
    email: 'original@test.local', password: 'fixture', totpSecret: 'fixture', totp: '123456',
    session: null, result: { accessToken: 'current-fixture-token' },
  } } }));
  await page.locator('[data-account-id="old"] [data-action="reveal-account"]').click();
  await page.waitForFunction(() => !document.getElementById('accountReveal').hidden);
  assert.match(await page.locator('#revealedSession').inputValue(), /current-fixture-token/);
});
