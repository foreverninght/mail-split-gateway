'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { decodeBase32, generateTotp } = require('../src/security/totp');

test('TOTP matches RFC 6238 SHA-1 vectors', () => {
  const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
  assert.equal(generateTotp(secret, { now: 59_000, digits: 8 }), '94287082');
  assert.equal(generateTotp(secret, { now: 1_111_111_109_000, digits: 8 }), '07081804');
  assert.equal(generateTotp(secret, { now: 2_000_000_000_000, digits: 8 }), '69279037');
  assert.throws(() => decodeBase32('INVALID!'), /invalid base32/);
});
