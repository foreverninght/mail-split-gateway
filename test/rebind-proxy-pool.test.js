'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { RebindStore, COOLDOWN_MS } = require('../src/rebind/store');
const { SecretBox } = require('../src/security/secret-box');

function fixture(t, proxyRefreshMs = 1800000) {
  let now = Date.parse('2026-02-01T00:00:00Z');
  const db = new DatabaseSync(':memory:');
  db.exec(`PRAGMA foreign_keys = ON;
    CREATE TABLE registration_tasks (id TEXT PRIMARY KEY, mailbox_category TEXT);
    INSERT INTO registration_tasks VALUES ('task', 'mail');
    CREATE TABLE qualified_accounts (id TEXT PRIMARY KEY, email TEXT, created_at TEXT, task_id TEXT DEFAULT 'task',
      encrypted_password TEXT, encrypted_totp_secret TEXT, encrypted_session_json TEXT, encrypted_result_json TEXT);
    CREATE TABLE mailboxes (id TEXT PRIMARY KEY);
    CREATE TABLE aliases (id TEXT PRIMARY KEY, state TEXT);
    INSERT INTO mailboxes VALUES ('mailbox');`);
  const secretBox = new SecretBox(Buffer.alloc(32, 7).toString('base64'));
  for (const id of ['a', 'b', 'c', 'd', 'e']) db.prepare('INSERT INTO qualified_accounts (id,email,created_at,encrypted_result_json) VALUES (?,?,?,?)')
    .run(id, `${id}@example.com`, new Date(now - COOLDOWN_MS).toISOString(), secretBox.seal('{}'));
  const store = new RebindStore({ db, secretBox, clock: () => now, proxyRefreshMs });
  t.after(() => db.close());
  return { store, db, secretBox, now: () => now, advance: (ms) => { now += ms; },
    create: (accountId, idempotencyKey) => store.createJob({ accountId, mailboxId: 'mailbox', idempotencyKey }),
    consume(job) {
      store.update(job.id, { state: 'running' });
      store.persistResult(job.id, { email: 'changed@example.com', password: 'p', totpSecret: 't', sessionToken: 's', accessToken: 'a' });
    } };
}

const rows = (f) => f.db.prepare('SELECT * FROM rebind_proxy_pool ORDER BY id').all();

test('empty pool rolls back jobs/events and permits the same idempotency key after import', (t) => {
  const f = fixture(t);
  assert.throws(() => f.create('a', 'retry'), { code: 'REBIND_PROXY_POOL_EXHAUSTED' });
  assert.equal(f.store.listJobs().length, 0);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM rebind_events').get().n, 0);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM rebind_alias_claims').get().n, 0);
  f.store.importProxies('host:8001');
  const job = f.create('a', 'retry');
  assert.equal(f.create('a', 'retry').id, job.id);
  assert.equal(rows(f).filter((row) => row.status === 'reserved').length, 1);
  assert.equal(f.store.proxyOverview({ q: job.id }).pagination.total, 1);
  assert.throws(() => f.create('b'), { code: 'REBIND_PROXY_POOL_EXHAUSTED' });
});

test('concurrent jobs reserve distinct entries and snapshots survive replacement', async (t) => {
  const f = fixture(t);
  f.store.importProxies(['host:8001', 'host:8002']);
  const [a, b] = await Promise.all([Promise.resolve().then(() => f.create('a')), Promise.resolve().then(() => f.create('b'))]);
  assert.notEqual(a.proxy_id, b.proxy_id);
  f.store.importProxies(['host:8003']);
  assert.equal(f.secretBox.open(f.store.getJob(a.id).encrypted_proxy), 'host:8001');
  assert.equal(rows(f)[0].active, 0);
  f.consume(a);
  assert.equal(rows(f)[0].status, 'consumed');
  const restored = f.store.importProxies(['host:8001', 'host:8002'], { mode: 'replace' });
  assert.equal(restored.restored, 2);
  assert.deepEqual(rows(f).map((row) => row.status), ['consumed', 'reserved', 'available']);
});

test('30 minute cooldown is exact, unused entries precede recycled entries and allocation rotates', (t) => {
  const f = fixture(t);
  f.store.importProxies(['host:8001']);
  const a = f.create('a');
  f.consume(a);
  const consumedAt = rows(f)[0].consumed_at;
  f.advance(1800000 - 1);
  assert.equal(f.store.proxyOverview().stats.consumed, 1);
  assert.throws(() => f.create('b'), { code: 'REBIND_PROXY_POOL_EXHAUSTED' });
  f.advance(1);
  assert.equal(f.store.proxyOverview().stats.available, 1);
  f.store.importProxies(['host:8001', 'host:8002'], { mode: 'replace' });
  const b = f.create('b');
  assert.notEqual(b.proxy_id, a.proxy_id);
  f.store.interrupt(b.id, { workerStarted: false });
  const c = f.create('c');
  assert.equal(c.proxy_id, a.proxy_id);
  assert.equal(rows(f)[0].consumed_at, consumedAt);
  const d = f.create('d');
  assert.equal(d.proxy_id, b.proxy_id);
});

