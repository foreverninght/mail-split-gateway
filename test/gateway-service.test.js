'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { ALIAS_STATES } = require('../src/domain/state-machine');
const { GatewayStore } = require('../src/db/store');
const { RemoteOutcomeUnknownError } = require('../src/mailcom/adapter');
const { SecretBox } = require('../src/security/secret-box');
const { GatewayService } = require('../src/services/gateway-service');

const MASTER_KEY = Buffer.alloc(32, 7).toString('base64');

class FakeAdapter {
  constructor() {
    this.aliases = [];
    this.createError = null;
    this.deleteError = null;
    this.inboxCalls = 0;
    this.messages = [];
    this.openCalls = 0;
    this.maintainCalls = 0;
    this.maintenanceDue = false;
  }

  async open() { this.openCalls += 1; return { open: true }; }
  async close() { return true; }
  needsMaintenance() { return this.maintenanceDue; }
  async maintain() { this.maintainCalls += 1; return { open: true }; }
  async listDomains() { return [{ domain: 'example.com', state: 'ACTIVE' }]; }
  async listAliases() { return this.aliases.map((address) => ({ address })); }
  async aliasExists(_mailbox, address) { return this.aliases.includes(address); }
  async createAlias(_mailbox, address) {
    if (this.createError) throw this.createError;
    this.aliases.push(address);
    return { confirmed: true };
  }
  async deleteAlias(_mailbox, address) {
    if (this.deleteError) throw this.deleteError;
    this.aliases = this.aliases.filter((value) => value !== address);
    return { confirmed: true };
  }
  async fetchInbox() {
    this.inboxCalls += 1;
    await new Promise((resolve) => setTimeout(resolve, 10));
    return this.messages;
  }
  async fetchMessageBody() { return { ok: false }; }
}

function fixture(t) {
  const store = new GatewayStore({ filename: ':memory:' });
  const adapter = new FakeAdapter();
  const service = new GatewayService({
    store,
    adapter,
    secretBox: new SecretBox(MASTER_KEY),
    publicBaseUrl: 'https://mail.example.test',
  });
  t.after(() => store.close());
  return { adapter, service, store };
}

async function readyMailbox(service) {
  const mailbox = service.addMailbox({ email: 'main@example.com', password: 'secret' });
  await service.openMailbox(mailbox.id);
  service.importDomainCatalog([{ domain: 'example.com', state: 'HIDDEN', blacklisted: false }], 'test');
  return mailbox;
}

test('batch creation exports opaque API lines and public access delivers OTP', async (t) => {
  const { adapter, service, store } = fixture(t);
  const mailbox = await readyMailbox(service);
  const [created] = await service.createBatch(mailbox.id, 1);
  assert.equal(created.ok, true);
  assert.match(created.exportLine, /^.+@example\.com----https:\/\/mail\.example\.test\/m\/[A-Za-z0-9_-]{43}$/);
  assert.equal(created.alias.state, ALIAS_STATES.EXPORTED);

  adapter.messages = [{
    id: 'mail-1',
    to: [created.alias.email],
    sender: 'OpenAI <noreply@openai.com>',
    subject: 'Your ChatGPT verification code is 123456',
    text: 'Your verification code is 123456',
    receivedAt: new Date().toISOString(),
  }];
  const result = await service.accessPublicToken(created.token);
  assert.deepEqual(result, { found: true, code: '123456' });
  assert.equal(store.getAlias(created.alias.id).state, ALIAS_STATES.DELIVERED);
  assert.equal(store.latestOtp(created.alias.id).delivered_count, 1);
});

test('simultaneous public requests share one mailbox inbox fetch', async (t) => {
  const { adapter, service } = fixture(t);
  const mailbox = await readyMailbox(service);
  const [created] = await service.createBatch(mailbox.id, 1);
  adapter.messages = [];
  await Promise.all([
    service.accessPublicToken(created.token),
    service.accessPublicToken(created.token),
    service.accessPublicToken(created.token),
  ]);
  assert.equal(adapter.inboxCalls, 1);
});

