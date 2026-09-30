'use strict';

const { DomUtils, parseDocument } = require('htmlparser2');
const { IcPickupError } = require('./ikunai-direct-html');

const HOSTNAME = 'enohaook.top1688.org';
const PORT = '5001';
const MAX_HTML_BYTES = 2 * 1024 * 1024;

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function validateTop1688Url(value, expectedEmail) {
  let url;
  try {
    url = new URL(String(value || ''));
  } catch (error) {
    throw new IcPickupError('IC_UPSTREAM_URL_INVALID', 'IC upstream URL is invalid', error);
  }
  if (url.protocol !== 'http:' || url.hostname.toLowerCase() !== HOSTNAME || url.port !== PORT
      || url.username || url.password) {
    throw new IcPickupError('IC_UPSTREAM_URL_INVALID', `IC upstream URL must use http://${HOSTNAME}:${PORT}`);
  }
  let parts;
  try {
    parts = url.pathname.split('/').filter(Boolean).map((part) => decodeURIComponent(part));
  } catch (error) {
    throw new IcPickupError('IC_UPSTREAM_URL_INVALID', 'IC upstream URL path is malformed', error);
  }
  if (parts.length !== 3 || parts[0] !== 'show' || !parts[1]
      || normalizeEmail(parts[2]) !== normalizeEmail(expectedEmail)) {
    throw new IcPickupError('IC_UPSTREAM_URL_INVALID', 'IC upstream URL path does not match the mailbox');
  }
  if (url.search || url.hash) throw new IcPickupError('IC_UPSTREAM_URL_INVALID', 'IC upstream URL must not contain query or fragment data');
  return url;
}

function walk(nodes, visit, ignored = false) {
  for (const node of nodes || []) {
    const nextIgnored = ignored || (node.type === 'tag' && ['script', 'style'].includes(node.name));
    if (!nextIgnored) visit(node);
    if (node.children) walk(node.children, visit, nextIgnored);
  }
}

function hasClass(node, className) {
  return node.type === 'tag'
    && String(node.attribs?.class || '').split(/\s+/).includes(className);
}

function findAll(root, predicate) {
  const found = [];
  walk(root.children, (node) => { if (predicate(node)) found.push(node); });
  return found;
}

function exactlyOne(root, predicate, field) {
  const matches = findAll(root, predicate);
  if (matches.length !== 1) {
    throw new IcPickupError('IC_UPSTREAM_HTML_INVALID', `IC pickup HTML has ${matches.length} ${field} elements`);
  }
  return matches[0];
}

function elementText(node) {
  return DomUtils.textContent(node).replace(/\s+/g, ' ').trim();
}

function exactTextCodes(root) {
  const values = new Set();
  walk(root.children, (node) => {
    if (node.type !== 'text') return;
    const value = String(node.data || '').trim();
    if (/^\d{6}$/.test(value)) values.add(value);
  });
  return [...values];
}

