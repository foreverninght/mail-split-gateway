'use strict';

const ALIAS_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS aliases (
  id TEXT PRIMARY KEY,
  mailbox_id TEXT NOT NULL REFERENCES mailboxes(id) ON DELETE RESTRICT,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  token_hash TEXT UNIQUE,
  state TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  exported_at TEXT,
  first_accessed_at TEXT,
  last_accessed_at TEXT,
  delivered_at TEXT,
  release_after TEXT,
  deleted_at TEXT,
  last_error TEXT NOT NULL DEFAULT '',
  CHECK (state IN (
    'creating', 'create_failed', 'create_unknown', 'discovered', 'ready', 'exported', 'active',
    'delivered', 'release_pending', 'deleting', 'delete_failed', 'delete_unknown', 'deleted'
  )),
  CHECK ((state IN ('exported', 'active', 'delivered') AND token_hash IS NOT NULL)
      OR state NOT IN ('exported', 'active', 'delivered'))
);
`;

const SCHEMA = `
PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;
PRAGMA busy_timeout = 5000;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS service_settings (
  key TEXT PRIMARY KEY,
  encrypted_value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS mailboxes (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  encrypted_password TEXT NOT NULL,
  state TEXT NOT NULL,
  remote_alias_count INTEGER NOT NULL DEFAULT 0,
  creation_blocked INTEGER NOT NULL DEFAULT 0 CHECK (creation_blocked IN (0, 1)),
  creation_blocked_reason TEXT NOT NULL DEFAULT '',
  creation_blocked_at TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  last_error TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (state IN ('closed', 'opening', 'ready', 'renewing', 'login_required', 'unavailable'))
);

${ALIAS_TABLE_SQL}

CREATE INDEX IF NOT EXISTS aliases_mailbox_state_idx ON aliases(mailbox_id, state);
CREATE INDEX IF NOT EXISTS aliases_release_after_idx ON aliases(release_after) WHERE release_after IS NOT NULL;

CREATE TABLE IF NOT EXISTS alias_domain_usage (
  alias_id TEXT PRIMARY KEY REFERENCES aliases(id) ON DELETE RESTRICT,
  domain TEXT NOT NULL COLLATE NOCASE,
  state TEXT NOT NULL,
  reserved_at TEXT NOT NULL,
  released_at TEXT,
  CHECK (state IN ('reserved', 'confirmed', 'uncertain', 'released'))
);

CREATE INDEX IF NOT EXISTS alias_domain_usage_window_idx
ON alias_domain_usage(domain, state, reserved_at);

CREATE TABLE IF NOT EXISTS mailbox_domains (
  mailbox_id TEXT NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE,
  domain TEXT NOT NULL COLLATE NOCASE,
  kind TEXT NOT NULL DEFAULT 'hidden',
  remote_state TEXT NOT NULL DEFAULT 'UNKNOWN',
  updated_at TEXT NOT NULL,
  PRIMARY KEY (mailbox_id, domain),
  CHECK (kind IN ('hidden', 'explicit', 'blacklist'))
);

CREATE INDEX IF NOT EXISTS mailbox_domains_kind_idx ON mailbox_domains(mailbox_id, kind, remote_state);

CREATE TABLE IF NOT EXISTS domain_catalog (
  domain TEXT PRIMARY KEY COLLATE NOCASE,
  kind TEXT NOT NULL,
  remote_state TEXT NOT NULL DEFAULT 'UNKNOWN',
  consecutive_otp_timeouts INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (kind IN ('hidden', 'explicit', 'blacklist'))
);

CREATE INDEX IF NOT EXISTS domain_catalog_kind_idx ON domain_catalog(kind, domain);

CREATE TABLE IF NOT EXISTS alias_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  alias_id TEXT NOT NULL REFERENCES aliases(id) ON DELETE RESTRICT,
  event TEXT NOT NULL,
  from_state TEXT NOT NULL,
  to_state TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS alias_events_alias_idx ON alias_events(alias_id, id);

INSERT OR IGNORE INTO alias_domain_usage (alias_id, domain, state, reserved_at)
SELECT
  aliases.id,
  lower(substr(aliases.email, instr(aliases.email, '@') + 1)),
  CASE WHEN aliases.state IN ('creating', 'create_unknown') THEN 'uncertain' ELSE 'confirmed' END,
  aliases.created_at
FROM aliases
WHERE aliases.state <> 'create_failed'
  AND (
    aliases.state = 'creating'
    OR EXISTS (
      SELECT 1 FROM alias_events
      WHERE alias_events.alias_id = aliases.id
        AND alias_events.event IN ('create_confirmed', 'create_result_unknown')
    )
  );

CREATE TABLE IF NOT EXISTS mailbox_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mailbox_id TEXT NOT NULL REFERENCES mailboxes(id) ON DELETE RESTRICT,
  event TEXT NOT NULL,
  from_state TEXT NOT NULL,
  to_state TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS otp_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  alias_id TEXT NOT NULL REFERENCES aliases(id) ON DELETE RESTRICT,
  remote_message_id TEXT NOT NULL,
  code TEXT NOT NULL,
  received_at TEXT NOT NULL,
  first_seen_at TEXT NOT NULL,
  delivered_count INTEGER NOT NULL DEFAULT 0,
  last_delivered_at TEXT,
  UNIQUE(alias_id, remote_message_id, code)
);

