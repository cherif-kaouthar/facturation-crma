/**
 * Timestamp bookkeeping for the sync engine.
 *
 * Pulled out of engine.js because these few rules are where the interesting
 * sync bugs lived, and because keeping them free of Electron/pg imports makes
 * them directly testable.
 *
 * Two separate concerns:
 *
 * 1. Time domains. Local rows are stamped with the *device* clock, cloud rows
 *    with Postgres now(). Comparing them directly makes last-write-wins depend
 *    on how wrong a device's clock is, so everything is converted into the
 *    server domain before any comparison.
 *
 * 2. Watermarks. A pull remembers how far it got. Advancing that mark past a
 *    row that was not actually applied loses the row permanently, and
 *    advancing it to exactly the newest row seen loses rows that commit out of
 *    timestamp order.
 */

export const EPOCH = '1970-01-01T00:00:00.000Z';

/**
 * How far back each pull re-reads. A transaction that began before ours can
 * commit after it while carrying an earlier updated_at; without a lag the
 * watermark steps straight over it and that row is never seen again.
 */
export const PULL_LAG_MS = 60_000;

/** Normalise anything Postgres or SQLite hands back to an ISO string. */
export function iso(value) {
  if (value === null || value === undefined || value === '') return null;
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

/**
 * Coerce a Postgres `date` into the plain 'YYYY-MM-DD' text the local schema
 * stores.
 *
 * node-postgres parses a `date` column into a JS Date at *local* midnight.
 * Binding that object into SQLite fails outright ("Unsupported type for
 * binding: object"), and the obvious repair — toISOString().slice(0, 10) —
 * silently reports the previous day for any timezone east of UTC, which
 * includes Algeria (UTC+1). Read the local calendar fields instead.
 */
export function dateOnly(value) {
  if (value === null || value === undefined || value === '') return null;
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    const pad = (n) => String(n).padStart(2, '0');
    return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`;
  }
  return String(value).slice(0, 10);
}

/** Translate a device-clock ISO timestamp into the server's time domain. */
export function toServerTs(localIso, clockOffsetMs) {
  const ms = Date.parse(localIso);
  if (!Number.isFinite(ms)) return new Date(Date.now() + clockOffsetMs).toISOString();
  return new Date(ms + clockOffsetMs).toISOString();
}

/**
 * A local row's timestamp expressed in server time, ready to compare against a
 * cloud value. A clean row already carries the cloud's own stamp; a dirty row
 * carries this device's clock and has to be translated.
 */
export function localTsInServerDomain(row, clockOffsetMs) {
  const ts = iso(row?.updated_at);
  if (!ts) return null;
  return row.sync_dirty ? toServerTs(ts, clockOffsetMs) : ts;
}

/** The floor actually sent to Postgres: the stored watermark minus the lag. */
export function queryFloor(stored) {
  const ms = Date.parse(stored);
  if (!Number.isFinite(ms)) return EPOCH;
  const lagged = ms - PULL_LAG_MS;
  return lagged <= 0 ? EPOCH : new Date(lagged).toISOString();
}

/**
 * Advance a watermark without ever stepping over a row we could not apply yet.
 *
 * `maxSeen` is the newest timestamp in the batch; `minDeferred` is the oldest
 * row we had to postpone (an invoice whose unit has not been pulled yet). The
 * previous implementation ignored `minDeferred` entirely, so deferred rows were
 * skipped and never fetched again — they were lost from that device for good.
 * Capping behind the earliest deferred row makes the retry real.
 *
 * Never returns a value earlier than `previous`: a watermark must not rewind.
 */
export function nextWatermark(previous, maxSeen, minDeferred) {
  let candidate = maxSeen;
  if (minDeferred) {
    const cap = new Date(Date.parse(minDeferred) - 1).toISOString();
    if (cap < candidate) candidate = cap;
  }
  return candidate > previous ? candidate : previous;
}