function parseTop1688Html(html, expectedEmail) {
  let document;
  try {
    document = parseDocument(String(html), { decodeEntities: true });
  } catch (error) {
    throw new IcPickupError('IC_UPSTREAM_HTML_INVALID', `IC pickup HTML is malformed: ${error.message}`, error);
  }

  const identity = exactlyOne(document, (node) => hasClass(node, 'lead'), 'mailbox identity');
  if (normalizeEmail(elementText(identity)) !== normalizeEmail(expectedEmail)) {
    throw new IcPickupError('IC_UPSTREAM_EMAIL_MISMATCH', 'IC pickup page belongs to a different mailbox');
  }

  const notices = findAll(document, (node) => hasClass(node, 'notice'));
  if (notices.length) {
    if (notices.length !== 1 || elementText(notices[0]) !== '当前无邮件') {
      throw new IcPickupError('IC_UPSTREAM_HTML_INVALID', 'IC pickup page returned an unknown notice');
    }
    return { status: 'pending', code: null };
  }

  const title = exactlyOne(document, (node) => hasClass(node, 'mail-card-title'), 'mail title');
  const subject = elementText(title);
  const recipientLabels = findAll(document, (node) => node.type === 'tag' && node.name === 'strong'
    && elementText(node) === '收件人');
  if (recipientLabels.length !== 1) {
    throw new IcPickupError('IC_UPSTREAM_FIELDS_MISSING', 'IC pickup page has no unique recipient field');
  }
  const recipientRow = recipientLabels[0].parent;
  const recipientSpans = (recipientRow?.children || []).filter((node) => node.type === 'tag' && node.name === 'span');
  if (recipientSpans.length !== 1 || normalizeEmail(elementText(recipientSpans[0])) !== normalizeEmail(expectedEmail)) {
    throw new IcPickupError('IC_UPSTREAM_EMAIL_MISMATCH', 'IC pickup message belongs to a different recipient');
  }

  const frame = exactlyOne(document, (node) => node.type === 'tag' && node.name === 'iframe'
    && hasClass(node, 'mail-frame'), 'mail body');
  const source = frame.attribs?.srcdoc;
  if (typeof source !== 'string' || !source.trim()) {
    throw new IcPickupError('IC_UPSTREAM_FIELDS_MISSING', 'IC pickup message body is missing');
  }
  const verificationMessage = /chatgpt|openai|验证码|verification\s+code/i.test(subject);
  if (!verificationMessage) return { status: 'pending', code: null };

  const body = parseDocument(source, { decodeEntities: true });
  const codes = exactTextCodes(body);
  if (codes.length !== 1) {
    throw new IcPickupError('IC_UPSTREAM_CODE_INVALID', `IC pickup message contains ${codes.length} verification code candidates`);
  }
  return { status: 'code', code: codes[0] };
}

class Top1688MailHtmlAdapter {
  constructor({ fetchImpl = globalThis.fetch, timeoutMs = 30000 } = {}) {
    if (typeof fetchImpl !== 'function') throw new TypeError('fetch implementation is required');
    this.key = 'top1688_mail_html';
    this.fetch = fetchImpl;
    this.timeoutMs = timeoutMs;
  }

  validateUrl(value, email) {
    return validateTop1688Url(value, email).toString();
  }

  async fetchCode({ upstreamUrl, email }) {
    const url = validateTop1688Url(upstreamUrl, email);
    let response;
    try {
      response = await this.fetch(url, {
        method: 'GET',
        redirect: 'error',
        signal: AbortSignal.timeout(this.timeoutMs),
        headers: {
          accept: 'text/html,application/xhtml+xml',
          'accept-language': 'zh-CN,zh;q=0.9',
          'cache-control': 'no-cache',
          pragma: 'no-cache',
        },
      });
    } catch (error) {
      throw new IcPickupError('IC_UPSTREAM_NETWORK_ERROR', `IC pickup request failed: ${error.message}`, error);
    }
    if (response.status !== 200) {
      throw new IcPickupError('IC_UPSTREAM_HTTP_ERROR', `IC pickup returned HTTP ${response.status}`);
    }
    const contentType = String(response.headers.get('content-type') || '').toLowerCase();
    if (contentType && !contentType.includes('text/html')) {
      throw new IcPickupError('IC_UPSTREAM_CONTENT_TYPE_INVALID', `IC pickup returned ${contentType}`);
    }
    const contentLength = Number(response.headers.get('content-length') || 0);
    if (contentLength > MAX_HTML_BYTES) throw new IcPickupError('IC_UPSTREAM_RESPONSE_TOO_LARGE', 'IC pickup response is too large');
    const html = await response.text();
    if (Buffer.byteLength(html) > MAX_HTML_BYTES) throw new IcPickupError('IC_UPSTREAM_RESPONSE_TOO_LARGE', 'IC pickup response is too large');
    return parseTop1688Html(html, email);
  }
}

module.exports = {
  HOSTNAME,
  PORT,
  Top1688MailHtmlAdapter,
  parseTop1688Html,
  validateTop1688Url,
};
