'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const { RebindWorker } = require('../src/rebind/worker');

const credentials = { email: 'old@example.test', password: ' password ', totpSecret: 'FIXTURESECRET' };
const input = () => ({ credentials, newEmail: 'new@example.test', proxy: 'http://fixture.invalid:8080', waitForCode: async () => '123456' });
const program = `
const readline = require('node:readline');
const mode = process.argv[1];
const emit = (x) => process.stdout.write(JSON.stringify(x) + '\\n');
const lines = readline.createInterface({ input: process.stdin });
let request;
lines.on('line', (line) => {
  const msg = JSON.parse(line);
  if (!request) {
    request = msg;
    if (mode === 'exit') process.exit(3);
    if (mode === 'hang') return setInterval(() => {}, 1000);
    if (mode === 'tree') {
      const descendant = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {stdio:'ignore'});
      process.stderr.write(String(descendant.pid));
      return setInterval(() => {}, 1000);
    }
    if (mode === 'invalid') return process.stdout.write('secret-raw-body\\n');
    if (mode === 'flood') return process.stderr.write('secret'.repeat(10000));
    if (mode === 'error') return emit({type:'error', code:'MFA_FAILED', message:'secret-raw-body'});
    emit({type:'stage',stage:'login_old'});
    emit({type:'stage',stage:'begin'});
    emit({type:'need_code',issuedAfter:Date.now()});
  } else {
    if (msg.code !== '123456') process.exit(4);
    emit({type:'stage',stage:'completed'});
    emit({type:'result',result:{email:request.newEmail,accountId:mode === 'mismatch' ? 'wrong' : 'id',
      originalAccountId:'id',password:request.credentials.password,totpSecret:request.credentials.totpSecret,
      sessionToken:'fixture-session',accessToken:'fixture-access',mfaVerified:true}});
    lines.close();
    process.stdin.destroy();
  }
});
`;

function fixture(mode, options = {}) {
  return new RebindWorker({ timeoutMs: 3000, ...options, spawnImpl(command, args, config) {
    assert.equal(args.includes(input().proxy), false);
    assert.equal(args.includes(credentials.password), false);
    assert.equal(config.env.OPENAI_SENTINEL_NODE_PATH, process.execPath);
    assert.ok(Object.keys(config.env).every((key) => /^(PATH|SYSTEMROOT|WINDIR|COMSPEC|PATHEXT|TEMP|TMP|TMPDIR|LANG|LC_ALL|LC_CTYPE|PYTHONDONTWRITEBYTECODE|PYTHONIOENCODING|OPENAI_SENTINEL_NODE_PATH)$/i.test(key)));
    return spawn(process.execPath, ['-e', program, mode], config);
  } });
}

test('IPC returns validated secrets only in result and serializes stage callbacks', async () => {
  const worker = fixture('success');
  const stages = [];
  const result = await worker.run({ ...input(), waitForCode: async ({ issuedAfter, signal }) => {
    assert.ok(issuedAfter > 1e12);
    assert.equal(signal.aborted, false);
    return '123456';
  }, onStage: async (stage) => {
    await new Promise((resolve) => setTimeout(resolve, 5));
    stages.push(stage);
  } });
  assert.equal(result.password, credentials.password);
  assert.equal(result.mfaVerified, true);
  assert.deepEqual(stages, ['login_old', 'begin', 'completed']);
  assert.equal(worker.active.size, 0);
});

for (const [mode, code, options] of [['exit', 'WORKER_EXIT_FAILED', {}], ['invalid', 'PROTOCOL_ERROR', {}],
  ['flood', 'OUTPUT_LIMIT', { maxOutputBytes: 1024 }], ['error', 'MFA_FAILED', {}],
  ['mismatch', 'INVALID_RESULT', {}], ['hang', 'WORKER_TIMEOUT', { timeoutMs: 150 }]]) {
  test(`worker ${mode} fails without leaking raw output`, async () => {
    const worker = fixture(mode, options);
    await assert.rejects(worker.run(input()), (error) => error.code === code && !error.message.includes('secret'));
    assert.equal(worker.active.size, 0);
  });
}

test('close aborts pending code wait and waits for worker disposal', async () => {
  const worker = fixture('success');
  let waiting;
  const reached = new Promise((resolve) => { waiting = resolve; });
  let codeSignal;
  const work = worker.run({ ...input(), waitForCode: ({ signal }) => {
    codeSignal = signal;
    waiting();
    return new Promise(() => {});
  } });
  const rejected = assert.rejects(work, { code: 'ABORTED' });
  await reached;
  await worker.close();
  assert.equal(codeSignal.aborted, true);
  assert.equal(worker.active.size, 0);
  await rejected;
});

test('aborted signal and missing proxy fail before spawn', async () => {
  const worker = new RebindWorker({ spawnImpl() { throw new Error('must not spawn'); } });
  await assert.rejects(worker.run({ ...input(), signal: AbortSignal.abort() }), { code: 'ABORTED' });
  await assert.rejects(worker.run({ ...input(), proxy: '' }), { code: 'INVALID_INPUT' });
});

test('stage and code callback errors are sanitized', async () => {
  await assert.rejects(fixture('success').run({ ...input(), onStage: () => { throw new Error('secret'); } }), { code: 'STAGE_CALLBACK_FAILED' });
  await assert.rejects(fixture('success').run({ ...input(), waitForCode: () => { throw new Error('secret'); } }), { code: 'CODE_WAIT_FAILED' });
});

test('Python entry emits only protocol errors for malformed input', () => {
  const result = spawnSync(process.env.REBIND_TEST_PYTHON || (process.platform === 'win32' ? 'python' : 'python3'), ['-B', 'python/rebind_worker/worker.py'], {
    input: '{"type":"invalid","password":"fixture-secret"}\n', encoding: 'utf8',
  });
  assert.equal(result.status, 1);
  assert.equal(result.stderr, '');
  assert.deepEqual(JSON.parse(result.stdout), { type: 'error', code: 'PROTOCOL_ERROR',
    diagnostic: { category: 'protocol', httpStatus: null, curlCode: null } });
});


test('timeout removes the real worker descendant process', async () => {
  let descendantPid;
  const worker = new RebindWorker({ timeoutMs: 500, spawnImpl(command, args, config) {
    const child = spawn(process.execPath, ['-e', program, 'tree'], config);
    child.stderr.once('data', (data) => { descendantPid = Number(data.toString()); });
    return child;
  } });
  await assert.rejects(worker.run(input()), { code: 'WORKER_TIMEOUT' });
  assert.ok(descendantPid > 0);
  const alive = () => { try { process.kill(descendantPid, 0); return true; } catch { return false; } };
  for (let i = 0; i < 40 && alive(); i += 1) await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(alive(), false);
});
