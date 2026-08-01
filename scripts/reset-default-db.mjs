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
 * file already exists (e.g. a pre-seeded template) it is upgraded to the full
 * schema and then sanitised.
 *
 * What it guarantees for a fresh install:
 *
 *   - No invoices, and numbering starts again at 1. A template carrying a
 *     counter would have every new installation begin part-way through a
 *     sequence it never issued.
 *
 *   - No cloud identity. This one matters most: cloud_id values are the
 *     primary keys of the Supabase rows. If the template shipped with them,
 *     every installation would claim the *same* UUIDs and silently overwrite
 *     each other's units, clients and invoices in the shared project. The
 *     same goes for sync_meta watermarks, which would make a new device skip
 *     the cloud history it has never actually read.
 *
 * Units, clients and settings are preserved, so an existing file can still be
 * used as a pre-seeded template — only invoices, numbering and sync state are
 * cleared. A freshly created file is schema-only (no data).
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

const before = {
  invoices: count('invoices'),
  counters: count('counters'),
  cloudIds: countCloudIds(),
  syncMeta: count('sync_meta'),
};

const dirty = Object.values(before).some((v) => v > 0);

// Nothing to do: leave the file untouched rather than VACUUM it into a
// byte-different blob, which would show up as a modification on every build.
if (!dirty) {
  const units = count('units');
  const clients = count('clients');
  const settings = count('settings');
  console.log(
    created
      ? '[default-db] created with the full schema'
      : '[default-db] already clean — file untouched'
  );
  console.log(
    `[default-db] template ships with ${units} unit(s), ${clients} client(s), ` +
      `${settings} settings row(s); numbering starts at 1.`
  );
} else {
  db.transaction(() => {
    for (const table of ['invoice_lines', 'invoices', 'counters', 'seq_batches', 'sync_meta', 'sync_tombstones']) {
      if (has(table)) db.prepare(`DELETE FROM ${table}`).run();
    }
    for (const table of ['units', 'clients']) {
      if (hasColumn(table, 'cloud_id')) db.prepare(`UPDATE ${table} SET cloud_id = NULL`).run();
      if (hasColumn(table, 'sync_dirty')) db.prepare(`UPDATE ${table} SET sync_dirty = 0`).run();
    }
    if (hasColumn('settings', 'sync_dirty')) db.prepare('UPDATE settings SET sync_dirty = 0').run();
    // Start AUTOINCREMENT ids from 1 again so a fresh install looks untouched.
    if (has('sqlite_sequence')) db.prepare('DELETE FROM sqlite_sequence').run();
  })();

  db.pragma('wal_checkpoint(TRUNCATE)');
  try {
    db.exec('VACUUM');
  } catch {
    /* not fatal — the file is already correct */
  }

  const after = {
    invoices: count('invoices'),
    counters: count('counters'),
    cloudIds: countCloudIds(),
    syncMeta: count('sync_meta'),
    units: count('units'),
    clients: count('clients'),
    settings: count('settings'),
  };
  db.close();

  const failures = ['invoices', 'counters', 'cloudIds', 'syncMeta'].filter((k) => after[k] !== 0);
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
  console.log(
    `[default-db] template ships with ${after.units} unit(s), ${after.clients} client(s), ` +
      `${after.settings} settings row(s); numbering starts at 1.`
  );
}
