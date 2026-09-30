'use strict';

const { createCipheriv, createDecipheriv, randomBytes } = require('node:crypto');

function decodeMasterKey(value) {
  const key = Buffer.from(String(value || ''), 'base64');
  if (key.length !== 32) throw new Error('MAIL_GATEWAY_MASTER_KEY must be a base64-encoded 32-byte key');
  return key;
}

class SecretBox {
  constructor(masterKey) {
    this.key = decodeMasterKey(masterKey);
  }

  seal(plaintext) {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const ciphertext = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return ['v1', iv, tag, ciphertext].map((part) => Buffer.isBuffer(part) ? part.toString('base64url') : part).join('.');
  }

  open(sealed) {
    const [version, ivRaw, tagRaw, ciphertextRaw] = String(sealed || '').split('.');
    if (version !== 'v1' || !ivRaw || !tagRaw || !ciphertextRaw) throw new Error('encrypted secret has an invalid format');
    const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(ivRaw, 'base64url'));
    decipher.setAuthTag(Buffer.from(tagRaw, 'base64url'));
    return Buffer.concat([
      decipher.update(Buffer.from(ciphertextRaw, 'base64url')),
      decipher.final(),
    ]).toString('utf8');
  }
}

module.exports = { SecretBox, decodeMasterKey };
