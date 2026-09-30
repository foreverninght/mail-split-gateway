'use strict';

const { randomBytes, randomUUID } = require('node:crypto');

const {
  ALIAS_EVENTS,
  ALIAS_STATES,
  MAILBOX_EVENTS,
  MAILBOX_STATES,
  isAliasPubliclyReadable,
  releasableStates,
} = require('../domain/state-machine');
const { RemoteOutcomeUnknownError } = require('../mailcom/adapter');
const { hashToken, issueToken } = require('../security/tokens');
const { MailboxPoller } = require('./mailbox-poller');
const { parseMailboxImport } = require('../mailcom/mailbox-import-parser');
const { RebindStore } = require('../rebind/store');
const creationQueues = new Map();

const LOCAL_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

function randomLocalPart(length = 8) {
  const bytes = randomBytes(length);
  return [...bytes].map((value) => LOCAL_ALPHABET[value % LOCAL_ALPHABET.length]).join('');
}

function publicMailbox(mailbox) {
  if (!mailbox) return null;
  const { encrypted_password: _secret, ...safe } = mailbox;
  return safe;
}

function isLoginFailure(error) {
  return /password|login|credential|账号|密码|登录页拒绝/i.test(String(error?.message || error));
}

class GatewayService {
  constructor({
    store,
    adapter,
    secretBox,
    publicBaseUrl,
    maxAliases = 9,
    deliveredRetentionMs = 30 * 60 * 1000,
    clock = Date.now,
    poller,
    icMailboxService = null,
  }) {
    this.store = store;
    this.adapter = adapter;
    this.secretBox = secretBox;
    this.publicBaseUrl = String(publicBaseUrl || '').replace(/\/$/, '');
    this.maxAliases = maxAliases;
    this.deliveredRetentionMs = deliveredRetentionMs;
    this.clock = clock;
    this.mailboxOpenings = new Map();
    // A mailbox session must remain serial, but separate main mailboxes can
    // create aliases concurrently.
    this.creationQueues = creationQueues;
    this.rebindStore = store.db ? new RebindStore({ db: store.db, secretBox, clock }) : null;
    this.icMailboxService = icMailboxService;
    this.poller = poller || new MailboxPoller({
      store,
      adapter,
      clock,
      loadMailbox: (id) => this.loadMailboxCredentials(id),
      onError: (id, error) => this.recordMailboxPollError(id, error),
      onSuccess: (id) => this.recordMailboxPollSuccess(id),
    });
  }

  recordMailboxPollError(id, error) {
    const mailbox = this.store.getMailbox(id);
    if (mailbox?.state === MAILBOX_STATES.READY) {
      this.store.transitionMailbox(id, MAILBOX_EVENTS.OPERATION_FAILED, {
        lastError: String(error?.message || error).slice(0, 500),
      });
    }
  }

  recordMailboxPollSuccess(id) {
    const mailbox = this.store.getMailbox(id);
    if (mailbox?.state === MAILBOX_STATES.UNAVAILABLE) {
      this.store.transitionMailbox(id, MAILBOX_EVENTS.OPEN);
      this.store.transitionMailbox(id, MAILBOX_EVENTS.OPENED);
    }
  }

