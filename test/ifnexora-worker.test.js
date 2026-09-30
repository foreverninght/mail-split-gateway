'use strict';

const assert = require('node:assert/strict');
const {
  constants,
  createCipheriv,
  generateKeyPairSync,
  publicEncrypt,
  randomBytes,
} = require('node:crypto');
const test = require('node:test');

const {
  IfnexoraWorker,
  browserLaunchOptions,
  clickTurnstileChallenge,
  configureAllowedProxyRegions,
  currentRevealValue,
  decryptCompactJwe,
  essentialChallengeResource,
  normalizeAllowedProxyRegions,
  proxyUrl,
  turnstileClickPoint,
  validateProtectedSubmission,
  verificationChallengeRejected,
} = require('../src/ifnexora/worker');

test('proxy region configuration defaults to unrestricted and normalizes explicit regions', () => {
  assert.deepEqual(normalizeAllowedProxyRegions(''), []);
  assert.deepEqual(normalizeAllowedProxyRegions('gb, JP gb'), ['GB', 'JP']);
  assert.throws(() => normalizeAllowedProxyRegions('United Kingdom'), /invalid proxy region code/);
});

test('proxy region selector clears stale choices and applies only configured countries', async () => {
  const choices = [
    { name: 'United Kingdom (GB)', checked: true },
    { name: 'Japan (JP)', checked: false },
  ];
  const checkboxLocator = (items) => ({
    count: async () => items.length,
    nth: (index) => checkboxLocator([items[index]]),
    isChecked: async () => items[0].checked,
    click: async () => { items[0].checked = !items[0].checked; },
  });
  const options = {
    waitFor: async () => {},
    getByRole: (_role, query = {}) => checkboxLocator(
      query.name ? choices.filter((item) => query.name.test(item.name)) : choices,
    ),
  };
  const pressed = [];
  const page = {
    locator: (selector) => selector === '#allowed-proxy-regions'
      ? { click: async () => {} }
      : options,
    waitForFunction: async () => {},
    keyboard: { press: async (key) => pressed.push(key) },
  };
  await configureAllowedProxyRegions(page, ['JP'], 1000);
  assert.deepEqual(choices.map((item) => [item.name, item.checked]), [
    ['United Kingdom (GB)', false],
    ['Japan (JP)', true],
  ]);
  assert.deepEqual(pressed, ['Escape']);
});

test('poll paginates every task and emits completed pages before the batch ends', async () => {
  const worker = new IfnexoraWorker({ pollIntervalMs: 0 });
  const page = { goto: async () => {} };
  const context = { newPage: async () => page, storageState: async () => ({ cookies: [] }) };
  worker.createContext = async () => context;
  worker.closeContext = async () => {};
  const updates = [];
  worker.pageFetch = async (_page, path) => {
    if (!path.includes('/tasks?')) return { status: 200, body: { status: 'completed' } };
    const searchParams = new URL(`https://ifnexora.test${path}`).searchParams;
    const number = Number(searchParams.get('page'));
    assert.equal(searchParams.get('page_size'), '20');
    assert.equal(searchParams.get('status'), 'all');
    return {
      status: 200,
      body: {
        items: [{ slot: number, task_id: `task-${number}`, status: number === 1 ? 'completed' : 'running' }],
        pagination: { page: number, page_size: 1, total: 2, total_pages: 2 },
      },
    };
  };
  const result = await worker.poll({
    externalBatchId: 'batch-1', storageState: {}, controlProxy: 'proxy',
    timeoutMs: 1000, onUpdate: async (snapshot) => updates.push(snapshot.tasks.map((task) => task.slot)),
  });
  assert.deepEqual(result.tasks.map((task) => task.slot), [1, 2]);
  assert.deepEqual(updates, [[1], [1, 2]]);
});

test('terminal public batch keeps polling until completed task results are collected', async () => {
  const worker = new IfnexoraWorker({ pollIntervalMs: 0 });
  const page = { goto: async () => {} };
  const context = { newPage: async () => page, storageState: async () => ({ cookies: [] }) };
  worker.createContext = async () => context;
  worker.closeContext = async () => {};
  let taskRequests = 0;
  worker.pageFetch = async (_page, path) => {
    if (!path.includes('/tasks?')) return { status: 200, body: { status: 'completed' } };
    taskRequests += 1;
    return {
      status: 200,
      body: {
        items: [{ slot: 1, task_id: 'task-1', status: 'completed', terminal_code: 'register_completed' }],
        pagination: { page: 1, page_size: 20, total: 1, total_pages: 1 },
      },
    };
  };
  let collectionAttempts = 0;
  await worker.poll({
    externalBatchId: 'batch-1', storageState: {}, controlProxy: 'proxy', timeoutMs: 1000,
    onUpdate: async () => { collectionAttempts += 1; return collectionAttempts >= 2; },
  });
  assert.equal(taskRequests, 2);
  assert.equal(collectionAttempts, 2);
});