test('atomic sanitized import, deduplication, replacement, filtering and public contract', (t) => {
  const f = fixture(t, 1234);
  f.store.importProxies(['host:8001']);
  const before = rows(f);
  assert.throws(() => f.store.importProxies(['new:9000'], { mode: 'append' }), { code: 'INVALID_PROXY_MODE', statusCode: 400 });
  assert.deepEqual(rows(f), before);
  assert.throws(() => f.store.importProxies(['good:9001', 'SECRET_INVALID_VALUE']), (error) => {
    assert.equal(error.statusCode, 400);
    assert.doesNotMatch(JSON.stringify(error) + error.message, /SECRET_INVALID_VALUE/);
    return true;
  });
  assert.deepEqual(rows(f), before);
  for (const bad of ['host:bad', 'host:0', 'host:65536', 'host name:8000', 'http://host:99999:user:password']) {
    assert.throws(() => f.store.importProxies(['good:8000', bad]), { code: 'INVALID_PROXY_LIST' });
    assert.deepEqual(rows(f), before);
  }
  assert.throws(() => f.store.importProxies(' \n'), { code: 'EMPTY_PROXY_LIST' });
  assert.deepEqual(rows(f), before);
  const imported = f.store.importProxies(['host:8001', 'http://other:9002:user:secret', 'http://other:9002:user:secret'], { mode: 'replace' });
  assert.equal(imported.duplicates, 1);
  assert.equal(imported.current, 2);
  assert.equal(f.secretBox.open(rows(f)[1].encrypted_endpoint), 'http://user:secret@other:9002');
  const overview = f.store.proxyOverview({ page: 3, limit: 1, status: 'available', q: 'other' });
  assert.deepEqual(overview.pagination, { page: 1, limit: 1, total: 1, pages: 1 });
  assert.equal(overview.cooldownMs, 1234);
  assert.deepEqual(overview.stats, { total: 2, available: 2, reserved: 0, consumed: 0, quarantined: 0 });
  assert.deepEqual(Object.keys(overview.proxies[0]).sort(), ['id', 'masked_endpoint', 'status', 'job_id', 'imported_at', 'reserved_at', 'consumed_at', 'cooldown_until'].sort());
  assert.doesNotMatch(JSON.stringify(overview), /secret|encrypted_endpoint|fingerprint/);
});

test('restart quarantines running, releases queued, preserves legacy jobs and never schedules replay', (t) => {
  const f = fixture(t);
  f.store.importProxies(['host:8001', 'host:8002']);
  const queued = f.create('a');
  const running = f.create('b');
  f.store.update(running.id, { state: 'running' });
  f.db.prepare(`INSERT INTO rebind_jobs (id,account_id,mailbox_id,state,created_at,updated_at)
    VALUES ('legacy','c','mailbox','running',?,?)`).run(new Date(f.now()).toISOString(), new Date(f.now()).toISOString());
  assert.deepEqual(f.store.recoverAfterRestart(), { jobs: 3 });
  assert.equal(f.store.getJob('legacy').state, 'needs_review');
  assert.equal(f.store.getJob(queued.id).state, 'preparation_failed');
  assert.equal(f.store.getJob(running.id).state, 'needs_review');
  assert.deepEqual(rows(f).map((row) => row.status), ['available', 'quarantined']);
  f.store.importProxies(['host:8003']);
  f.store.importProxies(['host:8001', 'host:8002'], { mode: 'replace' });
  assert.equal(rows(f)[1].status, 'quarantined');
  assert.deepEqual(f.store.recoverAfterRestart(), { jobs: 0 });
  assert.equal(f.create('b').id, running.id);
});

test('result persistence rollback protects accounts and reservation; cleanup never consumes a newer allocation', (t) => {
  const f = fixture(t, 1);
  f.store.importProxies(['host:8001']);
  const a = f.create('a');
  f.db.exec(`CREATE TRIGGER reject_consumption BEFORE UPDATE OF status ON rebind_proxy_pool
    WHEN NEW.status = 'consumed' BEGIN SELECT RAISE(ABORT, 'failure'); END;`);
  assert.throws(() => f.consume(a), /failure/);
  assert.equal(f.store.getJob(a.id).encrypted_result, null);
  assert.equal(f.db.prepare("SELECT email FROM qualified_accounts WHERE id = 'a'").get().email, 'a@example.com');
  assert.equal(rows(f)[0].status, 'reserved');
  f.db.exec('DROP TRIGGER reject_consumption');
  f.consume(a);
  f.advance(1);
  const b = f.create('b');
  f.store.complete(a.id);
  f.store.interrupt(a.id);
  f.store.proxyPool.finish(a.id, 'consumed');
  assert.equal(rows(f)[0].job_id, b.id);
  assert.equal(rows(f)[0].status, 'reserved');
});
