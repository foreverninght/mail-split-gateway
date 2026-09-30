'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const { createHttpServer } = require('../src/http/server');

async function fixture(t, rebindService) {
  const server = createHttpServer({
    service: { listMailboxes: () => [{ id: 'mail-1', email: 'target@example.com' }] },
    store: {}, rebindService, adminApiKey: 'test-key',
    publicDir: path.join(__dirname, '..', 'public'), logger: { error() {} },
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return (route, options = {}) => fetch(`http://127.0.0.1:${server.address().port}${route}`, options);
}
const headers = { 'x-api-key': 'test-key', 'content-type': 'application/json' };

test('reconciliation routes authenticate and only forward explicit idempotency key', async (t) => {
  const calls = [], payload = { job: { id: 'job', state: 'needs_review' }, recovery: { recovery_state: 'checking' } };
  const request = await fixture(t, {
    getReconciliation: (id) => { calls.push(id); return payload; },
    reconcile: (id, options) => { calls.push({ id, ...options }); return payload; },
  });
  const route = '/api/admin/rebind/jobs/job/reconcile';
  for (const method of ['GET','POST']) assert.equal((await request(route, { method })).status, 401);
  assert.deepEqual(calls, []);
  const response = await request(route, { method: 'POST', headers, body: JSON.stringify({ idempotencyKey: 'one', automatic: true, proxy: 'ignored' }) });
  assert.equal(response.status, 202);
  assert.deepEqual(await response.json(), payload);
  assert.deepEqual(calls, [{ id: 'job', idempotencyKey: 'one' }]);
  assert.deepEqual(await (await request(route, { headers })).json(), payload);
});


test('trial routes preserve authentication, body allowlist and asynchronous response contract', async (t) => {
  const calls = [];
  const check = { id: 'trial', state: 'queued', idempotency_key: 'key' };
  const request = await fixture(t, {
    startTrialCheck: (input) => { calls.push(input); return check; },
    getTrialCheck: (id) => { calls.push(id); return id === 'empty' ? null : check; },
  });
  const route = '/api/admin/qualified-accounts/account/trial-check';
  for (const method of ['GET', 'POST']) assert.equal((await request(route, { method })).status, 401);
  assert.deepEqual(calls, []);
  const response = await request(route, { headers, method: 'POST', body: JSON.stringify({ idempotencyKey: 'key', proxy: 'ignored', automatic: true }) });
  assert.equal(response.status, 202);
  assert.deepEqual(await response.json(), { check });
  assert.deepEqual(calls, [{ accountId: 'account', idempotencyKey: 'key' }]);
  const get = await request(route, { headers });
  assert.equal(get.status, 200);
  assert.deepEqual(await get.json(), { check });
  assert.deepEqual(await (await request('/api/admin/qualified-accounts/empty/trial-check', { headers })).json(), { check: null });
  assert.equal((await request(route, { headers, method: 'POST', body: '{' })).status, 400);
});

test('rebind routes authenticate all reads and writes before invoking the service', async (t) => {
  let calls = 0;
  const invoke = () => { calls++; return []; };
  const request = await fixture(t, { listAccounts: invoke, listJobs: invoke, getJob: invoke, createJob: invoke, retryCleanup: invoke });
  for (const [method, route] of [
    ['GET', '/accounts'], ['GET', '/jobs'], ['GET', '/jobs/job-1'],
    ['POST', '/jobs'], ['POST', '/jobs/job-1/retry-cleanup'],
  ]) {
    assert.equal((await request(`/api/admin/rebind${route}`, { method })).status, 401);
  }
  assert.equal(calls, 0);
});

test('rebind reads are passive and async creation and cleanup use separate service methods', async (t) => {
  const writes = [];
  const account = { id: 'account-1', email: 'a@example.com', cooldown_until: '2020-01-01T00:00:00Z', can_rebind: true };
  const job = { id: 'job-1', state: 'cleanup_pending', account_id: account.id };
  const request = await fixture(t, {
    listAccounts: () => [account], listJobs: async () => [job],
    getJob: (id) => id === job.id ? job : null,
    createJob: async (input) => { writes.push(input); return job; },
    retryCleanup: async (id) => { writes.push({ cleanup: id }); return job; },
  });
  for (let n = 0; n < 3; n++) {
    assert.deepEqual(await (await request('/api/admin/rebind/accounts', { headers })).json(), { accounts: [account] });
    assert.deepEqual(await (await request('/api/admin/rebind/jobs', { headers })).json(), { jobs: [job] });
    assert.deepEqual(await (await request('/api/admin/rebind/jobs/job-1', { headers })).json(), { job });
  }
  assert.deepEqual(writes, []);
  assert.equal((await request('/api/admin/rebind/jobs/missing', { headers })).status, 404);
  const input = { accountId: account.id, mailboxId: 'mail-1', proxy: 'http://proxy.test:80', idempotencyKey: 'request-1' };
  const created = await request('/api/admin/rebind/jobs', { headers, method: 'POST', body: JSON.stringify({ ...input, ignored: true }) });
  assert.equal(created.status, 202);
  assert.deepEqual(await created.json(), { job });
  assert.deepEqual(writes, [input]);
  assert.equal((await request('/api/admin/rebind/jobs/job-1/retry-cleanup', { headers, method: 'POST' })).status, 202);
  assert.deepEqual(writes, [input, { cleanup: 'job-1' }]);
});

test('rebind optional service preserves legacy routes and errors follow admin conventions', async (t) => {
  const disabled = await fixture(t);
  assert.equal((await disabled('/api/admin/rebind/accounts', { headers })).status, 404);
  assert.equal((await disabled('/api/admin/mailboxes', { headers })).status, 200);
  const request = await fixture(t, { createJob: async () => { throw Object.assign(new Error('account cooling down'), { statusCode: 409, code: 'account_cooling_down' }); } });
  const failure = await request('/api/admin/rebind/jobs', { headers, method: 'POST', body: '{}' });
  assert.equal(failure.status, 409);
  assert.deepEqual(await failure.json(), { error: 'account_cooling_down', message: 'account cooling down' });
  const invalid = await request('/api/admin/rebind/jobs', { headers, method: 'POST', body: '{' });
  assert.equal(invalid.status, 400);
});

test('rebind UI polling and cooldown expiry never submit jobs or cleanup automatically', async () => {
  const elements = new Map();
  const node = (id) => {
    if (!elements.has(id)) elements.set(id, { value: '', innerHTML: '', textContent: '', listeners: {}, querySelector: () => node(id + '-button'), addEventListener(name, handler) { this.listeners[name] = handler; }, classList: { toggle() {} } });
    return elements.get(id);
  };
  const requests = [];
  const intervals = [];
  let now = Date.parse('2025-01-01T00:00:00Z');
  let available = 1;
  class Clock extends Date { static now() { return now; } }
  const context = vm.createContext({
    document: { getElementById: node, querySelectorAll: () => [], querySelector: () => node('query') },
    sessionStorage: { getItem: () => '' }, Date: Clock, URLSearchParams,
    crypto: { getRandomValues: (bytes) => bytes.fill(171) },
    setInterval: (callback) => intervals.push(callback), setTimeout() {}, clearTimeout() {},
    fetch: async (url, options) => {
      requests.push({ url, method: options.method || 'GET', body: options.body });
      const body = url.includes('/proxies?') ? { stats: { total: available, available, reserved: 0, consumed: 0, quarantined: 0 }, proxies: [], pagination: { page: 1, pages: 1, total: available }, cooldownMs: 86400000 }
        : url.endsWith('/accounts') ? { accounts: [{ id: 'a1', email: 'a@example.com', eligible_at: '2025-01-02T00:00:00Z', eligible: true, password: 'DO_NOT_RENDER' }] }
        : url.endsWith('/jobs') ? { jobs: [{ id: 'j1', account_id: 'a1', state: 'cleanup_pending', raw: 'DO_NOT_RENDER' }] }
          : { mailboxes: [{ id: 'm1', email: 'target@example.com' }] };
      return { ok: true, json: async () => body };
    },
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8'), context);
  vm.runInContext("state.apiKey = 'key'; state.currentView = 'rebind';", context);
  node('rebindMailbox').value = 'm1';
  await vm.runInContext('loadRebind()', context);
  assert.match(node('rebindAccountRows').innerHTML, / disabled/);
  now += 24 * 60 * 60 * 1000;
  for (const callback of intervals) callback();
  await new Promise((resolve) => setImmediate(resolve));
  assert.doesNotMatch(node('rebindAccountRows').innerHTML, / disabled/);
  assert.match(node('rebindJobRows').innerHTML, /data-rebind-cleanup/);
  assert.ok(requests.length >= 6);
  assert.ok(requests.every((request) => request.method === 'GET'));
  assert.doesNotMatch(node('rebindAccountRows').innerHTML + node('rebindJobRows').innerHTML, /DO_NOT_RENDER/);
  assert.equal(vm.runInContext('rebindRequestId()', context), 'ab'.repeat(16));
  available = 0;
  await vm.runInContext('loadRebind()', context);
  assert.match(node('rebindAccountRows').innerHTML, / disabled/);
  await node('rebindAccountRows').listeners.click({ target: { closest: () => ({ dataset: { rebindAccount: 'a1' } }) } });
  assert.ok(requests.every((request) => request.method === 'GET'));
  available = 1;
  await vm.runInContext('loadRebind()', context);
  await node('rebindAccountRows').listeners.click({ target: { closest: () => ({ dataset: { rebindAccount: 'a1' } }) } });
  const posts = requests.filter((request) => request.method === 'POST');
  assert.equal(posts.length, 1);
  assert.equal(posts[0].url, '/api/admin/rebind/jobs');
  assert.equal(JSON.parse(posts[0].body).idempotencyKey, 'ab'.repeat(16));
  context.crypto.randomUUID = () => 'native-uuid';
  assert.equal(vm.runInContext('rebindRequestId()', context), 'native-uuid');
  vm.runInContext("rebindState.accounts[0].completed_job_id = 'done'; renderRebind();", context);
  assert.match(node('rebindAccountRows').innerHTML, /已换绑/);
  assert.match(node('rebindAccountRows').innerHTML, / disabled/);
  vm.runInContext("rebindState.accounts[0].completed_job_id = null; rebindState.accounts[0].active_job_id = 'j1'; rebindState.jobs[0].state = 'needs_review'; renderRebind();", context);
  assert.match(node('rebindAccountRows').innerHTML, /待核对/);
  assert.match(node('rebindAccountRows').innerHTML, / disabled/);
  vm.runInContext("rebindState.jobs[0].state = 'cleanup_pending'; rebindState.jobs[0].stage = 'completed'; renderRebind();", context);
  assert.match(node('rebindJobRows').innerHTML, /清理待重试 · 重登验证完成/);
  for (const stage of ['login_old', 'eligibility', 'begin', 'verify', 'login_new']) {
    assert.ok(vm.runInContext('REBIND_STAGE_LABELS[' + JSON.stringify(stage) + ']', context));
  }
});
