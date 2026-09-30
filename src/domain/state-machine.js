'use strict';

const MAILBOX_STATES = Object.freeze({
  CLOSED: 'closed',
  OPENING: 'opening',
  READY: 'ready',
  RENEWING: 'renewing',
  LOGIN_REQUIRED: 'login_required',
  UNAVAILABLE: 'unavailable',
});

const MAILBOX_EVENTS = Object.freeze({
  OPEN: 'open',
  OPENED: 'opened',
  RENEW: 'renew',
  LOGIN_REJECTED: 'login_rejected',
  OPERATION_FAILED: 'operation_failed',
  CLOSE: 'close',
});

const ALIAS_STATES = Object.freeze({
  CREATING: 'creating',
  CREATE_FAILED: 'create_failed',
  CREATE_UNKNOWN: 'create_unknown',
  DISCOVERED: 'discovered',
  READY: 'ready',
  EXPORTED: 'exported',
  ACTIVE: 'active',
  DELIVERED: 'delivered',
  RELEASE_PENDING: 'release_pending',
  DELETING: 'deleting',
  DELETE_FAILED: 'delete_failed',
  DELETE_UNKNOWN: 'delete_unknown',
  DELETED: 'deleted',
});

const ALIAS_EVENTS = Object.freeze({
  CREATE_CONFIRMED: 'create_confirmed',
  CREATE_FAILED: 'create_failed',
  CREATE_RESULT_UNKNOWN: 'create_result_unknown',
  RETRY_CREATE: 'retry_create',
  RECONCILE_PRESENT: 'reconcile_present',
  RECONCILE_ABSENT: 'reconcile_absent',
  EXPORT: 'export',
  ROTATE_TOKEN: 'rotate_token',
  ACCESS: 'access',
  CODE_DELIVERED: 'code_delivered',
  RELEASE: 'release',
  START_DELETE: 'start_delete',
  DELETE_CONFIRMED: 'delete_confirmed',
  DELETE_FAILED: 'delete_failed',
  DELETE_RESULT_UNKNOWN: 'delete_result_unknown',
  RETRY_DELETE: 'retry_delete',
});

function transitionMap(entries) {
  return new Map(entries.map(([state, events]) => [state, new Map(Object.entries(events))]));
}

const MAILBOX_TRANSITIONS = transitionMap([
  [MAILBOX_STATES.CLOSED, {
    [MAILBOX_EVENTS.OPEN]: MAILBOX_STATES.OPENING,
  }],
  [MAILBOX_STATES.OPENING, {
    [MAILBOX_EVENTS.OPENED]: MAILBOX_STATES.READY,
    [MAILBOX_EVENTS.LOGIN_REJECTED]: MAILBOX_STATES.LOGIN_REQUIRED,
    [MAILBOX_EVENTS.OPERATION_FAILED]: MAILBOX_STATES.UNAVAILABLE,
    [MAILBOX_EVENTS.CLOSE]: MAILBOX_STATES.CLOSED,
  }],
  [MAILBOX_STATES.READY, {
    [MAILBOX_EVENTS.RENEW]: MAILBOX_STATES.RENEWING,
    [MAILBOX_EVENTS.OPERATION_FAILED]: MAILBOX_STATES.UNAVAILABLE,
    [MAILBOX_EVENTS.CLOSE]: MAILBOX_STATES.CLOSED,
  }],
  [MAILBOX_STATES.RENEWING, {
    [MAILBOX_EVENTS.OPENED]: MAILBOX_STATES.READY,
    [MAILBOX_EVENTS.LOGIN_REJECTED]: MAILBOX_STATES.LOGIN_REQUIRED,
    [MAILBOX_EVENTS.OPERATION_FAILED]: MAILBOX_STATES.UNAVAILABLE,
    [MAILBOX_EVENTS.CLOSE]: MAILBOX_STATES.CLOSED,
  }],
  [MAILBOX_STATES.LOGIN_REQUIRED, {
    [MAILBOX_EVENTS.OPEN]: MAILBOX_STATES.OPENING,
    [MAILBOX_EVENTS.CLOSE]: MAILBOX_STATES.CLOSED,
  }],
  [MAILBOX_STATES.UNAVAILABLE, {
    [MAILBOX_EVENTS.OPEN]: MAILBOX_STATES.OPENING,
    [MAILBOX_EVENTS.CLOSE]: MAILBOX_STATES.CLOSED,
  }],
]);

const releasableStates = [
  ALIAS_STATES.DISCOVERED,
  ALIAS_STATES.READY,
  ALIAS_STATES.EXPORTED,
  ALIAS_STATES.ACTIVE,
  ALIAS_STATES.DELIVERED,
];

