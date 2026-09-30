'use strict';

const { normalizeProxy, maskProxy, proxyFingerprint } = require('../registration/store');
const DEFAULT_PROXY_REFRESH_MS = 30 * 60 * 1000;
const STATUSES = ['available', 'reserved', 'consumed', 'quarantined'];

function invalid(message, code = 'INVALID_PROXY_LIST') {
  return Object.assign(new Error(message), { code, statusCode: 400 });
}

class RebindProxyStore {
  constructor({ db, secretBox, clock, transaction, proxyRefreshMs = DEFAULT_PROXY_REFRESH_MS }) {
    if (!Number.isFinite(proxyRefreshMs) || proxyRefreshMs <= 0) throw new TypeError('proxyRefreshMs must be positive');
    Object.assign(this, { db, secretBox, clock, transaction, proxyRefreshMs });
    db.exec(`CREATE TABLE IF NOT EXISTS rebind_proxy_pool (
      id INTEGER PRIMARY KEY AUTOINCREMENT, fingerprint TEXT NOT NULL UNIQUE,
      encrypted_endpoint TEXT NOT NULL, masked_endpoint TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1, status TEXT NOT NULL DEFAULT 'available'
        CHECK(status IN ('available','reserved','consumed','quarantined')),
      job_id TEXT REFERENCES rebind_jobs(id), imported_at TEXT NOT NULL,
      reserved_at TEXT, consumed_at TEXT, allocation_order INTEGER NOT NULL DEFAULT 0
    )`);
  }

  refresh() {
    this.db.prepare(`UPDATE rebind_proxy_pool SET status = 'available', job_id = NULL
      WHERE active = 1 AND status = 'consumed' AND consumed_at <= ?`)
      .run(new Date(this.clock() - this.proxyRefreshMs).toISOString());
  }