CREATE TABLE IF NOT EXISTS ic_mailboxes (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  encrypted_upstream_url TEXT NOT NULL,
  pickup_hostname TEXT NOT NULL COLLATE NOCASE,
  adapter_key TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL DEFAULT 'available',
  version INTEGER NOT NULL DEFAULT 1,
  last_error TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  first_accessed_at TEXT,
  last_accessed_at TEXT,
  last_code_at TEXT,
  registration_baseline_code_hash TEXT,
  registration_allocated_at TEXT,
  CHECK (state IN ('available', 'allocated', 'running', 'used'))
);

CREATE INDEX IF NOT EXISTS ic_mailboxes_state_idx ON ic_mailboxes(state, created_at);

CREATE TABLE IF NOT EXISTS ic_mailbox_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mailbox_id TEXT NOT NULL REFERENCES ic_mailboxes(id) ON DELETE RESTRICT,
  event TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS ic_mailbox_events_mailbox_idx ON ic_mailbox_events(mailbox_id, id);

CREATE TABLE IF NOT EXISTS registration_batches (
  id TEXT PRIMARY KEY,
  requested_count INTEGER NOT NULL,
  proxies_per_mailbox INTEGER NOT NULL DEFAULT 20,
  mailbox_category TEXT NOT NULL DEFAULT 'mail',
  mailbox_provider TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL,
  external_batch_id TEXT UNIQUE,
  encrypted_external_session TEXT,
  alias_count INTEGER NOT NULL DEFAULT 0,
  proxy_count INTEGER NOT NULL DEFAULT 0,
  success_count INTEGER NOT NULL DEFAULT 0,
  qualified_count INTEGER NOT NULL DEFAULT 0,
  failed_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  accepted_at TEXT,
  completed_at TEXT,
  CHECK (requested_count >= 1),
  CHECK (mailbox_category IN ('mail', 'ic')),
  CHECK (state IN (
    'queued', 'creating_aliases', 'allocating_proxies', 'submitting', 'submit_unknown',
    'accepted', 'running', 'collecting_results', 'completed', 'partial_completed', 'failed'
  ))
);

CREATE INDEX IF NOT EXISTS registration_batches_state_idx
ON registration_batches(state, created_at);

CREATE TABLE IF NOT EXISTS proxy_pool (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  fingerprint TEXT NOT NULL UNIQUE,
  encrypted_endpoint TEXT NOT NULL,
  masked_endpoint TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'available',
  batch_id TEXT REFERENCES registration_batches(id) ON DELETE RESTRICT,
  imported_at TEXT NOT NULL,
  reserved_at TEXT,
  consumed_at TEXT,
  last_error TEXT NOT NULL DEFAULT '',
  CHECK (active IN (0, 1)),
  CHECK (status IN ('available', 'reserved', 'consumed', 'quarantined'))
);

