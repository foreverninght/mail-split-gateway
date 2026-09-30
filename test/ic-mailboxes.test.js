'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

const { IcAdapterRegistry } = require('../src/ic/adapter-registry');
const {
  IcPickupError,
  IkunaiDirectHtmlAdapter,
  parseIkunaiHtml,
  validateIkunaiUrl,
} = require('../src/ic/adapters/ikunai-direct-html');
const { IcMailboxService } = require('../src/ic/service');
const { IcMailboxStore } = require('../src/ic/store');
const { GatewayStore } = require('../src/db/store');
const { createHttpServer } = require('../src/http/server');
const { SecretBox } = require('../src/security/secret-box');
const { GatewayService } = require('../src/services/gateway-service');

const MASTER_KEY = Buffer.alloc(32, 13).toString('base64');
const EMAIL = 'mailbox-one@example.test';
const URL = `https://icloud.ikunai666.top/show/key_123/${EMAIL}`;

function html(email = EMAIL, code = '') {
  return `<!doctype html><html><head><meta name="pickup-email" content="${email}"><meta content="${code}" name="verification-code"></head></html>`;
}

function fixture(t, fetchImpl) {
  const gatewayStore = new GatewayStore({ filename: ':memory:' });
  const secretBox = new SecretBox(MASTER_KEY);
  const store = new IcMailboxStore({ db: gatewayStore.db });
  const registry = new IcAdapterRegistry().register('icloud.ikunai666.top', new IkunaiDirectHtmlAdapter({ fetchImpl }));
  const service = new IcMailboxService({
    store, secretBox, adapterRegistry: registry, publicBaseUrl: 'http://gateway.test:3110',
  });
  t.after(() => gatewayStore.close());
  return { gatewayStore, secretBox, service, store };
}

test('ikunai adapter validates URL identity and strict HTML fields', () => {
  assert.equal(validateIkunaiUrl(URL, EMAIL).hostname, 'icloud.ikunai666.top');
  assert.deepEqual(parseIkunaiHtml(html(EMAIL, '400202'), EMAIL), { status: 'code', code: '400202' });
  assert.deepEqual(parseIkunaiHtml(html(EMAIL, ''), EMAIL), { status: 'pending', code: null });
  assert.throws(() => validateIkunaiUrl(URL, 'other@icloud.com'), IcPickupError);
  assert.throws(() => parseIkunaiHtml(html('other@icloud.com', '400202'), EMAIL), /different mailbox/);
  assert.throws(() => parseIkunaiHtml('<html></html>', EMAIL), /missing required meta fields/);
  assert.throws(() => parseIkunaiHtml(html(EMAIL, '12345'), EMAIL), /malformed verification code/);
});

test('ikunai adapter distinguishes pending, code and upstream failure', async () => {
  let response = new Response(html(EMAIL), { status: 200, headers: { 'content-type': 'text/html' } });
  const adapter = new IkunaiDirectHtmlAdapter({ fetchImpl: async () => response });
  assert.deepEqual(await adapter.fetchCode({ upstreamUrl: URL, email: EMAIL }), { status: 'pending', code: null });
  response = new Response(html(EMAIL, '400202'), { status: 200 });
  assert.deepEqual(await adapter.fetchCode({ upstreamUrl: URL, email: EMAIL }), { status: 'code', code: '400202' });
  response = new Response('unavailable', { status: 503 });
  await assert.rejects(adapter.fetchCode({ upstreamUrl: URL, email: EMAIL }), /HTTP 503/);
});

test('IC import encrypts upstream URL and public tokens route without exposing secrets', async (t) => {
  let body = html(EMAIL);
  const { gatewayStore, service, store } = fixture(t, async () => new Response(body, { status: 200 }));
  const imported = service.importMailboxes(`${EMAIL}----${URL}`);
  assert.deepEqual(imported.counts, { imported: 1, duplicates: 0, invalid: 0 });
  assert.match(imported.results[0].exportLine, /^.+----http:\/\/gateway\.test:3110\/m\/[A-Za-z0-9_-]{43}$/);
  const row = gatewayStore.db.prepare('SELECT * FROM ic_mailboxes').get();
  assert.notEqual(row.encrypted_upstream_url, URL);
  assert.equal(service.listMailboxes()[0].encrypted_upstream_url, undefined);
  assert.equal(service.listMailboxes()[0].token_hash, undefined);

  const token = imported.results[0].exportLine.split('/m/')[1];
  assert.deepEqual(await service.accessPublicToken(token), { found: true, code: null });
  body = html(EMAIL, '400202');
  assert.deepEqual(await service.accessPublicToken(token), { found: true, code: '400202' });
  assert.equal(store.get(row.id).last_error, '');
  assert.equal(store.listEvents(row.id).filter((event) => event.event === 'pickup_code').length, 1);

  assert.deepEqual(service.importMailboxes(`${EMAIL}----${URL}`).counts, { imported: 0, duplicates: 1, invalid: 0 });
  const rotated = service.rotateToken(row.id);
  assert.ok(rotated.exportLine);
  assert.deepEqual(await service.accessPublicToken(token), { found: false, code: null });
});

test('split-mail gateway falls through to IC tokens only when no split token exists', async () => {
  const calls = [];
  const service = new GatewayService({
    store: { findAliasByTokenHash: () => null },
    adapter: {}, secretBox: {}, publicBaseUrl: 'http://gateway.test',
    poller: {},
    icMailboxService: { accessPublicToken: async (token) => { calls.push(token); return { found: true, code: '654321' }; } },
  });
  assert.deepEqual(await service.accessPublicToken('token'), { found: true, code: '654321' });
  assert.deepEqual(calls, ['token']);
});

test('IC admin routes import, list, test and rotate while public route preserves polling semantics', async (t) => {
  let body = html(EMAIL);
  const { service: icMailboxService } = fixture(t, async () => new Response(body, { status: 200 }));
  const gatewayService = { listMailboxes: () => [], accessPublicToken: (token) => icMailboxService.accessPublicToken(token) };
  const server = createHttpServer({
    service: gatewayService,
    store: { listAliasEvents: () => [] },
    icMailboxService,
    adminApiKey: 'key',
    publicDir: path.join(__dirname, '..', 'public'),
    logger: { error() {} },
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const headers = { 'x-api-key': 'key', 'content-type': 'application/json' };
  const importedResponse = await fetch(`${base}/api/admin/ic-mailboxes/import`, {
    method: 'POST', headers, body: JSON.stringify({ text: `${EMAIL}----${URL}` }),
  });
  const imported = await importedResponse.json();
  assert.equal(imported.counts.imported, 1);
  const token = imported.results[0].exportLine.split('/m/')[1];
  const pending = await fetch(`${base}/m/${token}`);
  assert.equal(pending.status, 200);
  assert.equal(await pending.text(), '');
  body = html(EMAIL, '400202');
  assert.equal(await (await fetch(`${base}/m/${token}`)).text(), '400202');

  const list = await (await fetch(`${base}/api/admin/ic-mailboxes`, { headers })).json();
  assert.equal(list.mailboxes.length, 1);
  const id = list.mailboxes[0].id;
  const tested = await (await fetch(`${base}/api/admin/ic-mailboxes/${id}/test`, {
    method: 'POST', headers, body: '{}',
  })).json();
  assert.deepEqual({ status: tested.result.status, code: tested.result.code }, { status: 'code', code: '400202' });
  assert.equal((await fetch(`${base}/api/admin/ic-mailboxes/${id}/rotate-token`, {
    method: 'POST', headers, body: '{}',
  })).status, 200);
});
