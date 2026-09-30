'use strict';

const {
  createDecipheriv,
  generateKeyPairSync,
  privateDecrypt,
  randomInt,
  randomUUID,
  constants,
} = require('node:crypto');
const { spawn } = require('node:child_process');
const { chromium } = require('playwright');
const { REGISTRATION_PROXIES_PER_MAILBOX } = require('../registration/proxy-policy');

const SENTINEL_PREFIX = '/api/security/nexora-sentinel/';
const REGISTRATION_REVEAL_TYP = 'registration-reveal+jwe';
const JWE_CONTENT_TYPE = 'application/json';

class SubmissionUnknownError extends Error {
  constructor(message, cause, storageState) {
    super(message, { cause });
    this.name = 'SubmissionUnknownError';
    this.code = 'IFNEXORA_SUBMISSION_UNKNOWN';
    this.storageState = storageState;
  }
}

class ControlProxyChallengeError extends Error {
  constructor(message, cause) {
    super(message, { cause });
    this.name = 'ControlProxyChallengeError';
    this.code = 'IFNEXORA_CHALLENGE_FAILED';
  }
}

function decodeCanonicalBase64Url(value) {
  const text = String(value || '');
  if (!text || !/^[A-Za-z0-9_-]+$/.test(text)) throw new Error('result JWE is not canonical base64url');
  const decoded = Buffer.from(text, 'base64url');
  if (decoded.toString('base64url') !== text) throw new Error('result JWE is not canonical base64url');
  return decoded;
}

function decryptCompactJwe(compact, privateKey, { expectedKid, expectedTyp } = {}) {
  const parts = String(compact || '').split('.');
  if (parts.length !== 5) throw new Error('result reveal did not return a compact JWE');
  const [headerRaw, encryptedKeyRaw, ivRaw, ciphertextRaw, tagRaw] = parts;
  const [headerBytes, encryptedKey, iv, ciphertext, tag] = parts.map(decodeCanonicalBase64Url);
  const header = JSON.parse(headerBytes.toString('utf8'));
  if (header.alg !== 'RSA-OAEP-256' || header.enc !== 'A256GCM') throw new Error('unsupported result JWE algorithm');
  if (expectedKid || expectedTyp) {
    const keys = Object.keys(header).sort();
    if (JSON.stringify(keys) !== JSON.stringify(['alg', 'cty', 'enc', 'kid', 'typ'])
        || header.kid !== expectedKid
        || header.typ !== expectedTyp
        || header.cty !== JWE_CONTENT_TYPE) {
      throw new Error('result reveal JWE header does not match the requested response key');
    }
  }
  const contentKey = privateDecrypt({
    key: privateKey,
    padding: constants.RSA_PKCS1_OAEP_PADDING,
    oaepHash: 'sha256',
  }, encryptedKey);
  const decipher = createDecipheriv('aes-256-gcm', contentKey, iv);
  decipher.setAAD(Buffer.from(headerRaw));
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]).toString('utf8');
  return JSON.parse(plaintext);
}

function validateProtectedSubmission(payload) {
  if (!payload || typeof payload !== 'object'
      || typeof payload.protectedRequest !== 'string' || !payload.protectedRequest
      || typeof payload.sentinelGrant !== 'string' || !payload.sentinelGrant) {
    throw new Error('ifnexora submission did not use the current protectedRequest + sentinelGrant protocol');
  }
  const plaintextKeys = [
    'mailboxPool', 'proxyPool', 'mailbox_pool', 'proxy_pool',
  ];
  if (plaintextKeys.some((key) => Object.hasOwn(payload, key))) {
    throw new Error('ifnexora submission unexpectedly exposed plaintext registration fields');
  }
  return true;
}

function currentRevealValue(payload) {
  if (!payload || typeof payload !== 'object' || !payload.value || typeof payload.value !== 'object') {
    throw new Error('ifnexora result reveal did not return the current value envelope');
  }
  return payload.value;
}

function normalizeAllowedProxyRegions(value) {
  const values = Array.isArray(value) ? value : String(value || '').split(/[\s,]+/);
  const regions = [...new Set(values.map((item) => String(item || '').trim().toUpperCase()).filter(Boolean))];
  const invalid = regions.find((item) => !/^[A-Z]{2}$/.test(item));
  if (invalid) throw new Error(`invalid proxy region code: ${invalid}`);
  return regions;
}

