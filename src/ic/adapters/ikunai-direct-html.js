'use strict';

const { readNamedMeta } = require('../html-meta-parser');

const HOSTNAME = 'icloud.ikunai666.top';
const MAX_HTML_BYTES = 1024 * 1024;

class IcPickupError extends Error {
  constructor(code, message, cause) {
    super(message, cause ? { cause } : undefined);
    this.name = 'IcPickupError';
    this.code = code;
    this.statusCode = 502;
  }
}

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function validateIkunaiUrl(value, expectedEmail) {
  let url;
  try {
    url = new URL(String(value || ''));
  } catch (error) {
    throw new IcPickupError('IC_UPSTREAM_URL_INVALID', 'IC upstream URL is invalid', error);
  }
  if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== HOSTNAME || url.username || url.password || url.port) {
    throw new IcPickupError('IC_UPSTREAM_URL_INVALID', `IC upstream URL must use https://${HOSTNAME}`);
  }
  const parts = url.pathname.split('/').filter(Boolean).map((part) => decodeURIComponent(part));
  if (parts.length !== 3 || parts[0] !== 'show' || !parts[1] || normalizeEmail(parts[2]) !== normalizeEmail(expectedEmail)) {
    throw new IcPickupError('IC_UPSTREAM_URL_INVALID', 'IC upstream URL path does not match the mailbox');
  }
  if (url.search || url.hash) throw new IcPickupError('IC_UPSTREAM_URL_INVALID', 'IC upstream URL must not contain query or fragment data');
  return url;
}

function parseIkunaiHtml(html, expectedEmail) {
  let fields;
  try {
    fields = readNamedMeta(String(html), ['pickup-email', 'verification-code']);
  } catch (error) {
    throw new IcPickupError('IC_UPSTREAM_HTML_INVALID', `IC pickup HTML is malformed: ${error.message}`, error);
  }
  if (!fields.has('pickup-email') || !fields.has('verification-code')) {
    throw new IcPickupError('IC_UPSTREAM_FIELDS_MISSING', 'IC pickup HTML is missing required meta fields');
  }
  if (normalizeEmail(fields.get('pickup-email')) !== normalizeEmail(expectedEmail)) {
    throw new IcPickupError('IC_UPSTREAM_EMAIL_MISMATCH', 'IC pickup page belongs to a different mailbox');
  }
  const code = fields.get('verification-code').trim();
  if (!code) return { status: 'pending', code: null };
  if (!/^\d{6}$/.test(code)) {
    throw new IcPickupError('IC_UPSTREAM_CODE_INVALID', 'IC pickup page returned a malformed verification code');
  }
  return { status: 'code', code };
}

class IkunaiDirectHtmlAdapter {
  constructor({ fetchImpl = globalThis.fetch, timeoutMs = 30000 } = {}) {
    if (typeof fetchImpl !== 'function') throw new TypeError('fetch implementation is required');
    this.key = 'ikunai_direct_html';
    this.fetch = fetchImpl;
    this.timeoutMs = timeoutMs;
  }

  validateUrl(value, email) {
    return validateIkunaiUrl(value, email).toString();
  }

  async fetchCode({ upstreamUrl, email }) {
    const url = validateIkunaiUrl(upstreamUrl, email);
    let response;
    try {
      response = await this.fetch(url, {
        method: 'GET',
        redirect: 'error',
        signal: AbortSignal.timeout(this.timeoutMs),
        headers: { accept: 'text/html,application/xhtml+xml' },
      });
    } catch (error) {
      throw new IcPickupError('IC_UPSTREAM_NETWORK_ERROR', `IC pickup request failed: ${error.message}`, error);
    }
    if (response.status !== 200) {
      throw new IcPickupError('IC_UPSTREAM_HTTP_ERROR', `IC pickup returned HTTP ${response.status}`);
    }
    const contentLength = Number(response.headers.get('content-length') || 0);
    if (contentLength > MAX_HTML_BYTES) throw new IcPickupError('IC_UPSTREAM_RESPONSE_TOO_LARGE', 'IC pickup response is too large');
    const html = await response.text();
    if (Buffer.byteLength(html) > MAX_HTML_BYTES) throw new IcPickupError('IC_UPSTREAM_RESPONSE_TOO_LARGE', 'IC pickup response is too large');
    return parseIkunaiHtml(html, email);
  }
}

module.exports = {
  HOSTNAME,
  IcPickupError,
  IkunaiDirectHtmlAdapter,
  parseIkunaiHtml,
  validateIkunaiUrl,
};
