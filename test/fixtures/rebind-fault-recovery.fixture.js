'use strict';

const { GatewayStore } = require('../../src/db/store');
const { GatewayService } = require('../../src/services/gateway-service');
const { RegistrationStore } = require('../../src/registration/store');
const { RebindStore, COOLDOWN_MS } = require('../../src/rebind/store');
const { RebindService } = require('../../src/rebind/service');
const { SecretBox } = require('../../src/security/secret-box');

async function createFixture(t, worker) {
  const now = Date.parse('2026-01-02T00:00:00Z');
  const clock = () => now;
  const gatewayStore = new GatewayStore({ filename: ':memory:', clock });
  const secretBox = new SecretBox(Buffer.alloc(32, 19).toString('base64'));
  const remote = [];
  const adapter = {
    async open() {}, async listDomains() { return []; },
    async listAliases() { return remote.map((address) => ({ address })); },
    async createAlias(_mailbox, email) { remote.push(email); },
    async deleteAlias(_mailbox, email) { remote.splice(remote.indexOf(email), 1); },
    async aliasExists(_mailbox, email) { return remote.includes(email); },
    async fetchInbox() { return []; }, async fetchMessageBody() { return { ok: false }; },
  };
  const gateway = new GatewayService({ store: gatewayStore, secretBox, adapter, clock, poller: { async refresh() {} } });
  const mailbox = gateway.addMailbox({ email: 'main@example.test', password: 'fixture-mail-password' });
  await gateway.openMailbox(mailbox.id);
  gateway.importDomainCatalog([{ domain: 'example.test', state: 'HIDDEN', blacklisted: false }], 'fixture');
  const registration = new RegistrationStore({ db: gatewayStore.db, secretBox, clock });
  const originalAlias = gatewayStore.discoverAlias({ mailboxId: mailbox.id, email: 'old@example.test' });
  const batch = registration.createBatch(1);
  const task = registration.createTask({ batchId: batch.id, slot: 0, aliasId: originalAlias.id, email: originalAlias.email, webApi: 'fixture' });
  gatewayStore.db.prepare(`INSERT INTO qualified_accounts
    (id, task_id, email, encrypted_password, encrypted_totp_secret, encrypted_result_json, trial_summary, created_at)
    VALUES ('account', ?, ?, ?, ?, ?, 'eligible', ?)`).run(task.id, originalAlias.email,
    secretBox.seal('fixture-password'), secretBox.seal('fixture-totp'),
    secretBox.seal(JSON.stringify({ accountId: 'fixture-account', trial_qualification: 'observed_eligible' })),
    new Date(now - COOLDOWN_MS).toISOString());
  const store = new RebindStore({ db: gatewayStore.db, secretBox, clock });
  const service = new RebindService({ store, gatewayService: gateway, worker, secretBox, registrationStore: registration, clock });
  service.importProxies(['http://fixture.invalid:8001', 'http://fixture.invalid:8002', 'http://fixture.invalid:8003']);
  gateway.readInternalCode = async () => '123456';
  t.after(async () => { await service.close(); gatewayStore.close(); });
  return { service, store, gateway, registration, mailbox, secretBox };
}

module.exports = { createFixture };
