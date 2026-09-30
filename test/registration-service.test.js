'use strict';

const test = require('node:test');

test('MAIL candidates skip creation-blocked mailboxes before opening or syncing', async () => {
  const touched = [];
  const service = Object.assign(Object.create(RegistrationService.prototype), {
    gatewayService: {
      listMailboxes: () => [{ id: 'blocked', creation_blocked: 1 }],
      ensureMailboxReady: async (id) => touched.push(id),
      syncMailbox: async (id) => touched.push(id),
    },
  });
  await assert.rejects(service.createExactAliases({ id: 'batch', requested_count: 1 }), /没有可用主邮箱/);
  assert.deepEqual(touched, []);
});

const assert = require('node:assert/strict');

const { GatewayStore } = require('../src/db/store');
const { GatewayService } = require('../src/services/gateway-service');
const { RegistrationStore } = require('../src/registration/store');
const {
  RegistrationService,
  isExternalBatchExpired,
  isMailboxCapacityConflict,
  revealedMfaEnabled,
  revealedTrialEligible,
} = require('../src/registration/service');
const { SecretBox } = require('../src/security/secret-box');
const { ControlProxyChallengeError } = require('../src/ifnexora/worker');

function registrationFixture({ externalWorker }) {
  const gatewayStore = new GatewayStore({ filename: ':memory:' });
  const secretBox = new SecretBox(Buffer.alloc(32, 6).toString('base64'));
  const remoteAliases = new Set();
  const adapter = {
    async open() {}, async close() {}, async closeAll() {},
    async listDomains() { return [{ domain: 'hidden.test', state: 'HIDDEN' }]; },
    async listAliases() { return [...remoteAliases].map((address) => ({ address })); },
    async createAlias(_mailbox, email) { remoteAliases.add(email); },
    async deleteAlias(_mailbox, email) { remoteAliases.delete(email); },
  };
  const gatewayService = new GatewayService({
    store: gatewayStore, adapter, secretBox, publicBaseUrl: 'http://gateway.test',
  });
  gatewayService.addMailbox({ email: 'main@example.com', password: 'secret' });
  gatewayService.importDomainCatalog([{ domain: 'hidden.test', state: 'HIDDEN' }], 'test');
  const registrationStore = new RegistrationStore({ db: gatewayStore.db, secretBox });
  const service = new RegistrationService({ store: registrationStore, gatewayService, externalWorker, secretBox });
  return { gatewayStore, registrationStore, service };
}

async function interruptedBatch(fixture, state, count = 1, reserve = true) {
  const { service, registrationStore: store } = fixture;
  const batch = store.createBatch(count, { proxiesPerMailbox: 1 });
  store.transitionBatch(batch.id, 'start');
  await service.createExactAliases(batch);
  if (state !== 'creating_aliases') store.transitionBatch(batch.id, 'aliases_created');
  if (reserve) {
    store.importControlProxies('control.test:1:u:p');
    store.importProxies(['task.test:1:u:p', 'task.test:2:u:p']);
    store.reserveControlProxy(batch.id);
    store.reserveProxies(batch.id, count);
  }
  if (['submitting', 'running', 'submit_unknown'].includes(state)) {
    store.transitionBatch(batch.id, 'proxies_allocated');
  }
  if (state === 'running') {
    store.setExternalBatch(batch.id, {
      externalBatchId: 'external-one', encryptedSession: service.secretBox.seal('{}'),
    });
    store.transitionBatch(batch.id, 'submit_accepted');
    store.transitionBatch(batch.id, 'external_started');
    for (const task of store.listTasks(batch.id)) {
      store.transitionTask(task.id, 'submit');
      store.transitionTask(task.id, 'start');
    }
    store.markBatchProxies(batch.id, 'consumed');
  }
  if (state === 'submit_unknown') store.transitionBatch(batch.id, 'submit_uncertain');
  return store.getBatch(batch.id);
}