const ALIAS_TRANSITIONS = transitionMap([
  [ALIAS_STATES.CREATING, {
    [ALIAS_EVENTS.CREATE_CONFIRMED]: ALIAS_STATES.READY,
    [ALIAS_EVENTS.CREATE_FAILED]: ALIAS_STATES.CREATE_FAILED,
    [ALIAS_EVENTS.CREATE_RESULT_UNKNOWN]: ALIAS_STATES.CREATE_UNKNOWN,
  }],
  [ALIAS_STATES.CREATE_FAILED, {
    [ALIAS_EVENTS.RETRY_CREATE]: ALIAS_STATES.CREATING,
  }],
  [ALIAS_STATES.CREATE_UNKNOWN, {
    [ALIAS_EVENTS.RECONCILE_PRESENT]: ALIAS_STATES.READY,
    [ALIAS_EVENTS.RECONCILE_ABSENT]: ALIAS_STATES.CREATE_FAILED,
  }],
  [ALIAS_STATES.DISCOVERED, {
    [ALIAS_EVENTS.RELEASE]: ALIAS_STATES.RELEASE_PENDING,
  }],
  [ALIAS_STATES.READY, {
    [ALIAS_EVENTS.EXPORT]: ALIAS_STATES.EXPORTED,
    [ALIAS_EVENTS.RELEASE]: ALIAS_STATES.RELEASE_PENDING,
  }],
  [ALIAS_STATES.EXPORTED, {
    [ALIAS_EVENTS.ROTATE_TOKEN]: ALIAS_STATES.EXPORTED,
    [ALIAS_EVENTS.ACCESS]: ALIAS_STATES.ACTIVE,
    [ALIAS_EVENTS.RELEASE]: ALIAS_STATES.RELEASE_PENDING,
  }],
  [ALIAS_STATES.ACTIVE, {
    [ALIAS_EVENTS.ROTATE_TOKEN]: ALIAS_STATES.ACTIVE,
    [ALIAS_EVENTS.ACCESS]: ALIAS_STATES.ACTIVE,
    [ALIAS_EVENTS.CODE_DELIVERED]: ALIAS_STATES.DELIVERED,
    [ALIAS_EVENTS.RELEASE]: ALIAS_STATES.RELEASE_PENDING,
  }],
  [ALIAS_STATES.DELIVERED, {
    [ALIAS_EVENTS.ROTATE_TOKEN]: ALIAS_STATES.DELIVERED,
    [ALIAS_EVENTS.ACCESS]: ALIAS_STATES.DELIVERED,
    [ALIAS_EVENTS.CODE_DELIVERED]: ALIAS_STATES.DELIVERED,
    [ALIAS_EVENTS.RELEASE]: ALIAS_STATES.RELEASE_PENDING,
  }],
  [ALIAS_STATES.RELEASE_PENDING, {
    [ALIAS_EVENTS.START_DELETE]: ALIAS_STATES.DELETING,
  }],
  [ALIAS_STATES.DELETING, {
    [ALIAS_EVENTS.DELETE_CONFIRMED]: ALIAS_STATES.DELETED,
    [ALIAS_EVENTS.DELETE_FAILED]: ALIAS_STATES.DELETE_FAILED,
    [ALIAS_EVENTS.DELETE_RESULT_UNKNOWN]: ALIAS_STATES.DELETE_UNKNOWN,
  }],
  [ALIAS_STATES.DELETE_FAILED, {
    [ALIAS_EVENTS.RETRY_DELETE]: ALIAS_STATES.DELETING,
  }],
  [ALIAS_STATES.DELETE_UNKNOWN, {
    [ALIAS_EVENTS.RECONCILE_PRESENT]: ALIAS_STATES.DELETE_FAILED,
    [ALIAS_EVENTS.RECONCILE_ABSENT]: ALIAS_STATES.DELETED,
  }],
  [ALIAS_STATES.DELETED, {}],
]);

class InvalidTransitionError extends Error {
  constructor(entity, state, event) {
    super(`invalid ${entity} transition: ${state} + ${event}`);
    this.name = 'InvalidTransitionError';
    this.code = 'INVALID_STATE_TRANSITION';
    this.entity = entity;
    this.state = state;
    this.event = event;
  }
}

function nextState(entity, transitions, state, event) {
  const next = transitions.get(state)?.get(event);
  if (!next) throw new InvalidTransitionError(entity, state, event);
  return next;
}

function nextMailboxState(state, event) {
  return nextState('mailbox', MAILBOX_TRANSITIONS, state, event);
}

function nextAliasState(state, event) {
  return nextState('alias', ALIAS_TRANSITIONS, state, event);
}

function isAliasCapacityOccupied(state) {
  return state !== ALIAS_STATES.CREATE_FAILED && state !== ALIAS_STATES.DELETED;
}

function isAliasPubliclyReadable(state) {
  return [ALIAS_STATES.EXPORTED, ALIAS_STATES.ACTIVE, ALIAS_STATES.DELIVERED].includes(state);
}

module.exports = {
  ALIAS_EVENTS,
  ALIAS_STATES,
  InvalidTransitionError,
  MAILBOX_EVENTS,
  MAILBOX_STATES,
  isAliasCapacityOccupied,
  isAliasPubliclyReadable,
  nextAliasState,
  nextMailboxState,
  releasableStates,
};
