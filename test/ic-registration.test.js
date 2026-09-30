'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { GatewayStore } = require('../src/db/store');
const { reconcileAssignedIcMailboxes } = require('../src/db/schema');
const { IcMailboxService } = require('../src/ic/service');
const { IcMailboxStore } = require('../src/ic/store');
const { RegistrationService } = require('../src/registration/service');
const { RegistrationStore } = require('../src/registration/store');
const { SecretBox } = require('../src/security/secret-box');
const { hashToken } = require('../src/security/tokens');

function fixture({
  precheckFails = false,
  initialCode = null,
  mailboxCount = 1,
  pickupNetworkFailures = 0,
  pickupDelayMs = 0,
} = {}) {
  const gatewayStore = new GatewayStore({ filename: ':memory:' });
  const secretBox = new SecretBox(Buffer.alloc(32, 12).toString('base64'));
  const icStore = new IcMailboxStore({ db: gatewayStore.db });
  const localParts = ['one', 'two'];
  for (let index = 0; index < mailboxCount; index += 1) {
    const email = `${localParts[index] || `mailbox-${index + 1}`}@icloud.com`;
    icStore.create({
      id: `ic-${index + 1}`,
      email,
      encryptedUpstreamUrl: secretBox.seal(`https://icloud.ikunai666.top/show/key/${email}`),
      pickupHostname: 'icloud.ikunai666.top',
      adapterKey: 'ikunai_direct_html',
      tokenHash: hashToken(`old-token-${index + 1}`),
    });
  }
  const pickup = { code: initialCode, calls: 0, active: 0, maxActive: 0 };
  const icMailboxService = new IcMailboxService({
    store: icStore,
    secretBox,
    adapterRegistry: {
      get() {
        return {
          async fetchCode() {
            pickup.calls += 1;
            const call = pickup.calls;
            pickup.active += 1;
            pickup.maxActive = Math.max(pickup.maxActive, pickup.active);
            try {
              if (pickupDelayMs) await new Promise((resolve) => setTimeout(resolve, pickupDelayMs));
              if (call <= pickupNetworkFailures) {
                throw Object.assign(new Error('temporary socket close'), { code: 'IC_UPSTREAM_NETWORK_ERROR' });
              }
              return pickup.code == null
                ? { status: 'pending', code: null }
                : { status: 'code', code: pickup.code };
            } finally {
              pickup.active -= 1;
            }
          },
        };
      },
    },
    publicBaseUrl: 'http://gateway.test',
    registrationPickupRetryDelayMs: 0,
  });
  const registrationStore = new RegistrationStore({ db: gatewayStore.db, secretBox });
  registrationStore.importControlProxies('control.test:1:user:pass');
  registrationStore.importProxies(Array.from(
    { length: mailboxCount * 2 },
    (_, index) => `task.test:${index + 1}:user:pass`,
  ));
  const externalWorker = {
    async testControlProxy() {
      if (precheckFails) throw new Error('precheck failed');
      return { storageState: { cookies: [] }, controlSession: {} };
    },
    async submit({ mailboxes }) {
      assert.equal(mailboxes.length, mailboxCount);
      assert.match(mailboxes[0], /^one@icloud\.com----http:\/\/gateway\.test\/m\/[A-Za-z0-9_-]{43}$/);
      return { externalBatchId: 'external-ic', storageState: { cookies: [] } };
    },
    async poll({ onUpdate }) {
      const snapshot = {
        batch: { status: 'completed' },
        storageState: { cookies: [] },
        tasks: Array.from({ length: mailboxCount }, (_, index) => ({
          slot: index + 1,
          task_id: `external-task-${index + 1}`,
          status: 'completed',
          terminal_code: 'register_completed',
          mfa_status: 'enabled',
          trial_qualification: 'observed_ineligible',
        })),
      };
      await onUpdate(snapshot);
      return snapshot;
    },
    async reveal() {
      return {
        password: 'generated-password',
        trial_qualification: 'observed_ineligible',
        mfa: {
          status: 'enabled',
          factor_type: 'totp',
          active_factor_present: true,
          mutation_started: true,
          mutation_rejected: false,
          secret: 'GEZDGNBVGY3TQOJQ',
        },
      };
    },
    async close() {},
  };
  const service = new RegistrationService({
    store: registrationStore,
    gatewayService: {},
    icMailboxService,
    externalWorker,
    secretBox,
  });
  return {
    gatewayStore, icStore, icMailboxService, pickup, registrationStore, service, externalWorker,
  };
}