async function configureAllowedProxyRegions(page, allowedRegions, timeoutMs) {
  const regions = normalizeAllowedProxyRegions(allowedRegions);
  const trigger = page.locator('#allowed-proxy-regions');
  await page.waitForFunction(() => {
    const element = document.querySelector('#allowed-proxy-regions');
    return element && !element.disabled;
  }, null, { timeout: timeoutMs });
  await trigger.click();
  const options = page.locator('#allowed-proxy-country-options');
  await options.waitFor({ state: 'visible', timeout: timeoutMs });
  const checkboxes = options.getByRole('checkbox');
  for (let index = 0; index < await checkboxes.count(); index += 1) {
    const checkbox = checkboxes.nth(index);
    if (await checkbox.isChecked()) await checkbox.click();
  }
  for (const region of regions) {
    const checkbox = options.getByRole('checkbox', {
      name: new RegExp(`\\(${region}\\)`, 'i'),
    });
    if (await checkbox.count() !== 1) throw new Error(`ifnexora does not offer proxy region ${region}`);
    if (!(await checkbox.isChecked())) await checkbox.click();
  }
  await page.keyboard.press('Escape');
}

async function waitForObserved(predicate, timeoutMs, message) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(message);
}

function pathname(rawUrl) {
  try { return new URL(rawUrl).pathname; } catch { return ''; }
}

function sentinelStage(rawUrl) {
  const path = pathname(rawUrl);
  return path.startsWith(SENTINEL_PREFIX) ? path.slice(SENTINEL_PREFIX.length) : '';
}

function essentialChallengeResource(rawUrl) {
  try {
    const url = new URL(rawUrl);
    if (url.hostname !== 'challenges.cloudflare.com') return '';
    if (/^\/turnstile\/v0\/(?:g\/[^/]+\/)?api\.js$/.test(url.pathname)) return 'turnstile_script';
    if (url.pathname.includes('/cdn-cgi/challenge-platform/')
        && url.pathname.includes('/turnstile/')) return 'challenge_frame';
  } catch {}
  return '';
}

function turnstileClickPoint(box) {
  if (!box || box.width < 100 || box.height < 40) return null;
  return {
    x: box.x + 20,
    y: box.y + Math.min(32, box.height / 2),
  };
}

async function clickTurnstileChallenge(page, {
  timeoutMs = 90_000,
  stopWhen = () => false,
  logger = console,
} = {}) {
  const deadline = Date.now() + timeoutMs;
  let frameReadyAt = 0;
  while (Date.now() < deadline && !stopWhen()) {
    const frame = page.frames().find((candidate) => essentialChallengeResource(candidate.url()) === 'challenge_frame');
    if (!frame) {
      await page.waitForTimeout(200);
      continue;
    }
    const frameElement = await frame.frameElement().catch(() => null);
    const box = await frameElement?.boundingBox().catch(() => null);
    const point = turnstileClickPoint(box);
    if (!point) {
      frameReadyAt = 0;
      await page.waitForTimeout(200);
      continue;
    }
    if (!frameReadyAt) frameReadyAt = Date.now();
    if (Date.now() - frameReadyAt < 800) {
      await page.waitForTimeout(200);
      continue;
    }
    await page.mouse.move(point.x - 90, point.y + 70);
    await page.waitForTimeout(400);
    await page.mouse.move(point.x, point.y, { steps: 24 });
    await page.waitForTimeout(850);
    await page.mouse.down();
    await page.waitForTimeout(180);
    await page.mouse.up();
    logger.info('ifnexora Turnstile checkbox clicked through the primary challenge frame');
    return { clicked: true, method: 'primary_frame_position' };
  }
  return { clicked: false, reason: stopWhen() ? 'submission_finished' : 'challenge_not_visible' };
}

function isRegistrationSubmission(request) {
  return pathname(request.url()) === '/api/registration-batches' && request.method() === 'POST';
}

function verificationChallengeRejected(message) {
  return /verification\s+(?:is\s+)?(?:temporarily\s+)?unavailable|verification\s+failed|验证.*(?:不可用|失败)/i
    .test(String(message || ''));
}

function terminalBatch(status) {
  return ['completed', 'partial_completed', 'failed', 'cancelled'].includes(String(status || '').toLowerCase());
}

function playwrightProxy(endpoint) {
  const raw = String(endpoint || '').trim();
  if (!raw) return undefined;
  if (/^https?:\/\//i.test(raw)) {
    const url = new URL(raw);
    return {
      server: `${url.protocol}//${url.hostname}:${url.port}`,
      ...(url.username ? { username: decodeURIComponent(url.username) } : {}),
      ...(url.password ? { password: decodeURIComponent(url.password) } : {}),
    };
  }
  const [host, port, username, ...passwordParts] = raw.split(':');
  return {
    server: `http://${host}:${port}`,
    ...(username ? { username } : {}),
    ...(passwordParts.length ? { password: passwordParts.join(':') } : {}),
  };
}