test('expiration recognizes exact batch/tasks 410, excluding 404 and 429', () => {
  for (const endpoint of ['batch', 'tasks']) {
    assert.equal(isExternalBatchExpired(new Error(`ifnexora polling failed: ${endpoint} 410`)), true);
    for (const status of [404, 429, 4100, 500]) {
      assert.equal(isExternalBatchExpired(`ifnexora polling failed: ${endpoint} ${status}`), false);
    }
  }
  assert.equal(isExternalBatchExpired('external_result_expired_http_410'), true);
  assert.equal(isExternalBatchExpired('HTTP 410'), false);
});

test('tasks 410 preserves saved accounts while releasing remaining tasks', async (t) => {
  let polls = 0;
  const f = registrationFixture({ externalWorker: {
    async poll() { polls += 1; throw new Error('ifnexora polling failed: tasks 410'); },
  } });
  t.after(() => f.gatewayStore.close());
  const { service, registrationStore: store } = f;
  const batch = await interruptedBatch(f, 'running', 2);
  const [saved] = store.listTasks(batch.id);
  store.transitionTask(saved.id, 'register');
  store.transitionTask(saved.id, 'qualify', { mfaStatus: 'enabled', trialQualification: 'observed_eligible' });
  store.saveQualifiedAccount(saved.id, {
    password: 'saved-password', trial_qualification: 'observed_eligible',
    mfa: { status: 'enabled', factor_type: 'totp', active_factor_present: true,
      mutation_started: true, mutation_rejected: false, secret: 'SAVEDSECRET' },
  });
  store.transitionTask(saved.id, 'save');
  const accounts = store.db.prepare('SELECT * FROM qualified_accounts').all();
  await service.runBatch(batch.id);
  assert.equal(polls, 1);
  assert.equal(store.getBatch(batch.id).state, 'partial_completed');
  assert.deepEqual(store.db.prepare('SELECT * FROM qualified_accounts').all(), accounts);
  assert.ok(store.listTasks(batch.id).every((task) => task.state === 'released'));
  assert.equal(store.controlProxyStats().consumed, 1);
});

for (const state of ['creating_aliases', 'allocating_proxies', 'running']) {
  for (const failure of ['return', 'throw']) {
    test(`restart ${state} cleanup ${failure} remains retryable until released`, async (t) => {
      let polls = 0;
      let submits = 0;
      const f = registrationFixture({ externalWorker: {
        async poll() { polls += 1; throw new Error('ifnexora polling failed: tasks 410'); },
        async submit() { submits += 1; throw new Error('unexpected submit'); },
      } });
      t.after(() => f.gatewayStore.close());
      const { service, registrationStore: store } = f;
      const batch = await interruptedBatch(f, state);
      const release = service.gatewayService.releaseAlias.bind(service.gatewayService);
      service.gatewayService.releaseAlias = async () => {
        if (failure === 'throw') throw new Error('delete failed');
        return { state: 'delete_failed', last_error: 'delete failed' };
      };
      assert.equal(service.recoverAfterRestart(), 1);
      await service.queue;
      assert.equal(store.getBatch(batch.id).state, state);
      assert.notEqual(store.listTasks(batch.id)[0].state, 'released');
      if (state === 'running') assert.equal(store.getBatch(batch.id).last_error, 'external_result_expired_http_410');
      const previousPolls = polls;
      service.gatewayService.releaseAlias = release;
      assert.equal(service.recoverAfterRestart(), 1);
      await service.queue;
      assert.equal(store.getBatch(batch.id).state, 'failed');
      assert.equal(store.listTasks(batch.id)[0].state, 'released');
      assert.equal(store.controlProxyStats().consumed, 1);
      assert.equal(store.proxyStats().consumed, 1);
      assert.equal(polls, previousPolls);
      assert.equal(submits, 0);
      assert.equal(service.recoverAfterRestart(), 0);
    });
  }
}

