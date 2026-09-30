'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { DatabaseSync } = require('node:sqlite');

const { GatewayStore } = require('../src/db/store');

test('existing alias rows and event foreign keys survive the discovered-state migration', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mail-gateway-migration-'));
  const filename = path.join(directory, 'gateway.sqlite');

  const legacy = new DatabaseSync(filename);
  legacy.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE mailboxes (
      id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, encrypted_password TEXT NOT NULL,
      state TEXT NOT NULL, remote_alias_count INTEGER NOT NULL DEFAULT 0,
      version INTEGER NOT NULL DEFAULT 1, last_error TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE aliases (
      id TEXT PRIMARY KEY,
      mailbox_id TEXT NOT NULL REFERENCES mailboxes(id) ON DELETE RESTRICT,
      email TEXT NOT NULL UNIQUE, token_hash TEXT UNIQUE, state TEXT NOT NULL,
      version INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      exported_at TEXT, first_accessed_at TEXT, last_accessed_at TEXT, delivered_at TEXT,
      release_after TEXT, deleted_at TEXT, last_error TEXT NOT NULL DEFAULT '',
      CHECK (state IN ('creating', 'create_failed', 'create_unknown', 'ready', 'exported',
        'active', 'delivered', 'release_pending', 'deleting', 'delete_failed', 'delete_unknown', 'deleted'))
    );
    CREATE INDEX aliases_mailbox_state_idx ON aliases(mailbox_id, state);
    CREATE INDEX aliases_release_after_idx ON aliases(release_after) WHERE release_after IS NOT NULL;
    CREATE TABLE alias_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      alias_id TEXT NOT NULL REFERENCES aliases(id) ON DELETE RESTRICT,
      event TEXT NOT NULL, from_state TEXT NOT NULL, to_state TEXT NOT NULL,
      detail TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL
    );
    INSERT INTO mailboxes VALUES ('m1', 'main@example.com', 'sealed', 'closed', 1, 1, '', 'now', 'now');
    INSERT INTO aliases (
      id, mailbox_id, email, token_hash, state, version, created_at, updated_at, last_error
    ) VALUES ('a1', 'm1', 'existing@example.com', NULL, 'ready', 1, 'now', 'now', '');
    INSERT INTO alias_events (alias_id, event, from_state, to_state, created_at)
    VALUES ('a1', 'create_confirmed', 'creating', 'ready', 'now');
  `);
  legacy.close();

  const store = new GatewayStore({ filename });
  t.after(() => {
    store.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  assert.equal(store.getMailbox('m1').creation_blocked, 0);
  assert.equal(store.getMailbox('m1').creation_blocked_reason, '');
  assert.equal(store.getMailbox('m1').creation_blocked_at, null);
  store.markMailboxCreationBlocked('m1', 'historical conflict');
  assert.equal(store.getMailbox('m1').creation_blocked, 1);
  assert.equal(store.getMailbox('m1').state, 'closed');
  assert.equal(store.getAlias('a1').state, 'ready');
  assert.equal(store.listAliasEvents('a1').length, 1);
  assert.equal(store.db.prepare('PRAGMA foreign_key_check').all().length, 0);
  assert.equal(store.db.prepare('SELECT version FROM schema_migrations WHERE version = 2').get().version, 2);
  assert.equal(store.db.prepare('SELECT version FROM schema_migrations WHERE version = 3').get().version, 3);
  assert.ok(store.db.prepare('PRAGMA table_info(proxy_pool)').all().some((column) => column.name === 'active'));
  assert.equal(store.discoverAlias({ mailboxId: 'm1', email: 'discovered@example.com' }).state, 'discovered');
});

test('legacy proxy rows become active pool members without losing encrypted data', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mail-gateway-proxy-migration-'));
  const filename = path.join(directory, 'gateway.sqlite');
  const legacy = new DatabaseSync(filename);
  legacy.exec(`
    CREATE TABLE proxy_pool (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      fingerprint TEXT NOT NULL UNIQUE,
      encrypted_endpoint TEXT NOT NULL,
      masked_endpoint TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'available',
      batch_id TEXT,
      imported_at TEXT NOT NULL,
      reserved_at TEXT,
      consumed_at TEXT,
      last_error TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX proxy_pool_status_id_idx ON proxy_pool(status, id);
    INSERT INTO proxy_pool
      (fingerprint, encrypted_endpoint, masked_endpoint, imported_at)
    VALUES ('fingerprint', 'sealed-value', 'proxy.test:1:use***:***', 'now');
  `);
  legacy.close();

  const store = new GatewayStore({ filename });
  t.after(() => {
    store.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const row = store.db.prepare('SELECT encrypted_endpoint, active FROM proxy_pool').get();
  assert.equal(row.encrypted_endpoint, 'sealed-value');
  assert.equal(row.active, 1);
  const index = store.db.prepare(`
    SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'proxy_pool_status_id_idx'
  `).get();
  assert.match(index.sql, /active\s*,\s*status\s*,\s*id/i);
  assert.equal(store.db.prepare('PRAGMA foreign_key_check').all().length, 0);
});
