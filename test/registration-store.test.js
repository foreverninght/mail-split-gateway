'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { GatewayStore } = require('../src/db/store');
const { RegistrationStore } = require('../src/registration/store');
const { SecretBox } = require('../src/security/secret-box');
const { TASK_EVENTS } = require('../src/registration/state-machine');

test('proxy imports accept supplier URLs in host:port:user:password form', () => {
  const { gateway, registration } = fixture();
  const endpoint = 'proxy.example.invalid:8080:fixture-user:fixture-password';
  const imported = registration.importProxies(`http://${endpoint}`);
  assert.equal(imported.current, 1);
  const row = gateway.db.prepare('SELECT encrypted_endpoint FROM proxy_pool').get();
  assert.equal(
    registration.secretBox.open(row.encrypted_endpoint),
    'http://fixture-user:fixture-password@proxy.example.invalid:8080',
  );
  gateway.close();
});

test('registration proxy imports normalize IPRoyal host:port@user:password lines', () => {
  const { gateway, registration } = fixture();
  const imported = registration.importProxies(
    'geo.iproyal.test:51250@account-id:password_country-jp_session-example_lifetime-1h',
  );
  assert.equal(imported.current, 1);
  const row = gateway.db.prepare('SELECT encrypted_endpoint FROM proxy_pool').get();
  assert.equal(
    registration.secretBox.open(row.encrypted_endpoint),
    'http://account-id:password_country-jp_session-example_lifetime-1h@geo.iproyal.test:51250',
  );
  assert.equal(registration.importControlProxies(
    'geo.iproyal.test:51250@account-id:password_country-jp_session-example_lifetime-1h',
  ).current, 1);
  const control = gateway.db.prepare('SELECT encrypted_endpoint FROM control_proxy_pool').get();
  assert.equal(registration.secretBox.open(control.encrypted_endpoint), registration.secretBox.open(row.encrypted_endpoint));
  gateway.close();
});

test('registration batches persist the configured proxies per mailbox', () => {
  const { gateway, registration } = fixture();
  const batch = registration.createBatch(3, { proxiesPerMailbox: 7 });
  assert.equal(batch.proxies_per_mailbox, 7);
  assert.equal(registration.getBatch(batch.id).proxies_per_mailbox, 7);
  gateway.close();
});

test('registration batches are not capped at one mailbox capacity', () => {
  const { gateway, registration } = fixture();
  const batch = registration.createBatch(10, { proxiesPerMailbox: 1 });
  assert.equal(batch.requested_count, 10);
  gateway.close();
});

function fixture({ clock = Date.now, registrationProxyRefreshMs } = {}) {
  const gateway = new GatewayStore({ filename: ':memory:', clock });
  const secretBox = new SecretBox(Buffer.alloc(32, 7).toString('base64'));
  return {
    gateway,
    registration: new RegistrationStore({
      db: gateway.db,
      secretBox,
      clock,
      ...(registrationProxyRefreshMs ? { registrationProxyRefreshMs } : {}),
    }),
  };
}

