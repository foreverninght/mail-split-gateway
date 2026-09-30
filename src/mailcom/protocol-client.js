#!/usr/bin/env node
'use strict';

const { randomUUID } = require('node:crypto');

const {
  mailsFromMailListJson,
} = require('./mail-list-parser');
const { extractVerificationCodeFromMail } = require('./otp-parser');

const sessions = new Map();
const sessionOpenings = new Map();
const sessionStates = new Map();

const MAILCOM_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36';
const MAIL_DETAIL_UI_APP = 'mailcom.webmailer.mail-detail/7.41.0';
const MAIL_BODY_ACCEPT = 'text/plain';
const MAILCOM_OAUTH_CLIENTS = Object.freeze({
  compose: 'mailcom_mailcompose_passport_live',
  detail: 'mailcom_maildetail_passport_live',
});
const DEFAULT_SESSION_KEEPALIVE_MS = 4 * 60 * 1000;

function oauthBasic(clientId) {
  return `Basic ${Buffer.from(`${clientId}:*******`, 'utf8').toString('base64')}`;
}

function nowIso() {
  return new Date().toISOString();
}

function extractSidFromUrl(raw = '') {
  try {
    const parsed = new URL(String(raw || ''));
    return parsed.searchParams.get('sid') || parsed.searchParams.get('navsid') || '';
  } catch {
    return '';
  }
}

function normalizeCookieDomain(domain = '', fallback = '') {
  return String(domain || fallback || '').trim().replace(/^\./, '').toLowerCase();
}

function normalizeProtocolCookie(raw = {}, fallbackUrl = '') {
  const name = String(raw.name || '').trim();
  const value = String(raw.value || '');
  if (!name || !value) return null;
  let fallbackHost = '';
  try { fallbackHost = new URL(fallbackUrl).hostname; } catch {}
  const domain = normalizeCookieDomain(raw.domain, fallbackHost);
  if (!domain) return null;
  return {
    name,
    value,
    domain,
    path: String(raw.path || '/').trim() || '/',
    expires: raw.expires ?? null,
    httpOnly: Boolean(raw.httpOnly),
    secure: raw.secure !== false,
    sameSite: raw.sameSite || null,
  };
}

function cookieKey(cookie = {}) {
  return [normalizeCookieDomain(cookie.domain), String(cookie.path || '/'), String(cookie.name || '')].join('|');
}

function ensureProtocolState(session) {
  session.cookies = Array.isArray(session.cookies) ? session.cookies.map((cookie) => normalizeProtocolCookie(cookie)).filter(Boolean) : [];
  session.tokens = session.tokens && typeof session.tokens === 'object' ? session.tokens : {};
  if (!(session.tokenRefreshes instanceof Map)) session.tokenRefreshes = new Map();
  return session;
}

function sessionKeepaliveMs(options = {}) {
  const value = Number(options.sessionKeepaliveMs);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_SESSION_KEEPALIVE_MS;
}

function markSessionMaintained(session, options = {}) {
  const now = Date.now();
  session.lastMaintainedAt = new Date(now).toISOString();
  session.nextMaintenanceAt = now + sessionKeepaliveMs(options);
}

function mergeProtocolCookies(session, cookies = [], fallbackUrl = '') {
  ensureProtocolState(session);
  const map = new Map(session.cookies.map((cookie) => [cookieKey(cookie), cookie]));
  for (const raw of Array.isArray(cookies) ? cookies : []) {
    const normalized = normalizeProtocolCookie(raw, fallbackUrl);
    if (!normalized) continue;
    map.set(cookieKey(normalized), normalized);
  }
  session.cookies = [...map.values()];
  return session.cookies;
}

function cookiesFromSetCookieHeaders(headers, fallbackUrl = '') {
  const rawList = typeof headers?.getSetCookie === 'function'
    ? headers.getSetCookie()
    : (headers?.get?.('set-cookie') ? [headers.get('set-cookie')] : []);
  return rawList.map((raw) => {
    const parts = String(raw || '').split(';').map((part) => part.trim()).filter(Boolean);
    const first = parts.shift() || '';
    const split = first.indexOf('=');
    if (split <= 0) return null;
    const cookie = {
      name: first.slice(0, split),
      value: first.slice(split + 1),
      path: '/',
      domain: '',
      secure: false,
      httpOnly: false,
    };
    for (const part of parts) {
      const index = part.indexOf('=');
      const key = (index >= 0 ? part.slice(0, index) : part).trim().toLowerCase();
      const value = index >= 0 ? part.slice(index + 1).trim() : '';
      if (key === 'domain') cookie.domain = value;
      else if (key === 'path') cookie.path = value || '/';
      else if (key === 'secure') cookie.secure = true;
      else if (key === 'httponly') cookie.httpOnly = true;
      else if (key === 'expires') cookie.expires = value;
    }
    return normalizeProtocolCookie(cookie, fallbackUrl);
  }).filter(Boolean);
}

function cookieDomainMatches(cookieDomain = '', host = '') {
  const domain = normalizeCookieDomain(cookieDomain);
  const hostname = normalizeCookieDomain(host);
  return Boolean(domain && hostname && (hostname === domain || hostname.endsWith(`.${domain}`)));
}

function cookieHeaderForUrl(session, rawUrl) {
  ensureProtocolState(session);
  let host = '';
  try { host = new URL(rawUrl).hostname; } catch {}
  const seen = new Set();
  return session.cookies
    .filter((cookie) => cookieDomainMatches(cookie.domain, host))
    .filter((cookie) => {
      if (seen.has(cookie.name)) return false;
      seen.add(cookie.name);
      return true;
    })
    .map((cookie) => `${cookie.name}=${cookie.value}`)
    .join('; ');
}

