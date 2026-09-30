'use strict';

const { MAILBOX_STATES } = require('../domain/state-machine');

class SessionMaintenanceScheduler {
  constructor({
    store,
    service,
    intervalMs = 30000,
    clock = Date.now,
    logger = console,
  }) {
    this.store = store;
    this.service = service;
    this.intervalMs = intervalMs;
    this.clock = clock;
    this.logger = logger;
    this.timer = null;
    this.running = null;
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(
      () => this.run().catch((error) => this.logger.error('session maintenance failed', error)),
      this.intervalMs,
    );
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
    const ready = this.store.listMailboxes()
      .filter((mailbox) => mailbox.state === MAILBOX_STATES.READY);
    const due = ready.filter((mailbox) => (
      this.service.needsMailboxSessionMaintenance(mailbox.id, this.clock())
    ));
    const results = [];
    for (const mailbox of due) {
      try {
        results.push(await this.service.maintainMailboxSession(mailbox.id));
      } catch (error) {
        this.logger.error(`failed to maintain mailbox session ${mailbox.id}`, error);
      }
    }
    return { scanned: ready.length, due: due.length, results };
  }
}

module.exports = { SessionMaintenanceScheduler };
