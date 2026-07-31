/**
 * Background sync engine.
 *
 * Local-first: SQLite is authoritative for the UI; the cloud is a mirror.
 * One sync cycle = pull cloud changes → reserve invoice numbers → push local
 * changes. Runs on a timer while sync is enabled.
 *
 * Concurrency
 * -----------
 * Writes (Express API) and this engine share the same in-process SQLite
 * connection, so every local mutation is synchronous. Local change detection
 * captures dirty rows in a synchronous transaction before any network call:
 * a row edited while a push is in flight keeps its dirty flag (finalize only
 * clears it if `updated_at` is unchanged), so nothing is ever lost.
 *
 * Conflicts are last-write-wins by updated_at. Pull applies a cloud row only
 * when it is newer than the local copy; push sends a local row only when it
 * is still dirty after the pull (i.e. local is the newer copy).
 *
 * Numbering: while online the engine reserves batches from the cloud counter
 * (reserve_invoice_numbers) so numbers issued offline cannot collide across
 * devices. A UNIQUE(year, seq) violation during push renumbers the invoice as
 * a safety net.
 */

import crypto from 'node:crypto';
import pg from 'pg';
import { runMigrations, resolveConnection } from './migrator.js';
import { loadCredentials, decryptSecret, saveCredentials } from './credentials.js';

export const SYNC_INTERVAL_MS = 30_000;
const BATCH_SIZE = 25;
const RESERVE_MARGIN = 5;
const EPOCH = '1970-01-01T00:00:00.000Z';

let db = null;
let lastSyncAt = null;
let lastError = null;
let cycleRunning = false;
let schedulerTimer = null;

async function initDb() {
  if (db) return db;
  const mod = await import('../../server/db.js');
  db = mod.db;
  return db;
}

const iso = (value) => {
  if (value === null || value === undefined || value === '') return null;
  if (value instanceof Date) return value.toISOString();
  return String(value);
};

function getMeta(key) {
  return db.prepare('SELECT value FROM sync_meta WHERE key = ?').get(key)?.value ?? null;
}