async function protocolFetch(session, rawUrl, options = {}) {
  ensureProtocolState(session);
  const headers = {
    'user-agent': MAILCOM_USER_AGENT,
    ...(options.headers || {}),
  };
  const cookie = cookieHeaderForUrl(session, rawUrl);
  if (cookie) headers.cookie = cookie;
  const timeoutMs = Math.max(1000, Number(options.timeoutMs) || 30000);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const fetchImpl = options.fetchImpl || session.fetchImpl || fetch;
    const response = await fetchImpl(rawUrl, {
      method: options.method || 'GET',
      redirect: options.redirect || 'manual',
      headers,
      body: options.body,
      signal: controller.signal,
    });
    mergeProtocolCookies(session, cookiesFromSetCookieHeaders(response.headers, rawUrl), rawUrl);
    session.lastUsedAt = nowIso();
    return response;
  } finally {
    clearTimeout(timer);
  }
}

async function responseTextPayload(response) {
  return {
    ok: response.ok,
    status: response.status,
    text: await response.text().catch(() => ''),
  };
}

function sessionExpiredError(message, details = {}) {
  const error = new Error(message);
  error.code = 'MAIL_COM_SESSION_EXPIRED';
  error.details = details;
  return error;
}

function isAuthenticationFailure({ status = 0, location = '', text = '' } = {}) {
  const numericStatus = Number(status) || 0;
  if (numericStatus === 401 || numericStatus === 403) return true;
  if (numericStatus >= 300 && numericStatus < 400
    && /(?:login\.mail\.com|\/logout(?:\?|$)|login_required)/iu.test(String(location || ''))) {
    return true;
  }
  return /\b(?:invalid[_ -]?grant|invalid[_ -]?token|no[_ -]?session|session[_ -]?(?:expired|invalid)|sid[_ -]?(?:expired|invalid)|login_required)\b/iu
    .test(String(text || ''));
}

function throwIfAuthenticationFailure(action, response, text = '') {
  const location = response?.headers?.get?.('location') || '';
  if (!isAuthenticationFailure({ status: response?.status, location, text })) return;
  throw sessionExpiredError(`${action}：mail.com 会话已失效。`, {
    status: Number(response?.status) || 0,
    location,
  });
}

async function refreshOAuthToken(session, scope, uiApp, options = {}, clientId = MAILCOM_OAUTH_CLIENTS.compose) {
  ensureProtocolState(session);
  const tokenKey = `${clientId}:${scope}`;
  const cached = session.tokens?.[tokenKey];
  if (!options.forceRefresh && cached?.token && Number(cached.expiresAt || 0) > Date.now() + 30000) return cached.token;
  const pending = session.tokenRefreshes.get(tokenKey);
  if (pending) return pending;

  const refresh = (async () => {
    if (!session.sid) throw sessionExpiredError('mail.com 协议会话缺少 sid，无法获取授权。');
    const url = `https://oauthbridge.navigator-lxa.mail.com/navigator/oauth2/token?sid=${encodeURIComponent(session.sid)}`;
    const response = await protocolFetch(session, url, {
      method: 'POST',
      timeoutMs: options.timeoutMs,
      fetchImpl: options.fetchImpl,
      headers: {
        accept: '*/*',
        'content-type': 'application/x-www-form-urlencoded',
        'cache-control': 'no-cache',
        pragma: 'no-cache',
        'x-ui-app': uiApp,
        origin: 'https://webmailer.mail.com',
        referer: 'https://webmailer.mail.com/',
        authorization: oauthBasic(clientId),
      },
      body: new URLSearchParams({
        grant_type: 'urn:mam:oauth:grant-type:spa',
        scope,
      }),
    });
    const text = await response.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch {}
    const token = body?.access_token || body?.accessToken || '';
    if (!response.ok || !token) {
      throwIfAuthenticationFailure('获取 mail.com 授权失败', response, text);
      const detail = body?.error_description || body?.error || text.replace(/\s+/g, ' ').trim().slice(0, 240);
      throw new Error(`获取 mail.com 授权失败（HTTP ${response.status}）${detail ? `：${detail}` : ''}`);
    }
    session.tokens[tokenKey] = {
      token,
      expiresAt: Date.now() + Math.max(60, Number(body?.expires_in) || 900) * 1000,
    };
    if (scope === 'mail_mailbox_w') session.settingsAuthorization = `Bearer ${token}`;
    return token;
  })();

  session.tokenRefreshes.set(tokenKey, refresh);
  try {
    return await refresh;
  } finally {
    if (session.tokenRefreshes.get(tokenKey) === refresh) session.tokenRefreshes.delete(tokenKey);
  }
}

async function ensureSettingsAuthorization(session, options = {}) {
  const token = await refreshOAuthToken(session, 'mail_mailbox_w', 'mailcom.mailset-compose/1.0.6', options);
  session.settingsAuthorization = `Bearer ${token}`;
  return session.settingsAuthorization;
}


function htmlHiddenInputValue(html = '', name = '') {
  const escaped = String(name || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const byNameFirst = new RegExp(`<input[^>]*name=["']${escaped}["'][^>]*>`, 'i').exec(String(html || ''));
  const tag = byNameFirst ? byNameFirst[0] : '';
  if (!tag) return '';
  const valueMatch = /\bvalue=["']([^"']*)["']/i.exec(tag);
  return valueMatch ? valueMatch[1] : '';
}


function navigatorRedirectUrlFromHtml(html = '', baseUrl = '') {
  const match = /"redirectUrl":"([^"]+)"/i.exec(String(html || ''));
  if (!match) return '';
  const raw = match[1].replace(/\\\//g, '/');
  try { return new URL(raw, baseUrl || 'https://navigator-lxa.mail.com/').toString(); } catch { return ''; }
}

