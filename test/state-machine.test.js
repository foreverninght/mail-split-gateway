'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  ALIAS_EVENTS,
  ALIAS_STATES,
  InvalidTransitionError,
  MAILBOX_EVENTS,
  MAILBOX_STATES,
  isAliasCapacityOccupied,
  isAliasPubliclyReadable,
  nextAliasState,
  nextMailboxState,
} = require('../src/domain/state-machine');

test('mailbox opens, renews, and closes through explicit states', () => {
  let state = nextMailboxState(MAILBOX_STATES.CLOSED, MAILBOX_EVENTS.OPEN);
  assert.equal(state, MAILBOX_STATES.OPENING);
  state = nextMailboxState(state, MAILBOX_EVENTS.OPENED);
  assert.equal(state, MAILBOX_STATES.READY);
  state = nextMailboxState(state, MAILBOX_EVENTS.RENEW);
  assert.equal(state, MAILBOX_STATES.RENEWING);
  state = nextMailboxState(state, MAILBOX_EVENTS.OPENED);
  assert.equal(state, MAILBOX_STATES.READY);
  assert.equal(nextMailboxState(state, MAILBOX_EVENTS.CLOSE), MAILBOX_STATES.CLOSED);
});

test('alias follows its complete public lifecycle', () => {
  let state = nextAliasState(ALIAS_STATES.CREATING, ALIAS_EVENTS.CREATE_CONFIRMED);
  state = nextAliasState(state, ALIAS_EVENTS.EXPORT);
  state = nextAliasState(state, ALIAS_EVENTS.ACCESS);
  state = nextAliasState(state, ALIAS_EVENTS.CODE_DELIVERED);
  state = nextAliasState(state, ALIAS_EVENTS.RELEASE);
  state = nextAliasState(state, ALIAS_EVENTS.START_DELETE);
  state = nextAliasState(state, ALIAS_EVENTS.DELETE_CONFIRMED);
  assert.equal(state, ALIAS_STATES.DELETED);
});

test('unknown remote outcomes must be reconciled', () => {
  const createUnknown = nextAliasState(ALIAS_STATES.CREATING, ALIAS_EVENTS.CREATE_RESULT_UNKNOWN);
  assert.throws(
    () => nextAliasState(createUnknown, ALIAS_EVENTS.RETRY_CREATE),
    InvalidTransitionError,
  );
  assert.equal(
    nextAliasState(createUnknown, ALIAS_EVENTS.RECONCILE_PRESENT),
    ALIAS_STATES.READY,
  );

  const deleteUnknown = nextAliasState(ALIAS_STATES.DELETING, ALIAS_EVENTS.DELETE_RESULT_UNKNOWN);
  assert.equal(
    nextAliasState(deleteUnknown, ALIAS_EVENTS.RECONCILE_ABSENT),
    ALIAS_STATES.DELETED,
  );
});

test('only exported aliases are publicly readable and unresolved aliases occupy capacity', () => {
  assert.equal(isAliasPubliclyReadable(ALIAS_STATES.READY), false);
  assert.equal(isAliasPubliclyReadable(ALIAS_STATES.EXPORTED), true);
  assert.equal(isAliasPubliclyReadable(ALIAS_STATES.ACTIVE), true);
  assert.equal(isAliasPubliclyReadable(ALIAS_STATES.DELIVERED), true);
  assert.equal(isAliasPubliclyReadable(ALIAS_STATES.RELEASE_PENDING), false);
  assert.equal(isAliasCapacityOccupied(ALIAS_STATES.CREATE_UNKNOWN), true);
  assert.equal(isAliasCapacityOccupied(ALIAS_STATES.DELETE_UNKNOWN), true);
  assert.equal(isAliasCapacityOccupied(ALIAS_STATES.DELETED), false);
});

test('discovered remote aliases must pass through confirmed deletion states', () => {
  let state = nextAliasState(ALIAS_STATES.DISCOVERED, ALIAS_EVENTS.RELEASE);
  state = nextAliasState(state, ALIAS_EVENTS.START_DELETE);
  state = nextAliasState(state, ALIAS_EVENTS.DELETE_CONFIRMED);
  assert.equal(state, ALIAS_STATES.DELETED);
});