test('restart pre-submit without proxy allocations cleans mailboxes and leaves pools unchanged', async (t) => {
  const f = registrationFixture({ externalWorker: {} });
  t.after(() => f.gatewayStore.close());
  const { service, registrationStore: store } = f;
  store.importControlProxies('control.test:1:u:p');
  store.importProxies(['task.test:1:u:p']);
  const batch = await interruptedBatch(f, 'creating_aliases', 1, false);
  service.recoverAfterRestart();
  await service.queue;
  assert.equal(store.getBatch(batch.id).state, 'failed');
  assert.equal(store.listTasks(batch.id)[0].state, 'released');
  assert.equal(store.controlProxyStats().available, 1);
  assert.equal(store.proxyStats().available, 1);
});

for (const externalId of [false, true]) {
  test(`lost submitting quarantines proxies without resubmission, external ID=${externalId}`, async (t) => {
    const f = registrationFixture({ externalWorker: {} });
    t.after(() => f.gatewayStore.close());
    const { service, registrationStore: store } = f;
    const batch = await interruptedBatch(f, 'submitting');
    if (externalId) store.setExternalBatch(batch.id, {
      externalBatchId: 'already-accepted', encryptedSession: service.secretBox.seal('{}'),
    });
    let releases = 0;
    service.gatewayService.releaseAlias = async () => { releases += 1; throw new Error('unexpected deletion'); };
    service.recoverAfterRestart();
    await service.queue;
    assert.equal(store.getBatch(batch.id).state, 'submit_unknown');
    if (externalId) assert.equal(store.getBatch(batch.id).external_batch_id, 'already-accepted');
    assert.equal(store.listTasks(batch.id)[0].state, 'alias_ready');
    assert.equal(store.proxyStats().quarantined, 1);
    assert.equal(store.controlProxyStats().quarantined, 1);
    assert.equal(service.recoverAfterRestart(), 0);
    await service.runBatch(batch.id);
    assert.equal(releases, 0);
  });
}

test('existing unknown without session is unchanged and recovery is not limited to latest 500', async (t) => {
  const f = registrationFixture({ externalWorker: {} });
  t.after(() => f.gatewayStore.close());
  const { service, registrationStore: store } = f;
  const unknown = await interruptedBatch(f, 'submit_unknown', 1, false);
  const batch = await interruptedBatch(f, 'allocating_proxies');
  store.db.prepare('UPDATE registration_batches SET created_at = ? WHERE id = ?').run('2000-01-01', batch.id);
  for (let index = 0; index < 501; index += 1) store.transitionBatch(store.createBatch(1).id, 'fail');
  assert.equal(store.listBatches({ limit: 500 }).some((row) => row.id === batch.id), false);
  assert.equal(service.recoverAfterRestart(), 1);
  await service.queue;
  assert.equal(store.getBatch(batch.id).state, 'failed');
  assert.deepEqual(store.getBatch(unknown.id), unknown);
});

test('revealed result requires confirmed TOTP activation and explicit trial eligibility', () => {
  const eligible = {
    mfa: {
      status: 'enabled', factor_type: 'totp', active_factor_present: true,
      mutation_started: true, mutation_rejected: false, secret: 'TOTPSECRET',
    },
    trial_qualification: 'observed_eligible',
  };
  assert.equal(revealedMfaEnabled(eligible), true);
  assert.equal(revealedTrialEligible(eligible), true);
  assert.equal(revealedMfaEnabled({ ...eligible, mfa: { ...eligible.mfa, active_factor_present: false } }), false);
  assert.equal(revealedMfaEnabled({ ...eligible, mfa: { ...eligible.mfa, mutation_rejected: true } }), false);
  assert.equal(revealedMfaEnabled({ ...eligible, mfa: { ...eligible.mfa, secret: '' } }), false);
  assert.equal(revealedTrialEligible({ ...eligible, trial_qualification: 'observed_ineligible' }), false);
});

test('mailbox HTTP 409 is classified as a capacity conflict', () => {
  assert.equal(isMailboxCapacityConflict('创建失败：HTTP 409：{"type":"urn:problem:mam:cats:request-conflict"}'), true);
  assert.equal(isMailboxCapacityConflict('HTTP 500'), false);
});