async function protocolLogin(main, options = {}) {
  const session = {
    protocolOnly: true,
    cookies: [],
    tokens: {},
    fetchImpl: options.fetchImpl,
    startedAt: nowIso(),
    lastUsedAt: nowIso(),
  };
  const home = await protocolFetch(session, 'https://www.mail.com/', {
    timeoutMs: options.timeoutMs,
    headers: { accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' },
  });
  const homeText = await home.text().catch(() => '');
  const loginBody = new URLSearchParams({
    ibaInfo: htmlHiddenInputValue(homeText, 'ibaInfo') || 'abd=false',
    service: htmlHiddenInputValue(homeText, 'service') || 'mailint',
    statistics: htmlHiddenInputValue(homeText, 'statistics'),
    uasServiceID: htmlHiddenInputValue(homeText, 'uasServiceID') || 'mc_starter_mailcom',
    successURL: htmlHiddenInputValue(homeText, 'successURL') || 'https://$(clientName)-$(dataCenter).mail.com/login',
    loginFailedURL: htmlHiddenInputValue(homeText, 'loginFailedURL') || 'https://www.mail.com/logout?ls=wd',
    loginErrorURL: htmlHiddenInputValue(homeText, 'loginErrorURL') || 'https://www.mail.com/logout?ls=te',
    edition: htmlHiddenInputValue(homeText, 'edition') || 'US',
    lang: htmlHiddenInputValue(homeText, 'lang') || 'en',
    usertype: htmlHiddenInputValue(homeText, 'usertype') || 'standard',
    username: main.email,
    password: main.password,
  });
  let url = 'https://login.mail.com/login';
  let method = 'POST';
  let body = loginBody;
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const response = await protocolFetch(session, url, {
      method,
      timeoutMs: options.timeoutMs,
      headers: {
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        ...(method === 'POST' ? {
          'content-type': 'application/x-www-form-urlencoded',
          origin: 'https://www.mail.com',
          referer: 'https://www.mail.com/',
        } : {}),
      },
      body,
    });
    const sid = extractSidFromUrl(url) || extractSidFromUrl(response.headers.get('location') || '');
    if (sid) session.sid = sid;
    const location = response.headers.get('location');
    if (!location) {
      const finalText = await response.text().catch(() => '');
      if (/logout\?ls=wd|invalid|incorrect|wrong|password/i.test(`${url}\n${finalText}`) && !session.sid) {
        throw new Error('mail.com HTTP 登录失败：账号或密码被登录页拒绝。');
      }
      const jsRedirect = navigatorRedirectUrlFromHtml(finalText, url);
      if (jsRedirect && jsRedirect !== url) {
        url = jsRedirect;
        method = 'GET';
        body = undefined;
        continue;
      }
      break;
    }
    url = new URL(location, url).toString();
    if (/logout\?ls=wd/i.test(url)) throw new Error('mail.com HTTP 登录失败：账号或密码被登录页拒绝。');
    method = 'GET';
    body = undefined;
  }
  if (!session.sid) throw new Error('mail.com HTTP 登录未拿到 sid。');
  await refreshOAuthToken(session, 'mail_mailbox_w', 'mailcom.mailset-compose/1.0.6', options);
  await refreshOAuthToken(session, 'mail_mailbox_r', 'mailcom.webmailer.mail-list/6.6.3', options);
  await refreshOAuthToken(session, 'mail_mailbox_r', MAIL_DETAIL_UI_APP, options, MAILCOM_OAUTH_CLIENTS.detail);
  markSessionMaintained(session, options);
  return session;
}

async function renewSession(main, staleSession, options = {}) {
  const current = sessions.get(main.id);
  if (current && current !== staleSession && isSessionUsable(current)) return current;
  const pending = sessionOpenings.get(main.id);
  if (pending) return pending;

  if (current === staleSession) sessions.delete(main.id);
  if (staleSession) {
    staleSession.tokens = {};
    staleSession.settingsAuthorization = '';
  }
  sessionStates.set(main.id, {
    ...(sessionStates.get(main.id) || {}),
    status: 'renewing',
    renewingAt: nowIso(),
    lastError: '',
  });

  const opening = (async () => {
    try {
      const renewed = await protocolLogin(main, options);
      sessions.set(main.id, renewed);
      sessionStates.set(main.id, {
        ...(sessionStates.get(main.id) || {}),
        status: 'open',
        startedAt: renewed.startedAt,
        lastUsedAt: renewed.lastUsedAt,
        lastMaintainedAt: renewed.lastMaintainedAt,
        nextMaintenanceAt: renewed.nextMaintenanceAt,
        lastError: '',
        mode: 'http',
      });
      return renewed;
    } catch (cause) {
      sessions.delete(main.id);
      const error = new Error(`mail.com 会话续期失败：${String(cause?.message || cause)}`);
      error.code = 'MAIL_COM_SESSION_RENEWAL_FAILED';
      error.cause = cause;
      sessionStates.set(main.id, {
        ...(sessionStates.get(main.id) || {}),
        status: 'failed',
        failedAt: nowIso(),
        lastError: error.message.slice(0, 500),
      });
      throw error;
    }
  })();

  sessionOpenings.set(main.id, opening);
  try {
    return await opening;
  } finally {
    if (sessionOpenings.get(main.id) === opening) sessionOpenings.delete(main.id);
  }
}

function needsSessionMaintenance(mainId, at = Date.now()) {
  const session = sessions.get(mainId);
  if (!isSessionUsable(session)) return false;
  const dueAt = Number(session.nextMaintenanceAt || 0);
  return !Number.isFinite(dueAt) || dueAt <= Number(at);
}

