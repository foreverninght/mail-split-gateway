'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  BATCH_EVENTS, BATCH_STATES, TASK_EVENTS, TASK_STATES, nextBatchState, nextTaskState,
} = require('../src/registration/state-machine');

test('registration state machines reject skipped business stages', () => {
  assert.equal(nextBatchState(BATCH_STATES.QUEUED, BATCH_EVENTS.START), BATCH_STATES.CREATING_ALIASES);
  assert.equal(nextTaskState(TASK_STATES.REGISTERED, TASK_EVENTS.QUALIFY), TASK_STATES.QUALIFIED);
  assert.throws(() => nextBatchState(BATCH_STATES.QUEUED, BATCH_EVENTS.SUBMIT_ACCEPTED), /invalid batch transition/);
  assert.throws(() => nextTaskState(TASK_STATES.REGISTERED, TASK_EVENTS.SAVE), /invalid task transition/);
});