  importProxies(values, { mode = 'replace' } = {}) {
    if (mode !== 'replace') throw invalid('only replace proxy import mode is supported', 'INVALID_PROXY_MODE');
    if (!Array.isArray(values) && typeof values !== 'string') throw invalid('proxy list must be text or an array');
    const inputs = Array.isArray(values) ? values : values.split(/\r?\n|\s+/);
    const entries = new Map();
    let duplicates = 0;
    for (let index = 0; index < inputs.length; index += 1) {
      if (typeof inputs[index] !== 'string') throw invalid(`invalid proxy at entry ${index + 1}`);
      if (!inputs[index].trim()) continue;
      try {
        const endpoint = normalizeProxy(inputs[index], { convertSupplierUrl: true });
        if (!/^https?:\/\//i.test(endpoint)) {
          const [host, port] = endpoint.split(':');
          if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535 || /[\s/@?#]/.test(host)) throw new Error('invalid endpoint');
          new URL(`http://${host}:${port}`);
        }
        const masked = maskProxy(endpoint);
        const fingerprint = proxyFingerprint(endpoint);
        if (entries.has(fingerprint)) duplicates += 1;
        else entries.set(fingerprint, { encrypted: this.secretBox.seal(endpoint), masked });
      } catch {
        throw invalid(`invalid proxy at entry ${index + 1}`);
      }
    }
    if (!entries.size) throw invalid('proxy list must not be empty', 'EMPTY_PROXY_LIST');
    const result = this.transaction(() => {
      const previous = this.db.prepare('SELECT fingerprint, active FROM rebind_proxy_pool').all();
      const known = new Map(previous.map((row) => [row.fingerprint, row.active]));
      this.db.prepare('UPDATE rebind_proxy_pool SET active = 0').run();
      const upsert = this.db.prepare(`INSERT INTO rebind_proxy_pool
        (fingerprint, encrypted_endpoint, masked_endpoint, imported_at) VALUES (?, ?, ?, ?)
        ON CONFLICT(fingerprint) DO UPDATE SET active = 1,
          encrypted_endpoint = excluded.encrypted_endpoint, masked_endpoint = excluded.masked_endpoint`);
      const now = new Date(this.clock()).toISOString();
      for (const [fingerprint, entry] of entries) upsert.run(fingerprint, entry.encrypted, entry.masked, now);
      const added = [...entries.keys()].filter((key) => !known.has(key)).length;
      const restored = [...entries.keys()].filter((key) => known.get(key) === 0).length;
      return { mode, replaced: true, added, restored, retained: entries.size - added - restored,
        removed: previous.filter((row) => row.active && !entries.has(row.fingerprint)).length,
        duplicates, invalid: 0 };
    });
    const { stats } = this.overview();
    return { ...result, current: stats.total, stats };
  }

  reserve(jobId) {
    this.refresh();
    const row = this.db.prepare(`SELECT * FROM rebind_proxy_pool WHERE active = 1 AND status = 'available'
      ORDER BY allocation_order, id LIMIT 1`).get();
    if (!row) throw Object.assign(new Error('rebind proxy pool is exhausted'), { code: 'REBIND_PROXY_POOL_EXHAUSTED', statusCode: 409 });
    this.db.prepare(`UPDATE rebind_proxy_pool SET status = 'reserved', job_id = ?, reserved_at = ?,
      allocation_order = (SELECT COALESCE(MAX(allocation_order), 0) + 1 FROM rebind_proxy_pool)
      WHERE id = ? AND status = 'available'`).run(jobId, new Date(this.clock()).toISOString(), row.id);
    return row;
  }

  finish(jobId, status, proxyId) {
    if (!['available', 'consumed', 'quarantined'].includes(status)) throw new Error('invalid proxy finish status');
    this.db.prepare(`UPDATE rebind_proxy_pool SET status = ?,
      job_id = CASE WHEN ? = 'available' THEN NULL ELSE job_id END,
      consumed_at = CASE WHEN ? = 'consumed' THEN ? ELSE consumed_at END
      WHERE job_id = ? AND status = 'reserved'${proxyId === undefined ? '' : ' AND id = ?'}`)
      .run(status, status, status, new Date(this.clock()).toISOString(), jobId, ...(proxyId === undefined ? [] : [proxyId]));
  }

  overview({ page = 1, limit = 50, status, q = '' } = {}) {
    this.refresh();
    if (status && !STATUSES.includes(status)) throw invalid('invalid proxy status', 'INVALID_PROXY_STATUS');
    const stats = { total: 0, available: 0, reserved: 0, consumed: 0, quarantined: 0 };
    for (const row of this.db.prepare('SELECT status, COUNT(*) AS n FROM rebind_proxy_pool WHERE active = 1 GROUP BY status').all()) {
      stats[row.status] = Number(row.n);
      stats.total += Number(row.n);
    }
    const where = 'active = 1' + (status ? ' AND status = ?' : '')
      + (q ? " AND (instr(lower(masked_endpoint), lower(?)) > 0 OR instr(lower(COALESCE(job_id, '')), lower(?)) > 0)" : '');
    const params = [...(status ? [status] : []), ...(q ? [String(q), String(q)] : [])];
    const total = Number(this.db.prepare(`SELECT COUNT(*) AS n FROM rebind_proxy_pool WHERE ${where}`).get(...params).n);
    const pageSize = Math.min(100, Math.max(1, Math.floor(Number(limit)) || 50));
    const pages = Math.max(1, Math.ceil(total / pageSize));
    const currentPage = Math.min(pages, Math.max(1, Math.floor(Number(page)) || 1));
    const proxies = this.db.prepare(`SELECT id, masked_endpoint, status, job_id, imported_at, reserved_at, consumed_at
      FROM rebind_proxy_pool WHERE ${where} ORDER BY id DESC LIMIT ? OFFSET ?`).all(...params, pageSize, (currentPage - 1) * pageSize)
      .map((row) => ({ ...row, cooldown_until: row.status === 'consumed' && row.consumed_at ? new Date(Date.parse(row.consumed_at) + this.proxyRefreshMs).toISOString() : null }));
    return { stats, proxies, pagination: { page: currentPage, limit: pageSize, total, pages }, cooldownMs: this.proxyRefreshMs };
  }
}

module.exports = { RebindProxyStore, DEFAULT_PROXY_REFRESH_MS };
