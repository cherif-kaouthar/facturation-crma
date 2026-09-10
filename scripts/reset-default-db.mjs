/**
 * Create or sanitise server/default.db before packaging.
 *
 * default.db is copied into place the first time the app runs on a new
 * machine, so whatever it contains becomes that customer's starting state.
 * Run automatically by `npm run electron:build`; safe to run by hand at any
 * time (it is idempotent).
 *
 * The file is gitignored, so on a fresh checkout it does not exist yet: in
 * that case it is created from scratch with the full local schema. When the
 * file already exists it is upgraded to the full schema and then sanitised.
 *
 * What it guarantees for a fresh install:
 *
 *   - The template is completely empty — no company info, no logo, no units,
 *     no clients, no invoices, no counters, no sync state. A new user opens
 *     the app and sees a blank slate, exactly like a brand-new installation.
 *
 *   - No cloud identity. cloud_id values are the primary keys of the
 *     Supabase rows. If the template shipped with them, every installation
 *     would claim the *same* UUIDs and silently overwrite each other's data
 *     in the shared project. The same goes for sync_meta watermarks.
 *
 *   - Numbering starts at 1 per year. The counters table is empty so the
 *     first invoice of any year gets seq 1.
 *
 * The per-year numbering system, all database tables, and the full schema
 * are preserved — only stored data is cleared. Default application settings
 * (blank company, default billing values, etc.) are provided at runtime by
 * DEFAULT_SETTINGS in server/db.js, so the shipped template needs no rows.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../server/sqlite.js';
import { applySchema } from '../server/schema.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_DB = path.resolve(__dirname, '..', 'server', 'default.db');
const created = !fs.existsSync(DEFAULT_DB);

// openDatabase creates the file if it is missing; applySchema then lays down
// the full schema (idempotent, so an existing template is upgraded in place).
const db = openDatabase(DEFAULT_DB);
applySchema(db);
const tables = new Set(
  db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name)
);
const has = (table) => tables.has(table);
const count = (table) => (has(table) ? db.prepare(`SELECT COUNT(*) c FROM ${table}`).get().c : 0);

/**
 * The shipped template may predate the sync feature entirely — cloud_id and
 * sync_dirty are added at runtime by initSchemaAndMigrations(), so they are
 * legitimately absent here and every sync column has to be probed first.
 */
const hasColumn = (table, column) =>
  has(table) && db.prepare(`PRAGMA table_info('${table}')`).all().some((c) => c.name === column);

const countCloudIds = () =>
  ['units', 'clients', 'invoices']
    .filter((t) => hasColumn(t, 'cloud_id'))
    .reduce((n, t) => n + db.prepare(`SELECT COUNT(*) c FROM ${t} WHERE cloud_id IS NOT NULL`).get().c, 0);

const DATA_TABLES = ['units', 'clients', 'settings'];
const ALL_DATA_TABLES = [...DATA_TABLES, 'invoice_lines', 'invoices', 'counters', 'seq_batches', 'sync_meta', 'sync_tombstones'];

const before = {};
for (const table of ALL_DATA_TABLES) {
  before[table] = count(table);
}
before.cloudIds = countCloudIds();

const dirty = Object.values(before).some((v) => v > 0);

// Nothing to do: leave the file untouched rather than VACUUM it into a
// byte-different blob, which would show up as a modification on every build.
if (!dirty) {
  console.log(
    created
      ? '[default-db] created with the full schema (empty template)'
      : '[default-db] already clean — file untouched'
  );
  console.log('[default-db] template is schema-only: no units, clients, settings, invoices, or numbering data.');
} else {
  db.transaction(() => {
    // Delete ALL business data so a fresh install starts with a blank slate.
    // Child tables first (foreign keys), then parent tables.
    for (const table of ALL_DATA_TABLES) {
      if (has(table)) db.prepare(`DELETE FROM ${table}`).run();
    }
    // Start AUTOINCREMENT ids from 1 again so a fresh install looks untouched.
    if (has('sqlite_sequence')) db.prepare('DELETE FROM sqlite_sequence').run();
  })();

  db.pragma('wal_checkpoint(TRUNCATE)');
  try {
    db.exec('VACUUM');
  } catch {
    /* not fatal — the file is already correct */
  }

  const after = {};
  for (const table of ALL_DATA_TABLES) {
    after[table] = count(table);
  }
  after.cloudIds = countCloudIds();
  db.close();

  const failures = ALL_DATA_TABLES.filter((t) => after[t] !== 0);
  failures.push(...['cloudIds'].filter((k) => after[k] !== 0));
  if (failures.length > 0) {
    console.error(`[default-db] FAILED to clear: ${failures.join(', ')}`);
    process.exitCode = 1;
  }

  const cleared = Object.entries(before).filter(([, v]) => v > 0);
  console.log(
    cleared.length > 0
      ? `[default-db] cleared ${cleared.map(([k, v]) => `${v} ${k}`).join(', ')}`
      : '[default-db] already clean'
  );
  console.log('[default-db] template is now schema-only: no units, clients, settings, invoices, or numbering data.');
}