test('alias preparation balances creation across ready main mailboxes', async () => {
  const tasks = [];
  const calls = [];
  const mailboxes = ['main-a@example.com', 'main-b@example.com', 'main-c@example.com']
    .map((email, index) => ({ id: `mailbox-${index + 1}`, email }));
  const service = new RegistrationService({
    store: {
      listTasks: () => tasks,
      createTask(task) { tasks.push(task); },
    },
    gatewayService: {
      listMailboxes: () => mailboxes,
      async ensureMailboxReady() {},
      async syncMailbox() { return { remoteAliases: [] }; },
      async createBatch(mailboxId) {
        calls.push(mailboxId);
        const number = calls.length;
        return [{
          ok: true,
          alias: { id: `alias-${number}`, email: `alias-${number}@hidden.test` },
          webApi: `http://gateway.test/m/token-${number}`,
        }];
      },
    },
    externalWorker: {},
    secretBox: {},
  });

  await service.createExactAliases({ id: 'batch-balanced', requested_count: 5 });

  assert.deepEqual(calls, [
    'mailbox-1', 'mailbox-2', 'mailbox-3',
    'mailbox-1', 'mailbox-2',
  ]);
  assert.equal(tasks.length, 5);
  assert.deepEqual(tasks.map((task) => task.slot), [1, 2, 3, 4, 5]);
});

test('alias preparation leaves a full mailbox on 409 and fills from other mailboxes', async () => {
  const tasks = [];
  const callCounts = new Map();
  const mailboxes = ['full@example.com', 'ready-a@example.com', 'ready-b@example.com']
    .map((email, index) => ({ id: `mailbox-${index + 1}`, email }));
  const service = new RegistrationService({
    store: {
      listTasks: () => tasks,
      createTask(task) { tasks.push(task); },
    },
    gatewayService: {
      listMailboxes: () => mailboxes,
      async ensureMailboxReady() {},
      async syncMailbox() { return { remoteAliases: [] }; },
      async createBatch(mailboxId) {
        const count = (callCounts.get(mailboxId) || 0) + 1;
        callCounts.set(mailboxId, count);
        if (mailboxId === 'mailbox-1') {
          return [{ ok: false, error: 'HTTP 409: request-conflict' }];
        }
        const key = `${mailboxId}-${count}`;
        return [{
          ok: true,
          alias: { id: `alias-${key}`, email: `${key}@hidden.test` },
          webApi: `http://gateway.test/m/token-${key}`,
        }];
      },
    },
    externalWorker: {},
    secretBox: {},
  });

  await service.createExactAliases({ id: 'batch-capacity', requested_count: 4 });

  assert.equal(callCounts.get('mailbox-1'), 1);
  assert.equal(callCounts.get('mailbox-2'), 2);
  assert.equal(callCounts.get('mailbox-3'), 2);
  assert.equal(tasks.length, 4);
});

test('alias preparation counts already attached aliases toward the total', async () => {
  const tasks = [{ id: 'existing-1' }, { id: 'existing-2' }];
  let creationCalls = 0;
  const service = new RegistrationService({
    store: {
      listTasks: () => tasks,
      createTask(task) { tasks.push(task); },
    },
    gatewayService: {
      listMailboxes: () => [{ id: 'mailbox-1', email: 'main@example.com' }],
      async ensureMailboxReady() {},
      async syncMailbox() { return { remoteAliases: [] }; },
      async createBatch() {
        creationCalls += 1;
        return [{
          ok: true,
          alias: { id: 'alias-new', email: 'new@hidden.test' },
          webApi: 'http://gateway.test/m/token-new',
        }];
      },
    },
    externalWorker: {},
    secretBox: {},
  });

  await service.createExactAliases({ id: 'batch-existing', requested_count: 3 });

  assert.equal(creationCalls, 1);
  assert.equal(tasks.length, 3);
  assert.equal(tasks[2].slot, 3);
});