for (const endpoint of ['batch', 'tasks']) {
  test(`restart closes running IC on known ${endpoint} 410 without polling`, async (t) => {
    const { gatewayStore, icStore, registrationStore: store, service, externalWorker } = fixture();
    t.after(() => gatewayStore.close());
    const batch = store.createBatch(1, { proxiesPerMailbox: 2, mailboxCategory: 'ic' });
    await service.prepareAndSubmit(batch);
    store.transitionBatch(batch.id, 'external_started');
    store.transitionTask(store.listTasks(batch.id)[0].id, 'start');
    store.setBatchError(batch.id, `ifnexora polling failed: ${endpoint} 410`);
    let polls = 0;
    externalWorker.poll = async () => { polls += 1; throw new Error('unexpected poll'); };
    assert.equal(service.recoverAfterRestart(), 1);
    await service.queue;
    assert.equal(polls, 0);
    assert.equal(store.getBatch(batch.id).state, 'failed');
    assert.equal(store.listTasks(batch.id)[0].state, 'released');
    assert.equal(icStore.get('ic-1').state, 'used');
    assert.equal(store.controlProxyStats().consumed, 1);
    assert.equal(service.recoverAfterRestart(), 0);
  });
}

for (const state of ['creating_aliases', 'allocating_proxies', 'submitting']) {
  test(`restart ${state} IC remains used instead of returning to pool`, async (t) => {
    const { gatewayStore, icStore, registrationStore: store, service, externalWorker } = fixture();
    t.after(() => gatewayStore.close());
    const batch = store.createBatch(1, { proxiesPerMailbox: 2, mailboxCategory: 'ic' });
    store.transitionBatch(batch.id, 'start');
    await service.createExactIcMailboxes(batch);
    if (state !== 'creating_aliases') {
      store.transitionBatch(batch.id, 'aliases_created');
      store.reserveControlProxy(batch.id);
      store.reserveProxies(batch.id, 2);
    }
    if (state === 'submitting') store.transitionBatch(batch.id, 'proxies_allocated');
    let submits = 0;
    externalWorker.submit = async () => { submits += 1; throw new Error('unexpected submit'); };
    assert.equal(service.recoverAfterRestart(), 1);
    await service.queue;
    assert.equal(submits, 0);
    assert.equal(store.getBatch(batch.id).state, state === 'submitting' ? 'submit_unknown' : 'failed');
    assert.equal(store.listTasks(batch.id)[0].state, state === 'submitting' ? 'alias_ready' : 'released');
    assert.equal(icStore.get('ic-1').state, 'used');
    assert.equal(service.icMailboxService.countAvailable(), 0);
    if (state !== 'creating_aliases') {
      const status = state === 'submitting' ? 'quarantined' : 'consumed';
      assert.equal(store.controlProxyStats()[status], 1);
      assert.equal(store.proxyStats()[status], 2);
    }
  });
}

test('IC registration allocates by provider, saves confirmed 2FA without trial, and never releases the mailbox', async () => {
  const { gatewayStore, icStore, registrationStore, service } = fixture();
  const batch = registrationStore.createBatch(1, {
    proxiesPerMailbox: 2,
    mailboxCategory: 'ic',
    mailboxProvider: 'icloud.ikunai666.top',
  });

  await service.runBatch(batch.id);

  const task = registrationStore.listTasks(batch.id)[0];
  assert.equal(task.mailbox_category, 'ic');
  assert.equal(task.alias_id, null);
  assert.equal(task.ic_mailbox_id, 'ic-1');
  assert.equal(task.state, 'released');
  assert.equal(icStore.get('ic-1').state, 'used');
  const accounts = registrationStore.listQualifiedAccounts();
  assert.equal(accounts.length, 1);
  assert.equal(accounts[0].mailbox_category, 'ic');
  assert.equal(accounts[0].trial_qualification, 'observed_ineligible');
  assert.equal(registrationStore.getBatch(batch.id).state, 'completed');
  gatewayStore.close();
});

test('IC mailbox is consumed even when submission is definitely not attempted', async () => {
  const { gatewayStore, icStore, registrationStore, service } = fixture({ precheckFails: true });
  const batch = registrationStore.createBatch(1, {
    proxiesPerMailbox: 2,
    mailboxCategory: 'ic',
    mailboxProvider: 'icloud.ikunai666.top',
  });

  await assert.rejects(service.runBatch(batch.id), /当前代理轮次已用完/);

  assert.equal(icStore.get('ic-1').state, 'used');
  assert.equal(registrationStore.listTasks(batch.id)[0].state, 'released');
  assert.throws(
    () => service.createBatch(1, 2, { mailboxCategory: 'ic', mailboxProvider: 'icloud.ikunai666.top' }),
    /可用 IC 邮箱不足/,
  );
  gatewayStore.close();
});

test('IC pickup preparation retries transient network failures and caps concurrent requests', async () => {
  const {
    gatewayStore, icStore, pickup, registrationStore, service,
  } = fixture({ mailboxCount: 8, pickupNetworkFailures: 2, pickupDelayMs: 5 });
  const batch = registrationStore.createBatch(8, {
    proxiesPerMailbox: 2,
    mailboxCategory: 'ic',
    mailboxProvider: 'icloud.ikunai666.top',
  });

  await service.createExactIcMailboxes(batch);

  assert.equal(registrationStore.listTasks(batch.id).length, 8);
  assert.equal(icStore.countAvailable(), 0);
  assert.ok(pickup.calls >= 10);
  assert.ok(pickup.maxActive <= 4);
  gatewayStore.close();
});