async function maintainSession(main, options = {}) {
  const pending = sessionOpenings.get(main.id);
  if (pending) return pending;
  const current = sessions.get(main.id);
  if (!isSessionUsable(current)) {
    const error = new Error('mail.com 主邮箱会话尚未打开，不能执行主动续期。');
    error.code = 'MAIL_COM_SESSION_NOT_OPEN';
    throw error;
  }

  sessionStates.set(main.id, {
    ...(sessionStates.get(main.id) || {}),
    status: 'renewing',
    renewingAt: nowIso(),
    lastError: '',
  });

  let replacingSession = false;
  const maintaining = (async () => {
    try {
      const refreshOptions = { ...options, forceRefresh: true };
      try {
        await refreshOAuthToken(current, 'mail_mailbox_w', 'mailcom.mailset-compose/1.0.6', refreshOptions);
        await refreshOAuthToken(current, 'mail_mailbox_r', 'mailcom.webmailer.mail-list/6.6.3', refreshOptions);
        await refreshOAuthToken(current, 'mail_mailbox_r', MAIL_DETAIL_UI_APP, refreshOptions, MAILCOM_OAUTH_CLIENTS.detail);
        markSessionMaintained(current, options);
      } catch (error) {
        if (error?.code !== 'MAIL_COM_SESSION_EXPIRED') throw error;
        replacingSession = true;
        const renewed = await protocolLogin(main, options);
        sessions.set(main.id, renewed);
      }

      const active = sessions.get(main.id);
      sessionStates.set(main.id, {
        ...(sessionStates.get(main.id) || {}),
        status: 'open',
        startedAt: active.startedAt,
        lastUsedAt: active.lastUsedAt,
        lastMaintainedAt: active.lastMaintainedAt,
        nextMaintenanceAt: active.nextMaintenanceAt,
        lastError: '',
        mode: 'http',
      });
      return active;
    } catch (cause) {
      sessions.delete(main.id);
      const error = new Error(`mail.com 主邮箱主动续期失败：${String(cause?.message || cause)}`);
      error.code = replacingSession ? 'MAIL_COM_SESSION_RENEWAL_FAILED' : 'MAIL_COM_SESSION_MAINTENANCE_FAILED';
      error.cause = cause;
      sessionStates.set(main.id, {
        ...(sessionStates.get(main.id) || {}),
        status: isAuthenticationFailure({
          status: cause?.details?.status,
          location: cause?.details?.location,
          text: cause?.message,
        }) ? 'login_required' : 'failed',
        failedAt: nowIso(),
        lastError: error.message.slice(0, 500),
      });
      throw error;
    }
  })();

  sessionOpenings.set(main.id, maintaining);
  try {
    return await maintaining;
  } finally {
    if (sessionOpenings.get(main.id) === maintaining) sessionOpenings.delete(main.id);
  }
}

async function withSessionRenewal(main, options, operation) {
  const session = await getSession(main, options);
  try {
    return await operation(session);
  } catch (error) {
    if (error?.code !== 'MAIL_COM_SESSION_EXPIRED') throw error;
    const renewed = await renewSession(main, session, options);
    try {
      return await operation(renewed);
    } catch (retryError) {
      if (retryError?.code === 'MAIL_COM_SESSION_EXPIRED') {
        await markSessionUnavailable(main.id, {
          status: 'login_required',
          lastError: retryError.message,
        });
      }
      throw retryError;
    }
  }
}

function emailKey(value = '') {
  return String(value || '').trim().toLowerCase();
}

function isSessionUsable(session) {
  return Boolean(session?.sid && Array.isArray(session.cookies) && session.cookies.length);
}

function publicSession(main) {
  const session = sessions.get(main.id);
  const open = isSessionUsable(session);
  const state = sessionStates.get(main.id) || {};
  const status = open && state.status !== 'renewing' ? 'open' : (state.status || (open ? 'open' : 'closed'));
  return {
    open,
    status,
    startedAt: session?.startedAt || state.startedAt || null,
    lastUsedAt: session?.lastUsedAt || state.lastUsedAt || null,
    lastMaintainedAt: session?.lastMaintainedAt || state.lastMaintainedAt || null,
    nextMaintenanceAt: session?.nextMaintenanceAt || state.nextMaintenanceAt || null,
    openingAt: state.openingAt || null,
    renewingAt: state.renewingAt || null,
    closedAt: state.closedAt || null,
    failedAt: state.failedAt || null,
    lastError: open ? '' : (state.lastError || ''),
    mode: state.mode || (open ? 'http' : 'closed'),
  };
}

async function getSession(main, options = {}) {
  const pending = sessionOpenings.get(main.id);
  if (pending) return pending;
  const current = sessions.get(main.id);
  if (current && isSessionUsable(current)) {
    current.lastUsedAt = nowIso();
    sessionStates.set(main.id, { ...(sessionStates.get(main.id) || {}), status: 'open', lastError: '', lastUsedAt: current.lastUsedAt });
    return current;
  }
  if (current) {
    await closeSession(main.id).catch(() => {});
  }
  if (options.requireOpenSession) {
    sessionStates.set(main.id, { ...(sessionStates.get(main.id) || {}), status: 'closed', lastError: '请先手动登录这个主邮箱。' });
    const error = new Error('请先手动登录这个主邮箱。');
    error.code = 'MAIL_COM_SESSION_NOT_OPEN';
    throw error;
  }

  sessionStates.set(main.id, {
    ...(sessionStates.get(main.id) || {}),
    status: 'opening',
    openingAt: nowIso(),
    lastError: '',
  });

  const opening = (async () => {
    if (!main.email || !main.password) throw new Error('主邮箱和密码不能为空。');
    try {
      const protocolSession = await protocolLogin(main, options);
      sessions.set(main.id, protocolSession);
      sessionStates.set(main.id, {
        ...(sessionStates.get(main.id) || {}),
        status: 'open',
        startedAt: protocolSession.startedAt,
        lastUsedAt: protocolSession.lastUsedAt,
        lastMaintainedAt: protocolSession.lastMaintainedAt,
        nextMaintenanceAt: protocolSession.nextMaintenanceAt,
        lastError: '',
        mode: 'http',
      });
      return protocolSession;
    } catch (error) {
      sessions.delete(main.id);
      sessionStates.set(main.id, {
        ...(sessionStates.get(main.id) || {}),
        status: 'failed',
        failedAt: nowIso(),
        lastError: String(error?.message || error).slice(0, 500),
      });
      throw error;
    }
  })();

  sessionOpenings.set(main.id, opening);
  try {
    return await opening;
  } finally {
    if (sessionOpenings.get(main.id) === opening) sessionOpenings.delete(main.id);
  }
}

