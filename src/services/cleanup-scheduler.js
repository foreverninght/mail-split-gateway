'use strict';

const { ALIAS_STATES } = require('../domain/state-machine');

class CleanupScheduler {
  constructor({
    store,
    service,
    intervalMs = 60000,
    unusedTtlMs = 6 * 60 * 60 * 1000,
    inactiveTtlMs = 30 * 60 * 1000,
    clock = Date.now,
    logger = console,
  }) {
    this.store = store;
    this.service = service;
    this.intervalMs = intervalMs;
    this.unusedTtlMs = unusedTtlMs;
    this.inactiveTtlMs = inactiveTtlMs;
    this.clock = clock;
    this.logger = logger;
    this.timer = null;
    this.running = null;
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.run().catch((error) => this.logger.error('cleanup failed', error)), this.intervalMs);
    this.timer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  run() {
    if (this.running) return this.running;
    this.running = this.sweep().finally(() => { this.running = null; });
    return this.running;
  }

  async sweep() {
    const now = this.clock();
    const aliases = this.store.listAliases({
      states: [
        ALIAS_STATES.EXPORTED,
        ALIAS_STATES.ACTIVE,
        ALIAS_STATES.DELIVERED,
        ALIAS_STATES.RELEASE_PENDING,
      ],
    });
    const due = aliases.filter((alias) => {
      if (this.service.isAliasClaimed?.(alias.id)) return false;
      if (alias.state === ALIAS_STATES.RELEASE_PENDING) return true;
      if (alias.state === ALIAS_STATES.DELIVERED) {
        return alias.release_after && Date.parse(alias.release_after) <= now;
      }
      if (alias.state === ALIAS_STATES.ACTIVE) {
        return alias.last_accessed_at && Date.parse(alias.last_accessed_at) + this.inactiveTtlMs <= now;
      }
      return alias.exported_at && Date.parse(alias.exported_at) + this.unusedTtlMs <= now;
    });
    const results = [];
    for (const alias of due) {
      try {
        results.push(await this.service.releaseAlias(alias.id, 'automatic_expiry'));
      } catch (error) {
        this.logger.error(`failed to release alias ${alias.id}`, error);
      }
    }
    return { scanned: aliases.length, due: due.length, results };
  }
}

module.exports = { CleanupScheduler };