test('registration proxies become reusable only after the configured refresh interval', () => {
  let time = Date.parse('2026-08-30T00:00:00.000Z');
  const { gateway, registration } = fixture({ clock: () => time });
  registration.importProxies([
    'proxy.test:1:u:p', 'proxy.test:2:u:p', 'proxy.test:3:u:p', 'proxy.test:4:u:p', 'proxy.test:5:u:p',
  ]);
  const first = registration.createBatch(2);
  assert.deepEqual(registration.reserveProxies(first.id, 4), [
    'proxy.test:1:u:p', 'proxy.test:2:u:p', 'proxy.test:3:u:p', 'proxy.test:4:u:p',
  ]);
  assert.deepEqual(registration.batchProxyEndpoints(first.id), [
    'proxy.test:1:u:p', 'proxy.test:2:u:p', 'proxy.test:3:u:p', 'proxy.test:4:u:p',
  ]);
  registration.markBatchProxies(first.id, 'consumed');
  const second = registration.createBatch(1);
  assert.throws(() => registration.reserveProxies(second.id, 2), /当前只有 1 条/);
  assert.deepEqual(registration.proxyStats(), { total: 5, available: 1, reserved: 0, consumed: 4, quarantined: 0 });
  assert.deepEqual(registration.reserveProxies(second.id, 1), ['proxy.test:5:u:p']);
  registration.markBatchProxies(second.id, 'consumed');
  assert.deepEqual(registration.proxyStats(), { total: 5, available: 0, reserved: 0, consumed: 5, quarantined: 0 });
  const third = registration.createBatch(1);
  assert.throws(() => registration.reserveProxies(third.id, 2), /当前只有 0 条/);
  time += 30 * 60 * 1000 - 1;
  assert.throws(() => registration.reserveProxies(third.id, 2), /当前只有 0 条/);
  time += 1;
  assert.deepEqual(registration.reserveProxies(third.id, 2), ['proxy.test:1:u:p', 'proxy.test:2:u:p']);
  assert.equal(registration.db.prepare(
    'SELECT COUNT(*) AS count FROM registration_proxy_allocations WHERE batch_id = ?',
  ).get(first.id).count, 4);
  gateway.close();
});

test('duplicate imports do not skip the proxy cycle and the same configured proxy is reusable after exhaustion', () => {
  let time = Date.parse('2026-08-30T00:00:00.000Z');
  const { gateway, registration } = fixture({ clock: () => time });
  const imported = registration.importProxies('proxy.test:1:u:p\nproxy.test:1:u:p');
  assert.equal(imported.current, 1);
  assert.equal(imported.added, 1);
  assert.equal(imported.duplicates, 1);
  const batch = registration.createBatch(1);
  registration.reserveProxies(batch.id, 1);
  registration.markBatchProxies(batch.id, 'consumed');
  assert.equal(registration.importProxies('proxy.test:1:u:p').retained, 1);
  assert.equal(registration.proxyStats().available, 0);
  const next = registration.createBatch(1);
  assert.throws(() => registration.reserveProxies(next.id, 1), /当前只有 0 条/);
  time += 30 * 60 * 1000;
  assert.deepEqual(registration.reserveProxies(next.id, 1), ['proxy.test:1:u:p']);
  gateway.close();
});

test('a large reservation combines unused proxies with every consumed proxy whose refresh is due', () => {
  let time = Date.parse('2026-08-30T00:00:00.000Z');
  const { gateway, registration } = fixture({ clock: () => time });
  registration.importProxies([
    'proxy.test:1:u:p', 'proxy.test:2:u:p', 'proxy.test:3:u:p',
    'proxy.test:4:u:p', 'proxy.test:5:u:p',
  ]);
  const first = registration.createBatch(1);
  registration.reserveProxies(first.id, 3);
  registration.markBatchProxies(first.id, 'consumed');

  const next = registration.createBatch(1);
  assert.throws(() => registration.reserveProxies(next.id, 4), /当前只有 2 条/);
  time += 30 * 60 * 1000;
  assert.deepEqual(registration.reserveProxies(next.id, 4), [
    'proxy.test:1:u:p', 'proxy.test:2:u:p', 'proxy.test:3:u:p', 'proxy.test:4:u:p',
  ]);
  assert.equal(registration.db.prepare(
    'SELECT COUNT(*) AS count FROM registration_proxy_allocations WHERE batch_id = ?',
  ).get(first.id).count, 3);
  gateway.close();
});

