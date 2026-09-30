'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { GatewayStore } = require('../src/db/store');
const { RegistrationStore } = require('../src/registration/store');
const { RegistrationService } = require('../src/registration/service');
const { SecretBox } = require('../src/security/secret-box');
const { createHttpServer } = require('../src/http/server');

function fixture(t) {
  const gateway = new GatewayStore({ filename: ':memory:' });
  t.after(() => gateway.close());
  const store = new RegistrationStore({
    db: gateway.db, secretBox: new SecretBox(Buffer.alloc(32, 7).toString('base64')),
    clock: () => Date.parse('2026-01-01T00:00:01Z'), registrationProxyRefreshMs: 60000,
  });
  const service = Object.assign(Object.create(RegistrationService.prototype), { store });
  return { store, service };
}

for (const [table, importer, overview] of [
  ['proxy_pool', 'importProxies', 'proxyOverview'],
  ['control_proxy_pool', 'importControlProxies', 'controlProxyOverview'],
]) {
  test(`${table} imports preserve state and validate before changes`, (t) => {
    const { store, service } = fixture(t);
    const values = ['one.test:1:user:secret', 'two.test:2:user:secret', 'three.test:3:user:secret'];
    service[importer](values);
    for (const [index, status] of ['reserved', 'consumed', 'quarantined'].entries()) {
      store.db.prepare(`UPDATE ${table} SET status = ?, consumed_at = ?, last_error = 'retained' WHERE id = ?`)
        .run(status, '2026-01-01T00:00:00.000Z', index + 1);
    }
    const states = () => store.db.prepare(`SELECT id, status, consumed_at, last_error FROM ${table} WHERE id <= 3 ORDER BY id`).all();
    const original = states();
    assert.throws(() => service[importer]('four.test:4:u:p', { mode: 'append' }), { code: 'INVALID_PROXY_MODE' });
    assert.equal(service[overview]().stats.total, 3);
    const replacedAll = service[importer]([...values, 'four.test:4:u:p'], { mode: 'replace' });
    assert.equal(replacedAll.current, 4);
    assert.equal(replacedAll.removed, 0);
    assert.equal(replacedAll.replaced, true);
    assert.deepEqual(states(), original);
    const filtered = service[overview]({ status: 'consumed', q: 'TWO.TEST', page: 1, limit: 1 });
    assert.equal(filtered.pagination.total, 1);
    assert.equal(filtered.stats.total, 4);
    assert.equal(filtered.proxies[0].cooldown_until, table === 'proxy_pool' ? '2026-01-01T00:01:00.000Z' : null);
    assert.equal(filtered.cooldownMs, table === 'proxy_pool' ? 60000 : 0);
    assert.equal(service[overview]({ q: 'secret' }).pagination.total, 0);
    assert.equal(service[overview]({ q: "' OR 1=1 --" }).pagination.total, 0);
    assert.equal(service[overview]({ q: '%' }).pagination.total, 0);
    assert.throws(() => service[overview]({ status: "available' OR 1=1 --" }), { code: 'INVALID_PROXY_STATUS' });
    for (const mode of [undefined, 'replace']) {
      assert.throws(() => service[importer]('valid.test:8:u:p\n\nhttp://secret-credential@', { mode }), (error) => {
        assert.deepEqual(error.details, [{ line: 3 }]);
        assert.doesNotMatch(JSON.stringify(error) + error.message, /secret-credential/);
        return error.code === 'INVALID_PROXY_LIST';
      });
      assert.equal(service[overview]().stats.total, 4);
    }
    assert.throws(() => service[importer](values, { mode: 'invalid' }), { code: 'INVALID_PROXY_MODE' });
    const replaced = service[importer]('four.test:4:u:p');
    assert.equal(replaced.removed, 3);
    assert.equal(replaced.current, 1);
    assert.deepEqual(states(), original);
    assert.deepEqual(store.db.prepare(`SELECT active FROM ${table} WHERE id <= 3`).all().map((row) => row.active), [0, 0, 0]);
    assert.throws(() => service[importer]('', { mode: 'replace' }), { code: 'EMPTY_PROXY_LIST' });
    assert.equal(service[overview]().stats.total, 1);
    assert.equal(service[importer](values, { mode: 'replace' }).restored, 3);
    assert.deepEqual(states(), original);
  });
}

