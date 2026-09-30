'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { GatewayStore } = require('./db/store');
const { createHttpServer } = require('./http/server');
const { MailComAdapter } = require('./mailcom/adapter');
const { SecretBox } = require('./security/secret-box');
const { CleanupScheduler } = require('./services/cleanup-scheduler');
const { GatewayService } = require('./services/gateway-service');
const { SessionMaintenanceScheduler } = require('./services/session-maintenance-scheduler');
const { IfnexoraWorker } = require('./ifnexora/worker');
const { RegistrationService } = require('./registration/service');
const { RegistrationStore } = require('./registration/store');
const { IcAdapterRegistry } = require('./ic/adapter-registry');
const { IcMailboxService } = require('./ic/service');
const { IcMailboxStore } = require('./ic/store');
const { IkunaiDirectHtmlAdapter } = require('./ic/adapters/ikunai-direct-html');
const { Top1688MailHtmlAdapter } = require('./ic/adapters/top1688-mail-html');
const { RebindStore } = require('./rebind/store');
const { RebindService } = require('./rebind/service');
const { RebindWorker } = require('./rebind/worker');

function positiveNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function loadConfig(env = process.env) {
  const port = positiveNumber(env.PORT, 3110);
  const host = env.HOST || '127.0.0.1';
  const dataDir = path.resolve(env.MAIL_GATEWAY_DATA_DIR || path.join(process.cwd(), 'data'));
  return {
    host,
    port,
    dataDir,
    databaseFile: path.join(dataDir, 'gateway.sqlite'),
    publicBaseUrl: env.MAIL_GATEWAY_PUBLIC_URL || `http://${host}:${port}`,
    masterKey: env.MAIL_GATEWAY_MASTER_KEY,
    adminApiKey: env.MAIL_GATEWAY_ADMIN_KEY,
    operationTimeoutMs: positiveNumber(env.MAIL_GATEWAY_OPERATION_TIMEOUT_MS, 60000),
    sessionKeepaliveMs: positiveNumber(env.MAIL_GATEWAY_SESSION_KEEPALIVE_MS, 4 * 60 * 1000),
    sessionMaintenanceScanMs: positiveNumber(env.MAIL_GATEWAY_SESSION_MAINTENANCE_SCAN_MS, 30000),
    deliveredRetentionMs: positiveNumber(env.MAIL_GATEWAY_DELIVERED_RETENTION_MS, 30 * 60 * 1000),
    unusedTtlMs: positiveNumber(env.MAIL_GATEWAY_UNUSED_TTL_MS, 6 * 60 * 60 * 1000),
    inactiveTtlMs: positiveNumber(env.MAIL_GATEWAY_INACTIVE_TTL_MS, 30 * 60 * 1000),
    ifnexoraBaseUrl: env.IFNEXORA_BASE_URL || 'https://ifnexora.com',
    ifnexoraAllowedProxyRegions: env.IFNEXORA_ALLOWED_PROXY_REGIONS || '',
    registrationProxyRefreshMs: positiveNumber(
      env.MAIL_GATEWAY_REGISTRATION_PROXY_REFRESH_MS,
      30 * 60 * 1000,
    ),
    browserExecutablePath: env.MAIL_GATEWAY_BROWSER_EXECUTABLE || '',
    browserHeadless: env.MAIL_GATEWAY_BROWSER_HEADLESS !== 'false',
    browserCloakMode: env.MAIL_GATEWAY_BROWSER_CLOAK_MODE === 'true',
    browserCloakPythonPath: env.MAIL_GATEWAY_CLOAK_PYTHON || '/opt/cloakbrowser-venv/bin/python',
    rebindEnabled: env.MAIL_GATEWAY_REBIND_ENABLED === 'true',
    rebindPythonPath: env.MAIL_GATEWAY_REBIND_PYTHON || 'python3',
    rebindTimeoutMs: positiveNumber(env.MAIL_GATEWAY_REBIND_TIMEOUT_MS, 300000),
  };
}