function proxyUrl(endpoint) {
  const parsed = playwrightProxy(endpoint);
  if (!parsed) throw new Error('proxy endpoint is required');
  const url = new URL(parsed.server);
  if (parsed.username) url.username = parsed.username;
  if (parsed.password) url.password = parsed.password;
  return url.toString();
}

function resolveCloakProxyGeo(endpoint, {
  pythonPath = '/opt/cloakbrowser-venv/bin/python',
  timeoutMs = 30_000,
} = {}) {
  const script = [
    'import json, sys',
    'from cloakbrowser.geoip import resolve_proxy_geo_with_ip',
    'request = json.load(sys.stdin)',
    'timezone, locale, exit_ip = resolve_proxy_geo_with_ip(request["proxy"])',
    'print(json.dumps({"timezone": timezone, "locale": locale, "exitIp": exit_ip}))',
  ].join('\n');
  return new Promise((resolve, reject) => {
    const child = spawn(pythonPath, ['-c', script], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`CloakBrowser proxy geo resolution timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(new Error('CloakBrowser proxy geo resolver could not start', { cause: error }));
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`CloakBrowser proxy geo resolution failed: ${stderr.trim() || `exit ${code}`}`));
        return;
      }
      try {
        const result = JSON.parse(stdout);
        if (!result.timezone || !result.locale || !result.exitIp) {
          throw new Error('resolver returned incomplete geo data');
        }
        resolve(result);
      } catch (error) {
        reject(new Error('CloakBrowser proxy geo resolver returned invalid data', { cause: error }));
      }
    });
    child.stdin.end(JSON.stringify({ proxy: proxyUrl(endpoint) }));
  });
}

function browserLaunchOptions({
  headless,
  executablePath,
  cloakMode = false,
  proxyEndpoint,
  fingerprintGeo,
  fingerprintSeed,
} = {}) {
  if (cloakMode) {
    if (!proxyEndpoint) throw new Error('CloakBrowser launch requires a control proxy');
    if (!fingerprintGeo?.timezone || !fingerprintGeo?.locale || !fingerprintGeo?.exitIp) {
      throw new Error('CloakBrowser launch requires complete proxy geo data');
    }
    const headed = headless === false;
    return {
      headless: !headed,
      ...(executablePath ? { executablePath } : {}),
      proxy: playwrightProxy(proxyEndpoint),
      ignoreDefaultArgs: ['--enable-automation', '--enable-unsafe-swiftshader'],
      args: [
        '--disable-dev-shm-usage',
        '--no-sandbox',
        `--fingerprint=${fingerprintSeed || randomInt(10_000, 100_000)}`,
        '--fingerprint-platform=windows',
        `--fingerprint-webrtc-ip=${fingerprintGeo.exitIp}`,
        `--fingerprint-timezone=${fingerprintGeo.timezone}`,
        `--lang=${fingerprintGeo.locale}`,
        `--fingerprint-locale=${fingerprintGeo.locale}`,
        '--disable-quic',
        '--disable-features=UseDnsHttpsSvcb,EncryptedClientHello',
        ...(headed ? ['--ignore-gpu-blocklist'] : []),
      ],
    };
  }
  return {
    headless: headless !== false,
    ...(executablePath ? { executablePath } : {}),
    args: ['--disable-dev-shm-usage', '--no-sandbox'],
  };
}

class IfnexoraWorker {
  constructor({
    baseUrl = 'https://ifnexora.com',
    executablePath,
    headless = true,
    navigationTimeoutMs = 120000,
    pollIntervalMs = 5000,
    submissionAttempts = 2,
    cloakMode = false,
    cloakGeoResolver = resolveCloakProxyGeo,
    cloakGeoResolverPythonPath = '/opt/cloakbrowser-venv/bin/python',
    allowedProxyRegions = [],
    logger = console,
  } = {}) {
    this.baseUrl = String(baseUrl).replace(/\/$/, '');
    this.executablePath = executablePath;
    this.headless = headless;
    this.navigationTimeoutMs = navigationTimeoutMs;
    this.pollIntervalMs = pollIntervalMs;
    this.submissionAttempts = Math.max(1, Number(submissionAttempts) || 1);
    this.cloakMode = Boolean(cloakMode);
    this.cloakGeoResolver = cloakGeoResolver;
    this.cloakGeoResolverPythonPath = cloakGeoResolverPythonPath;
    this.allowedProxyRegions = normalizeAllowedProxyRegions(allowedProxyRegions);
    this.logger = logger;
    this.browser = null;
    this.ownedBrowsers = new Set();
    this.contextBrowsers = new WeakMap();
  }

  async ensureBrowser() {
    if (this.browser?.isConnected()) return this.browser;
    this.browser = await chromium.launch(browserLaunchOptions({
      headless: this.headless,
      executablePath: this.executablePath,
    }));
    return this.browser;
  }

  async createContext(storageState, proxyEndpoint) {
    if (this.cloakMode) {
      const fingerprintGeo = await this.cloakGeoResolver(proxyEndpoint, {
        pythonPath: this.cloakGeoResolverPythonPath,
      });
      const browser = await chromium.launch(browserLaunchOptions({
        headless: this.headless,
        executablePath: this.executablePath,
        cloakMode: true,
        proxyEndpoint,
        fingerprintGeo,
      }));
      this.ownedBrowsers.add(browser);
      try {
        const context = await browser.newContext({
          viewport: null,
          ...(storageState ? { storageState } : {}),
        });
        this.contextBrowsers.set(context, browser);
        return context;
      } catch (error) {
        this.ownedBrowsers.delete(browser);
        await browser.close().catch(() => {});
        throw error;
      }
    }
    const browser = await this.ensureBrowser();
    return browser.newContext({
      locale: 'zh-CN',
      timezoneId: 'Asia/Shanghai',
      viewport: { width: 1440, height: 1000 },
      ...(proxyEndpoint ? { proxy: playwrightProxy(proxyEndpoint) } : {}),
      ...(storageState ? { storageState } : {}),
    });
  }

  async closeContext(context) {
    const ownedBrowser = this.contextBrowsers.get(context);
    this.contextBrowsers.delete(context);
    await context?.close().catch(() => {});
    if (ownedBrowser) {
      this.ownedBrowsers.delete(ownedBrowser);
      await ownedBrowser.close().catch(() => {});
    }
  }

  async waitForWorkspace(page) {
    const mailbox = page.locator('#mailbox-pool');
    await mailbox.waitFor({ state: 'visible', timeout: this.navigationTimeoutMs });
    await page.waitForFunction(() => {
      const mailboxPool = document.querySelector('#mailbox-pool');
      const proxyPool = document.querySelector('#proxy-pool');
      return mailboxPool && proxyPool && !mailboxPool.disabled && !proxyPool.disabled;
    }, null, { timeout: this.navigationTimeoutMs });
  }

  async testControlProxy(controlProxy) {
    const context = await this.createContext(undefined, controlProxy);
    const page = await context.newPage();
    const sentinel = { bootstrap: false };
    let handedOff = false;
    page.on('response', (response) => {
      if (sentinelStage(response.url()) === 'bootstrap' && response.status() === 200) sentinel.bootstrap = true;
    });
    try {
      const response = await page.goto(`${this.baseUrl}/`, {
        waitUntil: 'domcontentloaded', timeout: this.navigationTimeoutMs,
      });
      if (!response || response.status() >= 400) {
        throw new Error(`control proxy returned HTTP ${response?.status() || 'unknown'}`);
      }
      await this.waitForWorkspace(page);
      await page.locator('#mailbox-pool')
        .fill('control-health@example.com----https://mail-api.example.invalid/otp');
      await page.locator('#proxy-pool')
        .fill('proxy-health.example.invalid:8080:user:password');
      const readinessTimeoutMs = Math.min(this.navigationTimeoutMs, 30_000);
      await waitForObserved(
        () => sentinel.bootstrap,
        readinessTimeoutMs,
        'control proxy did not complete the current nexora-sentinel bootstrap',
      );
      const storageState = await context.storageState();
      this.logger.info(`ifnexora control session cookies: ${storageState.cookies.map((cookie) => cookie.name).sort().join(',') || 'none'}`);
      handedOff = true;
      return {
        ok: true,
        status: response.status(),
        securityProtocol: 'nexora-sentinel-v2',
        storageState,
        controlSession: {
          context,
          page,
          controlProxy,
          sentinelBootstrap: sentinel.bootstrap,
          closed: false,
        },
      };
    } finally {
      if (!handedOff) await this.closeContext(context);
    }
  }

  async discardControlSession(controlSession) {
    if (!controlSession || controlSession.closed) return;
    controlSession.closed = true;
    await this.closeContext(controlSession.context);
  }

  async submit({ mailboxes, proxies, proxiesPerMailbox = REGISTRATION_PROXIES_PER_MAILBOX, storageState, controlProxy, controlSession }) {
    const context = controlSession?.context;
    const page = controlSession?.page;
    if (!context || !page) {
      await this.discardControlSession(controlSession);
      throw new Error('ifnexora submission requires the live prechecked control session');
    }
    let responseSeen = false;
    let requestSeen = false;
    let essentialChallengeFailures = 0;
    let stage = 'opening_workspace';
    let submissionPayload = null;
    let submissionProtocolError = null;
    const sentinel = {
      bootstrap: Boolean(controlSession?.sentinelBootstrap),
      prepare: false,
      finalize: false,
      ping: false,
    };
    page.on('request', (request) => {
      if (isRegistrationSubmission(request)) {
        requestSeen = true;
        submissionPayload = request.postDataJSON();
        try { validateProtectedSubmission(submissionPayload); } catch (error) { submissionProtocolError = error; }
      }
      if (sentinelStage(request.url())) {
        this.logger.info(`ifnexora security request ${request.method()} ${pathname(request.url())}`);
      }
    });
    page.on('response', (response) => {
      const securityStage = sentinelStage(response.url());
      if (securityStage) {
        if (response.status() === 200 && Object.hasOwn(sentinel, securityStage)) sentinel[securityStage] = true;
        this.logger.info(`ifnexora security response ${response.status()} ${pathname(response.url())}`);
      }
    });
    page.on('requestfailed', (request) => {
      if (sentinelStage(request.url()) || request.url().includes('challenges.cloudflare.com')) {
        const resource = essentialChallengeResource(request.url());
        if (resource) {
          essentialChallengeFailures += 1;
          this.logger.error(`ifnexora essential challenge resource failed (${resource})`);
        }
        this.logger.error(`ifnexora request failed ${request.url()}: ${request.failure()?.errorText || 'unknown'}`);
      }
    });
    try {
      if (!Array.isArray(mailboxes) || !mailboxes.length) throw new Error('mailbox submission lines are required');
      const proxyCount = Number(proxiesPerMailbox);
      if (!Array.isArray(proxies) || !Number.isInteger(proxyCount) || proxyCount < 1
        || proxies.length !== mailboxes.length * proxyCount) {
        throw new Error(`submission requires exactly ${proxyCount} proxies per mailbox`);
      }
      if (!controlProxy) throw new Error('ifnexora control proxy is not configured');
      if (controlSession.controlProxy !== controlProxy) throw new Error('ifnexora live control session proxy does not match the submission proxy');
      if (page.isClosed()) throw new Error('ifnexora live control session page is already closed');
      const currentOrigin = new URL(page.url()).origin;
      if (currentOrigin !== new URL(this.baseUrl).origin) {
        throw new Error('ifnexora live control session is not on the submission site');
      }
      const initialStorageState = await context.storageState();
      this.logger.info(`ifnexora live submission session cookies: ${initialStorageState.cookies.map((cookie) => cookie.name).sort().join(',') || 'none'}`);
      await this.waitForWorkspace(page);
      stage = 'filling_form';
      await page.locator('#mailbox-pool').fill(mailboxes.join('\n'));
      await page.locator('#proxy-pool').fill(proxies.join('\n'));

      try {
        await configureAllowedProxyRegions(page, this.allowedProxyRegions, this.navigationTimeoutMs);
      } catch (error) {
        throw new ControlProxyChallengeError('control proxy did not make the submission form ready', error);
      }

      const reuse = page.locator('#allow-proxy-reuse');
      if (!(await reuse.isChecked())) await reuse.check();
      const autoStart = page.locator('#auto-start');
      if (!(await autoStart.isChecked())) await autoStart.check();
      const mfa = page.locator('#enable-2fa');
      if (!(await mfa.isChecked())) await mfa.check();
      const paymentDetection = page.locator('#detect-payment-types');
      if (!(await paymentDetection.isChecked())) await paymentDetection.check();

      stage = 'waiting_for_submission_readiness';
      const create = page.getByRole('button', { name: /创建批次|Create batch/i });
      await create.waitFor({ state: 'visible', timeout: this.navigationTimeoutMs });
      await page.waitForFunction(() => {
        const button = [...document.querySelectorAll('button')]
          .find((item) => /^(创建批次|Create batch)$/i.test(item.textContent?.trim() || ''));
        return button && !button.disabled;
      }, null, { timeout: this.navigationTimeoutMs });

      stage = 'submitting';
      const attemptTimeoutMs = Math.max(this.navigationTimeoutMs, 2 * 60 * 1000);
      const responseOutcome = page.waitForResponse(
        (response) => isRegistrationSubmission(response.request()),
        { timeout: attemptTimeoutMs * this.submissionAttempts },
      ).then(
        (response) => ({ type: 'response', response }),
        (error) => ({ type: 'response_error', error }),
      );
      const submitError = page.locator('#registration-submit-error');
      let response;
      for (let attempt = 1; attempt <= this.submissionAttempts; attempt += 1) {
        const previousErrorVisible = await submitError.isVisible().catch(() => false);
        if (previousErrorVisible) {
          const retry = submitError.getByRole('button', { name: /重新验证|Retry/i }).last();
          if (await retry.isVisible().catch(() => false)) await retry.click();
          else await create.click();
          await submitError.waitFor({ state: 'hidden', timeout: 5000 });
        } else {
          await create.click();
        }
        let attemptFinished = false;
        const challengeInteraction = clickTurnstileChallenge(page, {
          timeoutMs: Math.min(attemptTimeoutMs, 90_000),
          stopWhen: () => attemptFinished || requestSeen,
          logger: this.logger,
        }).catch((error) => {
          this.logger.warn(`ifnexora Turnstile interaction failed: ${error.message}`);
          return { clicked: false, reason: error.message };
        });
        const pageErrorOutcome = submitError.waitFor({ state: 'visible', timeout: attemptTimeoutMs })
          .then(async () => ({
            type: 'page_error',
            text: String(await submitError.textContent() || '').trim(),
            hasAction: await submitError.locator('[data-testid="registration-status-actions"] button').count() > 0,
          }))
          .catch((error) => ({ type: 'page_error_timeout', error }));
        const outcome = await Promise.race([responseOutcome, pageErrorOutcome]);
        attemptFinished = true;
        await challengeInteraction;
        if (outcome.type === 'response') {
          response = outcome.response;
          break;
        }
        if (outcome.type === 'response_error' || requestSeen) {
          throw outcome.error || new Error('ifnexora submission request outcome is unknown');
        }

        const detail = outcome.type === 'page_error' && outcome.text
          ? outcome.text : 'submission did not produce a request or a visible error';
        const verificationRejected = outcome.type === 'page_error' && verificationChallengeRejected(detail);
        if (essentialChallengeFailures) {
          throw new ControlProxyChallengeError(
            `ifnexora essential verification resource failed before POST after ${attempt} attempt(s): ${detail}`,
            outcome.error,
          );
        }
        if (verificationRejected) {
          throw new ControlProxyChallengeError(
            `ifnexora verification was rejected before POST after ${attempt} attempt(s): ${detail}`,
            outcome.error,
          );
        }
        if (attempt === this.submissionAttempts) {
          throw new Error(`ifnexora verification failed before POST after ${attempt} attempt(s): ${detail}`, {
            cause: outcome.error,
          });
        }
        this.logger.warn(
          `ifnexora rejected submission before POST; retrying verification with the same control proxy (${attempt}/${this.submissionAttempts}): ${detail}`,
        );
        await page.waitForFunction(() => {
          const button = [...document.querySelectorAll('button')]
            .find((item) => /^(创建批次|Create batch)$/i.test(item.textContent?.trim() || ''));
          return button && !button.disabled;
        }, null, { timeout: this.navigationTimeoutMs });
      }
      if (!response) throw new Error('ifnexora submission response was not observed');
      responseSeen = true;
      if (submissionProtocolError) throw submissionProtocolError;
      validateProtectedSubmission(submissionPayload);
      if (!sentinel.bootstrap || !sentinel.prepare || !sentinel.finalize) {
        throw new Error(`ifnexora submission skipped required nexora-sentinel stages: ${JSON.stringify(sentinel)}`);
      }
      const body = await response.json().catch(() => ({}));
      if (response.status() !== 202 || !body.batch_id) {
        const activeBatchId = body.activeBatchId || body.batchId || body.batch_id;
        if (response.status() === 409 && body.code === 'active_submission_exists' && activeBatchId) {
          return {
            externalBatchId: activeBatchId,
            response: body,
            storageState: await context.storageState(),
          };
        }
        const error = new Error(body.message || body.error || `ifnexora submission returned HTTP ${response.status()}`);
        error.statusCode = response.status();
        throw error;
      }
      return {
        externalBatchId: body.batch_id,
        response: body,
        storageState: await context.storageState(),
      };
    } catch (error) {
      const savedState = await context.storageState().catch(() => storageState);
      this.logger.error(`ifnexora ${stage} failed`, error);
      if (stage === 'submitting') {
        const active = await this.pageFetch(page, '/api/registration-batches/active').catch(() => null);
        if (active?.status === 200 && active.body?.active && active.body.batchId) {
          return {
            externalBatchId: active.body.batchId,
            response: active.body,
            storageState: savedState,
          };
        }
      }
      if (error instanceof ControlProxyChallengeError) throw error;
      if (!responseSeen && requestSeen) {
        throw new SubmissionUnknownError('ifnexora submission outcome is unknown', error, savedState);
      }
      if (!responseSeen && stage === 'submitting') {
        const diagnostics = await page.evaluate(() => ({
          url: location.href,
          alerts: [...document.querySelectorAll('[role="alert"]')].map((item) => item.textContent?.trim()).filter(Boolean),
          buttons: [...document.querySelectorAll('button')].filter((item) => /创建批次|Create batch/i.test(item.textContent || ''))
            .map((item) => ({ text: item.textContent?.trim(), disabled: item.disabled })),
        })).catch(() => ({}));
        const message = `ifnexora did not send the submission request: ${JSON.stringify(diagnostics)}`;
        if (essentialChallengeFailures) throw new ControlProxyChallengeError(message, error);
        throw new Error(message, { cause: error });
      }
      throw error;
    } finally {
      await this.discardControlSession(controlSession);
    }
  }

  async pageFetch(page, path, options = {}) {
    const csrf = (await page.context().cookies())
      .find((cookie) => cookie.name === 'gpt_register_csrf')?.value || '';
    return page.evaluate(async ({ path: requestPath, options: requestOptions, csrf }) => {
      const origin = location.origin;
      const referer = location.href;
      const response = await fetch(requestPath, {
        ...requestOptions,
        headers: {
          ...(requestOptions.body ? { 'content-type': 'application/json' } : {}),
          Origin: origin,
          Referer: referer,
          ...(csrf ? { 'x-csrf-token': csrf } : {}),
          ...(requestOptions.headers || {}),
        },
      });
      const text = await response.text();
      let body;
      try { body = JSON.parse(text); } catch { body = text; }
      return { status: response.status, body };
    }, { path, options, csrf });
  }

  async poll({ externalBatchId, storageState, controlProxy, onUpdate, timeoutMs = 45 * 60 * 1000 }) {
    const deadline = Date.now() + timeoutMs;
    let currentStorageState = storageState;
    let consecutiveFailures = 0;
    let lastError;
    while (Date.now() < deadline) {
      let context;
      try {
        const session = await this.openResultsPage(externalBatchId, currentStorageState, controlProxy);
        ({ context } = session);
        const { page } = session;
        while (Date.now() < deadline) {
          const batchResponse = await this.pageFetch(page, `/api/registration-batches/${encodeURIComponent(externalBatchId)}`);
          if (batchResponse.status !== 200) throw new Error(`ifnexora polling failed: batch ${batchResponse.status}`);
          const tasks = [];
          const seen = new Set();
          const pageSize = 20;
          let collectionComplete = true;
          for (let pageNumber = 1; ; pageNumber += 1) {
            const tasksResponse = await this.pageFetch(page, `/api/registration-batches/${encodeURIComponent(externalBatchId)}/tasks?page=${pageNumber}&page_size=${pageSize}&status=all`);
            if (tasksResponse.status !== 200) throw new Error(`ifnexora polling failed: tasks ${tasksResponse.status}`);
            const body = tasksResponse.body || {};
            const pageItems = body.items || body.tasks || [];
            const pagination = body.pagination || {};
            for (const task of pageItems) {
              const key = task.task_id || `${task.slot}:${task.email || ''}`;
              if (!seen.has(key)) { seen.add(key); tasks.push(task); }
            }
            // Do not wait for the whole batch before handling completed slots.
            // A result can disappear from the public service independently of
            // the other slots, so expose every page to the collector immediately.
            if (onUpdate && pageItems.length) {
              currentStorageState = await context.storageState();
              collectionComplete = (await onUpdate({
                batch: batchResponse.body,
                tasks: [...tasks],
                storageState: currentStorageState,
                reveal: (slot) => this.revealOnPage(page, externalBatchId, slot),
              })) !== false;
            }
            const total = Number(pagination.total ?? body.total ?? body.total_count ?? NaN);
            const pages = Number(pagination.total_pages ?? body.pages ?? body.total_pages ?? NaN);
            const effectivePageSize = Number(pagination.page_size ?? body.page_size ?? pageSize);
            const hasMore = body.has_more === true || body.hasNext === true || Boolean(body.next_page);
            if (!pageItems.length || (Number.isFinite(pages) && pageNumber >= pages)
              || (Number.isFinite(total) && tasks.length >= total)
              || (!hasMore && pageItems.length < effectivePageSize)) break;
          }
          currentStorageState = await context.storageState();
          const snapshot = {
            batch: batchResponse.body,
            tasks,
            storageState: currentStorageState,
          };
          consecutiveFailures = 0;
          if (terminalBatch(snapshot.batch.status) && collectionComplete) return snapshot;
          await new Promise((resolve) => setTimeout(resolve, this.pollIntervalMs));
        }
      } catch (error) {
        lastError = error;
        if (/ifnexora polling failed: (?:batch|tasks) (?:404|410)\b/.test(String(error.message || error))) throw error;
        consecutiveFailures += 1;
        this.logger.warn(`ifnexora polling connection failed; reconnecting the same batch session (${consecutiveFailures}): ${error.message || error}`);
      } finally {
        if (context) {
          currentStorageState = await context.storageState().catch(() => currentStorageState);
          await this.closeContext(context);
        }
      }
      const remaining = deadline - Date.now();
      if (remaining > 0) {
        const backoff = Math.min(30_000, consecutiveFailures * 2_000, remaining);
        await new Promise((resolve) => setTimeout(resolve, backoff));
      }
    }
    throw new Error(`ifnexora batch did not finish within ${timeoutMs}ms`, { cause: lastError });
  }

  async findActive({ storageState, controlProxy }) {
    const context = await this.createContext(storageState, controlProxy);
    const page = await context.newPage();
    try {
      await page.goto(`${this.baseUrl}/`, { waitUntil: 'domcontentloaded', timeout: this.navigationTimeoutMs });
      const response = await this.pageFetch(page, '/api/registration-batches/active');
      if (response.status !== 200) throw new Error(`ifnexora active-batch lookup returned HTTP ${response.status}`);
      return { ...response.body, storageState: await context.storageState() };
    } finally {
      await this.closeContext(context);
    }
  }

  async reveal({ externalBatchId, slot, storageState, controlProxy }) {
    const context = await this.createContext(storageState, controlProxy);
    const page = await context.newPage();
    try {
      await page.goto(`${this.baseUrl}/results/${encodeURIComponent(externalBatchId)}`, {
        waitUntil: 'domcontentloaded', timeout: this.navigationTimeoutMs,
      });
      return await this.revealOnPage(page, externalBatchId, slot);
    } finally {
      await this.closeContext(context);
    }
  }

  async openResultsPage(externalBatchId, storageState, controlProxy) {
    let lastError;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      let context;
      try {
        context = await this.createContext(storageState, controlProxy);
        const page = await context.newPage();
        await page.goto(`${this.baseUrl}/results/${encodeURIComponent(externalBatchId)}`, {
          waitUntil: 'domcontentloaded', timeout: this.navigationTimeoutMs,
        });
        return { context, page };
      } catch (error) {
        lastError = error;
        if (context) await this.closeContext(context);
        if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, attempt * 1000));
      }
    }
    throw lastError;
  }

  async revealOnPage(page, externalBatchId, slot) {
    const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 3072 });
    const kid = `mail-gateway-${randomUUID()}`;
    const publicJwk = { ...publicKey.export({ format: 'jwk' }), kid, alg: 'RSA-OAEP-256', use: 'enc' };
    const response = await this.pageFetch(
      page,
      `/api/registration-batches/${encodeURIComponent(externalBatchId)}/tasks/${Number(slot)}/reveal`,
      { method: 'POST', body: JSON.stringify({ responsePublicKey: publicJwk }) },
    );
    if (response.status !== 200) {
      const code = response.body?.code || `HTTP ${response.status}`;
      throw new Error(`ifnexora result reveal failed: ${code}`);
    }
    if (response.body?.protection !== 'jwe' || typeof response.body?.envelope !== 'string') {
      throw new Error('ifnexora result reveal did not use the current protected response envelope');
    }
    const revealed = decryptCompactJwe(response.body.envelope, privateKey, {
      expectedKid: kid,
      expectedTyp: REGISTRATION_REVEAL_TYP,
    });
    return currentRevealValue(revealed);
  }

  async close() {
    if (this.browser) await this.browser.close().catch(() => {});
    this.browser = null;
    const owned = [...this.ownedBrowsers];
    this.ownedBrowsers.clear();
    await Promise.all(owned.map((browser) => browser.close().catch(() => {})));
  }
}

module.exports = {
  IfnexoraWorker,
  SubmissionUnknownError,
  ControlProxyChallengeError,
  browserLaunchOptions,
  currentRevealValue,
  clickTurnstileChallenge,
  configureAllowedProxyRegions,
  decryptCompactJwe,
  essentialChallengeResource,
  playwrightProxy,
  normalizeAllowedProxyRegions,
  proxyUrl,
  resolveCloakProxyGeo,
  terminalBatch,
  turnstileClickPoint,
  validateProtectedSubmission,
  verificationChallengeRejected,
};
