'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { parseMailboxImport } = require('../src/mailcom/mailbox-import-parser');
const { GatewayService } = require('../src/services/gateway-service');
const { GatewayStore } = require('../src/db/store');
const { SecretBox } = require('../src/security/secret-box');
const { createHttpServer } = require('../src/http/server');

test('text formats preserve password punctuation and whitespace and original line numbers', () => {
  const entries = parseMailboxImport('\ufeff\na@example.com---- p:a,ss---- \r\nb@example.com:p,ass\nc@example.com\tp:ass\nd@example.com|p,ass');
  assert.deepEqual(entries.map((r) => r.password), [' p:a,ss---- ', 'p,ass', 'p:ass', 'p,ass']);
  assert.equal(entries[0].line, 2);
});

test('CSV and JSON parse structured passwords and reject malformed documents', () => {
  const entries = parseMailboxImport('email,password\r\na@example.com," p,""q""\nrest "\r\nb@example.com,pass');
  assert.equal(entries[0].password, ' p,"q"\nrest ');
  assert.equal(entries[1].line, 4);
  assert.equal(parseMailboxImport('{"address":"a@example.com","pass":" x "}')[0].password, ' x ');
  assert.throws(() => parseMailboxImport('[invalid'), /JSON/);
  assert.throws(() => parseMailboxImport('email,password\na@example.com,"bad'), /unclosed/);
  assert.equal(parseMailboxImport('a@example.com,one,extra')[0].malformed, true);
});

test('CSV supplier data column, Chinese headers, reordered columns and Excel separator', () => {
  const supplier = parseMailboxImport('#,data\r\n1,"a@example.com| p,""q"" "\r\n2,"b@example.com|pass"');
  assert.equal(supplier.length, 2);
  assert.equal(supplier[0].email, 'a@example.com');
  assert.equal(supplier[0].password, ' p,"q" ');
  assert.equal(supplier[0].line, 2);
  assert.equal(supplier[0].malformed, false);
  const chinese = parseMailboxImport('\ufeff备注,密码,邮箱\nhello," secret ",a@example.com');
  assert.equal(chinese[0].password, ' secret ');
  assert.equal(chinese[0].email, 'a@example.com');
  assert.equal(chinese[0].malformed, false);
  const excel = parseMailboxImport('sep=;\r\npassword;email\r\npass;a@example.com');
  assert.equal(excel[0].line, 3);
  assert.equal(excel[0].password, 'pass');
  assert.throws(() => parseMailboxImport('email,email,password\na@example.com,b@example.com,pass'), /唯一/);
});

test('authenticated bulk API imports, skips duplicates, encrypts unchanged passwords and never returns secrets', async (t) => {
  const store = new GatewayStore({ filename: ':memory:' });
  t.after(() => store.close());
  const secretBox = new SecretBox(Buffer.alloc(32, 7).toString('base64'));
  const service = new GatewayService({ store, secretBox, adapter: {}, publicBaseUrl: 'http://localhost' });
  service.addMailbox({ email: 'existing@example.com', password: 'original' });
  const escaped = service.importMailboxes('escaped\\@example.com|password');
  assert.equal(escaped.counts.imported, 1);
  assert.ok(store.findMailboxByEmail('escaped@example.com'));
  const server = createHttpServer({ service, store, adminApiKey: 'test-key', publicDir: path.join(__dirname, '../public'), logger: { error() {} } });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/api/admin/mailboxes/import`;
  assert.equal((await fetch(url, { method: 'POST' })).status, 401);
  const password = ' sensitive,:---- value ';
  const body = { mailboxes: [{ email: 'A@example.com', password }, { email: 'a@example.com', password: 'replacement' }, { email: 'existing@example.com', password: 'replacement' }, { email: 'bad', password }, null, { email: 'b@example.com', password: 123 }] };
  const response = await fetch(url, { method: 'POST', headers: { 'x-api-key': 'test-key', 'content-type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.deepEqual(result.counts, { imported: 1, duplicates: 2, invalid: 3 });
  assert.equal(JSON.stringify(result).includes(password), false);
  assert.equal(secretBox.open(store.findMailboxByEmail('a@example.com').encrypted_password), password);
  assert.equal(secretBox.open(store.findMailboxByEmail('existing@example.com').encrypted_password), 'original');
});
