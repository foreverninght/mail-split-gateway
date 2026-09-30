'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { ALIAS_EVENTS, ALIAS_STATES, MAILBOX_EVENTS } = require('../src/domain/state-machine');
const { GatewayStore } = require('../src/db/store');

test('store persists transitions and immutable event history', (t) => {
  let time = Date.parse('2026-08-30T00:00:00.000Z');
  const store = new GatewayStore({ filename: ':memory:', clock: () => time });
  t.after(() => store.close());

  const mailbox = store.createMailbox({ email: 'Main@Example.com', encryptedPassword: 'sealed' });
  store.transitionMailbox(mailbox.id, MAILBOX_EVENTS.OPEN);
  store.transitionMailbox(mailbox.id, MAILBOX_EVENTS.OPENED);

  const alias = store.createAlias({ mailboxId: mailbox.id, email: 'Alias@Example.com' });
  store.transitionAlias(alias.id, ALIAS_EVENTS.CREATE_CONFIRMED);
  time += 1000;
  store.transitionAlias(alias.id, ALIAS_EVENTS.EXPORT, {
    tokenHash: 'token-hash',
    exportedAt: new Date(time).toISOString(),
  });
  time += 1000;
  store.transitionAlias(alias.id, ALIAS_EVENTS.ACCESS, {
    firstAccessedAt: new Date(time).toISOString(),
    lastAccessedAt: new Date(time).toISOString(),
  });

  const current = store.getAlias(alias.id);
  assert.equal(current.state, ALIAS_STATES.ACTIVE);
  assert.equal(current.version, 4);
  assert.equal(store.findAliasByTokenHash('token-hash').id, alias.id);
  assert.deepEqual(
    store.listAliasEvents(alias.id).map((event) => event.event),
    [ALIAS_EVENTS.CREATE_CONFIRMED, ALIAS_EVENTS.EXPORT, ALIAS_EVENTS.ACCESS],
  );
});

test('database constraints reject exported aliases without a token', (t) => {
  const store = new GatewayStore({ filename: ':memory:' });
  t.after(() => store.close());
  const mailbox = store.createMailbox({ email: 'main@example.com', encryptedPassword: 'sealed' });
  const alias = store.createAlias({ mailboxId: mailbox.id, email: 'alias@example.com' });
  store.transitionAlias(alias.id, ALIAS_EVENTS.CREATE_CONFIRMED);
  assert.throws(() => store.transitionAlias(alias.id, ALIAS_EVENTS.EXPORT));
});

test('domain sync marks suffixes missing instead of leaving stale domains active', (t) => {
  const store = new GatewayStore({ filename: ':memory:' });
  t.after(() => store.close());
  const mailbox = store.createMailbox({ email: 'main@example.com', encryptedPassword: 'sealed' });
  store.replaceDomains(mailbox.id, [
    { domain: 'one.example', state: 'ACTIVE' },
    { domain: 'two.example', state: 'ACTIVE' },
  ]);
  store.replaceDomains(mailbox.id, [{ domain: 'two.example', state: 'ACTIVE' }]);
  const domains = store.listDomains(mailbox.id);
  assert.equal(domains.find((item) => item.domain === 'one.example').remote_state, 'MISSING');
  assert.equal(domains.find((item) => item.domain === 'two.example').remote_state, 'ACTIVE');
});

test('shared catalog preserves hidden, explicit, and blacklisted classifications', (t) => {
  const store = new GatewayStore({ filename: ':memory:' });
  t.after(() => store.close());
  const counts = store.importDomainCatalog([
    { domain: 'hidden.example', state: 'HIDDEN', blacklisted: false },
    { domain: 'visible.example', state: 'ACTIVE', blacklisted: false },
    { domain: 'blocked.example', state: 'HIDDEN', blacklisted: true },
  ], { source: 'test' });
  assert.deepEqual(counts, { total: 3, hidden: 1, explicit: 1, blacklist: 1 });
  store.mergeRemoteDomains([{ domain: 'hidden.example', state: 'ACTIVE' }]);
  assert.equal(store.listCatalogDomains({ kind: 'hidden' })[0].domain, 'hidden.example');
});

test('domain usage is globally limited to three creations in a rolling hour', (t) => {
  let time = Date.parse('2026-08-30T00:00:00.000Z');
  const store = new GatewayStore({ filename: ':memory:', clock: () => time });
  t.after(() => store.close());
  const firstMailbox = store.createMailbox({ email: 'first@example.com', encryptedPassword: 'sealed' });
  const secondMailbox = store.createMailbox({ email: 'second@example.com', encryptedPassword: 'sealed' });
  for (let index = 0; index < 3; index += 1) {
    const alias = store.createAliasWithDomainLimit({
      mailboxId: index % 2 ? firstMailbox.id : secondMailbox.id,
      localPart: `alias${index}`,
      domains: ['limited.example'],
    });
    store.markAliasDomainUsage(alias.id, index === 2 ? 'uncertain' : 'confirmed');
  }
  assert.equal(store.availableAliasDomainCapacity(['limited.example']), 0);
  assert.throws(() => store.createAliasWithDomainLimit({
    mailboxId: firstMailbox.id,
    localPart: 'blocked',
    domains: ['limited.example'],
  }), /limit of 3 per hour/);

  time += 60 * 60 * 1000 + 1;
  assert.equal(store.availableAliasDomainCapacity(['limited.example']), 3);
  assert.equal(store.createAliasWithDomainLimit({
    mailboxId: firstMailbox.id,
    localPart: 'allowed',
    domains: ['limited.example'],
  }).email, 'allowed@limited.example');
});

test('domain selection uses random indices across every eligible suffix and excludes full ones', (t) => {
  const sizes = [];
  const choices = [2, 2, 2, 1, 0];
  const store = new GatewayStore({ filename: ':memory:', randomDomainIndex: (size) => { sizes.push(size); return choices.shift(); } });
  t.after(() => store.close());
  const mailbox = store.createMailbox({ email: 'main@example.com', encryptedPassword: 'sealed' });
  const domains = ['aaa.example', 'bbb.example', 'zzz.example', 'AAA.EXAMPLE'];
  const emails = [];
  for (let index = 0; index < 5; index += 1) {
    const alias = store.createAliasWithDomainLimit({ mailboxId: mailbox.id, localPart: 'random' + index, domains });
    emails.push(alias.email.split('@')[1]);
    store.markAliasDomainUsage(alias.id, 'confirmed');
  }
  assert.deepEqual(emails, ['zzz.example', 'zzz.example', 'zzz.example', 'bbb.example', 'aaa.example']);
  assert.deepEqual(sizes, [3, 3, 3, 2, 2]);
  assert.equal(store.availableAliasDomainCapacity(domains), 4);
});

test('invalid random selection rolls back alias and quota reservations', (t) => {
  const store = new GatewayStore({ filename: ':memory:', randomDomainIndex: () => -1 });
  t.after(() => store.close());
  const mailbox = store.createMailbox({ email: 'main@example.com', encryptedPassword: 'sealed' });
  assert.throws(() => store.createAliasWithDomainLimit({ mailboxId: mailbox.id, localPart: 'bad', domains: ['one.example'] }), /invalid random domain index/);
  assert.equal(store.listAliases({ mailboxId: mailbox.id }).length, 0);
  assert.equal(store.aliasDomainUsage().length, 0);
});
