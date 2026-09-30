'use strict';

const { createHash, randomBytes, timingSafeEqual } = require('node:crypto');

function issueToken() {
  return randomBytes(32).toString('base64url');
}

function hashToken(token) {
  return createHash('sha256').update(String(token || ''), 'utf8').digest('hex');
}

function verifyApiKey(actual, expected) {
  const left = Buffer.from(String(actual || ''), 'utf8');
  const right = Buffer.from(String(expected || ''), 'utf8');
  return left.length === right.length && left.length > 0 && timingSafeEqual(left, right);
}

module.exports = { hashToken, issueToken, verifyApiKey };
