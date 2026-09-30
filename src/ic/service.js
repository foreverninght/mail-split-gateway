'use strict';

const { hashToken, issueToken } = require('../security/tokens');

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function publicMailbox(row) {
  if (!row) return null;
  const {
    encrypted_upstream_url: _upstream,
    token_hash: _token,
    registration_baseline_code_hash: _baseline,
    ...safe
  } = row;
  return safe;
}

function parseImportLines(input) {
  const lines = String(input || '').replace(/^\ufeff/, '').split(/\r?\n/);
  if (lines.length > 5000) throw Object.assign(new Error('each IC import accepts at most 5000 lines'), { statusCode: 400 });
  return lines.map((raw, index) => {
    const line = raw.trim();
    if (!line) return null;
    const separator = line.indexOf('----');
    if (separator < 1) return { line: index + 1, status: 'invalid', error: 'expected email----pickup URL' };
    const email = normalizeEmail(line.slice(0, separator));
    const upstreamUrl = line.slice(separator + 4).trim();
    if (!EMAIL_PATTERN.test(email) || !upstreamUrl) {
      return { line: index + 1, status: 'invalid', email, error: 'invalid email or pickup URL' };
    }
    return { line: index + 1, email, upstreamUrl };
  }).filter(Boolean);
}

class IcMailboxService {
  constructor({
    store,
    secretBox,
    adapterRegistry,
    publicBaseUrl,
    registrationPickupAttempts = 3,
    registrationPickupRetryDelayMs = 500,
    sleep = (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)),
  }) {
    this.store = store;
    this.secretBox = secretBox;
    this.adapterRegistry = adapterRegistry;
    this.publicBaseUrl = String(publicBaseUrl || '').replace(/\/$/, '');
    this.registrationPickupAttempts = registrationPickupAttempts;
    this.registrationPickupRetryDelayMs = registrationPickupRetryDelayMs;
    this.sleep = sleep;
  }

  exportLine(email, token) {
    return `${email}----${this.publicBaseUrl}/m/${token}`;
  }

  listMailboxes() {
    return this.store.list().map(publicMailbox);
  }

  countAvailable(pickupHostname = '') {
    return this.store.countAvailable(pickupHostname);
  }

  allocateForRegistration(count, { pickupHostname = '' } = {}) {
    return this.store.allocate({
      count,
      pickupHostname,
      issueCredential: () => {
        const token = issueToken();
        return { token, tokenHash: hashToken(token) };
      },
    }).map((mailbox) => ({
      mailbox: publicMailbox(mailbox),
      webApi: `${this.publicBaseUrl}/m/${mailbox.token}`,
      exportLine: this.exportLine(mailbox.email, mailbox.token),
    }));
  }

  markRegistrationRunning(id) {
    return publicMailbox(this.store.markRunning(id));
  }

  markRegistrationUsed(id, detail = '') {
    return publicMailbox(this.store.markUsed(id, detail));
  }

  releaseRegistrationAllocation(id, detail = '') {
    return publicMailbox(this.store.releaseAllocation(id, detail));
  }

  async prepareRegistrationPickup(id) {
    const row = this.store.get(id);
    if (!row || row.state !== 'allocated') throw new Error('IC mailbox is not allocated for registration');
    let result;
    for (let attempt = 1; attempt <= this.registrationPickupAttempts; attempt += 1) {
      try {
        result = await this.fetchUpstream(row);
        break;
      } catch (error) {
        if (error?.code !== 'IC_UPSTREAM_NETWORK_ERROR' || attempt === this.registrationPickupAttempts) throw error;
        await this.sleep(this.registrationPickupRetryDelayMs * attempt);
      }
    }
    this.store.setRegistrationBaseline(
      id,
      result.status === 'code' && result.code ? hashToken(result.code) : null,
    );
    this.store.recordPickup(id, { status: 'pending' });
    return { status: 'ready', baseline: result.status === 'code' ? 'code_present' : 'empty' };
  }

  importMailboxes(input) {
    const parsed = parseImportLines(input);
    const results = [];
    for (const item of parsed) {
      if (item.status === 'invalid') {
        results.push(item);
        continue;
      }
      if (this.store.findByEmail(item.email)) {
        results.push({ line: item.line, email: item.email, status: 'duplicate' });
        continue;
      }
      try {
        const { adapter, hostname } = this.adapterRegistry.resolveUrl(item.upstreamUrl);
        const validatedUrl = adapter.validateUrl(item.upstreamUrl, item.email);
        const token = issueToken();
        const mailbox = this.store.create({
          email: item.email,
          encryptedUpstreamUrl: this.secretBox.seal(validatedUrl),
          pickupHostname: hostname,
          adapterKey: adapter.key,
          tokenHash: hashToken(token),
        });
        results.push({
          line: item.line,
          email: item.email,
          status: 'imported',
          mailbox: publicMailbox(mailbox),
          exportLine: this.exportLine(item.email, token),
        });
      } catch (error) {
        results.push({ line: item.line, email: item.email, status: 'invalid', error: String(error.message || error) });
      }
    }
    return {
      counts: {
        imported: results.filter((item) => item.status === 'imported').length,
        duplicates: results.filter((item) => item.status === 'duplicate').length,
        invalid: results.filter((item) => item.status === 'invalid').length,
      },
      results,
    };
  }

  rotateToken(id) {
    const current = this.store.get(id);
    if (!current) return null;
    const token = issueToken();
    const mailbox = this.store.rotateToken(id, hashToken(token));
    return { mailbox: publicMailbox(mailbox), exportLine: this.exportLine(mailbox.email, token) };
  }

  async fetchUpstream(row) {
    const adapter = this.adapterRegistry.get(row.pickup_hostname, row.adapter_key);
    if (!adapter) {
      const error = new Error(`configured IC adapter is unavailable: ${row.adapter_key}`);
      error.code = 'IC_ADAPTER_UNAVAILABLE';
      error.statusCode = 502;
      throw error;
    }
    return adapter.fetchCode({
      upstreamUrl: this.secretBox.open(row.encrypted_upstream_url),
      email: row.email,
    });
  }

  async pickup(row) {
    try {
      const result = await this.fetchUpstream(row);
      const baseline = row.registration_baseline_code_hash;
      if (baseline && ['allocated', 'running'].includes(row.state)
        && result.status === 'code' && hashToken(result.code) === baseline) {
        this.store.recordPickup(row.id, { status: 'pending' });
        return { status: 'pending', code: null };
      }
      if (baseline && result.status === 'code') this.store.clearRegistrationBaseline(row.id);
      this.store.recordPickup(row.id, { status: result.status });
      return result;
    } catch (error) {
      this.store.recordPickup(row.id, { status: 'error', error: error.message || error });
      throw error;
    }
  }

  async accessPublicToken(token) {
    const row = this.store.findByTokenHash(hashToken(token));
    if (!row) return { found: false, code: null };
    const result = await this.pickup(row);
    return { found: true, code: result.code };
  }

  async testPickup(id) {
    const row = this.store.get(id);
    if (!row) return null;
    const result = await this.pickup(row);
    return { mailbox: publicMailbox(this.store.get(id)), status: result.status, code: result.code };
  }
}

module.exports = { IcMailboxService, normalizeEmail, parseImportLines, publicMailbox };
