'use strict';
const { RecoveryStore, problem } = require('./recovery-store');
class RecoveryService {
  constructor({ parent }) {
    this.parent = parent; this.store = parent.store; this.worker = parent.worker;
    this.records = new RecoveryStore({ store: this.store }); this.running = new Map(); this.closed = false;
  }
  start(id, options = {}) {
    if (this.closed) throw problem('RECOVERY_SERVICE_CLOSED', 503);
    const row = this.records.request(id, { ...options, workerAvailable: typeof this.worker?.runRecovery === 'function' });
    if (row?.state === 'queued' && !this.running.has(row.id)) {
      const operation = Promise.resolve().then(() => this.run(row.id));
      this.running.set(row.id, operation);
      operation.finally(() => this.running.delete(row.id)).catch(() => {});
    }
    return row;
  }
  async run(id) {
    const row = this.records.row(id);
    if (row?.state !== 'queued') return;
    let started = false, returned = false;
    try {
      if (this.closed) throw problem('RECOVERY_INTERRUPTED');
      const context = this.records.context(row.job_id);
      this.records.assertLease(row);
      const proxy = this.store.secretBox.open(row.encrypted_proxy);
      const claim = this.store.db.prepare("UPDATE rebind_recovery_attempts SET state = 'running', started_at = ?, encrypted_context = ? WHERE id = ? AND state = 'queued'").run(this.records.now(), this.store.secretBox.seal(JSON.stringify(context)), id);
      if (!claim.changes) return;
      started = true;
      const result = await this.worker.runRecovery({ credentials: context.credentials, newEmail: context.job.new_email,
        expectedAccountId: context.expectedAccountId, proxy, timeoutMs: Math.min(this.worker.timeoutMs || 180000, 180000),
        onStage: () => { if (this.closed || this.records.row(id)?.state !== 'running') throw problem('RECOVERY_INTERRUPTED'); this.records.context(row.job_id); } });
      returned = true;
      this.records.persistReconciledResult(row.job_id, id, result);
    } catch (error) {
      this.store.transaction(() => {
        this.records.fail(id, error.code === 'ABORTED' ? problem('RECOVERY_INTERRUPTED') : error);
        if (['WORKER_START_FAILED', 'INVALID_INPUT'].includes(error.code)) this.store.db.prepare('UPDATE rebind_recovery_attempts SET started_at = NULL WHERE id = ?').run(id);
        if (row.proxy_id !== null) this.store.proxyPool.finish(row.job_id,
          returned ? 'consumed' : !started || ['WORKER_START_FAILED', 'INVALID_INPUT'].includes(error.code) ? 'available' : 'quarantined', row.proxy_id);
      });
    }
    if (this.store.getJob(row.job_id)?.encrypted_result) await this.parent.finishVerified(row.job_id);
    else if (!this.closed && row.mode === 'automatic') this.start(row.job_id, { automatic: true });
  }
  recoverAfterRestart() {
    const ids = this.store.transaction(() => {
      const rows = this.store.db.prepare("SELECT * FROM rebind_recovery_attempts WHERE state IN ('queued','running')").all();
      for (const row of rows) {
        this.records.fail(row.id, problem('RECOVERY_INTERRUPTED'));
        if (row.proxy_id !== null) this.store.proxyPool.finish(row.job_id, row.state === 'running' ? 'quarantined' : 'available', row.proxy_id);
      }
      return this.store.db.prepare('SELECT DISTINCT job_id FROM rebind_recovery_attempts').all().map((r) => r.job_id);
    });
    for (const id of ids) this.start(id, { automatic: true });
    return ids.length;
  }
  async waitForIdle() { while (this.running.size) await Promise.all([...this.running.values()]); }
}
module.exports = { RecoveryService };
