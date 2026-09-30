'use strict';

const { ALIAS_STATES } = require('../domain/state-machine');
const { extractVerificationCodeFromMail } = require('../mailcom/otp-parser');

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function isTargetMail(mail) {
  return /chatgpt|openai/i.test(`${mail?.sender || ''} ${mail?.subject || ''}`);
}

class MailboxPoller {
  constructor({ store, adapter, loadMailbox, minIntervalMs = 2500, clock = Date.now, onError = () => {}, onSuccess = () => {} }) {
    this.store = store;
    this.adapter = adapter;
    this.loadMailbox = loadMailbox;
    this.minIntervalMs = minIntervalMs;
    this.clock = clock;
    this.onError = onError;
    this.onSuccess = onSuccess;
    this.running = new Map();
    this.lastPollAt = new Map();
  }

  refresh(mailboxId) {
    const pending = this.running.get(mailboxId);
    if (pending) return pending;
    const elapsed = this.clock() - (this.lastPollAt.get(mailboxId) || 0);
    if (elapsed < this.minIntervalMs) return Promise.resolve({ skipped: true, reason: 'fresh_cache' });
    const operation = this.poll(mailboxId)
      .then((result) => {
        this.onSuccess(mailboxId, result);
        return result;
      })
      .catch((error) => {
        this.onError(mailboxId, error);
        throw error;
      })
      .finally(() => {
        this.lastPollAt.set(mailboxId, this.clock());
        if (this.running.get(mailboxId) === operation) this.running.delete(mailboxId);
      });
    this.running.set(mailboxId, operation);
    return operation;
  }

  async poll(mailboxId) {
    const aliases = this.store.listAliases({
      mailboxId,
      states: [ALIAS_STATES.ACTIVE, ALIAS_STATES.DELIVERED],
    });
    if (!aliases.length) return { messages: 0, aliases: 0, codes: 0 };

    const mailbox = this.loadMailbox(mailboxId);
    const aliasByEmail = new Map(aliases.map((alias) => [normalizeEmail(alias.email), alias]));
    const messages = await this.adapter.fetchInbox(mailbox, { amount: 100 });
    let codes = 0;

    for (const message of messages) {
      if (!isTargetMail(message)) continue;
      const recipients = Array.isArray(message.to) ? message.to.map(normalizeEmail) : [];
      const alias = recipients.map((email) => aliasByEmail.get(email)).find(Boolean);
      if (!alias || !message.id) continue;
      const receivedAt = Date.parse(message.receivedAt || '');
      const createdAtSecond = Math.floor(Date.parse(alias.created_at) / 1000) * 1000;
      if (Number.isFinite(receivedAt) && receivedAt < createdAtSecond) continue;

      let parsed = extractVerificationCodeFromMail(message, { minScore: 15 });
      if (!parsed.found) {
        const body = await this.adapter.fetchMessageBody(mailbox, message.id);
        if (!body?.ok) {
          const error = new Error(`mail.com 邮件正文读取失败（HTTP ${Number(body?.status) || 0}）。`);
          error.code = 'MAIL_COM_BODY_UNAVAILABLE';
          error.details = { messageId: String(message.id), status: Number(body?.status) || 0 };
          throw error;
        }
        parsed = extractVerificationCodeFromMail({ ...message, html: body.html, text: body.html }, { minScore: 15 });
      }
      if (!parsed.found) continue;
      this.store.recordOtp({
        aliasId: alias.id,
        remoteMessageId: String(message.id),
        code: parsed.code,
        receivedAt: message.receivedAt,
      });
      codes += 1;
    }
    return { messages: messages.length, aliases: aliases.length, codes };
  }
}

module.exports = { MailboxPoller, isTargetMail };