async function closeSession(mainId) {
  const session = sessions.get(mainId);
  if (!session) {
    sessionStates.set(mainId, { ...(sessionStates.get(mainId) || {}), status: 'closed', closedAt: nowIso() });
    return false;
  }
  sessions.delete(mainId);
  sessionStates.set(mainId, { ...(sessionStates.get(mainId) || {}), status: 'closed', closedAt: nowIso(), lastError: '' });
  return true;
}

async function markSessionUnavailable(mainId, { status = 'failed', lastError = '' } = {}) {
  const session = sessions.get(mainId);
  if (session) sessions.delete(mainId);
  sessionStates.set(mainId, {
    ...(sessionStates.get(mainId) || {}),
    status,
    failedAt: status === 'failed' || status === 'login_required' ? nowIso() : undefined,
    closedAt: status === 'closed' ? nowIso() : undefined,
    lastError: String(lastError || '').slice(0, 500),
  });
  return publicSession({ id: mainId });
}

function settingsResponseError(action, response) {
  const detail = String(response?.text || '').replace(/\s+/g, ' ').trim().slice(0, 240);
  return `${action}（HTTP ${response?.status || 0}）${detail ? `：${detail}` : ''}`;
}

async function listFolderProtocol(session, folderTypeOrId = 'INBOX', options = {}) {
  const amount = Math.min(100, Math.max(1, Number(options.amount) || 50));
  const token = await refreshOAuthToken(session, 'mail_mailbox_r', 'mailcom.webmailer.mail-list/6.6.3', options);
  const mails = [];
  for (let offset = 0; offset <= 5000; offset += amount) {
    const noCache = `a-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
    const response = await protocolFetch(session,
      `https://maillist.mail.com/Mailbox/Mail?folderTypeOrId=${encodeURIComponent(folderTypeOrId)}&offset=${Number(offset) || 0}&amount=${amount}&orderBy=INTERNALDATE%20DESC&no_cache=${encodeURIComponent(noCache)}`,
      {
        method: 'POST',
        timeoutMs: options.timeoutMs,
        headers: {
          accept: 'application/vnd.1and1.mms.unified-maillist-v1+json; charset=utf-8',
          'content-type': 'application/vnd.1and1.mms.inboxadrequest-v1+json; charset=utf-8',
          authorization: `Bearer ${token}`,
          origin: 'https://webmailer.mail.com',
          referer: 'https://webmailer.mail.com/',
          'cache-control': 'no-cache',
          pragma: 'no-cache',
          'x-request-id': `${Math.random().toString(16).slice(2, 10)}-${Date.now().toString(16)}`,
          'x-ui-app': 'mailcom.webmailer.mail-list/6.6.3',
        },
        body: JSON.stringify({
          aditionContext: {
            brand: 'mailcom',
            category: 'mail',
            section: '3c/folder',
            tagid: 'inline',
            layoutclass: 'b',
          },
          deviceContext: {
            app: { name: 'browser' },
            deviceclass: 'b',
          },
          adBlocker: false,
          mailboxContext: {
            currentPage: Math.floor((Number(offset) || 0) / amount) + 1,
            visibleMessages: 8,
          },
        }),
      });
    const text = await response.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch {}
    throwIfAuthenticationFailure(`读取 ${folderTypeOrId} 失败`, response, text);
    if (!response.ok) throw new Error(`读取 ${folderTypeOrId} 失败（HTTP ${response.status}）。`);
    const pageMails = mailsFromMailListJson(body);
    mails.push(...pageMails);
    if (pageMails.length < amount || pageMails.length === 0) break;
  }
  session.lastUsedAt = nowIso();
  return mails;
}

async function listFolder(main, folderTypeOrId = 'INBOX', options = {}) {
  return withSessionRenewal(
    main,
    options,
    (session) => listFolderProtocol(session, folderTypeOrId, options),
  );
}

async function fetchMailBodyProtocol(session, mailId, options = {}) {
  const id = String(mailId || '').trim();
  if (!id) throw new TypeError('mail.com message id is required');
  const token = await refreshOAuthToken(
    session,
    'mail_mailbox_r',
    MAIL_DETAIL_UI_APP,
    options,
    MAILCOM_OAUTH_CLIENTS.detail,
  );
  const noCache = `a-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
  const bodyResponse = await protocolFetch(session,
    `https://webmail-cats-live.mail.com/mailbox/primary/mailbody/${encodeURIComponent(id)}/Body?absoluteURI=false&no_cache=${encodeURIComponent(noCache)}`,
    {
      method: 'GET',
      timeoutMs: Math.min(10000, Math.max(3000, Number(options.timeoutMs) || 10000)),
      headers: {
        accept: MAIL_BODY_ACCEPT,
        authorization: `Bearer ${token}`,
        origin: 'https://webmailer.mail.com',
        referer: 'https://webmailer.mail.com/',
        'cache-control': 'no-cache',
        pragma: 'no-cache',
        'x-request-id': randomUUID(),
        'x-ui-app': MAIL_DETAIL_UI_APP,
      },
    });
  const html = await bodyResponse.text();
  throwIfAuthenticationFailure('读取 mail.com 邮件正文失败', bodyResponse, html);
  return {
    ok: bodyResponse.ok,
    status: bodyResponse.status,
    html,
    error: bodyResponse.ok ? null : 'body_unavailable',
  };
}

