'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { SecretBox } = require('../src/security/secret-box');

test('secret box encrypts mailbox passwords with authenticated encryption', () => {
  const box = new SecretBox(Buffer.alloc(32, 3).toString('base64'));
  const sealed = box.seal('correct horse battery staple');
  assert.notEqual(sealed, 'correct horse battery staple');
  assert.equal(box.open(sealed), 'correct horse battery staple');
  const parts = sealed.split('.');
  const ciphertext = Buffer.from(parts[3], 'base64url');
  ciphertext[0] ^= 1;
  parts[3] = ciphertext.toString('base64url');
  assert.throws(() => box.open(parts.join('.')));
});