test('finished public tasks are revealed serially through their shared external session', async () => {
  const localTasks = [1, 2, 3].map((slot) => ({ id: `local-${slot}`, slot, state: 'registered' }));
  const service = new RegistrationService({
    store: { listTasks: () => localTasks },
    gatewayService: {},
    externalWorker: { async close() {} },
    secretBox: {},
  });
  const calls = [];
  let active = 0;
  let maxActive = 0;
  service.collectTaskResult = async (_batchId, local) => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    calls.push(local.slot);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active -= 1;
  };

  await service.collectFinishedTasks(
    'batch-1',
    [1, 2, 3].map((slot) => ({ slot, status: 'completed' })),
    { cookies: [] },
    'control-proxy',
  );

  assert.deepEqual(calls, [1, 2, 3]);
  assert.equal(maxActive, 1);
});

test('a task must be explicitly completed before its result can be revealed', async () => {
  let revealCalls = 0;
  const externalWorker = {
    async testControlProxy() { return { storageState: { cookies: [] }, controlSession: {} }; },
    async submit() { return { externalBatchId: 'external-running', storageState: { cookies: [] } }; },
    async poll({ onUpdate }) {
      const running = {
        batch: { status: 'running' }, storageState: { cookies: [] },
        tasks: [{
          slot: 1, task_id: 'task-running', status: 'running',
          terminal_code: 'register_completed', mfa_status: 'enabled', trial_qualification: 'observed_eligible',
        }],
      };
      await onUpdate(running);
      assert.equal(revealCalls, 0);
      const completed = {
        ...running,
        batch: { status: 'completed' },
        tasks: [{ ...running.tasks[0], status: 'completed' }],
        reveal: async () => {
          revealCalls += 1;
          return {
            password: 'generated-password', session: {}, trial_qualification: 'observed_ineligible',
            mfa: {
              status: 'enabled', factor_type: 'totp', active_factor_present: true,
              mutation_started: true, mutation_rejected: false, secret: 'GEZDGNBVGY3TQOJQ',
            },
          };
        },
      };
      await onUpdate(completed);
      return completed;
    },
    async reveal() {
      assert.fail('completed tasks must reveal through the active polling page');
    },
    async close() {},
  };
  const { gatewayStore, registrationStore, service } = registrationFixture({ externalWorker });
  registrationStore.importControlProxies('control.test:1:u:p');
  registrationStore.importProxies(['task.test:1:u:p', 'task.test:2:u:p']);
  const batch = registrationStore.createBatch(1, { proxiesPerMailbox: 2 });

  await service.runBatch(batch.id);

  assert.equal(revealCalls, 1);
  assert.equal(registrationStore.listTasks(batch.id)[0].state, 'released');
  gatewayStore.close();
});

test('revealed ineligible result overrides an eligible task-list summary', async () => {
  let revealCalls = 0;
  const externalWorker = {
    async testControlProxy() {
      return { storageState: { cookies: [] }, controlSession: { id: 'live' } };
    },
    async submit() {
      return { externalBatchId: 'external-ineligible', storageState: { cookies: [] } };
    },
    async poll({ onUpdate }) {
      const snapshot = {
        batch: { status: 'completed' },
        storageState: { cookies: [] },
        tasks: [{
          slot: 1, task_id: 'task-ineligible', status: 'completed',
          terminal_code: 'register_completed', mfa_status: 'enabled',
          trial_qualification: 'observed_eligible',
        }],
      };
      await onUpdate(snapshot);
      return snapshot;
    },
    async reveal() {
      revealCalls += 1;
      return {
        type: 'pure', password: 'generated-password', session: {},
        mfa: {
          status: 'enabled', factor_type: 'totp', active_factor_present: true,
          mutation_started: true, mutation_rejected: false, secret: 'GEZDGNBVGY3TQOJQ',
        },
        trial_qualification: 'observed_ineligible',
        account_offers: [{ eligible_promo_campaigns: [] }],
      };
    },
    async close() {},
  };
  const { gatewayStore, registrationStore, service } = registrationFixture({ externalWorker });
  registrationStore.importControlProxies('control.test:1:u:p');
  registrationStore.importProxies(['task.test:1:u:p', 'task.test:2:u:p']);
  const batch = registrationStore.createBatch(1, { proxiesPerMailbox: 2 });

  await service.runBatch(batch.id);

  assert.equal(revealCalls, 1);
  assert.equal(registrationStore.listQualifiedAccounts().length, 0);
  const task = registrationStore.listTasks(batch.id)[0];
  assert.equal(task.state, 'released');
  assert.equal(task.mfa_status, 'enabled');
  assert.equal(task.trial_qualification, 'observed_ineligible');
  gatewayStore.close();
});