function matchesAlias(mail, aliasEmail) {
  const target = emailKey(aliasEmail);
  return target && (mail.to || []).some((item) => emailKey(item) === target);
}

function isChatGptMail(mail) {
  return /chatgpt|openai/i.test(`${mail.sender || ''} ${mail.subject || ''}`);
}

function aliasMessageSnapshot(mails, aliasEmail) {
  return (Array.isArray(mails) ? mails : [])
    .filter((mail) => matchesAlias(mail, aliasEmail))
    .filter(isChatGptMail)
    .map((mail) => {
      const parsed = extractVerificationCodeFromMail(mail, { minScore: 15 });
      return {
        id: String(mail?.id || '').trim(),
        subject: mail?.subject || '',
        sender: mail?.sender || '',
        receivedAt: mail?.receivedAt || null,
        text: parsed.found ? parsed.code : '',
      };
    })
    .filter((mail) => mail.id);
}

async function snapshotAliasMessages(main, aliasEmail, options = {}) {
  const mails = await listFolder(main, 'INBOX', { ...options, amount: 100 });
  return aliasMessageSnapshot(mails, aliasEmail);
}

function timeValue(value) {
  if (!value) return 0;
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value > 100000000000 ? value : value * 1000;
  }
  const numeric = String(value).trim();
  if (/^\d{10,13}$/.test(numeric)) {
    const number = Number(numeric);
    return numeric.length >= 13 ? number : number * 1000;
  }
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : 0;
}

function normalizeSet(values) {
  return new Set((Array.isArray(values) ? values : [])
    .map((value) => String(value || '').trim())
    .filter(Boolean));
}

function setContainsMailId(seenIds, mailId) {
  const id = String(mailId || '').trim();
  if (!id) return false;
  if (seenIds.has(id)) return true;
  for (const seen of seenIds) {
    if (String(seen).endsWith(`:${id}`) || String(seen).endsWith(`/${id}`)) return true;
  }
  return false;
}

function mailPassesCodeWindow(mail, options = {}) {
  const after = timeValue(options.after || options.afterMs || options.notBefore);
  if (after) {
    const received = timeValue(mail?.receivedAt);
    if (!received || received <= after) return false;
  }
  const seenIds = normalizeSet(options.seenIds || options.excludeIds || options.excludedIds || options.excludeMailIds);
  if (setContainsMailId(seenIds, mail?.id)) return false;
  return true;
}

function codeWasSeen(code, options = {}) {
  const seenCodes = normalizeSet(options.seenCodes || options.excludeCodes || options.excludedCodes);
  return seenCodes.has(String(code || '').trim());
}