async function main() {
  const config = loadConfig();
  if (!config.masterKey) throw new Error('MAIL_GATEWAY_MASTER_KEY is required');
  if (!config.adminApiKey) throw new Error('MAIL_GATEWAY_ADMIN_KEY is required');
  fs.mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });

  const store = new GatewayStore({ filename: config.databaseFile });
  const adapter = new MailComAdapter({
    timeoutMs: config.operationTimeoutMs,
    sessionKeepaliveMs: config.sessionKeepaliveMs,
  });
  const secretBox = new SecretBox(config.masterKey);
  const icMailboxStore = new IcMailboxStore({ db: store.db });
  const icAdapterRegistry = new IcAdapterRegistry();
  icAdapterRegistry.register('icloud.ikunai666.top', new IkunaiDirectHtmlAdapter({
    timeoutMs: config.operationTimeoutMs,
  }));
  icAdapterRegistry.register('enohaook.top1688.org', new Top1688MailHtmlAdapter({
    timeoutMs: config.operationTimeoutMs,
  }));
  const icMailboxService = new IcMailboxService({
    store: icMailboxStore,
    secretBox,
    adapterRegistry: icAdapterRegistry,
    publicBaseUrl: config.publicBaseUrl,
  });
  const service = new GatewayService({
    store,
    adapter,
    secretBox,
    publicBaseUrl: config.publicBaseUrl,
    deliveredRetentionMs: config.deliveredRetentionMs,
    icMailboxService,
  });
  const registrationStore = new RegistrationStore({
    db: store.db,
    secretBox,
    registrationProxyRefreshMs: config.registrationProxyRefreshMs,
  });
  const externalWorker = new IfnexoraWorker({
    baseUrl: config.ifnexoraBaseUrl,
    executablePath: config.browserExecutablePath || undefined,
    headless: config.browserHeadless,
    cloakMode: config.browserCloakMode,
    cloakGeoResolverPythonPath: config.browserCloakPythonPath,
    allowedProxyRegions: config.ifnexoraAllowedProxyRegions,
  });
  const registrationService = new RegistrationService({
    store: registrationStore,
    gatewayService: service,
    icMailboxService,
    externalWorker,
    secretBox,
  });
  const rebindWorker = config.rebindEnabled ? new RebindWorker({
    pythonPath: config.rebindPythonPath,
    nodePath: process.execPath,
    timeoutMs: config.rebindTimeoutMs,
  }) : null;
  const rebindService = config.rebindEnabled ? new RebindService({
    store: new RebindStore({ db: store.db, secretBox, proxyRefreshMs: config.registrationProxyRefreshMs }),
    gatewayService: service,
    worker: rebindWorker,
    registrationStore,
    secretBox,
  }) : null;
  if (rebindService) {
    const recovery = rebindService.recoverAfterRestart();
    if (recovery.jobs) console.log("rebind jobs require review after restart:", recovery.jobs);
  }
  const recovered = service.recoverAfterRestart();
  if (recovered.mailboxes || recovered.aliases) console.log('recovered interrupted state', recovered);
  const cleanup = new CleanupScheduler({
    store,
    service,
    unusedTtlMs: config.unusedTtlMs,
    inactiveTtlMs: config.inactiveTtlMs,
  });
  const sessionMaintenance = new SessionMaintenanceScheduler({
    store,
    service,
    intervalMs: config.sessionMaintenanceScanMs,
  });
  const server = createHttpServer({
    service,
    store,
    adminApiKey: config.adminApiKey,
    publicDir: path.join(__dirname, '..', 'public'),
    rebindService,
    registrationService,
    icMailboxService,
  });

  cleanup.start();
  sessionMaintenance.start();
  const resumed = registrationService.recoverAfterRestart();
  if (resumed) console.log(`resumed ${resumed} registration batches`);
  server.listen(config.port, config.host, () => {
    console.log(`mail-split-gateway listening on ${config.host}:${config.port}`);
  });

  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    cleanup.stop();
    sessionMaintenance.stop();
    await new Promise((resolve) => server.close(resolve));
    const rebindStopped = rebindService ? rebindService.close().catch(() => {}) : Promise.resolve();
    if (rebindWorker) await rebindWorker.close().catch(() => {});
    await rebindStopped;
    await registrationService.close().catch(() => {});
    await adapter.closeAll().catch(() => {});
    store.close();
  };
  process.once('SIGTERM', () => stop().finally(() => process.exit(0)));
  process.once('SIGINT', () => stop().finally(() => process.exit(0)));
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

module.exports = { loadConfig, main };