test('control proxy is encrypted, bound to one batch, and survives a pool replacement', () => {
  const { gateway, registration } = fixture();
  const endpoint = 'control.test:8080:control-user:control-password';
  registration.importControlProxies([endpoint, 'next.test:8080:user:password']);
  const batch = registration.createBatch(1);
  assert.equal(registration.reserveControlProxy(batch.id), endpoint);
  const row = gateway.db.prepare('SELECT encrypted_endpoint FROM control_proxy_pool WHERE batch_id = ?').get(batch.id);
  assert.ok(row.encrypted_endpoint);
  assert.equal(row.encrypted_endpoint.includes('control-password'), false);
  registration.importControlProxies('replacement.test:8080:user:password');
  assert.equal(registration.batchControlProxyEndpoint(batch.id), endpoint);
  assert.equal(registration.controlProxyStats().total, 1);
  assert.equal(registration.controlProxyStats().available, 1);
  registration.markBatchControlProxy(batch.id, 'consumed');
  const allocation = gateway.db.prepare(`
    SELECT final_status FROM registration_batch_control_proxies WHERE batch_id = ?
  `).get(batch.id);
  assert.equal(allocation.final_status, 'consumed');
  gateway.close();
});

test('each batch reserves one control proxy and starts a new cycle after exhaustion', () => {
  let time = Date.parse('2026-08-30T00:00:00.000Z');
  const { gateway, registration } = fixture({ clock: () => time });
  registration.importControlProxies(['control.test:1:u:p', 'control.test:2:u:p']);
  const first = registration.createBatch(1);
  const second = registration.createBatch(1);
  const third = registration.createBatch(1);
  assert.equal(registration.reserveControlProxy(first.id), 'control.test:1:u:p');
  registration.markBatchControlProxy(first.id, 'consumed');
  assert.equal(registration.reserveControlProxy(second.id), 'control.test:2:u:p');
  registration.markBatchControlProxy(second.id, 'consumed');
  assert.equal(registration.reserveControlProxy(third.id), 'control.test:1:u:p');
  assert.equal(gateway.db.prepare(`
    SELECT COUNT(*) AS count FROM registration_batch_control_proxies
  `).get().count, 3);
  gateway.close();
});

test('control proxy precheck rotation consumes the current cycle in order without quarantining', () => {
  let time = Date.parse('2026-08-30T00:00:00.000Z');
  const { gateway, registration } = fixture({ clock: () => time });
  registration.importControlProxies([
    'control.test:1:u:p', 'control.test:2:u:p', 'control.test:3:u:p',
  ]);
  const batch = registration.createBatch(1);
  assert.equal(registration.reserveControlProxy(batch.id), 'control.test:1:u:p');
  assert.equal(registration.rotateBatchControlProxy(batch.id, 'precheck failed'), 'control.test:2:u:p');
  assert.equal(registration.rotateBatchControlProxy(batch.id, 'precheck failed'), 'control.test:3:u:p');
  assert.equal(registration.rotateBatchControlProxy(batch.id, 'precheck failed'), null);
  assert.equal(registration.controlProxyStats().quarantined, 0);
  assert.equal(registration.controlProxyStats().consumed, 3);
  const next = registration.createBatch(1);
  assert.equal(registration.reserveControlProxy(next.id), 'control.test:1:u:p');
  gateway.close();
});

test('proxy imports replace the current pool without deleting allocation history', () => {
  const { gateway, registration } = fixture();
  registration.importProxies(['old.test:1:u:p', 'keep.test:2:u:p']);
  const batch = registration.createBatch(1);
  registration.reserveProxies(batch.id, 1);
  registration.markBatchProxies(batch.id, 'consumed');
  const replaced = registration.importProxies(['keep.test:2:u:p', 'new.test:3:u:p']);
  assert.equal(replaced.current, 2);
  assert.equal(replaced.added, 1);
  assert.equal(replaced.removed, 1);
  assert.equal(registration.proxyStats().total, 2);
  const next = registration.createBatch(1);
  assert.deepEqual(registration.reserveProxies(next.id, 2), ['keep.test:2:u:p', 'new.test:3:u:p']);
  assert.equal(gateway.db.prepare(`
    SELECT COUNT(*) AS count FROM registration_proxy_allocations WHERE batch_id = ?
  `).get(batch.id).count, 1);
  gateway.close();
});