CREATE INDEX IF NOT EXISTS proxy_pool_status_id_idx ON proxy_pool(status, id);

CREATE TABLE IF NOT EXISTS control_proxy_pool (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  fingerprint TEXT NOT NULL UNIQUE,
  encrypted_endpoint TEXT NOT NULL,
  masked_endpoint TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'available',
  batch_id TEXT REFERENCES registration_batches(id) ON DELETE RESTRICT,
  imported_at TEXT NOT NULL,
  reserved_at TEXT,
  consumed_at TEXT,
  last_error TEXT NOT NULL DEFAULT '',
  CHECK (active IN (0, 1)),
  CHECK (status IN ('available', 'reserved', 'consumed', 'quarantined'))
);

CREATE INDEX IF NOT EXISTS control_proxy_pool_status_id_idx
ON control_proxy_pool(active, status, id);

CREATE TABLE IF NOT EXISTS registration_batch_control_proxies (
  batch_id TEXT PRIMARY KEY REFERENCES registration_batches(id) ON DELETE CASCADE,
  proxy_id INTEGER NOT NULL REFERENCES control_proxy_pool(id) ON DELETE RESTRICT,
  reserved_at TEXT NOT NULL,
  final_status TEXT NOT NULL DEFAULT 'reserved',
  completed_at TEXT,
  CHECK (final_status IN ('reserved', 'consumed', 'quarantined'))
);

CREATE INDEX IF NOT EXISTS registration_batch_control_proxies_proxy_idx
ON registration_batch_control_proxies(proxy_id, reserved_at);

CREATE TABLE IF NOT EXISTS registration_batch_proxies (
  batch_id TEXT NOT NULL REFERENCES registration_batches(id) ON DELETE CASCADE,
  proxy_id INTEGER NOT NULL UNIQUE REFERENCES proxy_pool(id) ON DELETE RESTRICT,
  ordinal INTEGER NOT NULL,
  PRIMARY KEY (batch_id, ordinal)
);

CREATE TABLE IF NOT EXISTS registration_proxy_allocations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id TEXT NOT NULL REFERENCES registration_batches(id) ON DELETE CASCADE,
  proxy_id INTEGER NOT NULL REFERENCES proxy_pool(id) ON DELETE RESTRICT,
  ordinal INTEGER NOT NULL,
  reserved_at TEXT NOT NULL,
  final_status TEXT NOT NULL DEFAULT 'reserved',
  completed_at TEXT,
  UNIQUE(batch_id, ordinal),
  UNIQUE(batch_id, proxy_id),
  CHECK (final_status IN ('reserved', 'consumed', 'quarantined', 'released'))
);

CREATE INDEX IF NOT EXISTS registration_proxy_allocations_proxy_idx
ON registration_proxy_allocations(proxy_id, reserved_at);

INSERT OR IGNORE INTO registration_proxy_allocations
  (batch_id, proxy_id, ordinal, reserved_at, final_status, completed_at)
SELECT
  links.batch_id,
  links.proxy_id,
  links.ordinal,
  COALESCE(proxies.reserved_at, batches.created_at),
  CASE proxies.status
    WHEN 'consumed' THEN 'consumed'
    WHEN 'quarantined' THEN 'quarantined'
    WHEN 'reserved' THEN 'reserved'
    ELSE 'released'
  END,
  CASE WHEN proxies.status IN ('consumed', 'quarantined')
    THEN COALESCE(proxies.consumed_at, batches.updated_at) ELSE NULL END
FROM registration_batch_proxies AS links
JOIN proxy_pool AS proxies ON proxies.id = links.proxy_id
JOIN registration_batches AS batches ON batches.id = links.batch_id;