  addMailbox({ email, password }) {
    const normalizedEmail = String(email || '').trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) throw new Error('valid mailbox email is required');
    if (!String(password || '')) throw new Error('mailbox password is required');
    if (this.store.findMailboxByEmail(normalizedEmail)) {
      const error = new Error('该主邮箱已经存在，请直接在列表中管理。');
      error.code = 'MAILBOX_ALREADY_EXISTS';
      error.statusCode = 409;
      throw error;
    }
    return publicMailbox(this.store.createMailbox({
      email: normalizedEmail,
      encryptedPassword: this.secretBox.seal(password),
    }));
  }

  listMailboxes() {
    return this.store.listMailboxes().map(publicMailbox);
  }

  importMailboxes(input) {
    const entries = parseMailboxImport(input);
    if (!entries.length || entries.length > 5000) {
      throw Object.assign(new Error('Import requires 1-5000 records'), { statusCode: 400 });
    }
    const counts = { imported: 0, duplicates: 0, invalid: 0 };
    const results = entries.map((entry) => {
      const email = typeof entry.email === 'string' ? entry.email.replace(/\\@/g, '@').trim().toLowerCase() : '';
      if (entry.malformed || !/^[^\s@\\]+@[^\s@\\]+\.[^\s@\\]+$/.test(email)
          || typeof entry.password !== 'string' || !entry.password.length) {
        counts.invalid += 1;
        return { line: entry.line, status: 'invalid', reason: 'Invalid email, password or record format' };
      }
      if (this.store.findMailboxByEmail(email)) {
        counts.duplicates += 1;
        return { line: entry.line, email, status: 'duplicate' };
      }
      this.addMailbox({ email, password: entry.password });
      counts.imported += 1;
      return { line: entry.line, email, status: 'imported' };
    });
    return { counts, results };
  }

  recoverAfterRestart() {
    const recovered = { mailboxes: 0, aliases: 0 };
    for (const mailbox of this.store.listMailboxes()) {
      if (mailbox.state === MAILBOX_STATES.CLOSED) continue;
      this.store.transitionMailbox(mailbox.id, MAILBOX_EVENTS.CLOSE, {
        lastError: 'session closed during process restart',
      });
      recovered.mailboxes += 1;
    }
    for (const alias of this.store.listAliases({ states: [ALIAS_STATES.CREATING, ALIAS_STATES.DELETING] })) {
      const event = alias.state === ALIAS_STATES.CREATING
        ? ALIAS_EVENTS.CREATE_RESULT_UNKNOWN
        : ALIAS_EVENTS.DELETE_RESULT_UNKNOWN;
      this.store.transitionAlias(alias.id, event, {
        lastError: 'remote result requires reconciliation after process restart',
        detail: 'process_restart',
      });
      if (alias.state === ALIAS_STATES.CREATING) this.store.markAliasDomainUsage(alias.id, 'uncertain');
      recovered.aliases += 1;
    }
    return recovered;
  }

  loadMailboxCredentials(id) {
    const mailbox = this.store.getMailbox(id);
    if (!mailbox) throw Object.assign(new Error('mailbox not found'), { code: 'MAILBOX_NOT_FOUND' });
    return {
      id: mailbox.id,
      email: mailbox.email,
      password: this.secretBox.open(mailbox.encrypted_password),
    };
  }

  async openMailbox(id) {
    const pending = this.mailboxOpenings.get(id);
    if (pending) return pending;
    const operation = this.openMailboxOnce(id)
      .finally(() => {
        if (this.mailboxOpenings.get(id) === operation) this.mailboxOpenings.delete(id);
      });
    this.mailboxOpenings.set(id, operation);
    return operation;
  }

  async openMailboxOnce(id) {
    const current = this.store.getMailbox(id);
    if (!current) return null;
    if (current.state === MAILBOX_STATES.READY) return publicMailbox(current);
    this.store.transitionMailbox(id, MAILBOX_EVENTS.OPEN);
    try {
      await this.adapter.open(this.loadMailboxCredentials(id));
      return publicMailbox(this.store.transitionMailbox(id, MAILBOX_EVENTS.OPENED));
    } catch (error) {
      const event = isLoginFailure(error) ? MAILBOX_EVENTS.LOGIN_REJECTED : MAILBOX_EVENTS.OPERATION_FAILED;
      this.store.transitionMailbox(id, event, { lastError: String(error?.message || error).slice(0, 500) });
      throw error;
    }
  }

  needsMailboxSessionMaintenance(id, at = this.clock()) {
    const mailbox = this.store.getMailbox(id);
    return mailbox?.state === MAILBOX_STATES.READY
      && this.adapter.needsMaintenance(id, at);
  }

  async maintainMailboxSession(id) {
    const pending = this.mailboxOpenings.get(id);
    if (pending) return pending;
    const operation = this.maintainMailboxSessionOnce(id)
      .finally(() => {
        if (this.mailboxOpenings.get(id) === operation) this.mailboxOpenings.delete(id);
      });
    this.mailboxOpenings.set(id, operation);
    return operation;
  }

  async maintainMailboxSessionOnce(id) {
    const current = this.store.getMailbox(id);
    if (!current) return null;
    if (current.state !== MAILBOX_STATES.READY) {
      throw new Error('mailbox session is not ready for maintenance');
    }
    this.store.transitionMailbox(id, MAILBOX_EVENTS.RENEW);
    try {
      await this.adapter.maintain(this.loadMailboxCredentials(id));
      return publicMailbox(this.store.transitionMailbox(id, MAILBOX_EVENTS.OPENED));
    } catch (error) {
      const event = isLoginFailure(error) ? MAILBOX_EVENTS.LOGIN_REJECTED : MAILBOX_EVENTS.OPERATION_FAILED;
      this.store.transitionMailbox(id, event, { lastError: String(error?.message || error).slice(0, 500) });
      throw error;
    }
  }

  async ensureMailboxReady(id) {
    const mailbox = this.store.getMailbox(id);
    if (!mailbox) throw Object.assign(new Error('mailbox not found'), { code: 'MAILBOX_NOT_FOUND' });
    if (mailbox.state === MAILBOX_STATES.READY) return publicMailbox(mailbox);
    return this.openMailbox(id);
  }

  async closeMailbox(id) {
    const current = this.store.getMailbox(id);
    if (!current) return null;
    if (current.state === MAILBOX_STATES.CLOSED) return publicMailbox(current);
    await this.adapter.close(id);
    return publicMailbox(this.store.transitionMailbox(id, MAILBOX_EVENTS.CLOSE));
  }

  async syncMailbox(id) {
    const current = this.store.getMailbox(id);
    if (!current) return null;
    if (current.state !== MAILBOX_STATES.READY) throw new Error('mailbox session is not ready');
    const credentials = this.loadMailboxCredentials(id);
    const [domains, aliases] = await Promise.all([
      this.adapter.listDomains(credentials),
      this.adapter.listAliases(credentials),
    ]);
    this.store.replaceDomains(id, domains);
    this.store.mergeRemoteDomains(domains);
    for (const alias of aliases) {
      this.store.discoverAlias({ mailboxId: id, email: alias.address });
    }
    this.store.updateRemoteAliasCount(id, aliases.length);
    return {
      mailbox: publicMailbox(this.store.getMailbox(id)),
      domains: this.store.listCatalogDomains(),
      domainCounts: this.store.domainCatalogCounts(),
      remoteAliases: aliases,
    };
  }

  listDomains() {
    return this.store.listCatalogDomains();
  }

  setDomainKind(_mailboxId, domain, kind) {
    if (!['hidden', 'explicit', 'blacklist'].includes(kind)) throw new Error('invalid domain kind');
    return this.store.setCatalogDomainKind(domain, kind);
  }

  importDomainCatalog(domains, source = 'legacy_3100') {
    if (!Array.isArray(domains) || !domains.length) throw new Error('domain catalog is required');
    return this.store.importDomainCatalog(domains, { source });
  }

  listAliases(mailboxId) {
    return this.store.listAliases({ mailboxId }).map((alias) => ({ ...alias, token_hash: alias.token_hash ? '[stored-hash]' : null }));
  }

  async createBatch(mailboxId, count, options = {}) {
    const previous = this.creationQueues.get(mailboxId) || Promise.resolve();
    const operation = previous.catch(() => {}).then(() => this.createBatchOnce(mailboxId, count, options));
    this.creationQueues.set(mailboxId, operation);
    operation.finally(() => {
      if (this.creationQueues.get(mailboxId) === operation) this.creationQueues.delete(mailboxId);
    }).catch(() => {});
    return operation;
  }

  async createBatchOnce(mailboxId, count, options = {}) {
    const requested = Number(count);
    if (!Number.isInteger(requested) || requested < 1 || requested > this.maxAliases) {
      throw new Error(`count must be between 1 and ${this.maxAliases}`);
    }
    this.store.assertMailboxCreationAllowed(mailboxId);
    const synced = await this.syncMailbox(mailboxId);
    this.store.assertMailboxCreationAllowed(mailboxId);
    const remaining = this.maxAliases - synced.remoteAliases.length;
    if (requested > remaining) throw new Error(`mailbox only has ${remaining} split-mailbox slots available`);
    const domains = this.store.listCatalogDomains({ kind: 'hidden' });
    if (!domains.length) throw new Error('mailbox has no available hidden suffixes');
    const domainNames = domains.map((item) => item.domain);
    const hourlyCapacity = this.store.availableAliasDomainCapacity(domainNames);
    if (requested > hourlyCapacity) {
      throw new Error(`hidden suffix hourly capacity is ${hourlyCapacity}; each suffix allows at most 3 creations per hour`);
    }

    const mailbox = this.loadMailboxCredentials(mailboxId);
    const results = [];
    let confirmedCount = synced.remoteAliases.length;
    for (let index = 0; index < requested; index += 1) {
      const alias = this.store.createAliasWithDomainLimit({
        id: randomUUID(),
        mailboxId,
        localPart: randomLocalPart(),
        domains: domainNames,
      });
      const email = alias.email;
      if (options.owner || options.jobId) this.rebindStore.claimAlias(alias, options);
      try {
        await this.adapter.createAlias(mailbox, email);
        this.store.transitionAlias(alias.id, ALIAS_EVENTS.CREATE_CONFIRMED);
        this.store.markAliasDomainUsage(alias.id, 'confirmed');
        const token = issueToken();
        const exportedAt = new Date(this.clock()).toISOString();
        const exported = this.store.transitionAlias(alias.id, ALIAS_EVENTS.EXPORT, {
          tokenHash: hashToken(token),
          exportedAt,
        });
        confirmedCount += 1;
        results.push({
          ok: true,
          alias: { ...exported, token_hash: '[stored-hash]' },
          token,
          webApi: `${this.publicBaseUrl}/m/${token}`,
          exportLine: `${email}----${this.publicBaseUrl}/m/${token}`,
        });
      } catch (error) {
        const event = error instanceof RemoteOutcomeUnknownError
          ? ALIAS_EVENTS.CREATE_RESULT_UNKNOWN
          : ALIAS_EVENTS.CREATE_FAILED;
        const failed = this.store.transitionAlias(alias.id, event, {
          lastError: String(error?.message || error).slice(0, 500),
        });
        this.store.markAliasDomainUsage(
          alias.id,
          error instanceof RemoteOutcomeUnknownError ? 'uncertain' : 'released',
        );
        results.push({ ok: false, alias: failed, error: failed.last_error, code: error.code });
        if (failed.state === ALIAS_STATES.CREATE_FAILED && error.code === 'MAIL_COM_ALIAS_CREATE_CONFLICT') {
          this.store.markMailboxCreationBlocked(mailboxId);
          break;
        }
      }
    }
    this.store.updateRemoteAliasCount(mailboxId, confirmedCount);
    return results;
  }

  async clearRemoteAliases(mailboxId) {
    await this.ensureMailboxReady(mailboxId);
    const synced = await this.syncMailbox(mailboxId);
    const results = [];
    for (const remote of synced.remoteAliases) {
      const alias = this.store.findAliasByMailboxEmail(mailboxId, remote.address);
      if (!alias) throw new Error(`remote alias was not discovered: ${remote.address}`);
      try {
        const released = await this.releaseAlias(alias.id, 'clear_remote_aliases');
        results.push({ email: alias.email, state: released.state, error: released.last_error || '' });
      } catch (error) {
        results.push({ email: alias.email, state: 'failed', error: String(error?.message || error) });
      }
    }
    return {
      requested: synced.remoteAliases.length,
      deleted: results.filter((item) => item.state === ALIAS_STATES.DELETED).length,
      failed: results.filter((item) => item.state !== ALIAS_STATES.DELETED).length,
      results,
    };
  }

  async accessPublicToken(token) {
    const alias = this.store.findAliasByTokenHash(hashToken(token));
    if (!alias) {
      return this.icMailboxService
        ? this.icMailboxService.accessPublicToken(token)
        : { found: false, code: null };
    }
    if (!isAliasPubliclyReadable(alias.state)) return { found: false, code: null };
    if (this.isAliasClaimed(alias.id)) return { found: false, code: null };
    const accessedAt = new Date(this.clock()).toISOString();
    const accessFields = { lastAccessedAt: accessedAt };
    if (!alias.first_accessed_at) accessFields.firstAccessedAt = accessedAt;
    const active = alias.state === ALIAS_STATES.EXPORTED
      ? this.store.transitionAlias(alias.id, ALIAS_EVENTS.ACCESS, accessFields)
      : this.store.touchAliasAccess(alias.id, accessFields);

    await this.ensureMailboxReady(active.mailbox_id);
    await this.poller.refresh(active.mailbox_id);
    const otp = this.store.latestOtp(active.id);
    if (!otp) return { found: true, code: null };

    const current = this.store.getAlias(active.id);
    if (current.state === ALIAS_STATES.ACTIVE) {
      const deliveredAt = new Date(this.clock()).toISOString();
      this.store.transitionAlias(current.id, ALIAS_EVENTS.CODE_DELIVERED, {
        deliveredAt,
        releaseAfter: new Date(this.clock() + this.deliveredRetentionMs).toISOString(),
      });
    }
    this.store.markOtpDelivered(otp.id);
    return { found: true, code: otp.code };
  }

  isAliasClaimed(aliasId) {
    if (!this.store.db) return false;
    return Boolean(this.store.db.prepare('SELECT 1 FROM rebind_alias_claims WHERE alias_id = ? AND released_at IS NULL').get(aliasId));
  }

  async readInternalCode(aliasId, issuedAfter, { jobId } = {}) {
    const baseline = Date.parse(issuedAfter);
    if (!Number.isFinite(baseline)) throw new Error('valid issuedAfter is required');
    const claim = this.store.db.prepare('SELECT * FROM rebind_alias_claims WHERE alias_id = ? AND released_at IS NULL').get(aliasId);
    if (!claim || claim.job_id !== jobId) throw new Error('alias claim mismatch');
    const alias = this.store.getAlias(aliasId);
    if (alias.state === ALIAS_STATES.EXPORTED) {
      const accessedAt = new Date(this.clock()).toISOString();
      this.store.transitionAlias(aliasId, ALIAS_EVENTS.ACCESS, {
        firstAccessedAt: accessedAt, lastAccessedAt: accessedAt,
      });
    }
    await this.ensureMailboxReady(alias.mailbox_id);
    await this.poller.refresh(alias.mailbox_id);
    const otp = this.store.db.prepare(`SELECT * FROM otp_messages WHERE alias_id = ?
      AND julianday(received_at) >= julianday(?) AND julianday(first_seen_at) >= julianday(?)
      AND delivered_count = 0 ORDER BY received_at DESC, id DESC LIMIT 1`)
      .get(aliasId, new Date(Math.floor(baseline / 1000) * 1000).toISOString(), new Date(baseline).toISOString());
    if (!otp) return null;
    this.store.markOtpDelivered(otp.id);
    return otp.code;
  }

  async releaseAlias(aliasId, detail = 'manual_release', { owner, jobId } = {}) {
    const claim = this.store.db.prepare('SELECT * FROM rebind_alias_claims WHERE alias_id = ? AND released_at IS NULL').get(aliasId);
    if (claim) {
      const job = this.rebindStore.getJob(claim.job_id);
      if (owner !== claim.owner || jobId !== claim.job_id || !job?.encrypted_result
          || !['cleanup_pending', 'completed'].includes(job.state)) {
        throw Object.assign(new Error('alias is claimed by a rebind job'), { code: 'ALIAS_CLAIMED', statusCode: 409 });
      }
    }
    let alias = this.store.getAlias(aliasId);
    if (!alias) return null;
    if (releasableStates.includes(alias.state)) {
      alias = this.store.transitionAlias(alias.id, ALIAS_EVENTS.RELEASE, { detail });
    }
    if (alias.state === ALIAS_STATES.DELETE_FAILED) {
      alias = this.store.transitionAlias(alias.id, ALIAS_EVENTS.RETRY_DELETE, { detail });
    } else if (alias.state === ALIAS_STATES.RELEASE_PENDING) {
      alias = this.store.transitionAlias(alias.id, ALIAS_EVENTS.START_DELETE, { detail });
    }
    if (alias.state !== ALIAS_STATES.DELETING) return alias;

    try {
      await this.ensureMailboxReady(alias.mailbox_id);
      await this.adapter.deleteAlias(this.loadMailboxCredentials(alias.mailbox_id), alias.email);
      const deleted = this.store.transitionAlias(alias.id, ALIAS_EVENTS.DELETE_CONFIRMED, {
        deletedAt: new Date(this.clock()).toISOString(),
      });
      const mailbox = this.store.getMailbox(alias.mailbox_id);
      this.store.updateRemoteAliasCount(alias.mailbox_id, Math.max(0, mailbox.remote_alias_count - 1));
      return deleted;
    } catch (error) {
      const event = error instanceof RemoteOutcomeUnknownError
        ? ALIAS_EVENTS.DELETE_RESULT_UNKNOWN
        : ALIAS_EVENTS.DELETE_FAILED;
      return this.store.transitionAlias(alias.id, event, {
        lastError: String(error?.message || error).slice(0, 500),
      });
    }
  }

  async reconcileAlias(aliasId) {
    let alias = this.store.getAlias(aliasId);
    if (!alias) return null;
    if (![ALIAS_STATES.CREATE_UNKNOWN, ALIAS_STATES.DELETE_UNKNOWN].includes(alias.state)) {
      throw new Error('alias does not require reconciliation');
    }
    await this.ensureMailboxReady(alias.mailbox_id);
    const exists = await this.adapter.aliasExists(
      this.loadMailboxCredentials(alias.mailbox_id),
      alias.email,
    );
    if (alias.state === ALIAS_STATES.CREATE_UNKNOWN) {
      alias = this.store.transitionAlias(
        alias.id,
        exists ? ALIAS_EVENTS.RECONCILE_PRESENT : ALIAS_EVENTS.RECONCILE_ABSENT,
        { detail: 'remote_reconciliation' },
      );
      if (!exists) return { alias, token: null, exportLine: null };
      const token = issueToken();
      alias = this.store.transitionAlias(alias.id, ALIAS_EVENTS.EXPORT, {
        tokenHash: hashToken(token),
        exportedAt: new Date(this.clock()).toISOString(),
        detail: 'export_after_reconciliation',
      });
      const mailbox = this.store.getMailbox(alias.mailbox_id);
      this.store.updateRemoteAliasCount(alias.mailbox_id, mailbox.remote_alias_count + 1);
      return {
        alias: { ...alias, token_hash: '[stored-hash]' },
        token,
        exportLine: `${alias.email}----${this.publicBaseUrl}/m/${token}`,
      };
    }

    alias = this.store.transitionAlias(
      alias.id,
      exists ? ALIAS_EVENTS.RECONCILE_PRESENT : ALIAS_EVENTS.RECONCILE_ABSENT,
      {
        detail: 'remote_reconciliation',
        ...(exists ? {} : { deletedAt: new Date(this.clock()).toISOString() }),
      },
    );
    if (!exists) {
      const mailbox = this.store.getMailbox(alias.mailbox_id);
      this.store.updateRemoteAliasCount(alias.mailbox_id, Math.max(0, mailbox.remote_alias_count - 1));
    }
    return { alias, token: null, exportLine: null };
  }
}

module.exports = { GatewayService, publicMailbox, randomLocalPart };
