/**
 * Background sync engine.
 *
 * Local-first: SQLite is authoritative for the UI; the cloud is a mirror.
 * One sync cycle = pull cloud changes → reserve invoice numbers → push local
 * changes. Runs on a short timer, and immediately (debounced) whenever this
 * device writes something.
 *
 * Concurrency
 * -----------
 * Writes (Express API) and this engine share the same in-process SQLite
 * connection, so every local mutation is synchronous. Local change detection
 * captures dirty rows in a synchronous transaction before any network call:
 * a row edited while a push is in flight keeps its dirty flag (finalize only
 * clears it if `updated_at` is unchanged), so nothing is ever lost.
 *
 * Conflicts are last-write-wins by updated_at.
 *
 * Time domain
 * -----------
 * Local writes stamp the *device* clock; cloud triggers stamp Postgres now().
 * Comparing the two directly makes last-write-wins depend on how wrong a
 * device's clock is — a machine running 5 minutes fast silently wins every
 * conflict, one running slow silently loses every edit. So each cycle measures
 * the server/device offset and every comparison and push is done in the
 * *server* time domain. After a successful push the local row is stamped with
 * the same timestamp the cloud now holds, which keeps the two in lockstep.
 *
 * Deletes
 * -------
 * Deletes are deliberately device-local: removing a record here does not
 * remove it on other devices (product decision). The local tombstone is kept
 * forever and used as a pull blocklist so a record deleted on this device is
 * never resurrected by a later pull. Because the cloud is therefore the union
 * of what the devices hold, pushing a record also clears any deleted_at left
 * behind by older builds that did propagate deletes. To make deletes propagate
 * again, set PROPAGATE_DELETES to true — see pushTombstones().
 *
 * Numbering: while online the engine reserves batches from the cloud counter
 * (reserve_invoice_numbers) so numbers issued offline cannot collide across
 * devices. A UNIQUE(year, seq) violation during push renumbers the invoice as
 * a safety net.
 */

import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import pg from 'pg';
import { runMigrations, resolveConnection } from './migrator.js';
import { loadCredentials, decryptSecret, saveCredentials } from './credentials.js';
import { localChanges } from '../../server/changes.js';
import {
  EPOCH,
  dateOnly,
  iso,
  nextWatermark,
  queryFloor,
  toServerTs as toServerTsAt,
  localTsInServerDomain as localTsInServerDomainAt,
} from './timeline.js';

/**
 * Hand back Postgres `date` values (OID 1082) as the plain 'YYYY-MM-DD' text
 * they arrive as, instead of parsing them into JS Date objects.
 *
 * The local schema stores dates as TEXT, and SQLite cannot bind an object at
 * all — an unconverted Date aborted the whole invoice pull with "Unsupported
 * type for binding: object". Keeping the raw string also sidesteps the
 * timezone shift that Date round-tripping introduces east of UTC.
 */
pg.types.setTypeParser(1082, (value) => value);

/** Background poll. Short, because a cycle is now cheap (see connect()). */
export const SYNC_INTERVAL_MS = 5_000;
/** Coalescing window for "this device just wrote something". */
const PUSH_DEBOUNCE_MS = 600;
const BATCH_SIZE = 25;
const RESERVE_MARGIN = 5;

/** Flip to true to make deletes remove the record on every device. */
const PROPAGATE_DELETES = false;

let db = null;
let lastSyncAt = null;
let lastError = null;
let cycleRunning = false;
let rerunRequested = false;
let schedulerTimer = null;
let debounceTimer = null;

/** Emits 'changed' after a cycle that actually applied cloud data. */
export const syncEvents = new EventEmitter();

async function initDb() {
  if (db) return db;
  const mod = await import('../../server/db.js');
  db = mod.db;
  return db;
}

function getMeta(key) {
  return db.prepare('SELECT value FROM sync_meta WHERE key = ?').get(key)?.value ?? null;
}