CREATE TABLE IF NOT EXISTS registration_tasks (
  id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL REFERENCES registration_batches(id) ON DELETE CASCADE,
  slot INTEGER NOT NULL,
  mailbox_category TEXT NOT NULL DEFAULT 'mail',
  alias_id TEXT UNIQUE REFERENCES aliases(id) ON DELETE RESTRICT,
  ic_mailbox_id TEXT UNIQUE REFERENCES ic_mailboxes(id) ON DELETE RESTRICT,
  email TEXT NOT NULL COLLATE NOCASE,
  encrypted_web_api TEXT NOT NULL,
  external_task_id TEXT,
  state TEXT NOT NULL,
  mfa_status TEXT NOT NULL DEFAULT 'pending',
  trial_qualification TEXT NOT NULL DEFAULT 'unknown',
  terminal_code TEXT,
  last_error TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  UNIQUE(batch_id, slot),
  CHECK (mailbox_category IN ('mail', 'ic')),
  CHECK (
    (mailbox_category = 'mail' AND alias_id IS NOT NULL AND ic_mailbox_id IS NULL)
    OR (mailbox_category = 'ic' AND alias_id IS NULL AND ic_mailbox_id IS NOT NULL)
  ),
  CHECK (state IN (
    'alias_ready', 'submitted', 'running', 'registered', 'qualified', 'unqualified',
    'mfa_failed', 'failed', 'saved', 'released'
  ))
);

CREATE INDEX IF NOT EXISTS registration_tasks_batch_idx ON registration_tasks(batch_id, slot);

CREATE TABLE IF NOT EXISTS qualified_accounts (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL UNIQUE REFERENCES registration_tasks(id) ON DELETE RESTRICT,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  encrypted_password TEXT NOT NULL,
  encrypted_totp_secret TEXT NOT NULL,
  encrypted_session_json TEXT,
  encrypted_result_json TEXT NOT NULL,
  trial_summary TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS registration_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id TEXT NOT NULL REFERENCES registration_batches(id) ON DELETE CASCADE,
  task_id TEXT REFERENCES registration_tasks(id) ON DELETE CASCADE,
  entity TEXT NOT NULL,
  event TEXT NOT NULL,
  from_state TEXT NOT NULL,
  to_state TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  CHECK (entity IN ('batch', 'task'))
);

CREATE INDEX IF NOT EXISTS registration_events_batch_idx ON registration_events(batch_id, id);
`;

function aliasSchemaSupportsDiscovered(db) {
  const row = db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'aliases'`).get();
  return /['"]discovered['"]/.test(String(row?.sql || ''));
}

function proxyPoolSupportsActiveMembership(db) {
  return db.prepare('PRAGMA table_info(proxy_pool)').all().some((column) => column.name === 'active');
}

function registrationBatchSupportsProxyCount(db) {
  return db.prepare('PRAGMA table_info(registration_batches)').all()
    .some((column) => column.name === 'proxies_per_mailbox');
}

function migrateIcRegistrationBaseline(db) {
  const columns = db.prepare('PRAGMA table_info(ic_mailboxes)').all();
  if (!columns.some((column) => column.name === 'registration_baseline_code_hash')) {
    db.exec('ALTER TABLE ic_mailboxes ADD COLUMN registration_baseline_code_hash TEXT;');
  }
  if (!columns.some((column) => column.name === 'registration_allocated_at')) {
    db.exec('ALTER TABLE ic_mailboxes ADD COLUMN registration_allocated_at TEXT;');
  }
}

