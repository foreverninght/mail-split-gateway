'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const protocol = require('../src/mailcom/protocol-client');

test('message body uses the current authenticated mailbox protocol endpoint', async (t) => {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    const index = calls.length;
    if (index === 1) {
      return new Response('<form></form>', {
        status: 200,
        headers: { 'set-cookie': 'mail-session=test; Domain=.mail.com; Path=/; Secure' },
      });
    }
    if (index === 2) {
      return new Response('', {
        status: 302,
        headers: { location: 'https://navigator-lxa.mail.com/mail?sid=test-sid' },
      });
    }
    if (index === 3) return new Response('<html></html>', { status: 200 });
    if (index === 4 || index === 5 || index === 6) {
      return Response.json({ access_token: `token-${index}`, expires_in: 900 });
    }
    if (index === 7) return new Response('<p>Your verification code is 123456</p>', { status: 200 });
    throw new Error(`unexpected fetch call ${index}: ${url}`);
  };
  const mailbox = { id: `body-test-${Date.now()}`, email: 'main@example.com', password: 'secret' };
  t.after(() => protocol.closeSession(mailbox.id));

  const body = await protocol.fetchMessageBody(mailbox, 'message-123', { fetchImpl });

  assert.equal(body.ok, true);
  assert.match(body.html, /123456/);
  const detailTokenRequest = calls[5];
  assert.match(detailTokenRequest.url, /^https:\/\/oauthbridge\.navigator-lxa\.mail\.com\/navigator\/oauth2\/token\?sid=test-sid$/);
  assert.equal(
    detailTokenRequest.options.headers.authorization,
    `Basic ${Buffer.from('mailcom_maildetail_passport_live:*******').toString('base64')}`,
  );
  const request = calls[6];
  assert.match(request.url, /^https:\/\/webmail-cats-live\.mail\.com\/mailbox\/primary\/mailbody\/message-123\/Body\?absoluteURI=false&no_cache=/);
  assert.equal(request.options.method, 'GET');
  assert.equal(request.options.headers.authorization, 'Bearer token-6');
  assert.equal(request.options.headers['x-ui-app'], 'mailcom.webmailer.mail-detail/7.41.0');
  assert.equal(request.options.headers.accept, 'text/plain');
  assert.equal(request.options.body, undefined);
});