function setMeta(key, value) {
  db.prepare(
    'INSERT INTO sync_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, value);
}

const isUniqueViolation = (error) => String(error?.code ?? '') === '23505';
const isForeignKeyViolation = (error) => String(error?.code ?? '') === '23503';

/* ------------------------------------------------------------------ */
/* Time domain                                                        */
/* ------------------------------------------------------------------ */

/** serverNow - deviceNow, in ms. Re-measured at the start of every cycle. */
let clockOffsetMs = 0;

async function measureClockOffset(client) {
  const before = Date.now();
  const { rows } = await client.query('SELECT now() AS now');
  const after = Date.now();
  // Charge half the round-trip to each direction.
  clockOffsetMs = new Date(rows[0].now).getTime() - (before + after) / 2;
}

/** Bind the shared helpers to the offset measured for this cycle. */
const toServerTs = (localIso) => toServerTsAt(localIso, clockOffsetMs);
const localTsInServerDomain = (row) => localTsInServerDomainAt(row, clockOffsetMs);

/* ------------------------------------------------------------------ */
/* Watermarks                                                         */
/* ------------------------------------------------------------------ */

function readWatermark(key) {
  return getMeta(key) ?? EPOCH;
}

/* ------------------------------------------------------------------ */
/* Cloud identity                                                     */
/* ------------------------------------------------------------------ */

/**
 * Every local row remembers the cloud UUID it was pushed under. Those ids only
 * mean anything inside the project that issued them, so pointing the app at a
 * different Supabase project (or a project whose tables were dropped and
 * recreated) leaves the whole database referring to rows that do not exist —
 * which surfaces as invoices_unit_id_fkey violations that never clear.
 *
 * Detect the switch and start over: forget the old ids, mark everything for
 * re-upload, and rewind the pull watermarks so the new project's contents are
 * read in full.
 */
function adoptProject(projectRef) {
  const known = getMeta('cloud_project_ref');
  if (known === projectRef) return false;
  if (!known) {
    // First sync on this device — nothing to reconcile.
    setMeta('cloud_project_ref', projectRef);
    return false;
  }

  db.transaction(() => {
    for (const table of ['units', 'clients', 'invoices']) {
      db.prepare(`UPDATE ${table} SET cloud_id = NULL, sync_dirty = 1`).run();
    }
    db.prepare('UPDATE settings SET sync_dirty = 1').run();
    // Tombstones reference ids from the old project; they mean nothing here.
    db.prepare('DELETE FROM sync_tombstones').run();
    db.prepare('DELETE FROM seq_batches').run();
    for (const key of ['pull_units', 'pull_clients', 'pull_invoices', 'pull_settings']) {
      setMeta(key, EPOCH);
    }
    setMeta('cloud_project_ref', projectRef);
  })();

  recordNotice('Nouveau projet Supabase détecté : toutes les données de ce poste vont être renvoyées.');
  return true;
}

/* ------------------------------------------------------------------ */
/* Invoice number collisions                                          */
/* ------------------------------------------------------------------ */

/**
 * Make room for an incoming cloud invoice that claims a (year, seq) already
 * used by a *different* local invoice.
 *
 * This is the single biggest cause of "invoices never sync". Two devices that
 * both started from the bundled database issue 0001/2026, 0002/2026 … from
 * their own local counter, so the first pull hits the local
 * UNIQUE(year, seq) constraint. That raised inside the pull transaction and
 * aborted the entire cycle — including every push — which is why clients
 * (pulled earlier) kept working while invoices and settings silently stopped.
 *
 * The cloud row keeps its number: it is the one other devices already agreed
 * on. The local-only invoice is renumbered to the next free sequence and left
 * dirty so it pushes under its new number.
 *
 * Returns a short description when something was renumbered, for reporting.
 */
function makeRoomForSeq(cloudId, year, seq) {
  const clash = db
    .prepare('SELECT id, number, cloud_id FROM invoices WHERE year = ? AND seq = ?')
    .get(year, seq);
  if (!clash || clash.cloud_id === cloudId) return null;

  if (clash.cloud_id) {
    // Both rows are known to the cloud, which enforces UNIQUE(year, seq) —
    // so this should be unreachable. Leave it alone rather than corrupt data.
    return `Conflit de numéro ${clash.number}/${year} entre deux factures déjà synchronisées.`;
  }

  const maxSeq = db.prepare('SELECT MAX(seq) AS m FROM invoices WHERE year = ?').get(year)?.m ?? 0;
  const counter = db.prepare('SELECT next_seq FROM counters WHERE year = ?').get(year)?.next_seq ?? 1;
  const freeSeq = Math.max(maxSeq + 1, counter);
  const padding = String(clash.number ?? '').length || 4;
  const freeNumber = String(freeSeq).padStart(padding, '0');

  db.prepare(
    'UPDATE invoices SET seq = ?, number = ?, updated_at = ?, sync_dirty = 1 WHERE id = ?'
  ).run(freeSeq, freeNumber, new Date().toISOString(), clash.id);
  db.prepare(
    'INSERT INTO counters (year, next_seq) VALUES (?, ?) ON CONFLICT(year) DO UPDATE SET next_seq = max(next_seq, excluded.next_seq)'
  ).run(year, freeSeq + 1);

  return `Facture ${clash.number}/${year} renumérotée en ${freeNumber}/${year} (numéro déjà utilisé sur un autre poste).`;
}

/* ------------------------------------------------------------------ */
/* Tombstones as a pull blocklist                                     */
/* ------------------------------------------------------------------ */

/**
 * Cloud ids deleted on this device. Pull skips them so a record removed here
 * is not silently re-created by the next pull. Tombstones are kept forever
 * (they are three small columns) precisely because they are the only memory
 * this device has of the deletion.
 */
function deletedCloudIds(entity) {
  const rows = db
    .prepare('SELECT cloud_id FROM sync_tombstones WHERE entity = ? AND cloud_id IS NOT NULL')
    .all(entity);
  return new Set(rows.map((r) => r.cloud_id));
}

/* ------------------------------------------------------------------ */
/* Pull                                                               */
/* ------------------------------------------------------------------ */

async function pullUnits(client) {
  const stored = readWatermark('pull_units');
  const { rows } = await client.query(
    'SELECT id, name, address, archived, created_at, updated_at, deleted_at FROM public.units WHERE updated_at >= $1 ORDER BY updated_at',
    [queryFloor(stored)]
  );
  if (rows.length === 0) return 0;

  const blocked = deletedCloudIds('units');
  let maxSeen = stored;
  const applying = [];

  for (const row of rows) {
    const ts = iso(row.updated_at);
    if (ts > maxSeen) maxSeen = ts;
    // Deleted here, or deleted elsewhere: either way this device keeps what it
    // has (deletes do not propagate — see the module header).
    if (blocked.has(row.id) || row.deleted_at) continue;
    const existing = db
      .prepare('SELECT id, updated_at, sync_dirty FROM units WHERE cloud_id = ?')
      .get(row.id);
    if (existing && localTsInServerDomain(existing) >= ts) continue;
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
      upsert.run(row.id, row.name, row.address, row.archived ? 1 : 0, iso(row.created_at), ts);
    }
    setMeta('pull_units', nextWatermark(stored, maxSeen, null));
  })();
  return applying.length;
}

