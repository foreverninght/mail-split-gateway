'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const protocol = require('../src/mailcom/protocol-client');
const { SessionMaintenanceScheduler } = require('../src/services/session-maintenance-scheduler');

function createProtocolServer() {
  const state = {
    failNextList: false,
    failNextToken: false,
    listRequests: 0,
    loginRequests: 0,
    tokenRequests: 0,
  };
  const fetchImpl = async (rawUrl) => {
    const url = String(rawUrl);
    if (url === 'https://www.mail.com/') {
      return new Response('<form></form>', {
        status: 200,
        headers: { 'set-cookie': 'mail-session=test; Domain=.mail.com; Path=/; Secure' },
      });
    }
    if (url === 'https://login.mail.com/login') {
      state.loginRequests += 1;
      return new Response('', {
        status: 302,
        headers: { location: `https://navigator-lxa.mail.com/mail?sid=sid-${state.loginRequests}` },
      });
    }
    if (/^https:\/\/navigator-lxa\.mail\.com\/mail\?sid=/.test(url)) {
      return new Response('<html></html>', { status: 200 });
    }
    if (/^https:\/\/oauthbridge\.navigator-lxa\.mail\.com\/navigator\/oauth2\/token\?sid=/.test(url)) {
      state.tokenRequests += 1;
      if (state.failNextToken) {
        state.failNextToken = false;
        return Response.json({ error: 'invalid_token' }, { status: 401 });
      }
      return Response.json({
        access_token: `token-${state.tokenRequests}`,
        expires_in: 900,
      });
    }
    if (url.startsWith('https://maillist.mail.com/Mailbox/Mail?')) {
      state.listRequests += 1;
      if (state.failNextList) {
        state.failNextList = false;
        return Response.json({ error: 'invalid_token' }, { status: 401 });
      }
      return Response.json({ mailList: [] });
    }
    throw new Error(`unexpected protocol request: ${url}`);
  };
  return { fetchImpl, state };
}

test('proactive maintenance refreshes all token classes before expiry and shares one lock', async (t) => {
  const remote = createProtocolServer();
  const mailbox = { id: `maintenance-${Date.now()}`, email: 'main@example.com', password: 'secret' };
  const options = { fetchImpl: remote.fetchImpl, sessionKeepaliveMs: 1000 };
  t.after(() => protocol.closeSession(mailbox.id));

  await protocol.getSession(mailbox, options);
  assert.equal(remote.state.tokenRequests, 3);
  assert.equal(protocol.needsSessionMaintenance(mailbox.id, Date.now() + 2000), true);

  const [first, second] = await Promise.all([
    protocol.maintainSession(mailbox, options),
    protocol.maintainSession(mailbox, options),
  ]);

  assert.equal(first, second);
  assert.equal(remote.state.loginRequests, 1);
  assert.equal(remote.state.tokenRequests, 6);
  assert.equal(protocol.publicSession(mailbox).status, 'open');
  assert.equal(protocol.needsSessionMaintenance(mailbox.id, Date.now()), false);
});

test('proactive maintenance replaces an invalid SID with one complete protocol login', async (t) => {
  const remote = createProtocolServer();
  const mailbox = { id: `renewal-${Date.now()}`, email: 'main@example.com', password: 'secret' };
  const options = { fetchImpl: remote.fetchImpl, sessionKeepaliveMs: 1000 };
  t.after(() => protocol.closeSession(mailbox.id));

  await protocol.getSession(mailbox, options);
  remote.state.failNextToken = true;
  const renewed = await protocol.maintainSession(mailbox, options);

  assert.equal(renewed.sid, 'sid-2');
  assert.equal(remote.state.loginRequests, 2);
  assert.equal(remote.state.tokenRequests, 7);
  assert.equal(protocol.publicSession(mailbox).status, 'open');
});

test('mail listing retries once with a newly authenticated protocol session', async (t) => {
  const remote = createProtocolServer();
  const mailbox = { id: `list-renewal-${Date.now()}`, email: 'main@example.com', password: 'secret' };
  const options = { fetchImpl: remote.fetchImpl };
  t.after(() => protocol.closeSession(mailbox.id));

  await protocol.getSession(mailbox, options);
  remote.state.failNextList = true;
  assert.deepEqual(await protocol.listFolder(mailbox, 'INBOX', options), []);
  assert.equal(remote.state.listRequests, 2);
  assert.equal(remote.state.loginRequests, 2);
});

test('maintenance scheduler only runs due ready mailbox sessions', async () => {
  const maintained = [];
  const errors = [];
  const store = {
    listMailboxes: () => [
      { id: 'ready-due', state: 'ready' },
      { id: 'ready-later', state: 'ready' },
      { id: 'closed', state: 'closed' },
      { id: 'login-required', state: 'login_required' },
    ],
  };
  const service = {
    needsMailboxSessionMaintenance: (id) => id === 'ready-due',
    maintainMailboxSession: async (id) => {
      maintained.push(id);
      return { id, state: 'ready' };
    },
  };
  const scheduler = new SessionMaintenanceScheduler({
    store,
    service,
    logger: { error: (...args) => errors.push(args) },
  });

  const result = await scheduler.sweep();
  assert.deepEqual(maintained, ['ready-due']);
  assert.equal(result.scanned, 2);
  assert.equal(result.due, 1);
  assert.deepEqual(errors, []);
});
