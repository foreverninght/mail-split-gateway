'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { ALIAS_STATES } = require('../src/domain/state-machine');
const { GatewayStore } = require('../src/db/store');
const { SecretBox } = require('../src/security/secret-box');
const { CleanupScheduler } = require('../src/services/cleanup-scheduler');
const { GatewayService } = require('../src/services/gateway-service');

test('delivered aliases are deleted only after their retention deadline', async (t) => {
  let now = Date.parse('2026-08-30T00:00:00.000Z');
  const store = new GatewayStore({ filename: ':memory:', clock: () => now });
  t.after(() => store.close());
  const adapter = {
    aliases: [],
    async open() {},
    async listDomains() { return [{ domain: 'example.com', state: 'ACTIVE' }]; },
    async listAliases() { return this.aliases.map((address) => ({ address })); },
    async createAlias(_mailbox, address) { this.aliases.push(address); },
    async deleteAlias(_mailbox, address) { this.aliases = this.aliases.filter((item) => item !== address); },
    async fetchInbox() { return this.messages || []; },
    async fetchMessageBody() { return { ok: false }; },
  };
  const service = new GatewayService({
    store,
    adapter,
    secretBox: new SecretBox(Buffer.alloc(32, 9).toString('base64')),
    publicBaseUrl: 'https://mail.example.test',
    deliveredRetentionMs: 30 * 60 * 1000,
    clock: () => now,
  });
  const mailbox = service.addMailbox({ email: 'main@example.com', password: 'secret' });
  await service.openMailbox(mailbox.id);
  service.importDomainCatalog([
    { domain: 'example.com', state: 'HIDDEN', blacklisted: false },
  ], 'test');
  const [created] = await service.createBatch(mailbox.id, 1);
  adapter.messages = [{
    id: 'mail-1',
    to: [created.alias.email],
    sender: 'OpenAI',
    subject: 'Verification code 654321',
    text: 'Verification code 654321',
    receivedAt: new Date(now).toISOString(),
  }];
  await service.accessPublicToken(created.token);

  const scheduler = new CleanupScheduler({ store, service, clock: () => now });
  assert.equal((await scheduler.run()).due, 0);
  now += 30 * 60 * 1000 + 1;
  assert.equal((await scheduler.run()).due, 1);
  assert.equal(store.getAlias(created.alias.id).state, ALIAS_STATES.DELETED);
});