test('public access rejects a matching message whose body cannot be read', async (t) => {
  const { adapter, service } = fixture(t);
  const mailbox = await readyMailbox(service);
  const [created] = await service.createBatch(mailbox.id, 1);
  adapter.messages = [{
    id: 'mail-with-unavailable-body',
    to: [created.alias.email],
    sender: 'ChatGPT <noreply@tm.openai.com>',
    subject: 'Your temporary ChatGPT verification code',
    text: '',
    receivedAt: new Date().toISOString(),
  }];

  await assert.rejects(
    service.accessPublicToken(created.token),
    (error) => error.code === 'MAIL_COM_BODY_UNAVAILABLE' && error.details.status === 0,
  );
});

test('unknown create result remains occupied and cannot be exported', async (t) => {
  const { adapter, service } = fixture(t);
  const mailbox = await readyMailbox(service);
  adapter.createError = new RemoteOutcomeUnknownError('create', 'unknown@example.com', new Error('timeout'));
  const [created] = await service.createBatch(mailbox.id, 1);
  assert.equal(created.ok, false);
  assert.equal(created.alias.state, ALIAS_STATES.CREATE_UNKNOWN);
  assert.equal(created.alias.token_hash, null);
});

test('release disables public reads before confirmed remote deletion', async (t) => {
  const { adapter, service, store } = fixture(t);
  const mailbox = await readyMailbox(service);
  const [created] = await service.createBatch(mailbox.id, 1);
  adapter.deleteError = new RemoteOutcomeUnknownError('delete', created.alias.email, new Error('timeout'));
  const released = await service.releaseAlias(created.alias.id);
  assert.equal(released.state, ALIAS_STATES.DELETE_UNKNOWN);
  assert.deepEqual(await service.accessPublicToken(created.token), { found: false, code: null });
  assert.equal(store.getAlias(created.alias.id).state, ALIAS_STATES.DELETE_UNKNOWN);
});

test('process restart closes sessions and makes interrupted remote operations reconcilable', async (t) => {
  const { service, store } = fixture(t);
  const mailbox = await readyMailbox(service);
  const creating = store.createAlias({ mailboxId: mailbox.id, email: 'creating@example.com' });
  const recovered = service.recoverAfterRestart();
  assert.deepEqual(recovered, { mailboxes: 1, aliases: 1 });
  assert.equal(store.getMailbox(mailbox.id).state, 'closed');
  assert.equal(store.getAlias(creating.id).state, ALIAS_STATES.CREATE_UNKNOWN);
});

test('create_unknown is exported only after remote reconciliation confirms it exists', async (t) => {
  const { adapter, service, store } = fixture(t);
  const mailbox = await readyMailbox(service);
  adapter.createError = new RemoteOutcomeUnknownError('create', 'unknown@example.com', new Error('timeout'));
  const [created] = await service.createBatch(mailbox.id, 1);
  adapter.aliases.push(created.alias.email);
  const reconciled = await service.reconcileAlias(created.alias.id);
  assert.equal(reconciled.alias.state, ALIAS_STATES.EXPORTED);
  assert.match(reconciled.exportLine, new RegExp(`^${created.alias.email}----https://`));
  assert.equal(store.findAliasByTokenHash(require('../src/security/tokens').hashToken(reconciled.token)).id, created.alias.id);
  assert.equal(store.getMailbox(mailbox.id).remote_alias_count, 1);
});

test('duplicate mailbox is rejected as a business conflict without exposing SQLite errors', (t) => {
  const { service } = fixture(t);
  service.addMailbox({ email: 'Main@Example.com', password: 'one' });
  assert.throws(
    () => service.addMailbox({ email: 'main@example.com', password: 'two' }),
    (error) => error.code === 'MAILBOX_ALREADY_EXISTS'
      && error.statusCode === 409
      && !/UNIQUE|constraint|SQLite/i.test(error.message),
  );
});

