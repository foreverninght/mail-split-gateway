'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  Top1688MailHtmlAdapter,
  parseTop1688Html,
  validateTop1688Url,
} = require('../src/ic/adapters/top1688-mail-html');

const EMAIL = 'mailbox-two@example.test';
const URL = `http://enohaook.top1688.org:5001/show/access_key/${EMAIL}`;

function escapeAttribute(value) {
  return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function page({ email = EMAIL, subject = '你的 ChatGPT 临时验证码', body = '<p>输入此临时验证码以继续：</p><p>078773</p>', notice = '' } = {}) {
  return `<!doctype html><html><body>
    <p class="lead">${email}</p>
    ${notice ? `<div class="notice">${notice}</div>` : ''}
    <section class="mail-card mail-single">
      <h2 class="mail-card-title">${subject}</h2>
      <div class="mail-meta"><strong>发件人</strong><span>sender@icloud.com</span></div>
      <div class="mail-meta"><strong>收件人</strong><span>${email}</span></div>
      <iframe class="mail-frame" title="${subject}" srcdoc="${escapeAttribute(body)}"></iframe>
    </section>
  </body></html>`;
}

test('top1688 adapter validates the exact HTTP host, port, path and mailbox', () => {
  assert.equal(validateTop1688Url(URL, EMAIL).toString(), URL);
  assert.throws(() => validateTop1688Url(URL.replace(':5001', ''), EMAIL), /must use http/);
  assert.throws(() => validateTop1688Url(URL.replace('http:', 'https:'), EMAIL), /must use http/);
  assert.throws(() => validateTop1688Url(URL, 'other@icloud.com'), /does not match/);
});

test('top1688 parser extracts only the unique code in the matching message body', () => {
  assert.deepEqual(parseTop1688Html(page(), EMAIL), { status: 'code', code: '078773' });
  assert.throws(() => parseTop1688Html(page({ email: 'other@icloud.com' }), EMAIL), /different mailbox/);
  assert.throws(() => parseTop1688Html(page({ body: '<p>123456</p><p>654321</p>' }), EMAIL), /2 verification code candidates/);
  assert.throws(() => parseTop1688Html(page({ body: '<p>code unavailable</p>' }), EMAIL), /0 verification code candidates/);
});

test('top1688 parser treats explicit empty and unrelated latest mail as pending', () => {
  assert.deepEqual(parseTop1688Html(page({ notice: '当前无邮件' }), EMAIL), { status: 'pending', code: null });
  assert.deepEqual(parseTop1688Html(page({ subject: '欢迎邮件', body: '<p>订单 123456</p>' }), EMAIL), {
    status: 'pending', code: null,
  });
  assert.throws(() => parseTop1688Html(page({ notice: '服务错误' }), EMAIL), /unknown notice/);
});

test('top1688 HTTP adapter preserves pending and rejects non-HTML upstream responses', async () => {
  let response = new Response(page({ notice: '当前无邮件' }), {
    status: 200, headers: { 'content-type': 'text/html; charset=utf-8' },
  });
  const adapter = new Top1688MailHtmlAdapter({ fetchImpl: async () => response });
  assert.deepEqual(await adapter.fetchCode({ upstreamUrl: URL, email: EMAIL }), { status: 'pending', code: null });
  response = new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  await assert.rejects(adapter.fetchCode({ upstreamUrl: URL, email: EMAIL }), /application\/json/);
});