test('complete orchestration stores eligible 2FA result before deleting its temporary alias', async () => {
  const gatewayStore = new GatewayStore({ filename: ':memory:' });
  const secretBox = new SecretBox(Buffer.alloc(32, 8).toString('base64'));
  const remoteAliases = new Set();
  const order = [];
  const adapter = {
    async open() {}, async close() {}, async closeAll() {},
    async listDomains() { return [{ domain: 'hidden.test', state: 'HIDDEN' }]; },
    async listAliases() { return [...remoteAliases].map((address) => ({ address })); },
    async createAlias(_mailbox, email) { remoteAliases.add(email); },
    async deleteAlias(_mailbox, email) {
      order.push('delete');
      assert.equal(registrationStore.listQualifiedAccounts().length, 1, 'qualified result must already be durable');
      remoteAliases.delete(email);
    },
  };
  const gatewayService = new GatewayService({
    store: gatewayStore, adapter, secretBox, publicBaseUrl: 'http://gateway.test',
  });
  gatewayService.addMailbox({ email: 'main@example.com', password: 'secret' });
  gatewayService.importDomainCatalog([{ domain: 'hidden.test', state: 'HIDDEN' }], 'test');
  const registrationStore = new RegistrationStore({ db: gatewayStore.db, secretBox });
  registrationStore.importProxies(['p.test:1:u:p', 'p.test:2:u:p']);
  registrationStore.importControlProxies('control.test:9:control-user:control-pass');
  const liveControlSession = { id: 'live-control-session' };
  const externalWorker = {
    async testControlProxy(controlProxy) {
      assert.equal(controlProxy, 'control.test:9:control-user:control-pass');
      return {
        storageState: { cookies: [{ name: 'session', value: 'prechecked' }] },
        controlSession: liveControlSession,
      };
    },
    async submit({ mailboxes, proxies, controlProxy, storageState, controlSession }) {
      assert.equal(mailboxes.length, 1);
      assert.equal(proxies.length, 2);
      assert.equal(controlProxy, 'control.test:9:control-user:control-pass');
      assert.deepEqual(storageState, {
        cookies: [{ name: 'session', value: 'prechecked' }],
      });
      assert.strictEqual(controlSession, liveControlSession);
      registrationStore.importControlProxies('replacement.test:9:user:pass');
      return { externalBatchId: 'external-1', storageState: { cookies: [] } };
    },
    async poll({ onUpdate, controlProxy }) {
      assert.equal(controlProxy, 'control.test:9:control-user:control-pass');
      order.push('poll-before-update');
      const snapshot = {
        batch: { status: 'completed' }, storageState: { cookies: [] },
        tasks: [{ slot: 1, task_id: 'task-1', status: 'completed', terminal_code: 'register_completed', mfa_status: 'enabled', trial_qualification: 'observed_eligible' }],
      };
      await onUpdate(snapshot);
      order.push('poll-after-update');
      return snapshot;
    },
    async reveal({ controlProxy }) {
      assert.equal(controlProxy, 'control.test:9:control-user:control-pass');
      order.push('reveal');
      return {
        type: 'pure',
        password: 'generated-password',
        session: { token: 'session' },
        mfa: {
          status: 'enabled', factor_type: 'totp', active_factor_present: true,
          mutation_started: true, mutation_rejected: false, secret: 'GEZDGNBVGY3TQOJQ',
        },
        trial_qualification: 'observed_eligible',
        account_offers: [{ eligible_promo_campaigns: ['plus-1-month-free'] }],
      };
    },
    async close() {},
  };
  const service = new RegistrationService({ store: registrationStore, gatewayService, externalWorker, secretBox });
  const batch = registrationStore.createBatch(1, { proxiesPerMailbox: 2 });
  await service.runBatch(batch.id);
  assert.deepEqual(order, ['poll-before-update', 'reveal', 'delete', 'poll-after-update']);
  assert.equal(registrationStore.getBatch(batch.id).state, 'completed');
  assert.equal(registrationStore.proxyStats().consumed, 2);
  assert.equal(registrationStore.batchControlProxyEndpoint(batch.id), 'control.test:9:control-user:control-pass');
  assert.equal(gatewayStore.db.prepare(`
    SELECT final_status FROM registration_batch_control_proxies WHERE batch_id = ?
  `).get(batch.id).final_status, 'consumed');
  const account = service.revealQualifiedAccount(registrationStore.listQualifiedAccounts()[0].id);
  assert.equal(account.password, 'generated-password');
  assert.equal(account.totpSecret, 'GEZDGNBVGY3TQOJQ');
  assert.equal(account.mfaStatus, 'enabled');
  assert.equal(account.trialQualification, 'observed_eligible');
  assert.equal(account.trialSummary, 'observed_eligible');
  assert.equal(remoteAliases.size, 0);
  gatewayStore.close();
});

