'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { RebindWorker } = require('../src/rebind/worker');

const input = () => ({ credentials: { email: 'new@example.test', password: 'private-password', totpSecret: 'private-totp' },
  proxy: 'http://fixture.invalid:8080', expectedAccountId: 'identity' });
const program = String.raw`
const emit = (value) => process.stdout.write(JSON.stringify(value) + '\n');
const mode = process.argv[1];
require('node:readline').createInterface({input: process.stdin}).once('line', (line) => {
  const request = JSON.parse(line);
  if (request.type !== 'trial' || request.newEmail || request.expectedAccountId !== 'identity'
    || Object.keys(request.credentials).sort().join() !== 'email,password,totpSecret') process.exit(2);
  if (mode === 'saved_session') {
    if (JSON.stringify(request.session) !== JSON.stringify({accessToken:'saved-access',sessionToken:'saved-session'})
      || request.mfaPreviouslyVerified !== true || JSON.stringify(request).includes('OLD_IDENTITY')) process.exit(3);
    process.stderr.write('saved-access saved-session');
    emit({type:'stage',stage:'session_trial'});
  }
  if (mode === 'no_session' && ('session' in request || request.mfaPreviouslyVerified !== false)) process.exit(4);
  if (mode === 'login_diagnostic') return emit({type:'error',code:'LOGIN_FAILED',diagnostic:{
    category:'http',httpStatus:401,phase:'password_verify',reason:'LOGIN_CREDENTIALS_REJECTED',message:'saved-access'}});
  if (mode === 'diagnostic') return emit({type:'error',code:'NETWORK_FAILED',diagnostic:{
    category:'http',httpStatus:429,curlCode:0,phase:'saved-access',reason:'saved-session',message:'saved-access'}});
  if (mode === 'hang') return setInterval(() => {}, 1000);
  if (mode === 'need_code') return emit({type:'need_code',issuedAfter:Date.now()});
  if (mode === 'old_stage') return emit({type:'stage',stage:'login_old'});
  if (mode === 'flood') return process.stderr.write('private'.repeat(50000));
  if (mode === 'invalid') return process.stdout.write('private-not-json\n');
  if (mode === 'worker_error') return emit({type:'error',code:'TRIAL_PROBE_FAILED',message:'private'});
  emit({type:'stage',stage:'login_trial'});
  emit({type:'stage',stage:'trial_qualification'});
  const result = {email:request.credentials.email,accountId:'identity',mfaVerified:true,status:'eligible',
    campaignId:'plus-1-month-free',amountMinor:0,currency:'USD',billingCountry:'US',errorCode:null,
    password:request.credentials.password,totpSecret:request.credentials.totpSecret,sessionToken:'private'};
  if (mode === 'fresh_session') result.session = { accessToken:'fresh-access',sessionToken:'fresh-session',email:'OLD_IDENTITY',password:'private' };
  if (mode === 'session_long') result.session = { accessToken:'a'.repeat(16385),sessionToken:'fresh-session' };
  if (mode === 'session_crlf') result.session = { accessToken:'fresh-access',sessionToken:'bad\r\nvalue' };
  if (mode === 'session_newline') result.session = { accessToken:'fresh-access',sessionToken:'bad\n' };
  if (mode === 'session_unicode') result.session = { accessToken:'\u00e9',sessionToken:'fresh-session' };
  if (mode === 'session_null') result.session = null;
  if (mode === 'session_array') result.session = [];
  if (mode === 'session_partial') result.session = { accessToken:'fresh-access' };
  if (mode === 'session_empty') result.session = { accessToken:'fresh-access',sessionToken:' ' };
  if (mode === 'session_number') result.session = { accessToken:42,sessionToken:'fresh-session' };
  if (mode === 'email') result.email = 'old@example.test';
  if (mode === 'identity') result.accountId = 'other';
  if (mode === 'mfa') result.mfaVerified = false;
  if (mode === 'amount') result.amountMinor = 0.5;
  if (mode === 'currency') result.currency = 'usd';
  if (mode === 'country') result.billingCountry = 'USA';
  if (mode === 'campaign') result.campaignId = 'other';
  if (mode === 'missing') delete result.amountMinor;
  if (mode === 'status') result.status = 'unknown';
  if (mode === 'error_code') result.errorCode = 'private';
  if (mode === 'error') Object.assign(result,{status:'error',amountMinor:null,currency:null,billingCountry:null,errorCode:'TRIAL_PROBE_FAILED'});
  emit({type:'result',result});
  if (mode === 'duplicate') emit({type:'result',result});
});
`;
function fixture(mode, options = {}) {
  return new RebindWorker({ timeoutMs: 3000, ...options, spawnImpl(command, args, config) {
    assert.equal(args.some((value) => /private|saved-access|saved-session|OLD_IDENTITY/.test(value)), false);
    assert.doesNotMatch(JSON.stringify(config.env), /saved-access|saved-session|OLD_IDENTITY/);
    assert.ok(Object.keys(config.env).every((key) => /^(PATH|SYSTEMROOT|WINDIR|COMSPEC|PATHEXT|TEMP|TMP|TMPDIR|LANG|LC_ALL|LC_CTYPE|PYTHONDONTWRITEBYTECODE|PYTHONIOENCODING|OPENAI_SENTINEL_NODE_PATH)$/i.test(key)));
    return spawn(process.execPath, ['-e', program, mode], config);
  } });
}