test('IC pickup preparation failure consumes every allocated mailbox and records failed tasks', async () => {
  const {
    gatewayStore, icStore, registrationStore, service,
  } = fixture({ mailboxCount: 5, pickupNetworkFailures: Number.POSITIVE_INFINITY });
  const batch = registrationStore.createBatch(5, {
    proxiesPerMailbox: 2,
    mailboxCategory: 'ic',
    mailboxProvider: 'icloud.ikunai666.top',
  });

  await assert.rejects(service.runBatch(batch.id), /temporary socket close/);

  assert.equal(registrationStore.getBatch(batch.id).state, 'failed');
  assert.deepEqual(registrationStore.listTasks(batch.id).map((task) => task.state), Array(5).fill('released'));
  assert.deepEqual(icStore.list().map((mailbox) => mailbox.state), Array(5).fill('used'));
  gatewayStore.close();
});

test('historically allocated IC mailboxes stay excluded and are reconciled even without a task row', () => {
  const {
    gatewayStore, icStore, icMailboxService, registrationStore,
  } = fixture();
  const [allocated] = icMailboxService.allocateForRegistration(1, {
    pickupHostname: 'icloud.ikunai666.top',
  });
  icStore.releaseAllocation(allocated.mailbox.id, 'legacy behavior');

  assert.equal(icStore.get(allocated.mailbox.id).state, 'available');
  assert.equal(icStore.countAvailable(), 0);
  assert.equal(reconcileAssignedIcMailboxes(gatewayStore.db), 1);
  assert.equal(icStore.get(allocated.mailbox.id).state, 'used');
  gatewayStore.close();
});

test('expired public results close the batch and consume an already submitted IC mailbox', async () => {
  const { gatewayStore, icStore, registrationStore, service, externalWorker } = fixture();
  externalWorker.poll = async () => { throw new Error('ifnexora polling failed: batch 410'); };
  const batch = registrationStore.createBatch(1, {
    proxiesPerMailbox: 2,
    mailboxCategory: 'ic',
    mailboxProvider: 'icloud.ikunai666.top',
  });

  await service.runBatch(batch.id);

  assert.equal(registrationStore.getBatch(batch.id).state, 'failed');
  assert.equal(registrationStore.getBatch(batch.id).last_error, 'external_result_expired_http_410');
  assert.equal(registrationStore.listTasks(batch.id)[0].state, 'released');
  assert.equal(icStore.get('ic-1').state, 'used');
  gatewayStore.close();
});

test('expired public results leave a batch partially completed when another account was already saved', async () => {
  const { gatewayStore, icStore, registrationStore, service, externalWorker } = fixture({ mailboxCount: 2 });
  externalWorker.poll = async ({ onUpdate }) => {
    await onUpdate({
      batch: { status: 'running' },
      storageState: { cookies: [] },
      tasks: [
        {
          slot: 1,
          task_id: 'external-task-1',
          status: 'completed',
          terminal_code: 'register_completed',
          mfa_status: 'enabled',
          trial_qualification: 'observed_ineligible',
        },
        { slot: 2, task_id: 'external-task-2', status: 'running' },
      ],
    });
    throw new Error('ifnexora polling failed: batch 410');
  };
  const batch = registrationStore.createBatch(2, {
    proxiesPerMailbox: 2,
    mailboxCategory: 'ic',
    mailboxProvider: 'icloud.ikunai666.top',
  });

  await service.runBatch(batch.id);

  const completed = registrationStore.getBatch(batch.id);
  assert.equal(completed.state, 'partial_completed');
  assert.equal(completed.qualified_count, 1);
  assert.equal(completed.failed_count, 1);
  assert.equal(completed.last_error, 'external_result_expired_http_410');
  assert.equal(registrationStore.listQualifiedAccounts().length, 1);
  assert.deepEqual(registrationStore.listTasks(batch.id).map((task) => task.state), ['released', 'released']);
  assert.equal(icStore.get('ic-1').state, 'used');
  assert.equal(icStore.get('ic-2').state, 'used');
  gatewayStore.close();
});

test('IC registration suppresses the allocation-time code until the provider exposes a new code', async () => {
  const {
    gatewayStore, icStore, icMailboxService, pickup, registrationStore, service,
  } = fixture({ initialCode: '400202' });
  const batch = registrationStore.createBatch(1, {
    proxiesPerMailbox: 2,
    mailboxCategory: 'ic',
    mailboxProvider: 'icloud.ikunai666.top',
  });

  await service.createExactIcMailboxes(batch);
  let row = icStore.get('ic-1');
  assert.ok(row.registration_baseline_code_hash);
  assert.deepEqual(await icMailboxService.pickup(row), { status: 'pending', code: null });

  pickup.code = '123456';
  row = icStore.get('ic-1');
  assert.deepEqual(await icMailboxService.pickup(row), { status: 'code', code: '123456' });
  assert.equal(icStore.get('ic-1').registration_baseline_code_hash, null);
  gatewayStore.close();
});