function reconcileAssignedIcMailboxes(db) {
  const rows = db.prepare(`
    SELECT mailbox.id FROM ic_mailboxes AS mailbox
    WHERE mailbox.state = 'available'
      AND (
        EXISTS (
          SELECT 1 FROM registration_tasks AS task WHERE task.ic_mailbox_id = mailbox.id
        )
        OR EXISTS (
          SELECT 1 FROM ic_mailbox_events AS event
          WHERE event.mailbox_id = mailbox.id AND event.event = 'allocated_for_registration'
        )
      )
  `).all();
  if (!rows.length) return 0;
  const timestamp = new Date().toISOString();
  const update = db.prepare(`
    UPDATE ic_mailboxes
    SET state = 'used', version = version + 1,
        last_error = 'reconciled_historical_registration_assignment', updated_at = ?
    WHERE id = ? AND state = 'available'
  `);
  const event = db.prepare(`
    INSERT INTO ic_mailbox_events (mailbox_id, event, detail, created_at)
    VALUES (?, 'reconciled_registration_assignment', 'historical task binding', ?)
  `);
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const row of rows) {
      if (update.run(timestamp, row.id).changes === 1) event.run(row.id, timestamp);
    }
    db.exec('COMMIT');
  } catch (error) {
    if (db.isTransaction) db.exec('ROLLBACK');
    throw error;
  }
  return rows.length;
}

function registrationSupportsMailboxCategories(db) {
  const batchColumns = db.prepare('PRAGMA table_info(registration_batches)').all();
  const taskColumns = db.prepare('PRAGMA table_info(registration_tasks)').all();
  const aliasColumn = taskColumns.find((column) => column.name === 'alias_id');
  return batchColumns.some((column) => column.name === 'mailbox_category')
    && taskColumns.some((column) => column.name === 'mailbox_category')
    && taskColumns.some((column) => column.name === 'ic_mailbox_id')
    && aliasColumn?.notnull === 0;
}

function migrateRegistrationMailboxCategories(db) {
  if (registrationSupportsMailboxCategories(db)) return;
  db.exec('PRAGMA foreign_keys = OFF; PRAGMA legacy_alter_table = ON; BEGIN IMMEDIATE;');
  try {
    const batchColumns = db.prepare('PRAGMA table_info(registration_batches)').all();
    if (!batchColumns.some((column) => column.name === 'mailbox_category')) {
      db.exec("ALTER TABLE registration_batches ADD COLUMN mailbox_category TEXT NOT NULL DEFAULT 'mail';");
    }
    if (!batchColumns.some((column) => column.name === 'mailbox_provider')) {
      db.exec("ALTER TABLE registration_batches ADD COLUMN mailbox_provider TEXT NOT NULL DEFAULT '';");
    }

    db.exec(`
      DROP INDEX IF EXISTS registration_tasks_batch_idx;
      ALTER TABLE registration_tasks RENAME TO registration_tasks_legacy;
      CREATE TABLE registration_tasks (
        id TEXT PRIMARY KEY,
        batch_id TEXT NOT NULL REFERENCES registration_batches(id) ON DELETE CASCADE,
        slot INTEGER NOT NULL,
        mailbox_category TEXT NOT NULL DEFAULT 'mail',
        alias_id TEXT UNIQUE REFERENCES aliases(id) ON DELETE RESTRICT,
        ic_mailbox_id TEXT UNIQUE REFERENCES ic_mailboxes(id) ON DELETE RESTRICT,
        email TEXT NOT NULL COLLATE NOCASE,
        encrypted_web_api TEXT NOT NULL,
        external_task_id TEXT,
        state TEXT NOT NULL,
        mfa_status TEXT NOT NULL DEFAULT 'pending',
        trial_qualification TEXT NOT NULL DEFAULT 'unknown',
        terminal_code TEXT,
        last_error TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT,
        UNIQUE(batch_id, slot),
        CHECK (mailbox_category IN ('mail', 'ic')),
        CHECK (
          (mailbox_category = 'mail' AND alias_id IS NOT NULL AND ic_mailbox_id IS NULL)
          OR (mailbox_category = 'ic' AND alias_id IS NULL AND ic_mailbox_id IS NOT NULL)
        ),
        CHECK (state IN (
          'alias_ready', 'submitted', 'running', 'registered', 'qualified', 'unqualified',
          'mfa_failed', 'failed', 'saved', 'released'
        ))
      );
      INSERT INTO registration_tasks (
        id, batch_id, slot, mailbox_category, alias_id, ic_mailbox_id, email,
        encrypted_web_api, external_task_id, state, mfa_status, trial_qualification,
        terminal_code, last_error, created_at, updated_at, completed_at
      )
      SELECT id, batch_id, slot, 'mail', alias_id, NULL, email,
        encrypted_web_api, external_task_id, state, mfa_status, trial_qualification,
        terminal_code, last_error, created_at, updated_at, completed_at
      FROM registration_tasks_legacy;
      DROP TABLE registration_tasks_legacy;
      CREATE INDEX registration_tasks_batch_idx ON registration_tasks(batch_id, slot);
    `);
    db.exec('COMMIT;');
  } catch (error) {
    if (db.isTransaction) db.exec('ROLLBACK;');
    throw error;
  } finally {
    db.exec('PRAGMA legacy_alter_table = OFF; PRAGMA foreign_keys = ON;');
  }
}