test('registration cannot be queued without an available batch control proxy', () => {
  const gatewayStore = new GatewayStore({ filename: ':memory:' });
  const secretBox = new SecretBox(Buffer.alloc(32, 9).toString('base64'));
  const registrationStore = new RegistrationStore({ db: gatewayStore.db, secretBox });
  const service = new RegistrationService({
    store: registrationStore,
    gatewayService: {},
    externalWorker: { async close() {} },
    secretBox,
  });
  assert.throws(() => service.createBatch(1), /没有可用的公共站请求代理/);
  assert.equal(registrationStore.listBatches().length, 0);
  gatewayStore.close();
});

test('failed control prechecks advance both proxy pools without quarantining or immediate reuse', async () => {
  const externalWorker = {
    async testControlProxy() { throw new Error('precheck failed'); },
    async close() {},
  };
  const { gatewayStore, registrationStore, service } = registrationFixture({ externalWorker });
  registrationStore.importControlProxies(['control.test:1:u:p', 'control.test:2:u:p']);
  registrationStore.importProxies(['task.test:1:u:p', 'task.test:2:u:p', 'task.test:3:u:p']);
  const batch = registrationStore.createBatch(1, { proxiesPerMailbox: 2 });
  await assert.rejects(service.runBatch(batch.id), /当前代理轮次已用完/);
  assert.deepEqual(registrationStore.controlProxyStats(), {
    total: 2, available: 0, reserved: 0, consumed: 2, quarantined: 0,
  });
  assert.deepEqual(registrationStore.proxyStats(), {
    total: 3, available: 3, reserved: 0, consumed: 0, quarantined: 0,
  });
  gatewayStore.close();
});

