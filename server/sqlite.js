/**
 * SQLite driver adapter.
 *
 * Presents one small synchronous API (`prepare`, `exec`, `transaction`,
 * `pragma`, `close`) over whichever driver this machine can actually load:
 *
 *   1. better-sqlite3  — native, fastest. Needs a C++ toolchain to install.
 *   2. node-sqlite3-wasm — real SQLite compiled to WebAssembly. No toolchain.
 *
 * The WASM driver is the default because it installs everywhere; adding
 * better-sqlite3 later is a drop-in speed-up with no code changes.
 */

import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

function loadDriver() {
  try {
    const Native = require('better-sqlite3');
    return { kind: 'native', open: (file) => new Native(file) };
  } catch {
    const { Database } = require('node-sqlite3-wasm');
    return { kind: 'wasm', open: (file) => new Database(file) };
  }
}

/** node-sqlite3-wasm binds one params argument; better-sqlite3 takes varargs. */
function packParams(args) {
  if (args.length === 0) return undefined;
  if (args.length === 1 && args[0] !== null && typeof args[0] === 'object' && !Array.isArray(args[0])) {
    return args[0];
  }
  return args.flat();
}

class WasmStatement {
  constructor(db, sql) {
    this.db = db;
    this.sql = sql;
  }

  #withStatement(fn) {
    const stmt = this.db.prepare(this.sql);
    try {
      return fn(stmt);
    } finally {
      stmt.finalize();
    }
  }

  run(...args) {
    const params = packParams(args);
    return this.#withStatement((s) => s.run(params));
  }

  get(...args) {
    const params = packParams(args);
    return this.#withStatement((s) => s.get(params)) ?? undefined;
  }

  all(...args) {
    const params = packParams(args);
    return this.#withStatement((s) => s.all(params));
  }
}

class Sqlite {
  constructor(file) {
    const driver = loadDriver();
    this.kind = driver.kind;
    this.raw = driver.open(file);
    this.depth = 0;
  }

  prepare(sql) {
    return this.kind === 'native' ? this.raw.prepare(sql) : new WasmStatement(this.raw, sql);
  }

  exec(sql) {
    this.raw.exec(sql);
    return this;
  }

  /** Best-effort: some pragmas are unavailable on the WASM VFS. */
  pragma(statement) {
    try {
      this.raw.exec(`PRAGMA ${statement}`);
    } catch {
      /* not supported by this driver — safe to skip */
    }
    return this;
  }

  /**
   * Wrap `fn` so every call runs atomically. Nested calls join the outer
   * transaction via savepoints rather than committing early.
   */
  transaction(fn) {
    return (...args) => {
      const nested = this.depth > 0;
      const name = `sp_${this.depth}`;
      this.exec(nested ? `SAVEPOINT ${name}` : 'BEGIN');
      this.depth += 1;
      try {
        const result = fn(...args);
        this.depth -= 1;
        this.exec(nested ? `RELEASE ${name}` : 'COMMIT');
        return result;
      } catch (error) {
        this.depth -= 1;
        try {
          this.exec(nested ? `ROLLBACK TO ${name}` : 'ROLLBACK');
          if (nested) this.exec(`RELEASE ${name}`);
        } catch {
          /* the transaction is already gone; surface the original error */
        }
        throw error;
      }
    };
  }

  close() {
    try {
      this.raw.close();
    } catch {
      /* already closed */
    }
  }
}

export function openDatabase(file) {
  // node-sqlite3-wasm marks a live write lock with `<db>.lock`. A crash or
  // hard kill leaves that directory behind, which would brick every later
  // open with "database is locked". This app is single-instance, so a
  // leftover lock is always stale recycle from a dead process — clear it.
  try {
    fs.rmSync(`${file}.lock`, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
  const db = new Sqlite(file);
  const shutdown = () => db.close();
  process.once('exit', shutdown);
  process.once('SIGINT', () => {
    shutdown();
    process.exit(0);
  });
  return db;
}