async function pullClients(client) {
  const stored = readWatermark('pull_clients');
  const { rows } = await client.query(
    'SELECT id, name, type, location, nif, art, phone, email, archived, created_at, updated_at, deleted_at FROM public.clients WHERE updated_at >= $1 ORDER BY updated_at',
    [queryFloor(stored)]
  );
  if (rows.length === 0) return 0;

  const blocked = deletedCloudIds('clients');
  let maxSeen = stored;
  const applying = [];

  for (const row of rows) {
    const ts = iso(row.updated_at);
    if (ts > maxSeen) maxSeen = ts;
    if (blocked.has(row.id) || row.deleted_at) continue;
    const existing = db
      .prepare('SELECT id, updated_at, sync_dirty FROM clients WHERE cloud_id = ?')
      .get(row.id);
    if (existing && localTsInServerDomain(existing) >= ts) continue;
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
      upsert.run(
        row.id, row.name, row.type, row.location, row.nif, row.art, row.phone, row.email,
        row.archived ? 1 : 0, iso(row.created_at), ts
      );
    }
    setMeta('pull_clients', nextWatermark(stored, maxSeen, null));
  })();
  return applying.length;
}

async function pullInvoices(client) {
  const stored = readWatermark('pull_invoices');
  const { rows } = await client.query(
    `SELECT id, unit_id, client_id, client_name, client_type, client_location, client_nif, client_art,
            client_phone, seq, number, year, date, notes, tva_rate, page_orientation,
            total_nette, total_tva, total_fga, total_timbre, total_amount,
            created_at, updated_at, deleted_at
       FROM public.invoices WHERE updated_at >= $1 ORDER BY updated_at`,
    [queryFloor(stored)]
  );
  if (rows.length === 0) return 0;

  const blocked = deletedCloudIds('invoices');
  const blockedUnits = deletedCloudIds('units');
  let maxSeen = stored;
  let minDeferred = null;
  const applying = [];

  for (const row of rows) {
    const ts = iso(row.updated_at);
    if (ts > maxSeen) maxSeen = ts;
    if (blocked.has(row.id) || row.deleted_at) continue;

    // The unit was deleted on this device, so it will never be pulled back and
    // this invoice can never be applied. Skip it outright — deferring would
    // pin the watermark forever and stall every later invoice behind it.
    if (blockedUnits.has(row.unit_id)) continue;

    const localUnit = db.prepare('SELECT id FROM units WHERE cloud_id = ?').get(row.unit_id);
    if (!localUnit) {
      // Its unit has not landed yet. Hold the watermark behind this row so the
      // next cycle genuinely retries it instead of skipping it forever.
      if (!minDeferred || ts < minDeferred) minDeferred = ts;
      continue;
    }
    const existing = db
      .prepare('SELECT id, updated_at, sync_dirty FROM invoices WHERE cloud_id = ?')
      .get(row.id);
    if (existing && localTsInServerDomain(existing) >= ts) continue;
    applying.push({ row, ts, unitId: localUnit.id });
  }

  if (applying.length === 0) {
    db.transaction(() => {
      setMeta('pull_invoices', nextWatermark(stored, maxSeen, minDeferred));
    })();
    return 0;
  }

  // Fetch lines only for the invoices we are actually going to write.
  const { rows: lineRows } = await client.query(
    'SELECT invoice_id, position, police, echeance, nette, fga, timbre, obs FROM public.invoice_lines WHERE invoice_id = ANY($1) ORDER BY invoice_id, position',
    [applying.map((a) => a.row.id)]
  );
  const linesByInvoice = new Map();
  for (const l of lineRows) {
    if (!linesByInvoice.has(l.invoice_id)) linesByInvoice.set(l.invoice_id, []);
    linesByInvoice.get(l.invoice_id).push(l);
  }

  const notices = [];

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
      // Free up (year, seq) first: the local UNIQUE constraint would otherwise
      // abort this transaction and, with it, the whole cycle.
      const renumbered = makeRoomForSeq(row.id, row.year, row.seq);
      if (renumbered) notices.push(renumbered);

      const existing = db.prepare('SELECT id FROM invoices WHERE cloud_id = ?').get(row.id);
      const clientId = row.client_id
        ? db.prepare('SELECT id FROM clients WHERE cloud_id = ?').get(row.client_id)?.id ?? null
        : null;
      const info = upsert.run(
        row.id, unitId, clientId,
        row.client_name, row.client_type, row.client_location, row.client_nif, row.client_art, row.client_phone,
        row.seq, row.number, row.year, dateOnly(row.date), row.notes, row.tva_rate, row.page_orientation,
        row.total_nette, row.total_tva, row.total_fga, row.total_timbre, row.total_amount,
        iso(row.created_at), ts
      );
      const localId = existing?.id ?? info.lastInsertRowid;
      db.prepare('DELETE FROM invoice_lines WHERE invoice_id = ?').run(localId);
      for (const l of linesByInvoice.get(row.id) ?? []) {
        insertLine.run(localId, l.position, l.police, dateOnly(l.echeance), l.nette, l.fga, l.timbre, l.obs);
      }
      reAnchor.run(row.year, row.seq + 1);
    }
    setMeta('pull_invoices', nextWatermark(stored, maxSeen, minDeferred));
  })();
  for (const notice of notices) recordNotice(notice);
  return applying.length;
}