test('poll reconnects the same batch session after a transient fetch failure', async () => {
  const warnings = [];
  const worker = new IfnexoraWorker({
    pollIntervalMs: 0,
    logger: { warn: (message) => warnings.push(message) },
  });
  let contexts = 0;
  worker.openResultsPage = async (_batchId, storageState, controlProxy) => {
    contexts += 1;
    assert.equal(controlProxy, 'stable-control-proxy');
    if (contexts === 2) assert.deepEqual(storageState, { cookies: [{ name: 'saved', value: 'state' }] });
    const page = {};
    return {
      page,
      context: {
        storageState: async () => ({ cookies: [{ name: 'saved', value: 'state' }] }),
      },
    };
  };
  worker.closeContext = async () => {};
  let calls = 0;
  worker.pageFetch = async (_page, path) => {
    calls += 1;
    if (calls === 1) throw new TypeError('Failed to fetch');
    if (!path.includes('/tasks?')) return { status: 200, body: { status: 'completed' } };
    return {
      status: 200,
      body: {
        items: [{ slot: 1, task_id: 'task-1', status: 'skipped' }],
        pagination: { page: 1, page_size: 20, total: 1, total_pages: 1 },
      },
    };
  };
  const result = await worker.poll({
    externalBatchId: 'batch-reconnect',
    storageState: { cookies: [] },
    controlProxy: 'stable-control-proxy',
    timeoutMs: 5000,
  });
  assert.equal(contexts, 2);
  assert.equal(result.tasks[0].task_id, 'task-1');
  assert.equal(warnings.length, 1);
});

test('page fetch sends the HttpOnly CSRF cookie from the browser context', async () => {
  const worker = new IfnexoraWorker();
  let evaluated;
  const page = {
    context: () => ({ cookies: async () => [{ name: 'gpt_register_csrf', value: 'csrf-http-only' }] }),
    evaluate: async (fn, args) => {
      evaluated = args;
      return { status: 200, body: { ok: true } };
    },
  };
  const result = await worker.pageFetch(page, '/api/check', { method: 'POST', body: '{}' });
  assert.deepEqual(result, { status: 200, body: { ok: true } });
  assert.equal(evaluated.csrf, 'csrf-http-only');
  assert.equal(evaluated.options.body, '{}');
});

test('browser launch uses the ordinary service-safe Chromium arguments', () => {
  assert.deepEqual(browserLaunchOptions({
    headless: false,
    executablePath: '/opt/chrome',
  }), {
    headless: false,
    executablePath: '/opt/chrome',
    args: ['--disable-dev-shm-usage', '--no-sandbox'],
  });
});

test('CloakBrowser launch binds the browser fingerprint to the control proxy exit', () => {
  assert.deepEqual(browserLaunchOptions({
    headless: false,
    executablePath: '/opt/cloak/chrome',
    cloakMode: true,
    proxyEndpoint: 'proxy.example:8080:user:password',
    fingerprintSeed: 31107,
    fingerprintGeo: {
      timezone: 'Asia/Tokyo',
      locale: 'ja-JP',
      exitIp: '203.0.113.7',
    },
  }), {
    headless: false,
    executablePath: '/opt/cloak/chrome',
    proxy: {
      server: 'http://proxy.example:8080',
      username: 'user',
      password: 'password',
    },
    ignoreDefaultArgs: ['--enable-automation', '--enable-unsafe-swiftshader'],
    args: [
      '--disable-dev-shm-usage',
      '--no-sandbox',
      '--fingerprint=31107',
      '--fingerprint-platform=windows',
      '--fingerprint-webrtc-ip=203.0.113.7',
      '--fingerprint-timezone=Asia/Tokyo',
      '--lang=ja-JP',
      '--fingerprint-locale=ja-JP',
      '--disable-quic',
      '--disable-features=UseDnsHttpsSvcb,EncryptedClientHello',
      '--ignore-gpu-blocklist',
    ],
  });
});

test('proxy URL safely carries credentials for the CloakBrowser geo resolver', () => {
  assert.equal(
    proxyUrl('proxy.example:8080:user@example.com:p:a ss'),
    'http://user%40example.com:p%3Aa%20ss@proxy.example:8080/',
  );
});

function protectedResponse(payload, publicKey, header) {
  const protectedHeader = Buffer.from(JSON.stringify(header)).toString('base64url');
  const contentKey = randomBytes(32);
  const encryptedKey = publicEncrypt({
    key: publicKey,
    padding: constants.RSA_PKCS1_OAEP_PADDING,
    oaepHash: 'sha256',
  }, contentKey);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', contentKey, iv);
  cipher.setAAD(Buffer.from(protectedHeader));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(payload)), cipher.final()]);
  return [
    protectedHeader,
    encryptedKey.toString('base64url'),
    iv.toString('base64url'),
    ciphertext.toString('base64url'),
    cipher.getAuthTag().toString('base64url'),
  ].join('.');
}

