'use strict';

const protocol = require('./protocol-client');

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

class RemoteOutcomeUnknownError extends Error {
  constructor(operation, address, cause) {
    super(`mail.com ${operation} result is unknown for ${address}: ${String(cause?.message || cause)}`);
    this.name = 'RemoteOutcomeUnknownError';
    this.code = 'REMOTE_OUTCOME_UNKNOWN';
    this.operation = operation;
    this.address = address;
    this.cause = cause;
  }
}

class MailComAdapter {
  constructor({ client = protocol, timeoutMs = 60000, sessionKeepaliveMs = 4 * 60 * 1000 } = {}) {
    this.client = client;
    this.timeoutMs = timeoutMs;
    this.sessionKeepaliveMs = sessionKeepaliveMs;
  }

  options(extra = {}) {
    return {
      timeoutMs: this.timeoutMs,
      sessionKeepaliveMs: this.sessionKeepaliveMs,
      ...extra,
    };
  }

  async open(mailbox) {
    await this.client.getSession(mailbox, this.options());
    return this.client.publicSession(mailbox);
  }

  async close(mailboxId) {
    return this.client.closeSession(mailboxId);
  }

  async closeAll() {
    return this.client.closeAllSessions();
  }

  needsMaintenance(mailboxId, at = Date.now()) {
    return this.client.needsSessionMaintenance(mailboxId, at);
  }

  async maintain(mailbox) {
    await this.client.maintainSession(mailbox, this.options());
    return this.client.publicSession(mailbox);
  }

  async listDomains(mailbox) {
    const domains = await this.client.listDomains(mailbox, this.options());
    return domains.filter((entry) => entry.state === 'ACTIVE');
  }

  async listAliases(mailbox) {
    return this.client.listAddresses(mailbox, this.options());
  }

  async aliasExists(mailbox, address) {
    const target = normalizeEmail(address);
    const aliases = await this.listAliases(mailbox);
    return aliases.some((entry) => normalizeEmail(entry.address) === target);
  }

  async createAlias(mailbox, address) {
    try {
      return await this.client.addAddress(mailbox, address, this.options());
    } catch (cause) {
      try {
        if (await this.aliasExists(mailbox, address)) return { address, confirmed: true, reconciled: true };
      } catch (reconcileError) {
        throw new RemoteOutcomeUnknownError('create', address, reconcileError);
      }
      throw cause;
    }
  }

  async deleteAlias(mailbox, address) {
    try {
      await this.client.removeAddress(mailbox, address, this.options());
    } catch (cause) {
      try {
        if (!await this.aliasExists(mailbox, address)) return { address, confirmed: true, reconciled: true };
      } catch (reconcileError) {
        throw new RemoteOutcomeUnknownError('delete', address, reconcileError);
      }
      throw cause;
    }
    try {
      if (await this.aliasExists(mailbox, address)) {
        throw new Error(`mail.com still returns deleted alias: ${address}`);
      }
      return { address, confirmed: true };
    } catch (cause) {
      if (cause?.message?.startsWith('mail.com still returns')) throw cause;
      throw new RemoteOutcomeUnknownError('delete', address, cause);
    }
  }

  async fetchInbox(mailbox, { amount = 100 } = {}) {
    return this.client.listFolder(mailbox, 'INBOX', this.options({ amount }));
  }

  async fetchMessageBody(mailbox, messageId) {
    return this.client.fetchMessageBody(mailbox, messageId, this.options());
  }
}

module.exports = {
  MailComAdapter,
  RemoteOutcomeUnknownError,
};
