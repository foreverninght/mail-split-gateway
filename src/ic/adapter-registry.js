'use strict';

class IcAdapterRegistry {
  constructor() {
    this.adapters = new Map();
  }

  register(hostname, adapter) {
    const key = String(hostname || '').trim().toLowerCase();
    if (!key || !adapter?.key || typeof adapter.fetchCode !== 'function' || typeof adapter.validateUrl !== 'function') {
      throw new TypeError('hostname and a complete IC adapter are required');
    }
    if (this.adapters.has(key)) throw new Error(`IC adapter already registered for ${key}`);
    this.adapters.set(key, adapter);
    return this;
  }

  resolveUrl(value) {
    let url;
    try { url = new URL(String(value || '')); } catch { throw new Error('valid IC pickup URL is required'); }
    const hostname = url.hostname.toLowerCase();
    const adapter = this.adapters.get(hostname);
    if (!adapter) {
      const error = new Error(`unsupported IC pickup hostname: ${hostname || '(empty)'}`);
      error.code = 'IC_PROVIDER_UNSUPPORTED';
      error.statusCode = 400;
      throw error;
    }
    return { adapter, hostname };
  }

  get(hostname, adapterKey) {
    const adapter = this.adapters.get(String(hostname || '').toLowerCase());
    return adapter?.key === adapterKey ? adapter : null;
  }
}

module.exports = { IcAdapterRegistry };