async function pullSettings(client) {
  const stored = readWatermark('pull_settings');
  const { rows } = await client.query(
    'SELECT key, value, updated_at FROM public.settings WHERE updated_at >= $1',
    [queryFloor(stored)]
  );
  if (rows.length === 0) return 0;

  let maxSeen = stored;
  let applied = 0;
  db.transaction(() => {
    for (const row of rows) {
      const ts = iso(row.updated_at);
      if (ts > maxSeen) maxSeen = ts;
      const local = db.prepare('SELECT updated_at, sync_dirty FROM settings WHERE key = ?').get(row.key);
      const localTs = localTsInServerDomain(local);
      if (localTs && localTs >= ts) continue;
      db.prepare(
        'INSERT INTO settings (key, value, updated_at, sync_dirty) VALUES (?, ?, ?, 0) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, sync_dirty = 0'
      ).run(row.key, JSON.stringify(row.value), ts);
      applied += 1;
    }
    setMeta('pull_settings', nextWatermark(stored, maxSeen, null));
  })();
  return applied;
}

/**
 * A push was rejected by the last-write-wins guard: the cloud copy is newer.
 *
 * Clear our dirty flag (so we stop re-pushing a losing copy), rewind the local
 * row's stamp so the next pull is guaranteed to overwrite it, and rewind the
 * table watermark — the winning cloud row may sit *behind* our watermark, in
 * which case a normal incremental pull would never fetch it again.
 *
 * Only reachable when a third device wrote the same record inside one cycle,
 * so the cost of the full re-read is irrelevant.
 */
function yieldToCloud(table, watermarkKey, keyColumn, keyValue, updatedAt) {
  // `IS` rather than `=` so a NULL updated_at (possible on settings) matches.
  db.prepare(
    `UPDATE ${table} SET sync_dirty = 0, updated_at = ? WHERE ${keyColumn} = ? AND updated_at IS ?`
  ).run(EPOCH, keyValue, updatedAt ?? null);
  setMeta(watermarkKey, EPOCH);
}

/* ------------------------------------------------------------------ */
/* Counters                                                           */
/* ------------------------------------------------------------------ */

/**
 * Undo the damage from the runaway-reservation bug, once.
 *
 * reserveNumbers used to advance the counter past every block it reserved
 * instead of to the start of it, so each cycle threw away 25 numbers and
 * reserved 25 more — thousands of phantom numbers with no invoices behind
 * them. Bring the counter back to the first genuinely free number.
 *
 * Conservative on purpose: it only fires when the gap is far larger than a
 * legitimate reservation could explain, and it never rewinds onto a number
 * already issued. pushCounters then clamps the result against the numbers the
 * *cloud* knows about, so a device that simply had not pulled yet cannot cause
 * a duplicate.
 */
const RUNAWAY_GAP = BATCH_SIZE * 2;

function repairRunawayCounters() {
  if (getMeta('counters_runaway_repaired')) return;

  const repaired = [];
  db.transaction(() => {
    for (const row of db.prepare('SELECT year, next_seq FROM counters').all()) {
      const issued = db.prepare('SELECT MAX(seq) AS m FROM invoices WHERE year = ?').get(row.year)?.m ?? 0;
      const floor = issued + 1;
      if (row.next_seq <= floor + RUNAWAY_GAP) continue;

      db.prepare('UPDATE counters SET next_seq = ?, sync_dirty = 1 WHERE year = ?').run(floor, row.year);
      db.prepare('DELETE FROM seq_batches WHERE year = ?').run(row.year);
      repaired.push({ year: row.year, from: row.next_seq, to: floor });
    }
    setMeta('counters_runaway_repaired', '1');
  })();

  for (const r of repaired) {
    recordNotice(`Numérotation ${r.year} corrigée : ${r.from} → ${r.to} (numéros perdus par un défaut de réservation).`);
  }
}

/**
 * Push an explicit numbering change.
 *
 * Only rows the user deliberately moved (repo.setNextSeq marks them dirty) are
 * sent. Ordinary counter movement is not pushed: reserve_invoice_numbers is
 * the authority there, and echoing every local increment back would fight it.
 *
 * The write is an override, not a max(), because the whole point of the
 * "prochain numéro" control is to be able to move the numbering *down* — but
 * never below a number already issued, which the cloud re-anchor enforces.
 */
async function pushCounters(client) {
  const rows = db.prepare('SELECT year, next_seq FROM counters WHERE sync_dirty = 1').all();
  let pushed = 0;
  for (const row of rows) {
    try {
      const { rows: issued } = await client.query(
        'SELECT coalesce(max(seq), 0) + 1 AS floor FROM public.invoices WHERE year = $1',
        [row.year]
      );
      const value = Math.max(row.next_seq, issued[0]?.floor ?? 1);
      await client.query(
        `INSERT INTO public.counters (year, next_seq) VALUES ($1, $2)
         ON CONFLICT (year) DO UPDATE SET next_seq = EXCLUDED.next_seq`,
        [row.year, value]
      );
      db.prepare('UPDATE counters SET sync_dirty = 0 WHERE year = ? AND next_seq = ?')
        .run(row.year, row.next_seq);
      if (value !== row.next_seq) {
        // The cloud already issued past the requested number.
        db.prepare('UPDATE counters SET next_seq = ? WHERE year = ?').run(value, row.year);
        recordNotice(`Numérotation ${row.year} ajustée à ${value} : les numéros précédents sont déjà utilisés.`);
      }
      pushed += 1;
    } catch (error) {
      cycleIssues.counters = `Numérotation ${row.year} : ${error?.message ?? error}`;
    }
  }
  return pushed;
}

/**
 * Adopt a numbering change made on another device.
 *
 * Skipped while this device is part-way through a reserved block — those
 * numbers are already spoken for here, and rewinding onto them would hand out
 * duplicates. Never moves the counter below a number already issued locally.
 */
