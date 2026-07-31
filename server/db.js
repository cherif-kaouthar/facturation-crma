import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from './sqlite.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = process.env.LFB_DATA_DIR || path.join(ROOT, 'data');
const DB_FILE = process.env.LFB_DB_FILE || path.join(DATA_DIR, 'lfb.db');

fs.mkdirSync(DATA_DIR, { recursive: true });

/* If no database exists yet, copy the bundled default */
const DEFAULT_DB = path.join(__dirname, 'default.db');
if (!fs.existsSync(DB_FILE) && fs.existsSync(DEFAULT_DB)) {
  fs.copyFileSync(DEFAULT_DB, DB_FILE);
}

export function formatDateStamp(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  const yyyy = date.getFullYear();
  const mm = pad(date.getMonth() + 1);
  const dd = pad(date.getDate());
  const hh = pad(date.getHours());
  const min = pad(date.getMinutes());
  const ss = pad(date.getSeconds());
  return `${yyyy}-${mm}-${dd}_${hh}-${min}-${ss}`;
}

export class DatabaseManager {
  #connection = null;
  #dbFile = null;
  #isRestoring = false;

  constructor(dbFile) {
    this.#dbFile = dbFile;
    this.open();
  }

  open() {
    this.#connection = openDatabase(this.#dbFile);
    this.#connection.pragma('journal_mode = WAL');
    this.#connection.pragma('foreign_keys = ON');
  }

  get isRestoring() {
    return this.#isRestoring;
  }

  getDbFilePath() {
    return this.#dbFile;
  }