function registrationBatchHasUnboundedCount(db) {
  const row = db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'registration_batches'`).get();
  return /requested_count\s*>=\s*1/i.test(String(row?.sql || ''));
}

function migrateRegistrationBatchCountConstraint(db) {
  if (registrationBatchHasUnboundedCount(db)) return;
  // SQLite cannot alter a CHECK expression in place. Rebuild this table while
  // preserving every batch and its foreign-key identity.
  db.exec('PRAGMA foreign_keys = OFF; PRAGMA legacy_alter_table = ON; BEGIN IMMEDIATE;');
  try {
    db.exec('DROP INDEX IF EXISTS registration_batches_state_idx; ALTER TABLE registration_batches RENAME TO registration_batches_legacy;');
    db.exec(`
      CREATE TABLE registration_batches (
        id TEXT PRIMARY KEY,
        requested_count INTEGER NOT NULL,
        state TEXT NOT NULL,
        external_batch_id TEXT UNIQUE,
        encrypted_external_session TEXT,
        alias_count INTEGER NOT NULL DEFAULT 0,
        proxy_count INTEGER NOT NULL DEFAULT 0,
        success_count INTEGER NOT NULL DEFAULT 0,
        qualified_count INTEGER NOT NULL DEFAULT 0,
        failed_count INTEGER NOT NULL DEFAULT 0,
        last_error TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        accepted_at TEXT,
        completed_at TEXT,
        proxies_per_mailbox INTEGER NOT NULL DEFAULT 20,
        CHECK (requested_count >= 1),
        CHECK (state IN ('queued', 'creating_aliases', 'allocating_proxies', 'submitting', 'submit_unknown', 'accepted', 'running', 'collecting_results', 'completed', 'partial_completed', 'failed'))
      );
    `);
    db.exec(`
      INSERT INTO registration_batches
        (id, requested_count, state, external_batch_id, encrypted_external_session,
         alias_count, proxy_count, success_count, qualified_count, failed_count,
         last_error, created_at, updated_at, accepted_at, completed_at, proxies_per_mailbox)
      SELECT id, requested_count, state, external_batch_id, encrypted_external_session,
         alias_count, proxy_count, success_count, qualified_count, failed_count,
         last_error, created_at, updated_at, accepted_at, completed_at,
         COALESCE(proxies_per_mailbox, 20)
      FROM registration_batches_legacy;
      DROP TABLE registration_batches_legacy;
      CREATE INDEX registration_batches_state_idx ON registration_batches(state, created_at);
    `);
    db.exec('COMMIT;');
  } catch (error) {
    if (db.isTransaction) db.exec('ROLLBACK;');
    throw error;
  } finally {
    db.exec('PRAGMA legacy_alter_table = OFF; PRAGMA foreign_keys = ON;');
  }
}

function migrateRegistrationBatchProxyCount(db) {
  if (registrationBatchSupportsProxyCount(db)) return;
  db.exec('BEGIN IMMEDIATE;');
  try {
    db.exec('ALTER TABLE registration_batches ADD COLUMN proxies_per_mailbox INTEGER NOT NULL DEFAULT 20;');
    db.exec('COMMIT;');
  } catch (error) {
    if (db.isTransaction) db.exec('ROLLBACK;');
    throw error;
  }
}

function migrateProxyPoolMembership(db) {
  db.exec('BEGIN IMMEDIATE;');
  try {
    if (!proxyPoolSupportsActiveMembership(db)) {
      db.exec(`
        ALTER TABLE proxy_pool
        ADD COLUMN active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1));
      `);
    }
    db.exec(`
      DROP INDEX IF EXISTS proxy_pool_status_id_idx;
      CREATE INDEX proxy_pool_status_id_idx ON proxy_pool(active, status, id);
    `);
    db.exec('COMMIT;');
  } catch (error) {
    if (db.isTransaction) db.exec('ROLLBACK;');
    throw error;
  }
  db.prepare(`
    INSERT INTO schema_migrations (version, applied_at)
    VALUES (3, ?) ON CONFLICT(version) DO NOTHING
  `).run(new Date().toISOString());
}

function migrateSchema(db) {
  if (aliasSchemaSupportsDiscovered(db)) {
    db.prepare(`
      INSERT INTO schema_migrations (version, applied_at)
      VALUES (2, ?) ON CONFLICT(version) DO NOTHING
    `).run(new Date().toISOString());
  } else {
    try {
      db.exec('PRAGMA foreign_keys = OFF; PRAGMA legacy_alter_table = ON; BEGIN IMMEDIATE;');
      db.exec('ALTER TABLE aliases RENAME TO aliases_legacy;');
      db.exec(ALIAS_TABLE_SQL);
      db.exec(`
        INSERT INTO aliases (
          id, mailbox_id, email, token_hash, state, version, created_at, updated_at,
          exported_at, first_accessed_at, last_accessed_at, delivered_at, release_after,
          deleted_at, last_error
        )
        SELECT
          id, mailbox_id, email, token_hash, state, version, created_at, updated_at,
          exported_at, first_accessed_at, last_accessed_at, delivered_at, release_after,
          deleted_at, last_error
        FROM aliases_legacy;
        DROP TABLE aliases_legacy;
        CREATE INDEX aliases_mailbox_state_idx ON aliases(mailbox_id, state);
        CREATE INDEX aliases_release_after_idx ON aliases(release_after) WHERE release_after IS NOT NULL;
      `);
      db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (2, ?)').run(new Date().toISOString());
      db.exec('COMMIT;');
    } catch (error) {
      if (db.isTransaction) db.exec('ROLLBACK;');
      throw error;
    } finally {
      db.exec('PRAGMA legacy_alter_table = OFF; PRAGMA foreign_keys = ON;');
    }
  }

  const mailboxColumns = db.prepare('PRAGMA table_info(mailboxes)').all();
  for (const [name, definition] of [
    ['creation_blocked', 'INTEGER NOT NULL DEFAULT 0 CHECK (creation_blocked IN (0, 1))'],
    ['creation_blocked_reason', "TEXT NOT NULL DEFAULT ''"],
    ['creation_blocked_at', 'TEXT'],
  ]) {
    if (!mailboxColumns.some((column) => column.name === name)) {
      db.exec(`ALTER TABLE mailboxes ADD COLUMN ${name} ${definition}`);
    }
  }

  migrateProxyPoolMembership(db);
  migrateRegistrationBatchProxyCount(db);
  migrateRegistrationBatchCountConstraint(db);
  migrateRegistrationMailboxCategories(db);
  migrateIcRegistrationBaseline(db);
  reconcileAssignedIcMailboxes(db);

  const violations = db.prepare('PRAGMA foreign_key_check').all();
  if (violations.length) throw new Error(`database migration produced ${violations.length} foreign key violations`);
}

module.exports = {
  ALIAS_TABLE_SQL,
  SCHEMA,
  aliasSchemaSupportsDiscovered,
  migrateSchema,
  proxyPoolSupportsActiveMembership,
  registrationBatchSupportsProxyCount,
  registrationSupportsMailboxCategories,
  reconcileAssignedIcMailboxes,
};