test('an invalid replacement leaves both proxy pools unchanged', () => {
  const { gateway, registration } = fixture();
  registration.importProxies('task.test:1:u:p');
  registration.importControlProxies('control.test:2:u:p');
  assert.throws(() => registration.importProxies('new.test:3:u:p\ninvalid'), /未变更/);
  assert.throws(() => registration.importControlProxies(''), /未变更/);
  assert.equal(registration.proxyStats().total, 1);
  assert.equal(registration.controlProxyStats().total, 1);
  gateway.close();
});

test('proxy pool listings are paginated in the database query', () => {
  const { gateway, registration } = fixture();
  registration.importProxies(Array.from(
    { length: 120 }, (_, index) => `task-${index}.test:${1000 + index}:user:password`,
  ));
  const first = registration.listProxies({ page: 1, limit: 50 });
  const third = registration.listProxies({ page: 3, limit: 50 });
  assert.deepEqual(first.pagination, { page: 1, limit: 50, total: 120, pages: 3 });
  assert.equal(first.proxies.length, 50);
  assert.deepEqual(third.pagination, { page: 3, limit: 50, total: 120, pages: 3 });
  assert.equal(third.proxies.length, 20);
  assert.equal(new Set([...first.proxies, ...third.proxies].map((proxy) => proxy.id)).size, 70);
  gateway.close();
});

test('unknown submissions quarantine proxies until explicit reconciliation', () => {
  const { gateway, registration } = fixture();
  registration.importProxies(['proxy.test:1:u:p', 'proxy.test:2:u:p']);
  const batch = registration.createBatch(1);
  registration.reserveProxies(batch.id, 2);
  registration.markBatchProxies(batch.id, 'quarantined', 'response lost');
  assert.equal(registration.proxyStats().quarantined, 2);
  registration.reconcileQuarantinedProxies(batch.id, 'consumed');
  assert.equal(registration.proxyStats().consumed, 2);
  assert.equal(registration.proxyStats().available, 0);
  gateway.close();
});

test('released tasks without a saved account remain counted as failed', () => {
  const { gateway, registration } = fixture();
  const timestamp = new Date().toISOString();
  gateway.db.prepare(`
    INSERT INTO mailboxes (id, email, encrypted_password, state, created_at, updated_at)
    VALUES (?, ?, ?, 'ready', ?, ?)
  `).run('mailbox-1', 'main@example.com', 'encrypted', timestamp, timestamp);
  gateway.db.prepare(`
    INSERT INTO aliases (id, mailbox_id, email, state, created_at, updated_at)
    VALUES (?, ?, ?, 'ready', ?, ?)
  `).run('alias-1', 'mailbox-1', 'alias@example.com', timestamp, timestamp);
  const batch = registration.createBatch(1);
  const task = registration.createTask({
    batchId: batch.id, slot: 1, aliasId: 'alias-1', email: 'alias@example.com', webApi: 'https://mail-api.example/otp',
  });
  registration.transitionTask(task.id, TASK_EVENTS.RELEASE);
  const counts = registration.getBatch(batch.id);
  assert.equal(counts.failed_count, 1);
  assert.equal(counts.qualified_count, 0);
  gateway.close();
});

test('releasing an unsuccessful task preserves its business failure reason', () => {
  const { gateway, registration } = fixture();
  const timestamp = new Date().toISOString();
  gateway.db.prepare(`
    INSERT INTO mailboxes (id, email, encrypted_password, state, created_at, updated_at)
    VALUES (?, ?, ?, 'ready', ?, ?)
  `).run('mailbox-release-reason', 'main@example.com', 'encrypted', timestamp, timestamp);
  gateway.db.prepare(`
    INSERT INTO aliases (id, mailbox_id, email, state, created_at, updated_at)
    VALUES (?, ?, ?, 'ready', ?, ?)
  `).run('alias-release-reason', 'mailbox-release-reason', 'alias@example.com', timestamp, timestamp);
  const batch = registration.createBatch(1);
  let task = registration.createTask({
    batchId: batch.id, slot: 1, aliasId: 'alias-release-reason', email: 'alias@example.com', webApi: 'https://mail-api.example/otp',
  });
  task = registration.transitionTask(task.id, TASK_EVENTS.SUBMIT);
  task = registration.transitionTask(task.id, TASK_EVENTS.REGISTER, { terminalCode: 'register_completed' });
  task = registration.transitionTask(task.id, TASK_EVENTS.REJECT_QUALIFICATION, {
    lastError: 'revealed_trial_not_eligible',
  });
  task = registration.transitionTask(task.id, TASK_EVENTS.RELEASE);
  assert.equal(task.last_error, 'revealed_trial_not_eligible');
  gateway.close();
});

