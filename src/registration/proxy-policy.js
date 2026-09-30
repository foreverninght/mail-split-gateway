'use strict';

// The public registration service preflights every supplied proxy. A single
// proxy per mailbox is too likely to be rejected, so each mailbox receives a
// fixed set of twenty registration proxies.
const REGISTRATION_PROXIES_PER_MAILBOX = 20;
const MIN_REGISTRATION_PROXIES_PER_MAILBOX = 1;
const MAX_REGISTRATION_PROXIES_PER_MAILBOX = 100;

module.exports = {
  REGISTRATION_PROXIES_PER_MAILBOX,
  MIN_REGISTRATION_PROXIES_PER_MAILBOX,
  MAX_REGISTRATION_PROXIES_PER_MAILBOX,
};