test('a failed public submission still advances the allocated registration proxies', async () => {
  const liveControlSession = { id: 'failed-submission-session' };
  const externalWorker = {
    async testControlProxy() {
      return { storageState: { cookies: [] }, controlSession: liveControlSession };
    },
    async submit({ controlSession }) {
      assert.strictEqual(controlSession, liveControlSession);
      throw new Error('public submission rejected');
    },
    async close() {},
  };
  const { gatewayStore, registrationStore, service } = registrationFixture({ externalWorker });
  registrationStore.importControlProxies(['control.test:1:u:p', 'control.test:2:u:p']);
  registrationStore.importProxies([
    'task.test:1:u:p', 'task.test:2:u:p', 'task.test:3:u:p', 'task.test:4:u:p',
  ]);
  const batch = registrationStore.createBatch(1, { proxiesPerMailbox: 2 });
  await assert.rejects(service.runBatch(batch.id), /public submission rejected/);
  assert.deepEqual(registrationStore.proxyStats(), {
    total: 4, available: 2, reserved: 0, consumed: 2, quarantined: 0,
  });
  const next = registrationStore.createBatch(1, { proxiesPerMailbox: 2 });
  assert.deepEqual(registrationStore.reserveProxies(next.id, 2), [
    'task.test:3:u:p', 'task.test:4:u:p',
  ]);
  gatewayStore.close();
});

test('a pre-POST challenge network failure rotates the control proxy and keeps the registration proxies', async () => {
  const submissions = [];
  const sessions = [];
  const externalWorker = {
    async testControlProxy(controlProxy) {
      const controlSession = { controlProxy, closed: false };
      sessions.push(controlSession);
      return {
        storageState: { cookies: [{ name: 'control', value: controlProxy }] },
        controlSession,
      };
    },
    async submit({ proxies, controlProxy, storageState, controlSession }) {
      assert.strictEqual(controlSession, sessions.at(-1));
      controlSession.closed = true;
      submissions.push({ proxies: [...proxies], controlProxy, storageState, controlSession });
      if (submissions.length === 1) {
        throw new ControlProxyChallengeError('turnstile script connection closed');
      }
      return { externalBatchId: 'external-rotated', storageState };
    },
    async close() {},
  };
  const { gatewayStore, registrationStore, service } = registrationFixture({ externalWorker });
  registrationStore.importControlProxies(['control.test:1:u:p', 'control.test:2:u:p']);
  registrationStore.importProxies(['task.test:1:u:p', 'task.test:2:u:p']);
  const batch = registrationStore.createBatch(1, { proxiesPerMailbox: 2 });

  await service.prepareAndSubmit(batch);

  assert.equal(submissions.length, 2);
  assert.equal(submissions[0].controlProxy, 'control.test:1:u:p');
  assert.equal(submissions[1].controlProxy, 'control.test:2:u:p');
  assert.deepEqual(submissions[1].proxies, submissions[0].proxies);
  assert.deepEqual(submissions[1].storageState, {
    cookies: [{ name: 'control', value: 'control.test:2:u:p' }],
  });
  assert.equal(sessions.length, 2);
  assert.equal(sessions.every((session) => session.closed), true);
  assert.equal(registrationStore.getBatch(batch.id).external_batch_id, 'external-rotated');
  assert.deepEqual(registrationStore.controlProxyStats(), {
    total: 2, available: 0, reserved: 1, consumed: 1, quarantined: 0,
  });
  gatewayStore.close();
});

test('an unused prechecked control session is closed when setup fails before submission', async () => {
  const liveControlSession = { id: 'unused-live-session' };
  const discarded = [];
  const externalWorker = {
    async testControlProxy() {
      return { storageState: { cookies: [] }, controlSession: liveControlSession };
    },
    async discardControlSession(controlSession) {
      discarded.push(controlSession);
    },
    async submit() {
      assert.fail('submission must not run after proxy allocation fails');
    },
    async close() {},
  };
  const { gatewayStore, registrationStore, service } = registrationFixture({ externalWorker });
  registrationStore.importControlProxies('control.test:1:u:p');
  registrationStore.importProxies(['task.test:1:u:p', 'task.test:2:u:p']);
  const batch = registrationStore.createBatch(1);
  registrationStore.reserveProxies = () => { throw new Error('allocation failed'); };

  await assert.rejects(service.prepareAndSubmit(batch), /allocation failed/);

  assert.deepEqual(discarded, [liveControlSession]);
  gatewayStore.close();
});