function setMeta(key, value) {
  db.prepare(
    'INSERT INTO sync_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, value);
}

const isUniqueViolation = (error) => String(error?.code ?? '') === '23505';

/* ------------------------------------------------------------------ */
/* Pull                                                               */
/* ------------------------------------------------------------------ */

async function pullUnits(client) {
  const last = getMeta('pull_units') ?? EPOCH;
  const { rows } = await client.query(
    'SELECT id, name, address, archived, created_at, updated_at, deleted_at FROM public.units WHERE updated_at >= $1 ORDER BY updated_at',
    [last]
  );
  if (rows.length === 0) return 0;

  let maxTs = last;
  const applying = [];
  for (const row of rows) {
    const ts = iso(row.updated_at);
    if (ts > maxTs) maxTs = ts;
    const existing = db.prepare('SELECT id, updated_at FROM units WHERE cloud_id = ?').get(row.id);
    if (existing && iso(existing.updated_at) >= ts) continue;
    applying.push({ row, ts });
  }

  db.transaction(() => {
    const upsert = db.prepare(
      `INSERT INTO units (cloud_id, name, address, archived, created_at, updated_at, sync_dirty)
       VALUES (?, ?, ?, ?, ?, ?, 0)
       ON CONFLICT(cloud_id) WHERE cloud_id IS NOT NULL DO UPDATE SET
         name = excluded.name, address = excluded.address,
         archived = excluded.archived, updated_at = excluded.updated_at, sync_dirty = 0`
    );
    for (const { row, ts } of applying) {
      if (row.deleted_at) {
        db.prepare('UPDATE units SET archived = 1 WHERE cloud_id = ?').run(row.id);
      } else {
        upsert.run(row.id, row.name, row.address, row.archived ? 1 : 0, iso(row.created_at), ts);
      }
    }
    setMeta('pull_units', maxTs);
  })();
  return applying.length;
}

async function pullClients(client) {
  const last = getMeta('pull_clients') ?? EPOCH;
  const { rows } = await client.query(
    'SELECT id, name, type, location, nif, art, phone, email, archived, created_at, updated_at, deleted_at FROM public.clients WHERE updated_at >= $1 ORDER BY updated_at',
    [last]
  );
  if (rows.length === 0) return 0;

  let maxTs = last;
  const applying = [];
  for (const row of rows) {
    const ts = iso(row.updated_at);
    if (ts > maxTs) maxTs = ts;
    const existing = db.prepare('SELECT id, updated_at FROM clients WHERE cloud_id = ?').get(row.id);
    if (existing && iso(existing.updated_at) >= ts) continue;
    applying.push({ row, ts });
  }

  db.transaction(() => {
    const upsert = db.prepare(
      `INSERT INTO clients (cloud_id, name, type, location, nif, art, phone, email, archived, created_at, updated_at, sync_dirty)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
       ON CONFLICT(cloud_id) WHERE cloud_id IS NOT NULL DO UPDATE SET
         name = excluded.name, type = excluded.type, location = excluded.location,
         nif = excluded.nif, art = excluded.art, phone = excluded.phone, email = excluded.email,
         archived = excluded.archived, updated_at = excluded.updated_at, sync_dirty = 0`
    );
    for (const { row, ts } of applying) {
      if (row.deleted_at) {
        db.prepare('UPDATE clients SET archived = 1 WHERE cloud_id = ?').run(row.id);
      } else {
        upsert.run(row.id, row.name, row.type, row.location, row.nif, row.art, row.phone, row.email, row.archived ? 1 : 0, iso(row.created_at), ts);
      }
    }
    setMeta('pull_clients', maxTs);
  })();
  return applying.length;
}

async function pullInvoices(client) {
  const last = getMeta('pull_invoices') ?? EPOCH;
  const { rows } = await client.query(
    `SELECT id, unit_id, client_id, client_name, client_type, client_location, client_nif, client_art,
            client_phone, seq, number, year, date, notes, tva_rate, page_orientation,
            total_nette, total_tva, total_fga, total_timbre, total_amount,
            created_at, updated_at, deleted_at
       FROM public.invoices WHERE updated_at >= $1 ORDER BY updated_at`,
    [last]
  );
  if (rows.length === 0) return 0;

  let maxTs = last;
  const ids = rows.map((r) => r.id);
  const { rows: lineRows } = await client.query(
    'SELECT invoice_id, position, police, echeance, nette, fga, timbre, obs FROM public.invoice_lines WHERE invoice_id = ANY($1) ORDER BY invoice_id, position',
    [ids]
  );
  const linesByInvoice = new Map();
  for (const l of lineRows) {
    if (!linesByInvoice.has(l.invoice_id)) linesByInvoice.set(l.invoice_id, []);
    linesByInvoice.get(l.invoice_id).push(l);
  }

  const applying = [];
  for (const row of rows) {
    const ts = iso(row.updated_at);
    if (ts > maxTs) maxTs = ts;
    const localUnit = db.prepare('SELECT id FROM units WHERE cloud_id = ?').get(row.unit_id);
    if (!localUnit) continue; // unit not pulled yet — skip, retried next cycle
    const existing = db.prepare('SELECT id, updated_at FROM invoices WHERE cloud_id = ?').get(row.id);
    if (existing && iso(existing.updated_at) >= ts) continue;
    applying.push({ row, ts, unitId: localUnit.id });
  }

  db.transaction(() => {
    const upsert = db.prepare(
      `INSERT INTO invoices (cloud_id, unit_id, client_id, client_name, client_type, client_location, client_nif, client_art, client_phone,
                             seq, number, year, date, notes, tva_rate, page_orientation,
                             total_nette, total_tva, total_fga, total_timbre, total_amount, created_at, updated_at, sync_dirty)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
       ON CONFLICT(cloud_id) WHERE cloud_id IS NOT NULL DO UPDATE SET
         unit_id = excluded.unit_id, client_id = excluded.client_id,
         client_name = excluded.client_name, client_type = excluded.client_type,
         client_location = excluded.client_location, client_nif = excluded.client_nif,
         client_art = excluded.client_art, client_phone = excluded.client_phone,
         seq = excluded.seq, number = excluded.number, year = excluded.year, date = excluded.date,
         notes = excluded.notes, tva_rate = excluded.tva_rate, page_orientation = excluded.page_orientation,
         total_nette = excluded.total_nette, total_tva = excluded.total_tva,
         total_fga = excluded.total_fga, total_timbre = excluded.total_timbre,
         total_amount = excluded.total_amount, updated_at = excluded.updated_at, sync_dirty = 0`
    );
    const insertLine = db.prepare(
      'INSERT INTO invoice_lines (invoice_id, position, police, echeance, nette, fga, timbre, obs) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    );
    const reAnchor = db.prepare(
      'INSERT INTO counters (year, next_seq) VALUES (?, ?) ON CONFLICT(year) DO UPDATE SET next_seq = max(next_seq, excluded.next_seq)'
    );
    for (const { row, ts, unitId } of applying) {
      const existing = db.prepare('SELECT id FROM invoices WHERE cloud_id = ?').get(row.id);
      if (row.deleted_at) {
        if (existing) {
          db.prepare('DELETE FROM invoice_lines WHERE invoice_id = ?').run(existing.id);
          db.prepare('DELETE FROM invoices WHERE id = ?').run(existing.id);
        }
        continue;
      }
      const clientId = row.client_id
        ? db.prepare('SELECT id FROM clients WHERE cloud_id = ?').get(row.client_id)?.id ?? null
        : null;
      const info = upsert.run(
        row.id, unitId, clientId,
        row.client_name, row.client_type, row.client_location, row.client_nif, row.client_art, row.client_phone,
        row.seq, row.number, row.year, row.date, row.notes, row.tva_rate, row.page_orientation,
        row.total_nette, row.total_tva, row.total_fga, row.total_timbre, row.total_amount,
        iso(row.created_at), ts
      );
      const localId = existing?.id ?? info.lastInsertRowid;
      db.prepare('DELETE FROM invoice_lines WHERE invoice_id = ?').run(localId);
      for (const l of linesByInvoice.get(row.id) ?? []) {
        insertLine.run(localId, l.position, l.police, l.echeance, l.nette, l.fga, l.timbre, l.obs);
      }
      reAnchor.run(row.year, row.seq + 1);
    }
    setMeta('pull_invoices', maxTs);
  })();
  return applying.length;
}

async function pullSettings(client) {
  const { rows } = await client.query('SELECT key, value, updated_at FROM public.settings');
  let applied = 0;
  db.transaction(() => {
    for (const row of rows) {
      const ts = iso(row.updated_at);
      const local = db.prepare('SELECT updated_at FROM settings WHERE key = ?').get(row.key);
      if (local && iso(local.updated_at) >= ts) continue;
      db.prepare(
        'INSERT INTO settings (key, value, updated_at, sync_dirty) VALUES (?, ?, ?, 0) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, sync_dirty = 0'
      ).run(row.key, JSON.stringify(row.value), ts);
      applied += 1;
    }
  })();
  return applied;
}

/* ------------------------------------------------------------------ */
/* Number reservation                                                 */
/* ------------------------------------------------------------------ */

async function reserveNumbers(client) {
  const years = new Set([new Date().getFullYear(), new Date().getFullYear() + 1]);
  for (const r of db.prepare('SELECT year FROM counters').all()) years.add(r.year);
  for (const r of db.prepare('SELECT DISTINCT year FROM invoices').all()) years.add(r.year);

  for (const year of years) {
    const batch = db.prepare('SELECT to_seq FROM seq_batches WHERE year = ?').get(year);
    const counter = db.prepare('SELECT next_seq FROM counters WHERE year = ?').get(year);
    const nextSeq = counter?.next_seq ?? 1;
    if (batch && nextSeq <= batch.to_seq - RESERVE_MARGIN) continue;

    const { rows } = await client.query('SELECT seq FROM public.reserve_invoice_numbers($1, $2)', [
      year,
      BATCH_SIZE,
    ]);
    if (!rows.length) continue;
    const to = rows[rows.length - 1].seq;
    db.transaction(() => {
      db.prepare(
        'INSERT INTO seq_batches (year, from_seq, to_seq) VALUES (?, ?, ?) ON CONFLICT(year) DO UPDATE SET from_seq = excluded.from_seq, to_seq = excluded.to_seq'
      ).run(year, rows[0].seq, to);
      db.prepare(
        'INSERT INTO counters (year, next_seq) VALUES (?, ?) ON CONFLICT(year) DO UPDATE SET next_seq = max(next_seq, excluded.next_seq)'
      ).run(year, to + 1);
    })();
  }
}

/* ------------------------------------------------------------------ */
/* Push                                                               */
/* ------------------------------------------------------------------ */

function captureUnits() {
  return db.transaction(() => {
    const rows = db
      .prepare('SELECT id, cloud_id, name, address, archived, created_at, updated_at FROM units WHERE sync_dirty = 1 OR cloud_id IS NULL')
      .all();
    const assign = db.prepare('UPDATE units SET cloud_id = ? WHERE id = ? AND cloud_id IS NULL');
    for (const row of rows) {
      if (!row.cloud_id) {
        row.cloud_id = crypto.randomUUID();
        assign.run(row.cloud_id, row.id);
      }
    }
    return rows;
  })();
}

function captureClients() {
  return db.transaction(() => {
    const rows = db
      .prepare('SELECT id, cloud_id, name, type, location, nif, art, phone, email, archived, created_at, updated_at FROM clients WHERE sync_dirty = 1 OR cloud_id IS NULL')
      .all();
    const assign = db.prepare('UPDATE clients SET cloud_id = ? WHERE id = ? AND cloud_id IS NULL');
    for (const row of rows) {
      if (!row.cloud_id) {
        row.cloud_id = crypto.randomUUID();
        assign.run(row.cloud_id, row.id);
      }
    }
    return rows;
  })();
}

function captureInvoices() {
  return db.transaction(() => {
    const rows = db
      .prepare(
        `SELECT i.id, i.cloud_id, i.unit_id, i.client_id, i.client_name, i.client_type, i.client_location,
                i.client_nif, i.client_art, i.client_phone, i.seq, i.number, i.year, i.date, i.notes,
                i.tva_rate, i.page_orientation, i.total_nette, i.total_tva, i.total_fga, i.total_timbre,
                i.total_amount, i.created_at, i.updated_at
           FROM invoices i
          WHERE i.sync_dirty = 1 OR i.cloud_id IS NULL`
      )
      .all();
    const assign = db.prepare('UPDATE invoices SET cloud_id = ? WHERE id = ? AND cloud_id IS NULL');
    for (const row of rows) {
      if (!row.cloud_id) {
        row.cloud_id = crypto.randomUUID();
        assign.run(row.cloud_id, row.id);
      }
      row.lines = db
        .prepare('SELECT position, police, echeance, nette, fga, timbre, obs FROM invoice_lines WHERE invoice_id = ? ORDER BY position')
        .all(row.id);
    }
    return rows;
  })();
}

function finalizeUnit(pushed) {
  db.prepare('UPDATE units SET sync_dirty = 0 WHERE id = ? AND updated_at = ?').run(pushed.id, pushed.updated_at);
}

function finalizeClient(pushed) {
  db.prepare('UPDATE clients SET sync_dirty = 0 WHERE id = ? AND updated_at = ?').run(pushed.id, pushed.updated_at);
}

function finalizeInvoice(pushed) {
  db.prepare('UPDATE invoices SET sync_dirty = 0 WHERE id = ? AND updated_at = ?').run(pushed.id, pushed.updated_at);
}

async function pushUnits(client) {
  const rows = captureUnits();
  let pushed = 0;
  for (const row of rows) {
    try {
      await client.query(
        `INSERT INTO public.units (id, name, address, archived, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (id) DO UPDATE SET
           name = EXCLUDED.name, address = EXCLUDED.address,
           archived = EXCLUDED.archived, updated_at = EXCLUDED.updated_at
         WHERE public.units.updated_at < EXCLUDED.updated_at`,
        [row.cloud_id, row.name, row.address, !!row.archived, row.created_at, row.updated_at]
      );
      finalizeUnit(row);
      pushed += 1;
    } catch (error) {
      // row stays dirty → retried next cycle
      lastError = `Unité « ${row.name} » : ${error?.message ?? error}`;
    }
  }
  return pushed;
}

async function pushClients(client) {
  const rows = captureClients();
  let pushed = 0;
  for (const row of rows) {
    try {
      await client.query(
        `INSERT INTO public.clients (id, name, type, location, nif, art, phone, email, archived, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         ON CONFLICT (id) DO UPDATE SET
           name = EXCLUDED.name, type = EXCLUDED.type, location = EXCLUDED.location,
           nif = EXCLUDED.nif, art = EXCLUDED.art, phone = EXCLUDED.phone, email = EXCLUDED.email,
           archived = EXCLUDED.archived, updated_at = EXCLUDED.updated_at
         WHERE public.clients.updated_at < EXCLUDED.updated_at`,
        [row.cloud_id, row.name, row.type, row.location, row.nif, row.art, row.phone, row.email, !!row.archived, row.created_at, row.updated_at]
      );
      finalizeClient(row);
      pushed += 1;
    } catch (error) {
      lastError = `Client « ${row.name} » : ${error?.message ?? error}`;
    }
  }
  return pushed;
}

async function pushInvoice(client, row, renumber = false) {
  const cloudUnitId = db.prepare('SELECT cloud_id FROM units WHERE id = ?').get(row.unit_id)?.cloud_id;
  if (!cloudUnitId) {
    throw new Error(`La facture ${row.number}/${row.year} référence une unité qui n’est pas encore synchronisée.`);
  }
  const cloudClientId = row.client_id
    ? db.prepare('SELECT cloud_id FROM clients WHERE id = ?').get(row.client_id)?.cloud_id ?? null
    : null;

  if (renumber) {
    const { rows: reserved } = await client.query('SELECT seq, number FROM public.reserve_invoice_numbers($1, 1)', [row.year]);
    const seq = reserved[0].seq;
    const number = reserved[0].number;
    row.seq = seq;
    row.number = number;
    row.updated_at = new Date().toISOString();
    db.prepare('UPDATE invoices SET seq = ?, number = ?, updated_at = ? WHERE id = ?').run(seq, number, row.updated_at, row.id);
  }

  await client.query(
    `INSERT INTO public.invoices (id, unit_id, client_id, client_name, client_type, client_location,
                                  client_nif, client_art, client_phone, seq, number, year, date, notes,
                                  tva_rate, page_orientation, total_nette, total_tva, total_fga, total_timbre,
                                  total_amount, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23)
     ON CONFLICT (id) DO UPDATE SET
       unit_id = EXCLUDED.unit_id, client_id = EXCLUDED.client_id,
       client_name = EXCLUDED.client_name, client_type = EXCLUDED.client_type,
       client_location = EXCLUDED.client_location, client_nif = EXCLUDED.client_nif,
       client_art = EXCLUDED.client_art, client_phone = EXCLUDED.client_phone,
       seq = EXCLUDED.seq, number = EXCLUDED.number, year = EXCLUDED.year, date = EXCLUDED.date,
       notes = EXCLUDED.notes, tva_rate = EXCLUDED.tva_rate, page_orientation = EXCLUDED.page_orientation,
       total_nette = EXCLUDED.total_nette, total_tva = EXCLUDED.total_tva,
       total_fga = EXCLUDED.total_fga, total_timbre = EXCLUDED.total_timbre,
       total_amount = EXCLUDED.total_amount, updated_at = EXCLUDED.updated_at,
       deleted_at = NULL
     WHERE public.invoices.updated_at < EXCLUDED.updated_at`,
    [row.cloud_id, cloudUnitId, cloudClientId, row.client_name, row.client_type, row.client_location,
     row.client_nif, row.client_art, row.client_phone, row.seq, row.number, row.year, row.date, row.notes,
     row.tva_rate, row.page_orientation, row.total_nette, row.total_tva, row.total_fga, row.total_timbre,
     row.total_amount, row.created_at, row.updated_at]
  );

  await client.query('DELETE FROM public.invoice_lines WHERE invoice_id = $1', [row.cloud_id]);
  const insertLine = client.query.bind(client);
  for (const l of row.lines) {
    await insertLine(
      'INSERT INTO public.invoice_lines (invoice_id, position, police, echeance, nette, fga, timbre, obs) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
      [row.cloud_id, l.position, l.police, l.echeance, l.nette, l.fga, l.timbre, l.obs]
    );
  }
}

async function pushInvoices(client) {
  const rows = captureInvoices();
  let pushed = 0;
  for (const row of rows) {
    try {
      await pushInvoice(client, row);
      finalizeInvoice(row);
      pushed += 1;
    } catch (error) {
      if (isUniqueViolation(error) && !row.retried) {
        row.retried = true;
        try {
          await pushInvoice(client, row, true);
          finalizeInvoice(row);
          pushed += 1;
          continue;
        } catch (retryError) {
          lastError = `Facture ${row.number}/${row.year} : ${retryError?.message ?? retryError}`;
        }
      } else {
        lastError = `Facture ${row.number}/${row.year} : ${error?.message ?? error}`;
      }
    }
  }
  return pushed;
}

async function pushSettings(client) {
  const rows = db
    .prepare('SELECT key, value, updated_at FROM settings WHERE sync_dirty = 1')
    .all();
  let pushed = 0;
  for (const row of rows) {
    try {
      await client.query(
        'INSERT INTO public.settings (key, value, updated_at) VALUES ($1, $2::jsonb, $3) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at WHERE public.settings.updated_at IS NULL OR public.settings.updated_at < EXCLUDED.updated_at',
        [row.key, row.value, row.updated_at]
      );
      db.prepare('UPDATE settings SET sync_dirty = 0 WHERE key = ? AND updated_at = ?').run(row.key, row.updated_at);
      pushed += 1;
    } catch (error) {
      lastError = `Réglage « ${row.key} » : ${error?.message ?? error}`;
    }
  }
  return pushed;
}

async function pushTombstones(client) {
  const tombstones = db
    .prepare('SELECT entity, local_id, cloud_id FROM sync_tombstones WHERE cloud_id IS NOT NULL')
    .all();
  for (const t of tombstones) {
    try {
      if (t.entity === 'invoices') {
        await client.query('DELETE FROM public.invoice_lines WHERE invoice_id = $1', [t.cloud_id]);
      }
      await client.query(
        `UPDATE public.${t.entity} SET deleted_at = now(), updated_at = now() WHERE id = $1 AND deleted_at IS NULL`,
        [t.cloud_id]
      );
      db.prepare('DELETE FROM sync_tombstones WHERE entity = ? AND local_id = ?').run(t.entity, t.local_id);
    } catch (error) {
      lastError = `Suppression (${t.entity}) : ${error?.message ?? error}`;
    }
  }
  // Rows that never reached the cloud need no tombstone.
  db.prepare('DELETE FROM sync_tombstones WHERE cloud_id IS NULL').run();
}

/* ------------------------------------------------------------------ */
/* Cycle                                                              */
/* ------------------------------------------------------------------ */

export function getLastSync() {
  return { lastSyncAt, lastError };
}

/**
 * Run one full sync cycle. Never throws: failures are recorded and reported
 * through getLastSync(). Returns a summary for callers that want it.
 */
export async function runSyncCycle() {
  await initDb();
  if (cycleRunning) return { ok: true, skipped: true };
  cycleRunning = true;

  const creds = loadCredentials();
  if (!creds?.projectUrl || !creds?.publishableKey) {
    cycleRunning = false;
    return { ok: false, error: 'Configuration du projet Supabase manquante.' };
  }

  const password = await decryptSecret(creds.dbSecret);
  if (!password) {
    lastError = 'Mot de passe de base de données indisponible. Refaites la configuration.';
    cycleRunning = false;
    return { ok: false, error: lastError };
  }

  let client = null;
  try {
    const { connection, method, region } = await resolveConnection(creds, password);
    if (creds.connection?.method !== method || creds.connection?.region !== region) {
      await saveCredentials({
        projectUrl: creds.projectUrl,
        publishableKey: creds.publishableKey,
        databasePassword: password,
        connection: { method, region: region ?? null },
      });
    }

    client = new pg.Client({ ...connection, password, statement_timeout: 120000 });
    await client.connect();

    // Apply any pending schema migrations (no-op when everything is applied).
    await runMigrations(connection, password);

    const pulled = {
      units: await pullUnits(client),
      clients: await pullClients(client),
      settings: await pullSettings(client),
      invoices: await pullInvoices(client),
    };
    await reserveNumbers(client);

    const pushed = {
      settings: await pushSettings(client),
      units: await pushUnits(client),
      clients: await pushClients(client),
      invoices: await pushInvoices(client),
    };
    await pushTombstones(client);

    await client.end();
    client = null;

    lastSyncAt = new Date().toISOString();
    lastError = null;
    return { ok: true, pulled, pushed };
  } catch (error) {
    lastError = error?.message ?? String(error);
    return { ok: false, error: lastError };
  } finally {
    if (client) {
      try { await client.end(); } catch { /* best effort */ }
    }
    cycleRunning = false;
  }
}

/* ------------------------------------------------------------------ */
/* Scheduler                                                          */
/* ------------------------------------------------------------------ */

export function startSyncScheduler() {
  if (schedulerTimer) return;
  schedulerTimer = setInterval(() => {
    const creds = loadCredentials();
    if (creds?.enabled) runSyncCycle();
  }, SYNC_INTERVAL_MS);
}

export function stopSyncScheduler() {
  if (schedulerTimer) {
    clearInterval(schedulerTimer);
    schedulerTimer = null;
  }
}

export function isCycleRunning() {
  return cycleRunning;
}
