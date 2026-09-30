'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

const { createHttpServer } = require('../src/http/server');

test('HTTP server protects admin routes and serves plain-text public OTP responses', async (t) => {
  const service = {
    listMailboxes: () => [{ id: 'm1', email: 'main@example.com' }],
    accessPublicToken: async (token) => ({ found: true, code: token.startsWith('a') ? '123456' : null }),
  };
  const store = { listAliasEvents: () => [] };
  const server = createHttpServer({
    service,
    store,
    adminApiKey: 'test-admin-key',
    publicDir: path.join(__dirname, '..', 'public'),
    logger: { error() {} },
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;

  const unauthorized = await fetch(`${base}/api/admin/mailboxes`);
  assert.equal(unauthorized.status, 401);
  const authorized = await fetch(`${base}/api/admin/mailboxes`, { headers: { 'x-api-key': 'test-admin-key' } });
  assert.equal(authorized.status, 200);

  const tokenWithCode = `a${'b'.repeat(42)}`;
  const otp = await fetch(`${base}/m/${tokenWithCode}`);
  assert.equal(otp.headers.get('content-type'), 'text/plain; charset=utf-8');
  assert.equal(await otp.text(), '123456');
  const empty = await fetch(`${base}/m/${'c'.repeat(43)}`);
  assert.equal(empty.status, 200);
  assert.equal(await empty.text(), '');
});

test('public OTP route exposes mailbox polling failures instead of returning a false empty result', async (t) => {
  const server = createHttpServer({
    service: {
      accessPublicToken: async () => { throw new Error('mail body unavailable'); },
    },
    store: { listAliasEvents: () => [] },
    adminApiKey: 'test-admin-key',
    publicDir: path.join(__dirname, '..', 'public'),
    logger: { error() {} },
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const response = await fetch(`http://127.0.0.1:${server.address().port}/m/${'x'.repeat(43)}`);
  assert.equal(response.status, 502);
  assert.equal(await response.text(), '');
});

test('HTTP server exposes registration management only through authenticated admin routes', async (t) => {
  const calls = [];
  const registrationService = {
    listBatches: () => [{ id: 'batch-1', state: 'queued' }],
    createBatch: (count) => { calls.push(count); return { id: 'batch-2', requested_count: count }; },
    proxyOverview: () => ({ stats: { available: 4 }, proxies: [] }),
    importProxies: (text) => ({ current: String(text).split('\n').length }),
    controlProxyOverview: () => ({ stats: { available: 2 }, proxies: [] }),
    importControlProxies: (text) => ({ current: String(text).split('\n').length }),
    listQualifiedAccounts: () => [{ id: 'account-1', email: 'qualified@example.com' }],
    revealQualifiedAccount: () => ({ email: 'qualified@example.com', password: 'secret' }),
  };
  const server = createHttpServer({
    service: { listMailboxes: () => [] }, store: { listAliasEvents: () => [] }, registrationService,
    adminApiKey: 'test-admin-key', publicDir: path.join(__dirname, '..', 'public'), logger: { error() {} },
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const headers = { 'x-api-key': 'test-admin-key', 'content-type': 'application/json' };
  assert.equal((await fetch(`${base}/api/admin/registration-batches`)).status, 401);
  const created = await fetch(`${base}/api/admin/registration-batches`, {
    method: 'POST', headers, body: JSON.stringify({ count: 2 }),
  });
  assert.equal(created.status, 202);
  assert.deepEqual(calls, [2]);
  assert.equal((await fetch(`${base}/api/admin/proxies`, { headers })).status, 200);
  assert.equal((await fetch(`${base}/api/admin/control-proxies`, { headers })).status, 200);
  assert.equal((await fetch(`${base}/api/admin/control-proxies/import`, {
    method: 'POST', headers, body: JSON.stringify({ text: 'proxy.test:1:u:p' }),
  })).status, 200);
  assert.equal((await fetch(`${base}/api/admin/qualified-accounts/account-1/reveal`, {
    method: 'POST', headers, body: '{}',
  })).status, 200);
});
