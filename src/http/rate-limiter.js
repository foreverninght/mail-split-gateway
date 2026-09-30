'use strict';

class FixedWindowRateLimiter {
  constructor({ limit = 40, windowMs = 60000, clock = Date.now } = {}) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.clock = clock;
    this.entries = new Map();
  }

  allow(key) {
    const now = this.clock();
    if (this.entries.size > 10000) {
      for (const [entryKey, entry] of this.entries) {
        if (entry.resetAt <= now) this.entries.delete(entryKey);
      }
    }
    const current = this.entries.get(key);
    if (!current || current.resetAt <= now) {
      this.entries.set(key, { count: 1, resetAt: now + this.windowMs });
      return true;
    }
    current.count += 1;
    return current.count <= this.limit;
  }
}

module.exports = { FixedWindowRateLimiter };
