'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { MailComAdapter, RemoteOutcomeUnknownError } = require('../src/mailcom/adapter');

const mailbox = { id: 'm1', email: 'main@example.com', password: 'secret' };

test('delete is not confirmed until the remote address list no longer contains the alias', async () => {
  const client = {
    async removeAddress() {},
    async listAddresses() { return [{ address: 'alias@example.com' }]; },
  };
  const adapter = new MailComAdapter({ client });
  await assert.rejects(
    adapter.deleteAlias(mailbox, 'alias@example.com'),
    /still returns deleted alias/,
  );
});

test('network failure during reconciliation produces an unknown remote outcome', async () => {
  const client = {
    async addAddress() { throw new Error('socket closed'); },
    async listAddresses() { throw new Error('mail.com unavailable'); },
  };
  const adapter = new MailComAdapter({ client });
  await assert.rejects(
    adapter.createAlias(mailbox, 'alias@example.com'),
    RemoteOutcomeUnknownError,
  );
});