test('control pool accepts both supplier forms and legacy formats', (t) => {
  const { service } = fixture(t);
  assert.equal(service.importControlProxies([
    'http://host.test:8080:user:password', 'host.test:8081@user:password',
    'host.test:8082:user:password', 'host.test:8083', 'http://user:password@host.test:8084',
  ]).current, 5);
});

test('proxy HTTP routes authenticate, forward filters and only allow replacement', async (t) => {
  const { service } = fixture(t);
  const calls = [];
  const rebindService = {
    proxyOverview: async (options) => { calls.push(options); return { proxies: [], stats: {}, pagination: { total: 0 } }; },
    importProxies: async (values, options) => { calls.push({ values, options }); return { added: 1 }; },
  };
  const server = createHttpServer({ service: {}, store: {}, registrationService: service, rebindService,
    adminApiKey: 'test-key', publicDir: path.join(__dirname, '..', 'public'), logger: { error() {} } });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const headers = { 'x-api-key': 'test-key', 'content-type': 'application/json' };
  const request = (route, options) => fetch(`http://127.0.0.1:${server.address().port}/api/admin/${route}`, options);
  for (const pool of ['proxies', 'control-proxies', 'rebind/proxies']) {
    assert.equal((await request(pool)).status, 401);
    assert.equal((await request(`${pool}/import`, { method: 'POST', body: '{}' })).status, 401);
  }
  assert.deepEqual(calls, []);
  for (const pool of ['proxies', 'control-proxies']) {
    const post = async (body) => {
      const response = await request(`${pool}/import`, { headers, method: 'POST', body: JSON.stringify(body) });
      assert.equal(response.status, 200);
      return response.json();
    };
    assert.equal((await post({ text: 'one.test:1:u:p' })).current, 1);
    const append = await request(`${pool}/import`, { headers, method: 'POST', body: JSON.stringify({ text: 'two.test:2:u:p', mode: 'append' }) });
    assert.equal(append.status, 400);
    assert.equal((await append.json()).error, 'INVALID_PROXY_MODE');
    assert.equal((await post({ proxies: ['one.test:1:u:p', 'two.test:2:u:p'], mode: 'replace' })).current, 2);
    const filtered = await (await request(`${pool}?status=available&q=two.test`, { headers })).json();
    assert.equal(filtered.pagination.total, 1);
    assert.equal(filtered.stats.total, 2);
    assert.equal((await request(`${pool}?status=invalid`, { headers })).status, 400);
    assert.equal((await post({ text: 'three.test:3:u:p' })).current, 1);
    const invalid = await request(`${pool}/import`, { headers, method: 'POST', body: JSON.stringify({ text: 'valid.test:4\nhttp://private-password@' }) });
    assert.equal(invalid.status, 400);
    const failure = await invalid.json();
    assert.match(failure.message, /2/);
    assert.doesNotMatch(JSON.stringify(failure), /private-password/);
  }
  assert.equal((await request('rebind/proxies?page=2&limit=7&status=quarantined&q=masked', { headers })).status, 200);
  assert.deepEqual(calls.pop(), { page: '2', limit: '7', status: 'quarantined', q: 'masked' });
  for (const body of [{ text: 'one', proxies: 'ignored', mode: 'replace' }, { proxies: ['two'] }, ['three']]) {
    assert.equal((await request('rebind/proxies/import', { headers, method: 'POST', body: JSON.stringify(body) })).status, 200);
  }
  assert.deepEqual(calls, [
    { values: 'one', options: { mode: 'replace' } },
    { values: ['two'], options: { mode: undefined } },
    { values: ['three'], options: { mode: undefined } },
  ]);
});

test('rebind proxy routes stay absent when rebind service is disabled', async (t) => {
  const server = createHttpServer({ service: {}, store: {}, adminApiKey: 'test-key',
    publicDir: path.join(__dirname, '..', 'public'), logger: { error() {} } });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  for (const [route, method] of [['proxies', 'GET'], ['proxies/import', 'POST']]) {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/admin/rebind/${route}`, {
      method, headers: { 'x-api-key': 'test-key' },
    });
    assert.equal(response.status, 404);
  }
});
