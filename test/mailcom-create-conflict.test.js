'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const protocol = require('../src/mailcom/protocol-client');

for (const [endpoint, status, type, expected] of [
  ['create', 409, 'urn:problem:mam:cats:request-conflict', 'MAIL_COM_ALIAS_CREATE_CONFLICT'],
  ['validation', 409, 'urn:problem:mam:cats:request-conflict', undefined],
  ['create', 400, 'urn:problem:mam:cats:request-conflict', undefined],
  ['create', 409, 'another-problem', undefined],
  ['delete', 409, 'urn:problem:mam:cats:request-conflict', undefined],
]) {
  test(`creation conflict classification: ${endpoint} ${status} ${type}`, async (t) => {
    let calls = 0;
    const mailbox = { id: `${endpoint}-${status}-${type}`, email: 'main@example.com', password: 'secret' };
    t.after(() => protocol.closeSession(mailbox.id));
    const fetchImpl = async (url) => {
      calls += 1;
      if (calls === 1) return new Response('<form></form>', { headers: { 'set-cookie': 'mail-session=test; Domain=.mail.com; Path=/; Secure' } });
      if (calls === 2) return new Response('', { status: 302, headers: { location: 'https://navigator-lxa.mail.com/mail?sid=test-sid' } });
      if (calls === 3) return new Response('<html></html>');
      if (calls <= 6) return Response.json({ access_token: `token-${calls}`, expires_in: 900 });
      if (String(url).includes('emailAddressValidations') && endpoint !== 'validation') return Response.json({});
      assert.match(String(url), endpoint === 'validation' ? /emailAddressValidations/ : endpoint === 'delete' ? /emailAddressesRemovals/ : /emailAddresses\?/);
      return Response.json({ type }, { status });
    };
    const operation = endpoint === 'delete' ? protocol.removeAddress : protocol.addAddress;
    await assert.rejects(operation(mailbox, 'new@example.com', { fetchImpl }), (error) => {
      assert.equal(error.code, expected);
      assert.match(error.message, new RegExp(`HTTP ${status}`));
      return true;
    });
  });
}