async function pullCounters(client) {
  const { rows } = await client.query('SELECT year, next_seq FROM public.counters');
  let applied = 0;
  db.transaction(() => {
    for (const row of rows) {
      const local = db.prepare('SELECT next_seq, sync_dirty FROM counters WHERE year = ?').get(row.year);
      if (local?.sync_dirty) continue; // our own pending change wins

      const batch = db.prepare('SELECT to_seq FROM seq_batches WHERE year = ?').get(row.year);
      const current = local?.next_seq ?? 1;
      if (batch && current <= batch.to_seq) continue; // mid-block, leave it alone

      const issued = db.prepare('SELECT MAX(seq) AS m FROM invoices WHERE year = ?').get(row.year)?.m ?? 0;
      const value = Math.max(row.next_seq, issued + 1);
      if (value === current) continue;

      db.prepare(
        'INSERT INTO counters (year, next_seq, sync_dirty) VALUES (?, ?, 0) ON CONFLICT(year) DO UPDATE SET next_seq = excluded.next_seq'
      ).run(row.year, value);
      db.prepare('DELETE FROM seq_batches WHERE year = ?').run(row.year);
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
    const from = rows[0].seq;
    const to = rows[rows.length - 1].seq;
    db.transaction(() => {
      db.prepare(
        'INSERT INTO seq_batches (year, from_seq, to_seq) VALUES (?, ?, ?) ON CONFLICT(year) DO UPDATE SET from_seq = excluded.from_seq, to_seq = excluded.to_seq'
      ).run(year, from, to);
      // Start issuing at the *beginning* of the block we just reserved.
      //
      // This used to set next_seq = to + 1, which threw the whole block away
      // the instant it was reserved: the next cycle saw an exhausted batch and
      // reserved another 25, and so on. At a 5-second poll that burned ~300
      // invoice numbers a minute and ran the counter into the thousands
      // without a single invoice being created.
      db.prepare(
        'INSERT INTO counters (year, next_seq) VALUES (?, ?) ON CONFLICT(year) DO UPDATE SET next_seq = max(next_seq, excluded.next_seq)'
      ).run(year, from);
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

/* ------------------------------------------------------------------ */
/* Parent rows (foreign keys)                                          */
/* ------------------------------------------------------------------ */

/**
 * Cloud ids confirmed present during this cycle, so the check costs one query
 * per unit/client rather than one per invoice.
 */
let cloudUnitsPresent = new Set();
let cloudClientsPresent = new Set();

function resetPresenceCache() {
  cloudUnitsPresent = new Set();
  cloudClientsPresent = new Set();
}

/**
 * Guarantee that an invoice's unit exists in the cloud, and return its id.
 *
 * A local cloud_id does NOT prove the cloud row exists. captureUnits() assigns
 * and persists a fresh UUID *before* pushing, so a failed push burns the id
 * locally with nothing on the other end; and because the push filter is
 * `sync_dirty = 1 OR cloud_id IS NULL`, a clean unit is never sent again — so
 * if the cloud row disappears (project reset or swapped, tables wiped, row
 * deleted by hand) it is never recreated. Either way every invoice under that
 * unit then fails with invoices_unit_id_fkey, permanently.
 *
 * Verifying the parent here is what makes an invoice push self-healing.
 */
async function ensureUnitInCloud(client, localUnitId) {
  const unit = db
    .prepare('SELECT id, cloud_id, name, address, archived, created_at, updated_at FROM units WHERE id = ?')
    .get(localUnitId);
  if (!unit) {
    throw new Error('La facture référence une unité de production qui n’existe plus sur ce poste.');
  }

  if (!unit.cloud_id) {
    unit.cloud_id = crypto.randomUUID();
    db.prepare('UPDATE units SET cloud_id = ?, sync_dirty = 1 WHERE id = ? AND cloud_id IS NULL')
      .run(unit.cloud_id, unit.id);
  }
  if (cloudUnitsPresent.has(unit.cloud_id)) return unit.cloud_id;

  const found = await client.query('SELECT 1 FROM public.units WHERE id = $1', [unit.cloud_id]);
  if (found.rowCount === 0) {
    await client.query(
      `INSERT INTO public.units (id, name, address, archived, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (id) DO NOTHING`,
      [unit.cloud_id, unit.name, unit.address, !!unit.archived, unit.created_at, toServerTs(unit.updated_at)]
    );
    recordNotice(`Unité « ${unit.name} » recréée dans le cloud (elle y était absente).`);
  }
  cloudUnitsPresent.add(unit.cloud_id);
  return unit.cloud_id;
}

/** Same guarantee for the optional client reference. Null stays null. */
async function ensureClientInCloud(client, localClientId) {
  if (!localClientId) return null;
  const person = db
    .prepare('SELECT id, cloud_id, name, type, location, nif, art, phone, email, archived, created_at, updated_at FROM clients WHERE id = ?')
    .get(localClientId);
  // A missing client is not fatal: the invoice keeps its denormalised copy of
  // the client details and simply carries no reference.
  if (!person) return null;

  if (!person.cloud_id) {
    person.cloud_id = crypto.randomUUID();
    db.prepare('UPDATE clients SET cloud_id = ?, sync_dirty = 1 WHERE id = ? AND cloud_id IS NULL')
      .run(person.cloud_id, person.id);
  }
  if (cloudClientsPresent.has(person.cloud_id)) return person.cloud_id;

  const found = await client.query('SELECT 1 FROM public.clients WHERE id = $1', [person.cloud_id]);
  if (found.rowCount === 0) {
    await client.query(
      `INSERT INTO public.clients (id, name, type, location, nif, art, phone, email, archived, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) ON CONFLICT (id) DO NOTHING`,
      [person.cloud_id, person.name, person.type, person.location, person.nif, person.art,
       person.phone, person.email, !!person.archived, person.created_at, toServerTs(person.updated_at)]
    );
    recordNotice(`Client « ${person.name} » recréé dans le cloud (il y était absent).`);
  }
  cloudClientsPresent.add(person.cloud_id);
  return person.cloud_id;
}

/**
 * Mark a pushed row clean and adopt the timestamp the cloud now holds, so the
 * local and cloud copies live in the same (server) time domain. The
 * `updated_at = ?` guard means a row edited while the push was in flight stays
 * dirty and is retried.
 */
function finalize(table, row, serverTs) {
  db.prepare(`UPDATE ${table} SET sync_dirty = 0, updated_at = ? WHERE id = ? AND updated_at = ?`)
    .run(serverTs, row.id, row.updated_at);
}

async function pushUnits(client) {
  const rows = captureUnits();
  let pushed = 0;
  for (const row of rows) {
    const serverTs = toServerTs(row.updated_at);
    try {
      const result = await client.query(
        `INSERT INTO public.units (id, name, address, archived, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (id) DO UPDATE SET
           name = EXCLUDED.name, address = EXCLUDED.address,
           archived = EXCLUDED.archived, updated_at = EXCLUDED.updated_at,
           deleted_at = NULL
         WHERE public.units.updated_at < EXCLUDED.updated_at
            OR public.units.updated_at > now() + interval '1 minute'
         RETURNING id`,
        [row.cloud_id, row.name, row.address, !!row.archived, row.created_at, serverTs]
      );
      if (result.rowCount === 0) {
        yieldToCloud('units', 'pull_units', 'id', row.id, row.updated_at);
        continue;
      }
      finalize('units', row, serverTs);
      pushed += 1;
    } catch (error) {
      // row stays dirty → retried next cycle
      cycleIssues.units = `Unité « ${row.name} » : ${error?.message ?? error}`;
    }
  }
  return pushed;
}

async function pushClients(client) {
  const rows = captureClients();
  let pushed = 0;
  for (const row of rows) {
    const serverTs = toServerTs(row.updated_at);
    try {
      const result = await client.query(
        `INSERT INTO public.clients (id, name, type, location, nif, art, phone, email, archived, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         ON CONFLICT (id) DO UPDATE SET
           name = EXCLUDED.name, type = EXCLUDED.type, location = EXCLUDED.location,
           nif = EXCLUDED.nif, art = EXCLUDED.art, phone = EXCLUDED.phone, email = EXCLUDED.email,
           archived = EXCLUDED.archived, updated_at = EXCLUDED.updated_at,
           deleted_at = NULL
         WHERE public.clients.updated_at < EXCLUDED.updated_at
            OR public.clients.updated_at > now() + interval '1 minute'
         RETURNING id`,
        [row.cloud_id, row.name, row.type, row.location, row.nif, row.art, row.phone, row.email, !!row.archived, row.created_at, serverTs]
      );
      if (result.rowCount === 0) {
        yieldToCloud('clients', 'pull_clients', 'id', row.id, row.updated_at);
        continue;
      }
      finalize('clients', row, serverTs);
      pushed += 1;
    } catch (error) {
      cycleIssues.clients = `Client « ${row.name} » : ${error?.message ?? error}`;
    }
  }
  return pushed;
}

/**
 * Push one invoice, header and lines together.
 *
 * Both statements run in a single Postgres transaction and the lines are only
 * replaced when the header write actually applied. Previously the lines were
 * rewritten even when the last-write-wins guard rejected the header, which
 * left the cloud holding the winner's totals next to the loser's lines.
 *
 * Returns true if the cloud row was written, false if the cloud copy won.
 */
async function pushInvoice(client, row, renumber = false) {
  const cloudUnitId = await ensureUnitInCloud(client, row.unit_id);
  const cloudClientId = await ensureClientInCloud(client, row.client_id);

  if (renumber) {
    const { rows: reserved } = await client.query('SELECT seq, number FROM public.reserve_invoice_numbers($1, 1)', [row.year]);
    const seq = reserved[0].seq;
    const number = reserved[0].number;
    const stamp = new Date().toISOString();
    db.prepare('UPDATE invoices SET seq = ?, number = ?, updated_at = ? WHERE id = ?')
      .run(seq, number, stamp, row.id);
    row.seq = seq;
    row.number = number;
    row.updated_at = stamp;
  }

  const serverTs = toServerTs(row.updated_at);

  await client.query('BEGIN');
  try {
    const result = await client.query(
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
       WHERE public.invoices.updated_at < EXCLUDED.updated_at
          OR public.invoices.updated_at > now() + interval '1 minute'
       RETURNING id`,
      [row.cloud_id, cloudUnitId, cloudClientId, row.client_name, row.client_type, row.client_location,
       row.client_nif, row.client_art, row.client_phone, row.seq, row.number, row.year, row.date, row.notes,
       row.tva_rate, row.page_orientation, row.total_nette, row.total_tva, row.total_fga, row.total_timbre,
       row.total_amount, row.created_at, serverTs]
    );

    if (result.rowCount === 0) {
      await client.query('ROLLBACK');
      return { applied: false, serverTs };
    }

    await client.query('DELETE FROM public.invoice_lines WHERE invoice_id = $1', [row.cloud_id]);
    for (const l of row.lines) {
      await client.query(
        'INSERT INTO public.invoice_lines (invoice_id, position, police, echeance, nette, fga, timbre, obs) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
        [row.cloud_id, l.position, l.police, l.echeance, l.nette, l.fga, l.timbre, l.obs]
      );
    }
    await client.query('COMMIT');
    return { applied: true, serverTs };
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* connection already gone */ }
    throw error;
  }
}

async function pushInvoices(client) {
  const rows = captureInvoices();
  let pushed = 0;

  for (const row of rows) {
    try {
      const { applied, serverTs } = await pushInvoice(client, row);
      if (applied) {
        finalize('invoices', row, serverTs);
        pushed += 1;
      } else {
        yieldToCloud('invoices', 'pull_invoices', 'id', row.id, row.updated_at);
      }
    } catch (error) {
      if (isForeignKeyViolation(error) && !row.retried) {
        // A parent vanished between our check and the insert (another device
        // deleting it, say). Re-verify from scratch and try once more.
        row.retried = true;
        resetPresenceCache();
        try {
          const retry = await pushInvoice(client, row);
          if (retry.applied) {
            finalize('invoices', row, retry.serverTs);
            pushed += 1;
          } else {
            yieldToCloud('invoices', 'pull_invoices', 'id', row.id, row.updated_at);
          }
          continue;
        } catch (retryError) {
          cycleIssues.invoices = `Facture ${row.number}/${row.year} : ${retryError?.message ?? retryError}`;
          continue;
        }
      }
      if (isUniqueViolation(error) && !row.retried) {
        row.retried = true;
        try {
          const retry = await pushInvoice(client, row, true);
          if (retry.applied) {
            finalize('invoices', row, retry.serverTs);
            pushed += 1;
          } else {
            // Don't leave it dirty: another renumber attempt every cycle would
            // burn a sequence number each time.
            yieldToCloud('invoices', 'pull_invoices', 'id', row.id, row.updated_at);
          }
          continue;
        } catch (retryError) {
          cycleIssues.invoices = `Facture ${row.number}/${row.year} : ${retryError?.message ?? retryError}`;
        }
      } else {
        cycleIssues.invoices = `Facture ${row.number}/${row.year} : ${error?.message ?? error}`;
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
    const serverTs = toServerTs(row.updated_at);
    try {
      const result = await client.query(
        `INSERT INTO public.settings (key, value, updated_at) VALUES ($1, $2::jsonb, $3)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at
         WHERE public.settings.updated_at IS NULL
            OR public.settings.updated_at < EXCLUDED.updated_at
            OR public.settings.updated_at > now() + interval '1 minute'
         RETURNING key`,
        [row.key, row.value, serverTs]
      );
      if (result.rowCount === 0) {
        yieldToCloud('settings', 'pull_settings', 'key', row.key, row.updated_at);
        continue;
      }
      // `IS` not `=`: settings.updated_at is nullable, and rows written before
      // sync existed carry NULL. With `=` the guard never matched, so the row
      // stayed dirty and was re-pushed on every single cycle, forever.
      db.prepare('UPDATE settings SET sync_dirty = 0, updated_at = ? WHERE key = ? AND updated_at IS ?')
        .run(serverTs, row.key, row.updated_at ?? null);
      pushed += 1;
    } catch (error) {
      cycleIssues.settings = `Réglage « ${row.key} » : ${error?.message ?? error}`;
    }
  }
  return pushed;
}

/**
 * Deletes are device-local by design, so this pushes nothing: the tombstone
 * stays in SQLite as a pull blocklist (see deletedCloudIds) and the cloud row
 * is left untouched for other devices.
 *
 * Setting PROPAGATE_DELETES = true restores cross-device deletion by writing a
 * soft-delete to the cloud instead.
 */
async function pushTombstones(client) {
  // Rows that never reached the cloud need no tombstone at all.
  db.prepare('DELETE FROM sync_tombstones WHERE cloud_id IS NULL').run();

  if (!PROPAGATE_DELETES) return;

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
    } catch (error) {
      cycleIssues.tombstones = `Suppression (${t.entity}) : ${error?.message ?? error}`;
    }
  }
}

/* ------------------------------------------------------------------ */
/* Connection                                                         */
/* ------------------------------------------------------------------ */

let pgClient = null;
let pgClientKey = null;
let migratedKey = null;

/**
 * One long-lived Postgres connection reused across cycles. Reconnecting every
 * few seconds — plus the per-cycle migration run the old engine did — made a
 * cycle cost seconds, which is why nothing ever felt immediate.
 */
async function connect(creds, password) {
  const key = `${creds.projectUrl}|${creds.connection?.method ?? ''}|${creds.connection?.region ?? ''}`;
  if (pgClient && pgClientKey === key) return pgClient;

  await disconnect();

  const { connection, method, region } = await resolveConnection(creds, password);
  if (creds.connection?.method !== method || creds.connection?.region !== region) {
    await saveCredentials({
      projectUrl: creds.projectUrl,
      publishableKey: creds.publishableKey,
      databasePassword: password,
      connection: { method, region: region ?? null },
    });
  }

  // Schema migrations are a one-time-per-process concern, not a per-cycle one.
  if (migratedKey !== creds.projectUrl) {
    await runMigrations(connection, password);
    migratedKey = creds.projectUrl;
  }

  const client = new pg.Client({ ...connection, password, statement_timeout: 120000 });
  client.on('error', () => {
    // Server-side disconnect: drop it so the next cycle reconnects.
    if (pgClient === client) {
      pgClient = null;
      pgClientKey = null;
    }
  });
  await client.connect();
  pgClient = client;
  pgClientKey = key;
  return pgClient;
}

async function disconnect() {
  const client = pgClient;
  pgClient = null;
  pgClientKey = null;
  if (client) {
    try { await client.end(); } catch { /* best effort */ }
  }
}

/* ------------------------------------------------------------------ */
/* Cycle                                                              */
/* ------------------------------------------------------------------ */

/**
 * Problems from the cycle in progress, keyed by entity. Collected per step so
 * one failing table is reported instead of being flattened into a single
 * `lastError` that the next success wipes out.
 */
let cycleIssues = {};
let cycleNotices = [];

function recordNotice(message) {
  if (!cycleNotices.includes(message)) cycleNotices.push(message);
}

export function getLastSync() {
  return { lastSyncAt, lastError, issues: cycleIssues, notices: cycleNotices };
}

/**
 * Run one step of a cycle in isolation.
 *
 * Previously every pull and push was awaited in a single expression, so the
 * first failure skipped everything after it. A local invoice-number clash in
 * pullInvoices therefore cancelled all four pushes, which is exactly why
 * invoices and settings stopped syncing while clients kept working.
 */
async function step(entity, phase, enabled, fn) {
  if (!enabled) return 0;
  try {
    return await fn();
  } catch (error) {
    const message = error?.message ?? String(error);
    cycleIssues[entity] = `${phase} : ${message}`;
    return 0;
  }
}

/**
 * Run one full sync cycle. Never throws: failures are recorded and reported
 * through getLastSync(). Returns a summary for callers that want it.
 */
export async function runSyncCycle() {
  await initDb();

  if (cycleRunning) {
    // Don't drop the request — a write that arrives mid-cycle must still be
    // pushed. Ask the running cycle to go round once more.
    rerunRequested = true;
    return { ok: true, skipped: true };
  }
  cycleRunning = true;

  try {
    return await runSyncCycleInner();
  } finally {
    cycleRunning = false;
    if (rerunRequested) {
      rerunRequested = false;
      setTimeout(() => { runSyncCycle(); }, 0);
    }
  }
}

async function runSyncCycleInner() {
  const creds = loadCredentials();
  if (!creds?.projectUrl || !creds?.publishableKey) {
    return { ok: false, error: 'Configuration du projet Supabase manquante.' };
  }

  const password = await decryptSecret(creds.dbSecret);
  if (!password) {
    lastError = 'Mot de passe de base de données indisponible. Refaites la configuration.';
    return { ok: false, error: lastError };
  }

  const scopes = creds.scopes;
  cycleIssues = {};
  cycleNotices = [];
  resetPresenceCache();

  try {
    const client = await connect(creds, password);
    await measureClockOffset(client);

    try {
      adoptProject(new URL(creds.projectUrl).hostname.split('.')[0]);
    } catch (error) {
      cycleIssues.project = error?.message ?? String(error);
    }

    // Each entity is isolated: one failing table must not cancel the rest.
    const pulled = {
      units: await step('units', 'réception', scopes.units, () => pullUnits(client)),
      clients: await step('clients', 'réception', scopes.clients, () => pullClients(client)),
      settings: await step('settings', 'réception', scopes.settings, () => pullSettings(client)),
      invoices: await step('invoices', 'réception', scopes.invoices, () => pullInvoices(client)),
    };

    // Numbering travels with invoices: it is meaningless without them.
    if (scopes.invoices) {
      await step('counters', 'numérotation', true, async () => repairRunawayCounters());
      await step('counters', 'numérotation', true, () => pushCounters(client));
      await step('counters', 'numérotation', true, () => pullCounters(client));
      await step('invoices', 'numérotation', true, () => reserveNumbers(client));
    }

    const pushed = {
      settings: await step('settings', 'envoi', scopes.settings, () => pushSettings(client)),
      units: await step('units', 'envoi', scopes.units, () => pushUnits(client)),
      clients: await step('clients', 'envoi', scopes.clients, () => pushClients(client)),
      invoices: await step('invoices', 'envoi', scopes.invoices, () => pushInvoices(client)),
    };
    await step('tombstones', 'nettoyage', true, () => pushTombstones(client));

    lastSyncAt = new Date().toISOString();
    // Keep per-entity failures visible: the old code cleared lastError on any
    // completed cycle, so a table that failed every single time still showed
    // a clean "last sync OK".
    const messages = Object.values(cycleIssues);
    lastError = messages.length > 0 ? messages.join(' · ') : null;

    const applied = pulled.units + pulled.clients + pulled.settings + pulled.invoices;
    if (applied > 0) syncEvents.emit('changed', { pulled });

    return { ok: messages.length === 0, pulled, pushed, issues: cycleIssues, error: lastError };
  } catch (error) {
    lastError = error?.message ?? String(error);
    // A broken connection must not be reused.
    await disconnect();
    return { ok: false, error: lastError, issues: cycleIssues };
  }
}

/* ------------------------------------------------------------------ */
/* Scheduler                                                          */
/* ------------------------------------------------------------------ */

/** Schedule a cycle very soon, coalescing bursts of local writes. */
export function requestSync() {
  if (debounceTimer) return;
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    const creds = loadCredentials();
    if (creds?.enabled) runSyncCycle();
  }, PUSH_DEBOUNCE_MS);
}

export function startSyncScheduler() {
  if (schedulerTimer) return;
  schedulerTimer = setInterval(() => {
    const creds = loadCredentials();
    if (creds?.enabled) runSyncCycle();
  }, SYNC_INTERVAL_MS);
  // Push local edits as soon as they happen instead of waiting for the timer.
  localChanges.on('change', requestSync);
}

export function stopSyncScheduler() {
  if (schedulerTimer) {
    clearInterval(schedulerTimer);
    schedulerTimer = null;
  }
  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
  localChanges.off('change', requestSync);
}

/** Drop the cached connection — call when credentials change or are cleared. */
export async function resetConnection() {
  migratedKey = null;
  await disconnect();
}

export function isCycleRunning() {
  return cycleRunning;
}