test('alias creation uses only hidden non-blacklisted suffixes', async (t) => {
  const { service } = fixture(t);
  const mailbox = service.addMailbox({ email: 'main@example.com', password: 'secret' });
  await service.openMailbox(mailbox.id);
  service.importDomainCatalog([
    { domain: 'hidden.example', state: 'HIDDEN', blacklisted: false },
    { domain: 'visible.example', state: 'ACTIVE', blacklisted: false },
    { domain: 'blocked.example', state: 'HIDDEN', blacklisted: true },
  ], 'test');
  const results = await service.createBatch(mailbox.id, 3);
  assert.equal(results.every((item) => item.alias.email.endsWith('@hidden.example')), true);
});

test('deleting confirmed aliases does not reset the suffix hourly limit', async (t) => {
  const { service } = fixture(t);
  const mailbox = await readyMailbox(service);
  const created = await service.createBatch(mailbox.id, 3);
  for (const result of created) await service.releaseAlias(result.alias.id);
  await assert.rejects(() => service.createBatch(mailbox.id, 1), /hourly capacity is 0/);
});

test('definite remote creation failures release suffix capacity', async (t) => {
  const { adapter, service } = fixture(t);
  const mailbox = await readyMailbox(service);
  adapter.createError = new Error('remote rejected before creation');
  for (let index = 0; index < 4; index += 1) {
    const [result] = await service.createBatch(mailbox.id, 1);
    assert.equal(result.ok, false);
  }
});

test('first public access after restart reopens one mailbox session through the state machine', async (t) => {
  const { adapter, service, store } = fixture(t);
  const mailbox = await readyMailbox(service);
  const [created] = await service.createBatch(mailbox.id, 1);
  service.recoverAfterRestart();
  assert.equal(store.getMailbox(mailbox.id).state, 'closed');
  await Promise.all([
    service.accessPublicToken(created.token),
    service.accessPublicToken(created.token),
  ]);
  assert.equal(store.getMailbox(mailbox.id).state, 'ready');
  assert.equal(adapter.openCalls, 2);
});

test('active maintenance moves the persisted mailbox through renewing back to ready', async (t) => {
  const { adapter, service, store } = fixture(t);
  const mailbox = await readyMailbox(service);
  adapter.maintenanceDue = true;

  assert.equal(service.needsMailboxSessionMaintenance(mailbox.id), true);
  const maintained = await service.maintainMailboxSession(mailbox.id);

  assert.equal(maintained.state, 'ready');
  assert.equal(adapter.maintainCalls, 1);
  const events = store.db.prepare(`
    SELECT event, from_state, to_state
    FROM mailbox_events
    WHERE mailbox_id = ?
    ORDER BY id DESC
    LIMIT 2
  `).all(mailbox.id).reverse().map((event) => ({ ...event }));
  assert.deepEqual(events, [
    { event: 'renew', from_state: 'ready', to_state: 'renewing' },
    { event: 'opened', from_state: 'renewing', to_state: 'ready' },
  ]);
});

test('clear discovers existing remote aliases and confirms every deletion through the state machine', async (t) => {
  const { adapter, service, store } = fixture(t);
  const mailbox = await readyMailbox(service);
  adapter.aliases = ['old-one@example.com', 'old-two@example.com'];
  const cleared = await service.clearRemoteAliases(mailbox.id);
  assert.deepEqual({ requested: cleared.requested, deleted: cleared.deleted, failed: cleared.failed }, {
    requested: 2,
    deleted: 2,
    failed: 0,
  });
  assert.equal(adapter.aliases.length, 0);
  assert.equal(store.getMailbox(mailbox.id).remote_alias_count, 0);
  assert.equal(store.listAliases({ mailboxId: mailbox.id }).every((alias) => alias.state === ALIAS_STATES.DELETED), true);
});