test('qualified account storage requires authoritative reveal statuses and exposes them in listings', () => {
  const { gateway, registration } = fixture();
  const timestamp = new Date().toISOString();
  gateway.db.prepare(`
    INSERT INTO mailboxes (id, email, encrypted_password, state, created_at, updated_at)
    VALUES (?, ?, ?, 'ready', ?, ?)
  `).run('mailbox-qualified', 'main@example.com', 'encrypted', timestamp, timestamp);
  gateway.db.prepare(`
    INSERT INTO aliases (id, mailbox_id, email, state, created_at, updated_at)
    VALUES (?, ?, ?, 'ready', ?, ?)
  `).run('alias-qualified', 'mailbox-qualified', 'qualified@example.com', timestamp, timestamp);
  const batch = registration.createBatch(1);
  let task = registration.createTask({
    batchId: batch.id,
    slot: 1,
    aliasId: 'alias-qualified',
    email: 'qualified@example.com',
    webApi: 'https://mail-api.example/otp',
  });
  task = registration.transitionTask(task.id, TASK_EVENTS.SUBMIT);
  task = registration.transitionTask(task.id, TASK_EVENTS.REGISTER, { terminalCode: 'register_completed' });
  task = registration.transitionTask(task.id, TASK_EVENTS.QUALIFY, {
    mfaStatus: 'enabled',
    trialQualification: 'observed_eligible',
  });

  const revealed = {
    password: 'generated-password',
    session: { token: 'session' },
    mfa: {
      status: 'enabled',
      factor_type: 'totp',
      active_factor_present: true,
      mutation_started: true,
      mutation_rejected: false,
      secret: 'GEZDGNBVGY3TQOJQ',
    },
    trial_qualification: 'observed_eligible',
    account_offers: [{ eligible_promo_campaigns: ['plus-1-month-free'] }],
  };
  const saved = registration.saveQualifiedAccount(task.id, revealed);

  assert.equal(saved.mfa_status, 'enabled');
  assert.equal(saved.trial_qualification, 'observed_eligible');
  assert.equal(saved.trial_summary, 'observed_eligible');
  const [listed] = registration.listQualifiedAccounts();
  assert.equal(listed.id, saved.id);
  assert.equal(listed.mfa_status, 'enabled');
  assert.equal(listed.trial_qualification, 'observed_eligible');
  assert.equal(listed.trial_summary, 'observed_eligible');
  const defaults = {
    rebind_status: 'original', original_email: 'qualified@example.com', rebound_at: null,
    last_rebind_job_id: null, credential_ready: true, cleanup_pending: false,
    current_mailbox_category: 'mail', mailbox_receiving: 'not_applicable',
  };
  for (const account of [saved, listed, registration.getQualifiedAccount(saved.id),
    registration.getQualifiedAccount(saved.id, { reveal: true })]) {
    for (const [key, value] of Object.entries(defaults)) assert.equal(account[key], value);
  }
  assert.deepEqual(registration.getQualifiedAccountRebindHistory(saved.id), { account: listed, history: [] });
  assert.equal(registration.getQualifiedAccountRebindHistory('missing'), null);

  const badResult = {
    ...revealed,
    trial_qualification: 'observed_ineligible',
  };
  assert.throws(
    () => registration.saveQualifiedAccount(task.id, badResult),
    /does not meet qualified account requirements/,
  );
  gateway.close();
});