test('trial IPC matches identity and returns only sanitized qualification fields', async () => {
  const worker = fixture('success');
  const stages = [];
  const result = await worker.runTrial({ ...input(), onStage: async (stage) => { await new Promise(setImmediate); stages.push(stage); },
    waitForCode() { throw new Error('never permitted'); } });
  assert.deepEqual(stages, ['login_trial', 'trial_qualification']);
  assert.deepEqual(Object.keys(result).sort(), ['email', 'accountId', 'mfaVerified', 'status', 'campaignId', 'amountMinor', 'currency', 'billingCountry', 'errorCode'].sort());
  assert.equal(result.amountMinor, 0);
  assert.equal(result.status, 'eligible');
  assert.doesNotMatch(JSON.stringify(result), /private/);
  assert.equal(worker.active.size, 0);
  assert.equal((await fixture('error').runTrial(input())).status, 'error');
});

test('trial refreshed session response retains token whitelist only', async () => {
  const result = await fixture('fresh_session').runTrial(input());
  assert.deepEqual(result.session, { accessToken: 'fresh-access', sessionToken: 'fresh-session' });
  assert.doesNotMatch(JSON.stringify(result), /OLD_IDENTITY|private/);
});

for (const mode of ['session_long', 'session_crlf', 'session_newline', 'session_unicode', 'session_null', 'session_array', 'session_partial', 'session_empty', 'session_number',
  'email', 'identity', 'mfa', 'amount', 'currency', 'country', 'campaign', 'missing', 'status', 'error_code']) {
  test(`trial rejects invalid ${mode} result`, async () => {
    await assert.rejects(fixture(mode).runTrial(input()), { code: 'INVALID_RESULT' });
  });
}
for (const [mode, code] of [['need_code', 'PROTOCOL_ERROR'], ['old_stage', 'PROTOCOL_ERROR'], ['invalid', 'PROTOCOL_ERROR'],
  ['duplicate', 'PROTOCOL_ERROR'], ['flood', 'OUTPUT_LIMIT'], ['worker_error', 'TRIAL_PROBE_FAILED']]) {
  test(`trial ${mode} fails closed with sanitized protocol error`, async () => {
    const worker = fixture(mode, { maxOutputBytes: 16384 });
    await assert.rejects(worker.runTrial(input()), (error) => error.code === code && !error.message.includes('private'));
    assert.equal(worker.active.size, 0);
  });
}

test('trial timeout, close and stage callback failure use isolated worker disposal', async () => {
  const timeout = fixture('hang', { timeoutMs: 100 });
  await assert.rejects(timeout.runTrial(input()), { code: 'WORKER_TIMEOUT' });
  assert.equal(timeout.active.size, 0);
  const closing = fixture('hang');
  const pending = assert.rejects(closing.runTrial(input()), { code: 'ABORTED' });
  await closing.close();
  await pending;
  assert.equal(closing.active.size, 0);
  await assert.rejects(fixture('success').runTrial({ ...input(), onStage() { throw new Error('private'); } }), { code: 'STAGE_CALLBACK_FAILED' });
});

test('trial saved session crosses stdin only with token whitelist and strict MFA boolean', async () => {
  const stages = [];
  const result = await fixture('saved_session').runTrial({ ...input(),
    session: { accessToken: 'saved-access', sessionToken: 'saved-session', email: 'OLD_IDENTITY',
      accountId: 'OLD_IDENTITY', password: 'OLD_IDENTITY', nested: { sessionToken: 'OLD_IDENTITY' } },
    mfaPreviouslyVerified: true, onStage: (stage) => stages.push(stage) });
  assert.deepEqual(stages, ['session_trial', 'login_trial', 'trial_qualification']);
  assert.doesNotMatch(JSON.stringify(result), /saved-access|saved-session|OLD_IDENTITY/);
  for (const session of [undefined, null, [], 'saved-access', { accessToken: '', sessionToken: 123 }, { email: 'OLD_IDENTITY' },
    { accessToken: 'a'.repeat(16385), sessionToken: 'bad\r\nvalue' }, { accessToken: '\u00e9', sessionToken: 'bad value' }]) {
    await fixture('no_session').runTrial({ ...input(), session, mfaPreviouslyVerified: 'true' });
  }
  await assert.rejects(fixture('login_diagnostic').runTrial(input()), (error) => {
    assert.deepEqual(error.diagnostic, { category: 'http', httpStatus: 401, curlCode: null,
      phase: 'password_verify', reason: 'LOGIN_CREDENTIALS_REJECTED' });
    assert.doesNotMatch(JSON.stringify(error), /saved-access/);
    return error.code === 'LOGIN_FAILED';
  });
  await assert.rejects(fixture('diagnostic').runTrial(input()), (error) => {
    assert.deepEqual(error.diagnostic, { category: 'http', httpStatus: 429, curlCode: null });
    assert.doesNotMatch(JSON.stringify(error), /saved-access|saved-session/);
    return error.code === 'NETWORK_FAILED';
  });
});

test('trial rejects absent expected identity and oversized requests before spawning', async () => {
  const worker = new RebindWorker({ spawnImpl() { assert.fail('unexpected spawn'); } });
  await assert.rejects(worker.runTrial({ ...input(), expectedAccountId: undefined }), { code: 'INVALID_INPUT' });
  await assert.rejects(worker.runTrial({ ...input(), expectedAccountId: 'a'.repeat(70000) }), { code: 'INVALID_INPUT' });
  await assert.rejects(worker.runTrial({ ...input(), signal: AbortSignal.abort() }), { code: 'ABORTED' });
});