  #ensureAvailable() {
    if (this.#isRestoring) {
      throw new Error('Une restauration de la base de données est en cours. Veuillez patienter.');
    }
    if (!this.#connection) {
      this.open();
    }
  }

  prepare(sql) {
    this.#ensureAvailable();
    return this.#connection.prepare(sql);
  }

  exec(sql) {
    this.#ensureAvailable();
    return this.#connection.exec(sql);
  }

  pragma(stmt) {
    this.#ensureAvailable();
    return this.#connection.pragma(stmt);
  }

  transaction(fn) {
    return (...args) => {
      this.#ensureAvailable();
      const tx = this.#connection.transaction(fn);
      return tx(...args);
    };
  }

  close() {
    if (this.#connection) {
      try {
        this.#connection.close();
      } catch {
        /* already closed */
      }
      this.#connection = null;
    }
  }

  checkpoint() {
    if (this.#connection) {
      try {
        this.#connection.pragma('wal_checkpoint(TRUNCATE)');
      } catch {
        /* best effort */
      }
    }
  }

  async restoreFromBackup(uploadedFilePath) {
    if (this.#isRestoring) {
      throw new Error('Une restauration est déjà en cours.');
    }

    this.#isRestoring = true;

    try {
      // 1. Flush active WAL transactions
      this.checkpoint();

      // 2. Close active SQLite connection
      this.close();

      // 3. Create a safety pre-restore backup
      const timestamp = formatDateStamp();
      const backupsDir = path.join(path.dirname(this.#dbFile), 'backups');
      fs.mkdirSync(backupsDir, { recursive: true });
      const safetyBackupPath = path.join(backupsDir, `pre_restore_${timestamp}.db`);

      if (fs.existsSync(this.#dbFile)) {
        fs.copyFileSync(this.#dbFile, safetyBackupPath);
      }

      // 4. Overwrite DB_FILE with uploaded file
      fs.copyFileSync(uploadedFilePath, this.#dbFile);

      // Clean up wal / shm files
      const walFile = `${this.#dbFile}-wal`;
      const shmFile = `${this.#dbFile}-shm`;
      if (fs.existsSync(walFile)) {
        try { fs.unlinkSync(walFile); } catch {}
      }
      if (fs.existsSync(shmFile)) {
        try { fs.unlinkSync(shmFile); } catch {}
      }

      // 5. Reopen connection
      this.open();

      // Database is now consistent — release the lock so migrations can run
      this.#isRestoring = false;

      // 6. Run schema & migrations on restored database
      initSchemaAndMigrations();

      return { safetyBackupPath };
    } finally {
      this.#isRestoring = false;
    }
  }
}

export const db = new DatabaseManager(DB_FILE);

/* ------------------------------------------------------------------ */
/* Schema & Migrations                                                 */
/* ------------------------------------------------------------------ */

function ensureColumn(table, column, definition) {
  try {
    const pragma = db.prepare(`PRAGMA table_info('${table}')`).all();
    const exists = pragma.some((col) => col.name === column);
    if (!exists) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
  } catch (err) {
    console.error(`Failed to ensure column ${column} on ${table}:`, err);
  }
}

export function initSchemaAndMigrations() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS units (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      name        TEXT    NOT NULL,
      address     TEXT    NOT NULL DEFAULT '',
      archived    INTEGER NOT NULL DEFAULT 0,
      created_at  TEXT    NOT NULL,
      updated_at  TEXT    NOT NULL
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
      updated_at  TEXT    NOT NULL
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
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_invoices_unit ON invoices(unit_id);
    CREATE INDEX IF NOT EXISTS idx_invoices_year ON invoices(year);
    CREATE INDEX IF NOT EXISTS idx_lines_invoice  ON invoice_lines(invoice_id);
  `);

  ensureColumn('invoices', 'page_orientation', "TEXT NOT NULL DEFAULT 'portrait'");
  ensureColumn('invoices', 'notes', "TEXT NOT NULL DEFAULT ''");
  ensureColumn('invoices', 'tva_rate', "REAL NOT NULL DEFAULT 0.19");
  ensureColumn('invoices', 'client_id', "INTEGER REFERENCES clients(id) ON DELETE SET NULL");
  ensureColumn('invoices', 'client_name', "TEXT NOT NULL DEFAULT ''");
  ensureColumn('invoices', 'client_type', "TEXT NOT NULL DEFAULT 'company'");
  ensureColumn('invoices', 'client_location', "TEXT NOT NULL DEFAULT ''");
  ensureColumn('invoices', 'client_nif', "TEXT NOT NULL DEFAULT ''");
  ensureColumn('invoices', 'client_art', "TEXT NOT NULL DEFAULT ''");
  ensureColumn('invoices', 'client_phone', "TEXT NOT NULL DEFAULT ''");
  ensureColumn('units', 'address', "TEXT NOT NULL DEFAULT ''");
  ensureColumn('units', 'archived', "INTEGER NOT NULL DEFAULT 0");

  seed();
}

initSchemaAndMigrations();

/* ------------------------------------------------------------------ */
/* Settings                                                            */
/* ------------------------------------------------------------------ */

export const DEFAULT_SETTINGS = {
  company: {
    name: 'CRMA de Lakhdaria',
    address: 'Cité 05 Juillet Lakhdaria, W. de Bouira',
    agrement: "Numéro d'agrément : 60 du 14/07/2011",
    nif: '000110139009162',
    art: '2000018597',
    bna: 'BNA Lakhdaria 00100576030000015770',
    ccp: 'CCP 00799990000754241069',
    tel: '020 54 36 94',
    fax: '020 54 35 95',
    city: 'Lakhdaria',
    customFields: [],
  },
  client: {
    name: 'LAITERIE FROMAGERIE LFB',
    customFields: [],
  },
  billing: {
    tvaRate: 0.19,
    defaultTimbre: 40,
    defaultObs: 'Assurance Incendie & Risques Annexes',
    numberPadding: 4,
    currency: 'DA',
    pageOrientation: 'portrait',
    observationPresets: [
      'Assurance Incendie & Risques Annexes',
      'Assurance Catastrophe Naturelle',
      'Assurance Tous Risques',
      'Assurance Transport',
      'Assurance Multirisque',
    ],
  },
  branding: {
    // data: URL of the uploaded logo, or '' to fall back to the built-in mark
    logo: '',
  },
  app: {
    language: 'fr',
  },
};

/** Deep-merge stored settings over the defaults so new keys always resolve. */
function mergeDeep(base, override) {
  if (override === null || override === undefined) return base;
  if (typeof base !== 'object' || Array.isArray(base) || base === null) return override;
  if (typeof override !== 'object' || Array.isArray(override)) return base;
  const out = { ...base };
  for (const [key, value] of Object.entries(override)) {
    out[key] = key in base ? mergeDeep(base[key], value) : value;
  }
  return out;
}

export function getSettings() {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const stored = {};
  for (const row of rows) {
    try {
      stored[row.key] = JSON.parse(row.value);
    } catch {
      stored[row.key] = row.value;
    }
  }
  return mergeDeep(DEFAULT_SETTINGS, stored);
}

const upsertSetting = db.prepare(
  `INSERT INTO settings (key, value) VALUES (?, ?)
   ON CONFLICT(key) DO UPDATE SET value = excluded.value`
);

export const saveSettings = db.transaction((patch) => {
  const current = getSettings();
  const next = mergeDeep(current, patch);
  for (const key of Object.keys(DEFAULT_SETTINGS)) {
    upsertSetting.run(key, JSON.stringify(next[key]));
  }
  return next;
});

/* ------------------------------------------------------------------ */
/* Seed                                                                */
/* ------------------------------------------------------------------ */

export function seed() {
  const now = new Date().toISOString();

  const { count: unitCount } = db.prepare('SELECT COUNT(*) AS count FROM units').get();
  if (unitCount === 0) {
    const insertUnit = db.prepare(
      'INSERT INTO units (name, address, created_at, updated_at) VALUES (?, ?, ?, ?)'
    );
    db.transaction(() => {
      insertUnit.run('La Ferme EURL DBK SOFLAIT DBK', 'Wilaya de Tizi Ouzou', now, now);
      insertUnit.run('Zone Industrielle de Rouiba', "Wilaya d'Alger", now, now);
    })();
  }

  const { count: clientCount } = db.prepare('SELECT COUNT(*) AS count FROM clients').get();
  if (clientCount === 0) {
    const insertClient = db.prepare(
      `INSERT INTO clients (name, type, location, nif, art, phone, email, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    db.transaction(() => {
      insertClient.run(
        'LAITERIE FROMAGERIE LFB',
        'company',
        'Draâ El Mizan, Wilaya de Tizi Ouzou',
        '000115019008821',
        '1501004523',
        '026 34 12 80',
        'contact@lfb-dz.com',
        now,
        now
      );
      insertClient.run(
        'Complexe Agro-Alimentaire Soummam',
        'company',
        'Akbou, Wilaya de Béjaïa',
        '000206018005432',
        '0601008765',
        '034 35 60 00',
        'info@soummam-dz.com',
        now,
        now
      );
      insertClient.run(
        'Kamel Haddad',
        'person',
        'Lakhdaria, Wilaya de Bouira',
        '',
        '',
        '0550 12 34 56',
        '',
        now,
        now
      );
    })();
  }
}

seed();