function mailUriForDelete(mail) {
  const raw = String(mail?.removalUri || mail?.uri || mail?.id || '').trim();
  if (!raw) return '';
  const normalized = raw
    .replace(/^\/+/, '')
    .replace(/^Mail\//i, '')
    .replace(/\/Removal$/i, '');
  return normalized ? `/Mail/${normalized}` : '';
}

async function fetchAliasCode(main, aliasEmail, options = {}) {
  const mails = (await listFolder(main, 'INBOX', options))
    .filter((mail) => matchesAlias(mail, aliasEmail))
    .filter(isChatGptMail)
    .filter((mail) => mailPassesCodeWindow(mail, options));

  for (const mail of mails) {
    const headerResult = extractVerificationCodeFromMail(mail, { minScore: 15 });
    if (headerResult.found && !codeWasSeen(headerResult.code, options)) {
      return { ...headerResult, source: 'mail-list-api' };
    }
  }

  for (const mail of mails) {
    const body = await fetchMessageBody(main, mail.id, options);
    if (!body?.ok || !body.html) continue;
    const result = extractVerificationCodeFromMail({
      ...mail,
      html: body.html,
      text: body.html,
    }, { minScore: 15 });
    if (result.found && !codeWasSeen(result.code, options)) {
      return { ...result, source: 'mail-body-response' };
    }
  }

  return {
    found: false,
    code: null,
    reason: mails.length ? 'no_code_in_matching_mails' : 'no_matching_mail',
    mail: mails[0] || null,
    mails,
  };
}

async function fetchMessageBody(main, mailId, options = {}) {
  return withSessionRenewal(main, options, (session) => fetchMailBodyProtocol(session, mailId, options));
}

async function batchDeleteProtocol(session, mailUris, moveToTrash, options = {}) {
  const uris = [...new Set((Array.isArray(mailUris) ? mailUris : []).filter(Boolean).map(String))];
  if (!uris.length) return { deleted: 0 };
  const authorization = await ensureSettingsAuthorization(session, options);
  for (let offset = 0; offset < uris.length; offset += 100) {
    const chunk = uris.slice(offset, offset + 100);
    const response = await protocolFetch(session,
      `https://webmail-cats-live.mail.com/mailbox/primary/MailBatchDelete?absoluteURI=false&no_cache=${encodeURIComponent(`a-${Date.now()}-${Math.random().toString(36).slice(2)}`)}`,
      {
        method: 'POST',
        timeoutMs: options.timeoutMs,
        headers: {
          accept: 'application/json; charset=utf-8',
          'content-type': 'application/vnd.ui.trinity.message.batchdelete+json; charset=utf-8',
          authorization,
          origin: 'https://webmailer.mail.com',
          referer: 'https://webmailer.mail.com/',
          'cache-control': 'no-cache',
          pragma: 'no-cache',
          'x-request-id': `${Math.random().toString(16).slice(2)}-${Date.now().toString(16)}`,
          'x-ui-app': 'mailcom.webmailer.mail-list/6.6.3',
        },
        body: JSON.stringify({
          moveToTrash: String(Boolean(moveToTrash)),
          mailUris: chunk.map((uri) => mailUriForDelete({ uri })),
        }),
      });
    if (!response.ok) {
      const detail = String(await response.text().catch(() => '')).replace(/\s+/g, ' ').trim().slice(0, 240);
      throwIfAuthenticationFailure('删除邮件失败', response, detail);
      throw new Error(`删除邮件失败（HTTP ${response.status}）${detail ? `：${detail}` : ''}。`);
    }
  }
  session.lastUsedAt = nowIso();
  return { deleted: uris.length, moveToTrash: Boolean(moveToTrash) };
}

async function batchDelete(main, mailUris, moveToTrash, options = {}) {
  return withSessionRenewal(
    main,
    options,
    (session) => batchDeleteProtocol(session, mailUris, moveToTrash, options),
  );
}

async function requestAddress(main, method, address, options = {}) {
  return withSessionRenewal(main, options, async (session) => {
    const encodedAddress = encodeURIComponent(String(address || ''));
    const adding = method === 'POST';
    const authorization = await ensureSettingsAuthorization(session, options);
    const url = `https://settings-cats.mail.com/mailaccount/primary/${adding
      ? 'emailAddresses'
      : `emailAddressesRemovals/${encodedAddress}/removals`}?absoluteURI=false`;
    const response = await protocolFetch(session, url, {
      method: 'POST',
      timeoutMs: options.timeoutMs,
      fetchImpl: options.fetchImpl,
      headers: {
        accept: adding
          ? 'application/vnd.ui.trinity.minimalmailaddress-v3+json'
          : 'text/plain;charset=UTF-8',
        'content-type': adding
          ? 'application/vnd.ui.trinity.minimalmailaddress-v3+json'
          : 'text/plain;charset=UTF-8',
        'cache-control': 'no-cache',
        pragma: 'no-cache',
        'x-request-id': randomUUID(),
        'x-ui-app': 'mailcom.mailset-compose/1.0.5-build.335',
        authorization,
      },
      body: adding ? JSON.stringify({
        address,
        deletable: true,
        pgpEnabled: false,
        defaultSenderAddress: false,
        defaultReceiverAddress: false,
        state: 'ACTIVE',
      }) : undefined,
    });
    const payload = await responseTextPayload(response);
    throwIfAuthenticationFailure(`${adding ? '添加' : '删除'}分裂邮箱失败`, response, payload.text);
    if (!payload.ok) {
      const error = new Error(settingsResponseError(
        `${adding ? '添加' : '删除'}分裂邮箱失败`, payload,
      ));
      if (adding && payload.status === 409 && /urn:problem:mam:cats:request-conflict/.test(payload.text)) {
        error.code = 'MAIL_COM_ALIAS_CREATE_CONFLICT';
      }
      throw error;
    }
    session.lastUsedAt = nowIso();
    return { status: payload.status, address };
  });
}

async function validateAddress(main, address, options = {}) {
  return withSessionRenewal(main, options, async (session) => {
    const authorization = await ensureSettingsAuthorization(session, options);
    const response = await protocolFetch(
      session,
      'https://settings-cats.mail.com/mailaccount/emailAddressValidations?absoluteURI=false',
      {
        method: 'POST',
        timeoutMs: options.timeoutMs,
        headers: {
          accept: 'application/vnd.ui.trinity.email-address-validation-response+json',
          'content-type': 'application/vnd.ui.trinity.email-address-validation-request+json',
          'cache-control': 'no-cache',
          pragma: 'no-cache',
          'x-request-id': randomUUID(),
          'x-ui-app': 'mailcom.mailset-compose/1.0.6',
          authorization,
        },
        body: JSON.stringify([address]),
      },
    );
    const payload = await responseTextPayload(response);
    throwIfAuthenticationFailure('分裂邮箱地址校验失败', response, payload.text);
    if (!payload.ok) {
      throw new Error(settingsResponseError('分裂邮箱地址校验失败', payload));
    }
    session.lastUsedAt = nowIso();
    return true;
  });
}

async function addAddress(main, address, options = {}) {
  await validateAddress(main, address, options);
  const created = await requestAddress(main, 'POST', address, options);
  const addresses = await listAddresses(main, options);
  if (!addresses.some((entry) => emailKey(entry.address) === emailKey(address))) {
    const error = new Error(`mail.com 未在远端地址列表返回新分裂邮箱：${address}`);
    error.code = 'MAIL_COM_ALIAS_CREATION_UNCONFIRMED';
    error.address = address;
    throw error;
  }
  return { ...created, confirmed: true };
}

async function removeAddress(main, address, options = {}) {
  return requestAddress(main, 'POST_REMOVE', address, options);
}

function collectDomainEntries(value, output = []) {
  if (!value) return output;
  if (typeof value === 'string') {
    const domain = value.trim().replace(/^@+/, '').toLowerCase();
    if (/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}$/i.test(domain)) {
      output.push({ domain, state: 'UNKNOWN' });
    }
    return output;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectDomainEntries(item, output);
    return output;
  }
  if (typeof value !== 'object') return output;
  const direct = value.domain || value.name || value.mailDomain || value.emailDomain || value.value;
  if (typeof direct === 'string') {
    const domain = direct.trim().replace(/^@+/, '').toLowerCase();
    if (/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}$/i.test(domain)) {
      output.push({
        domain,
        state: String(value.state || value.status || value.availability || 'UNKNOWN').trim().toUpperCase(),
      });
    }
  }
  for (const [key, nested] of Object.entries(value)) {
    if (/domain|domains|list|items|entries|results/i.test(key) && nested !== direct) {
      collectDomainEntries(nested, output);
    }
  }
  return output;
}

