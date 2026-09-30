'use strict';

const { createHmac } = require('node:crypto');

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function decodeBase32(value) {
  const normalized = String(value || '').toUpperCase().replace(/[\s=-]/g, '');
  if (!normalized) throw new Error('TOTP secret is empty');
  let bits = '';
  for (const character of normalized) {
    const index = BASE32.indexOf(character);
    if (index < 0) throw new Error('invalid base32 TOTP secret');
    bits += index.toString(2).padStart(5, '0');
  }
  const bytes = [];
  for (let index = 0; index + 8 <= bits.length; index += 8) {
    bytes.push(Number.parseInt(bits.slice(index, index + 8), 2));
  }
  return Buffer.from(bytes);
}

function generateTotp(secret, { now = Date.now(), period = 30, digits = 6 } = {}) {
  const counter = Math.floor(now / 1000 / period);
  const counterBytes = Buffer.alloc(8);
  counterBytes.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac('sha1', decodeBase32(secret)).update(counterBytes).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary = (digest.readUInt32BE(offset) & 0x7fffffff) % (10 ** digits);
  return String(binary).padStart(digits, '0');
}

module.exports = { decodeBase32, generateTotp };
