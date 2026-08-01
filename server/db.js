import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from './sqlite.js';
import { applySchema } from './schema.js';

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

export function initSchemaAndMigrations() {
  applySchema(db);
}

initSchemaAndMigrations();

/* ------------------------------------------------------------------ */
/* Settings                                                            */
/* ------------------------------------------------------------------ */

export const DEFAULT_SETTINGS = {
  company: {
    name: '',
    address: '',
    agrement: '',
    nif: '',
    art: '',
    bna: '',
    ccp: '',
    tel: '',
    fax: '',
    city: '',
    customFields: [],
  },
  client: {
    name: '',
    customFields: [],
  },
  billing: {
    tvaRate: 0.19,
    defaultTimbre: 40,
    defaultObs: '',
    numberPadding: 4,
    currency: 'DA',
    pageOrientation: 'portrait',
    observationPresets: [],
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
  `INSERT INTO settings (key, value, updated_at, sync_dirty)
   VALUES (?, ?, ?, 1)
   ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, sync_dirty = 1`
);

export const saveSettings = db.transaction((patch) => {
  const current = getSettings();
  const next = mergeDeep(current, patch);
  const ts = new Date().toISOString();
  // Only touch sections that actually changed. Rewriting all five on every
  // save marked them all dirty, so each save pushed the whole settings table
  // (logo included) to the cloud and made every device re-pull it.
  const stored = new Map(
    db.prepare('SELECT key, value FROM settings').all().map((row) => [row.key, row.value])
  );
  for (const key of Object.keys(DEFAULT_SETTINGS)) {
    const value = JSON.stringify(next[key]);
    if (stored.get(key) === value) continue;
    upsertSetting.run(key, value, ts);
  }
  return next;
});

/**
 * Write a single settings key without marking it dirty — used by the sync
 * engine to apply values pulled from the cloud without pushing them back.
 */
export function setSettingRaw(key, value, updatedAt) {
  upsertSettingRaw.run(String(value), updatedAt, key);
}

const upsertSettingRaw = db.prepare(
  `INSERT INTO settings (key, value, updated_at, sync_dirty)
   VALUES (?, ?, ?, 0)
   ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, sync_dirty = 0`
);