test('current submission requires encrypted request and sentinel v2 grant', () => {
  assert.equal(validateProtectedSubmission({
    protectedRequest: 'compact-jwe',
    sentinelGrant: 'sentinel-grant',
  }), true);
  assert.throws(
    () => validateProtectedSubmission({ protectedRequest: 'compact-jwe' }),
    /protectedRequest \+ sentinelGrant/,
  );
  assert.throws(
    () => validateProtectedSubmission({
      protectedRequest: 'compact-jwe',
      sentinelGrant: 'sentinel-grant',
      mailboxPool: 'plaintext',
    }),
    /plaintext registration fields/,
  );
});

test('current reveal validates the response key and registration reveal type', () => {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const header = {
    alg: 'RSA-OAEP-256',
    enc: 'A256GCM',
    kid: 'mail-gateway-test',
    typ: 'registration-reveal+jwe',
    cty: 'application/json',
  };
  const payload = {
    value: { password: 'generated-password', totp_secret: 'totp-secret' },
    expires_at: '2026-09-18T16:10:00Z',
  };
  const compact = protectedResponse(payload, publicKey, header);

  const decrypted = decryptCompactJwe(compact, privateKey, {
    expectedKid: header.kid,
    expectedTyp: header.typ,
  });
  assert.deepEqual(currentRevealValue(decrypted), payload.value);
  assert.throws(
    () => decryptCompactJwe(compact, privateKey, {
      expectedKid: header.kid,
      expectedTyp: 'registration-export+jwe',
    }),
    /header does not match/,
  );
});

test('current reveal rejects legacy unwrapped result payloads', () => {
  assert.throws(
    () => currentRevealValue({ password: 'legacy', totp_secret: 'legacy-secret' }),
    /current value envelope/,
  );
});

test('only primary Turnstile resources are classified as control-proxy failures', () => {
  assert.equal(
    essentialChallengeResource('https://challenges.cloudflare.com/turnstile/v0/api.js'),
    'turnstile_script',
  );
  assert.equal(
    essentialChallengeResource('https://challenges.cloudflare.com/turnstile/v0/g/revision/api.js'),
    'turnstile_script',
  );
  assert.equal(
    essentialChallengeResource('https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/g/turnstile/f/av0/rch/widget/site-key/light/fbE/new/flexible'),
    'challenge_frame',
  );
  assert.equal(
    essentialChallengeResource('https://brunhild.challenges.cloudflare.com/cdn-cgi/challenge-platform/h/g/i/session'),
    '',
  );
  assert.equal(
    essentialChallengeResource('https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/g/pat/session'),
    '',
  );
});

test('Turnstile click point targets the checkbox area of a usable frame', () => {
  assert.deepEqual(
    turnstileClickPoint({ x: 570, y: 460, width: 300, height: 65 }),
    { x: 590, y: 492 },
  );
  assert.equal(turnstileClickPoint({ x: 0, y: 0, width: 99, height: 65 }), null);
  assert.equal(turnstileClickPoint(null), null);
});

test('only explicit pre-POST verification rejection messages rotate the control proxy', () => {
  assert.equal(verificationChallengeRejected('Verification is temporarily unavailable. Please try again later.'), true);
  assert.equal(verificationChallengeRejected('Verification failed'), true);
  assert.equal(verificationChallengeRejected('验证暂时不可用，请稍后重试'), true);
  assert.equal(verificationChallengeRejected('The mailbox format is invalid'), false);
  assert.equal(verificationChallengeRejected('HTTP 403'), false);
});

test('Turnstile interaction performs one paced click on the primary frame', async () => {
  const calls = [];
  let now = 0;
  const originalNow = Date.now;
  Date.now = () => now;
  const frame = {
    url: () => 'https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/g/turnstile/f/widget',
    frameElement: async () => ({
      boundingBox: async () => ({ x: 500, y: 400, width: 300, height: 65 }),
    }),
  };
  const page = {
    frames: () => [frame],
    waitForTimeout: async (milliseconds) => { now += milliseconds; },
    mouse: {
      move: async (...args) => calls.push(['move', ...args]),
      down: async () => calls.push(['down']),
      up: async () => calls.push(['up']),
    },
  };
  try {
    const result = await clickTurnstileChallenge(page, {
      timeoutMs: 5000,
      logger: { info: () => {} },
    });
    assert.deepEqual(result, { clicked: true, method: 'primary_frame_position' });
    assert.deepEqual(calls, [
      ['move', 430, 502],
      ['move', 520, 432, { steps: 24 }],
      ['down'],
      ['up'],
    ]);
  } finally {
    Date.now = originalNow;
  }
});
