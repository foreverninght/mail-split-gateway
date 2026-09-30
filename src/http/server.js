'use strict';

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const { verifyApiKey } = require('../security/tokens');
const { FixedWindowRateLimiter } = require('./rate-limiter');

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  });
  res.end(payload);
}

function sendText(res, status, body = '') {
  res.writeHead(status, {
    'content-type': 'text/plain; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store, no-cache, must-revalidate',
    pragma: 'no-cache',
  });
  res.end(body);
}

async function readJson(req, limit = 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw Object.assign(new Error('request body too large'), { statusCode: 413 });
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw Object.assign(new Error('invalid JSON body'), { statusCode: 400 });
  }
}

function match(pathname, pattern) {
  const result = pattern.exec(pathname);
  return result ? result.slice(1).map(decodeURIComponent) : null;
}

function requestIp(req) {
  return String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
}

function createHttpServer({ service, store, registrationService, icMailboxService, rebindService, adminApiKey, publicDir, logger = console }) {
  if (!adminApiKey) throw new Error('admin API key is required');
  const indexHtml = fs.readFileSync(path.join(publicDir, 'index.html'));
  const appJs = fs.readFileSync(path.join(publicDir, 'app.js'));
  const stylesCss = fs.readFileSync(path.join(publicDir, 'styles.css'));
  const limiter = new FixedWindowRateLimiter();

  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    try {
      if (req.method === 'GET' && url.pathname === '/health') {
        return sendJson(res, 200, { ok: true });
      }
      if (req.method === 'GET' && url.pathname === '/') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-length': indexHtml.length });
        return res.end(indexHtml);
      }
      if (req.method === 'GET' && url.pathname === '/app.js') {
        res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'content-length': appJs.length });
        return res.end(appJs);
      }
      if (req.method === 'GET' && url.pathname === '/styles.css') {
        res.writeHead(200, { 'content-type': 'text/css; charset=utf-8', 'content-length': stylesCss.length });
        return res.end(stylesCss);
      }

      const publicToken = match(url.pathname, /^\/m\/([A-Za-z0-9_-]{43})$/);
      if (req.method === 'GET' && publicToken) {
        const rateKey = `${requestIp(req)}:${publicToken[0]}`;
        if (!limiter.allow(rateKey)) return sendText(res, 429);
        try {
          const result = await service.accessPublicToken(publicToken[0]);
          if (!result.found) return sendText(res, 404);
          return sendText(res, 200, result.code || '');
        } catch (error) {
          logger.error('public mailbox poll failed', error);
          return sendText(res, 502);
        }
      }

      if (url.pathname.startsWith('/api/admin/')) {
        const supplied = req.headers['x-api-key'] || String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
        if (!verifyApiKey(supplied, adminApiKey)) return sendJson(res, 401, { error: 'unauthorized' });
      }

      const trialCheck = match(url.pathname, /^\/api\/admin\/qualified-accounts\/([^/]+)\/trial-check$/);
      if (rebindService && trialCheck && req.method === 'POST') {
        const body = await readJson(req);
        return sendJson(res, 202, { check: await rebindService.startTrialCheck({ accountId: trialCheck[0], idempotencyKey: body?.idempotencyKey }) });
      }
      if (rebindService && trialCheck && req.method === 'GET') {
        return sendJson(res, 200, { check: await rebindService.getTrialCheck(trialCheck[0]) });
      }
      if (rebindService && req.method === 'GET' && url.pathname === '/api/admin/rebind/proxies') {
        return sendJson(res, 200, await rebindService.proxyOverview({
          page: url.searchParams.get('page'), limit: url.searchParams.get('limit'),
          status: url.searchParams.get('status'), q: url.searchParams.get('q'),
        }));
      }
      if (rebindService && req.method === 'POST' && url.pathname === '/api/admin/rebind/proxies/import') {
        const body = await readJson(req, 8 * 1024 * 1024);
        return sendJson(res, 200, await rebindService.importProxies(body?.text ?? body?.proxies ?? body, { mode: body?.mode }));
      }
      if (rebindService && req.method === 'GET' && url.pathname === '/api/admin/rebind/accounts') {
        return sendJson(res, 200, { accounts: await rebindService.listAccounts() });
      }
      if (rebindService && req.method === 'GET' && url.pathname === '/api/admin/rebind/jobs') {
        return sendJson(res, 200, { jobs: await rebindService.listJobs() });
      }
      if (rebindService && req.method === 'POST' && url.pathname === '/api/admin/rebind/jobs') {
        const body = await readJson(req);
        const { accountId, mailboxId, proxy, idempotencyKey } = body || {};
        return sendJson(res, 202, { job: await rebindService.createJob({ accountId, mailboxId, proxy, idempotencyKey }) });
      }
      const reconcileJob = match(url.pathname, /^\/api\/admin\/rebind\/jobs\/([^/]+)\/reconcile$/);
      if (rebindService && reconcileJob && req.method === 'GET') {
        return sendJson(res, 200, await rebindService.getReconciliation(reconcileJob[0]));
      }
      if (rebindService && reconcileJob && req.method === 'POST') {
        const body = await readJson(req);
        return sendJson(res, 202, await rebindService.reconcile(reconcileJob[0], { idempotencyKey: body?.idempotencyKey }));
      }
      const rebindJob = match(url.pathname, /^\/api\/admin\/rebind\/jobs\/([^/]+)$/);
      if (rebindService && req.method === 'GET' && rebindJob) {
        const job = await rebindService.getJob(rebindJob[0]);
        return job ? sendJson(res, 200, { job }) : sendJson(res, 404, { error: 'job_not_found' });
      }
      const rebindCleanup = match(url.pathname, /^\/api\/admin\/rebind\/jobs\/([^/]+)\/retry-cleanup$/);
      if (rebindService && req.method === 'POST' && rebindCleanup) {
        const job = await rebindService.retryCleanup(rebindCleanup[0]);
        return job ? sendJson(res, 202, { job }) : sendJson(res, 404, { error: 'job_not_found' });
      }

      if (req.method === 'GET' && url.pathname === '/api/admin/mailboxes') {
        return sendJson(res, 200, { mailboxes: service.listMailboxes() });
      }
      if (req.method === 'POST' && url.pathname === '/api/admin/mailboxes') {
        const body = await readJson(req);
        return sendJson(res, 201, { mailbox: service.addMailbox(body) });
      }

      if (req.method === 'POST' && url.pathname === '/api/admin/mailboxes/import') {
        const body = await readJson(req, 8 * 1024 * 1024);
        return sendJson(res, 200, service.importMailboxes(body?.mailboxes ?? body?.text ?? body));
      }

      let params = match(url.pathname, /^\/api\/admin\/mailboxes\/([^/]+)\/(open|close|sync)$/);
      if (req.method === 'POST' && params) {
        const [id, action] = params;
        const result = action === 'open'
          ? await service.openMailbox(id)
          : action === 'close'
            ? await service.closeMailbox(id)
            : await service.syncMailbox(id);
        if (!result) return sendJson(res, 404, { error: 'mailbox_not_found' });
        return sendJson(res, 200, { result });
      }

      params = match(url.pathname, /^\/api\/admin\/mailboxes\/([^/]+)\/aliases$/);
      if (params && req.method === 'GET') {
        return sendJson(res, 200, { aliases: service.listAliases(params[0]) });
      }
      if (params && req.method === 'POST') {
        const body = await readJson(req);
        return sendJson(res, 201, { results: await service.createBatch(params[0], body.count) });
      }
      params = match(url.pathname, /^\/api\/admin\/mailboxes\/([^/]+)\/aliases\/clear$/);
      if (params && req.method === 'POST') {
        return sendJson(res, 200, { result: await service.clearRemoteAliases(params[0]) });
      }

      params = match(url.pathname, /^\/api\/admin\/mailboxes\/([^/]+)\/domains$/);
      if (params && req.method === 'GET') {
        return sendJson(res, 200, { domains: service.listDomains(params[0]) });
      }
      params = match(url.pathname, /^\/api\/admin\/mailboxes\/([^/]+)\/domains\/([^/]+)$/);
      if (params && req.method === 'PATCH') {
        const body = await readJson(req);
        const changed = service.setDomainKind(params[0], params[1], body.kind);
        return sendJson(res, changed ? 200 : 404, { changed });
      }
      if (req.method === 'POST' && url.pathname === '/api/admin/domains/import') {
        const body = await readJson(req, 4 * 1024 * 1024);
        return sendJson(res, 200, {
          counts: service.importDomainCatalog(body.domains, body.source || 'admin_import'),
        });
      }

      params = match(url.pathname, /^\/api\/admin\/aliases\/([^/]+)\/(release|reconcile)$/);
      if (params && req.method === 'POST') {
        const [id, action] = params;
        const result = action === 'release'
          ? await service.releaseAlias(id)
          : await service.reconcileAlias(id);
        if (!result) return sendJson(res, 404, { error: 'alias_not_found' });
        return sendJson(res, 200, { result });
      }
      params = match(url.pathname, /^\/api\/admin\/aliases\/([^/]+)\/events$/);
      if (params && req.method === 'GET') {
        return sendJson(res, 200, { events: store.listAliasEvents(params[0]) });
      }

      if (icMailboxService && req.method === 'GET' && url.pathname === '/api/admin/ic-mailboxes') {
        return sendJson(res, 200, { mailboxes: icMailboxService.listMailboxes() });
      }
      if (icMailboxService && req.method === 'POST' && url.pathname === '/api/admin/ic-mailboxes/import') {
        const body = await readJson(req, 8 * 1024 * 1024);
        return sendJson(res, 200, icMailboxService.importMailboxes(body?.text ?? body));
      }
      params = match(url.pathname, /^\/api\/admin\/ic-mailboxes\/([^/]+)\/(rotate-token|test)$/);
      if (icMailboxService && req.method === 'POST' && params) {
        const [id, action] = params;
        const result = action === 'rotate-token'
          ? icMailboxService.rotateToken(id)
          : await icMailboxService.testPickup(id);
        if (!result) return sendJson(res, 404, { error: 'ic_mailbox_not_found' });
        return sendJson(res, 200, { result });
      }

      if (registrationService && req.method === 'GET' && url.pathname === '/api/admin/registration-batches') {
        return sendJson(res, 200, { batches: registrationService.listBatches() });
      }
      if (registrationService && req.method === 'POST' && url.pathname === '/api/admin/registration-batches') {
        const body = await readJson(req);
        return sendJson(res, 202, {
          batch: registrationService.createBatch(body.count, body.proxiesPerMailbox, {
            mailboxCategory: body.mailboxCategory,
            mailboxProvider: body.mailboxProvider,
          }),
        });
      }
      params = match(url.pathname, /^\/api\/admin\/registration-batches\/([^/]+)$/);
      if (registrationService && req.method === 'GET' && params) {
        const batch = registrationService.getBatch(params[0]);
        return batch ? sendJson(res, 200, { batch }) : sendJson(res, 404, { error: 'batch_not_found' });
      }
      params = match(url.pathname, /^\/api\/admin\/registration-batches\/([^/]+)\/reconcile$/);
      if (registrationService && req.method === 'POST' && params) {
        const batch = await registrationService.reconcileUnknown(params[0]);
        return batch ? sendJson(res, 200, { batch }) : sendJson(res, 404, { error: 'batch_not_found' });
      }
      if (registrationService && req.method === 'GET' && url.pathname === '/api/admin/proxies') {
        return sendJson(res, 200, registrationService.proxyOverview({
          page: url.searchParams.get('page'), limit: url.searchParams.get('limit'),
          status: url.searchParams.get('status'), q: url.searchParams.get('q'),
        }));
      }
      if (registrationService && req.method === 'POST' && url.pathname === '/api/admin/proxies/import') {
        const body = await readJson(req, 8 * 1024 * 1024);
        return sendJson(res, 200, registrationService.importProxies(body?.text ?? body?.proxies ?? body, { mode: body?.mode }));
      }
      if (registrationService && req.method === 'GET' && url.pathname === '/api/admin/control-proxies') {
        return sendJson(res, 200, registrationService.controlProxyOverview({
          page: url.searchParams.get('page'), limit: url.searchParams.get('limit'),
          status: url.searchParams.get('status'), q: url.searchParams.get('q'),
        }));
      }
      if (registrationService && req.method === 'POST' && url.pathname === '/api/admin/control-proxies/import') {
        const body = await readJson(req, 8 * 1024 * 1024);
        return sendJson(res, 200, registrationService.importControlProxies(body?.text ?? body?.proxies ?? body, { mode: body?.mode }));
      }
      if (registrationService && req.method === 'GET' && url.pathname === '/api/admin/qualified-accounts') {
        return sendJson(res, 200, { accounts: registrationService.listQualifiedAccounts() });
      }
      params = match(url.pathname, /^\/api\/admin\/qualified-accounts\/([^/]+)\/rebind-history$/);
      if (registrationService && req.method === 'GET' && params) {
        const history = registrationService.getQualifiedAccountRebindHistory(params[0]);
        return history ? sendJson(res, 200, history) : sendJson(res, 404, { error: 'account_not_found' });
      }
      params = match(url.pathname, /^\/api\/admin\/qualified-accounts\/([^/]+)\/reveal$/);
      if (registrationService && req.method === 'POST' && params) {
        const account = registrationService.revealQualifiedAccount(params[0]);
        return account ? sendJson(res, 200, { account }) : sendJson(res, 404, { error: 'account_not_found' });
      }

      return sendJson(res, 404, { error: 'not_found' });
    } catch (error) {
      logger.error('request failed', error);
      return sendJson(res, error.statusCode || 400, {
        error: error.code || 'request_failed',
        message: String(error.message || error),
      });
    }
  });
}

module.exports = { createHttpServer, readJson };