function parseDomainsResponse(text = '') {
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch {}
  const seen = new Set();
  return (Array.isArray(body?.domains) ? body.domains : []).flatMap((item) => {
    const domain = String(item?.domain || '').trim().toLowerCase();
    if (!/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}$/i.test(domain) || seen.has(domain)) return [];
    seen.add(domain);
    return [{
      domain,
      state: String(item?.state || 'UNKNOWN').trim().toUpperCase(),
    }];
  });
}

function uniqueDomainEntries(entries = []) {
  const map = new Map();
  for (const entry of entries) {
    const domain = String(entry?.domain || '').trim().replace(/^@+/, '').toLowerCase();
    if (!domain) continue;
    const state = String(entry?.state || 'UNKNOWN').trim().toUpperCase();
    const previous = map.get(domain);
    if (!previous || state === 'ACTIVE') map.set(domain, { domain, state });
  }
  return [...map.values()].sort((a, b) => {
    const stateOrder = Number(b.state === 'ACTIVE') - Number(a.state === 'ACTIVE');
    return stateOrder || a.domain.localeCompare(b.domain);
  });
}

async function listDomains(main, options = {}) {
  return withSessionRenewal(main, options, async (session) => {
    const authorization = await ensureSettingsAuthorization(session, options);
    const response = await protocolFetch(
      session,
      'https://settings-cats.mail.com/domains?absoluteURI=false&q.owner.eq=gmx_MAILCOM',
      {
        method: 'GET',
        timeoutMs: options.timeoutMs,
        headers: {
          accept: 'application/json',
          'cache-control': 'no-cache',
          pragma: 'no-cache',
          'x-request-id': randomUUID(),
          'x-ui-app': 'mailcom.mailset-compose/1.0.5-build.335',
          authorization,
        },
      },
    );
    const payload = await responseTextPayload(response);
    throwIfAuthenticationFailure('读取分裂邮箱后缀失败', response, payload.text);
    if (!payload.ok) {
      throw new Error(settingsResponseError('读取分裂邮箱后缀失败', payload));
    }
    session.lastUsedAt = nowIso();
    return parseDomainsResponse(payload.text);
  });
}

async function listAddresses(main, options = {}) {
  return withSessionRenewal(main, options, async (session) => {
    const authorization = await ensureSettingsAuthorization(session, options);
    const response = await protocolFetch(
      session,
      'https://settings-cats.mail.com/mailaccount/primary/emailAddresses?absoluteURI=false&q.state.in=ACTIVE&q.type.in=MANAGED,DOMAIN_HOSTING',
      {
        method: 'GET',
        timeoutMs: options.timeoutMs,
        headers: {
          accept: 'application/vnd.ui.trinity.mailaddress.list-v5+json',
          'content-type': 'application/vnd.ui.trinity.mailaddress.list-v5+json',
          'cache-control': 'no-cache',
          pragma: 'no-cache',
          'x-request-id': randomUUID(),
          'x-ui-app': 'mailcom.mailset-compose/1.0.6',
          authorization,
        },
      },
    );
    const payload = await responseTextPayload(response);
    throwIfAuthenticationFailure('读取已有分裂邮箱失败', response, payload.text);
    if (!payload.ok) {
      throw new Error(settingsResponseError('读取已有分裂邮箱失败', payload));
    }
    let body = null;
    try { body = payload.text ? JSON.parse(payload.text) : null; } catch {}
    if (!Array.isArray(body?.mailaddresslist)) {
      const error = new Error('读取已有分裂邮箱失败：mail.com 未返回地址列表。');
      error.code = 'MAIL_COM_ADDRESS_LIST_INVALID';
      throw error;
    }
    session.lastUsedAt = nowIso();
    return body.mailaddresslist.filter((item) => item?.address && emailKey(item.address) !== emailKey(main.email)).map((item) => ({
      address: String(item.address).trim(),
      type: item.type || '',
      deletable: item.deletable !== false,
      state: item.state || '',
    }));
  });
}

async function emptyFolder(main, folderTypeOrId, options = {}) {
  const mails = await listFolder(main, folderTypeOrId, options);
  return batchDelete(main, mails.map(mailUriForDelete), true, options);
}

async function emptyTrash(main, options = {}) {
  const mails = await listFolder(main, 'TRASH', options);
  return batchDelete(main, mails.map(mailUriForDelete), false, options);
}

async function closeAllSessions() {
  await Promise.all([...sessions.keys()].map((id) => closeSession(id)));
}

process.once('exit', () => {
  sessions.clear();
});

module.exports = {
  batchDelete,
  addAddress,
  closeAllSessions,
  closeSession,
  markSessionUnavailable,
  emptyFolder,
  fetchAliasCode,
  fetchMessageBody,
  getSession,
  maintainSession,
  needsSessionMaintenance,
  listFolder,
  listAddresses,
  listDomains,
  snapshotAliasMessages,
  aliasMessageSnapshot,
  parseDomainsResponse,
  removeAddress,
  emptyTrash,
  publicSession,
};
