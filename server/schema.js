/**
 * Single source of truth for the local SQLite schema.
 *
 * `applySchema(conn)` is run by both the app (at startup and after a restore)
 * and the build-time default-db generator, so the bundled template always
 * carries the exact same tables, columns and indexes the runtime expects.
 */

function ensureColumn(conn, table, column, definition) {
  try {
    const pragma = conn.prepare(`PRAGMA table_info('${table}')`).all();
    const exists = pragma.some((col) => col.name === column);
    if (!exists) {
      conn.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
  } catch (err) {
    console.error(`Failed to ensure column ${column} on ${table}:`, err);
  }
}

export function applySchema(conn) {
  conn.exec(`
    CREATE TABLE IF NOT EXISTS units (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      name        TEXT    NOT NULL,
      address     TEXT    NOT NULL DEFAULT '',
      archived    INTEGER NOT NULL DEFAULT 0,
      created_at  TEXT    NOT NULL,
      updated_at  TEXT    NOT NULL,
      cloud_id    TEXT,
      sync_dirty  INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS clients (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      name        TEXT    NOT NULL,
      type        TEXT    NOT NULL DEFAULT 'company',
      location    TEXT    NOT NULL DEFAULT '',
      nif         TEXT    NOT NULL DEFAULT '',
      art         TEXT    NOT NULL DEFAULT '',
      phone       TEXT    NOT NULL DEFAULT '',
      email       TEXT    NOT NULL DEFAULT '',
      archived    INTEGER NOT NULL DEFAULT 0,
      created_at  TEXT    NOT NULL,
      updated_at  TEXT    NOT NULL,
      cloud_id    TEXT,
      sync_dirty  INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS invoices (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      unit_id         INTEGER NOT NULL REFERENCES units(id) ON DELETE RESTRICT,
      client_id       INTEGER REFERENCES clients(id) ON DELETE SET NULL,
      client_name     TEXT    NOT NULL DEFAULT '',
      client_type     TEXT    NOT NULL DEFAULT 'company',
      client_location TEXT    NOT NULL DEFAULT '',
      client_nif      TEXT    NOT NULL DEFAULT '',
      client_art      TEXT    NOT NULL DEFAULT '',
      client_phone    TEXT    NOT NULL DEFAULT '',
      seq             INTEGER NOT NULL,
      number          TEXT    NOT NULL,
      year            INTEGER NOT NULL,
      date            TEXT    NOT NULL,
      notes           TEXT    NOT NULL DEFAULT '',
      tva_rate        REAL    NOT NULL DEFAULT 0.19,
      page_orientation TEXT   NOT NULL DEFAULT 'portrait',
      total_nette     REAL    NOT NULL DEFAULT 0,
      total_tva       REAL    NOT NULL DEFAULT 0,
      total_fga       REAL    NOT NULL DEFAULT 0,
      total_timbre    REAL    NOT NULL DEFAULT 0,
      total_amount    REAL    NOT NULL DEFAULT 0,
      created_at      TEXT    NOT NULL,
      updated_at      TEXT    NOT NULL,
      cloud_id        TEXT,
      sync_dirty      INTEGER NOT NULL DEFAULT 0,
      UNIQUE (year, seq)
    );

    CREATE TABLE IF NOT EXISTS invoice_lines (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      invoice_id INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
      position   INTEGER NOT NULL,
      police     TEXT    NOT NULL DEFAULT '',
      echeance   TEXT,
      nette      REAL    NOT NULL DEFAULT 0,
      fga        REAL    NOT NULL DEFAULT 0,
      timbre     REAL    NOT NULL DEFAULT 0,
      obs        TEXT    NOT NULL DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS counters (
      year     INTEGER PRIMARY KEY,
      next_seq INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS settings (
      key        TEXT PRIMARY KEY,
      value      TEXT NOT NULL,
      updated_at TEXT,
      sync_dirty INTEGER NOT NULL DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_invoices_unit ON invoices(unit_id);
    CREATE INDEX IF NOT EXISTS idx_invoices_year ON invoices(year);
    CREATE INDEX IF NOT EXISTS idx_lines_invoice  ON invoice_lines(invoice_id);

    /* Cloud sync bookkeeping */
    CREATE TABLE IF NOT EXISTS sync_meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sync_tombstones (
      entity     TEXT    NOT NULL,
      local_id   INTEGER NOT NULL,
      cloud_id   TEXT,
      deleted_at TEXT    NOT NULL,
      PRIMARY KEY (entity, local_id)
    );

    CREATE TABLE IF NOT EXISTS seq_batches (
      year     INTEGER PRIMARY KEY,
      from_seq INTEGER NOT NULL,
      to_seq   INTEGER NOT NULL
    );
  `);

  ensureColumn(conn, 'invoices', 'page_orientation', "TEXT NOT NULL DEFAULT 'portrait'");
  ensureColumn(conn, 'invoices', 'notes', "TEXT NOT NULL DEFAULT ''");
  ensureColumn(conn, 'invoices', 'tva_rate', "REAL NOT NULL DEFAULT 0.19");
  ensureColumn(conn, 'invoices', 'client_id', "INTEGER REFERENCES clients(id) ON DELETE SET NULL");
  ensureColumn(conn, 'invoices', 'client_name', "TEXT NOT NULL DEFAULT ''");
  ensureColumn(conn, 'invoices', 'client_type', "TEXT NOT NULL DEFAULT 'company'");
  ensureColumn(conn, 'invoices', 'client_location', "TEXT NOT NULL DEFAULT ''");
  ensureColumn(conn, 'invoices', 'client_nif', "TEXT NOT NULL DEFAULT ''");
  ensureColumn(conn, 'invoices', 'client_art', "TEXT NOT NULL DEFAULT ''");
  ensureColumn(conn, 'invoices', 'client_phone', "TEXT NOT NULL DEFAULT ''");
  ensureColumn(conn, 'units', 'address', "TEXT NOT NULL DEFAULT ''");
  ensureColumn(conn, 'units', 'archived', "INTEGER NOT NULL DEFAULT 0");

  // Sync metadata for existing databases (must exist before the unique
  // cloud indexes are created on top of them).
  ensureColumn(conn, 'units', 'cloud_id', 'TEXT');
  ensureColumn(conn, 'units', 'sync_dirty', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn(conn, 'clients', 'cloud_id', 'TEXT');
  ensureColumn(conn, 'clients', 'sync_dirty', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn(conn, 'invoices', 'cloud_id', 'TEXT');
  ensureColumn(conn, 'invoices', 'sync_dirty', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn(conn, 'settings', 'updated_at', 'TEXT');
  ensureColumn(conn, 'settings', 'sync_dirty', 'INTEGER NOT NULL DEFAULT 0');
  // Only set when the user explicitly moves the numbering (setNextSeq), so the
  // choice is pushed to the cloud instead of being overwritten by the shared
  // counter on the next reservation.
  ensureColumn(conn, 'counters', 'sync_dirty', 'INTEGER NOT NULL DEFAULT 0');

  conn.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_units_cloud    ON units(cloud_id)    WHERE cloud_id IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_clients_cloud  ON clients(cloud_id)  WHERE cloud_id IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_invoices_cloud ON invoices(cloud_id) WHERE cloud_id IS NOT NULL;
  `);
}
