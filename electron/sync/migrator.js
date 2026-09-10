/**
 * Migration runner for the customer's Supabase Postgres database.
 *
 * Connects directly to Postgres with the project's DB password (main process
 * only), applies any pending migrations/*.sql files inside a transaction, and
 * records each applied version in public.schema_migrations so future app
 * updates can push only the new migrations.
 *
 * Connection routing
 * ------------------
 * Supabase's direct endpoint (db.<ref>.supabase.co:5432, user "postgres") is
 * IPv6-only unless the project has the paid IPv4 add-on. On IPv4-only networks
 * we fall back to the shared pooler (Supavisor) in session mode:
 *   aws-0-<region>.pooler.supabase.com:5432  user "postgres.<ref>"
 * Because the project URL alone does not reveal the region, setup probes the
 * pooler hosts until one authenticates with the given DB password, then reuses
 * that connection method for every later migration on this device.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dns from 'node:dns';
import pg from 'pg';
import { log } from './log.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const MIGRATIONS_DIR = path.resolve(__dirname, '..', '..', 'migrations');

const lookup = (host) =>
  dns.promises.lookup(host, { all: false, verbatim: true }).then(
    () => true,
    () => false
  );

/** Most likely regions first: the project's AAAA block (2a05:d018) is RIPE (Europe). */
export const SUPABASE_REGIONS = [
  'eu-central-1', 'eu-west-1', 'eu-west-2', 'eu-west-3', 'eu-north-1',
  'eu-south-1', 'eu-south-2', 'eu-central-2',
  'us-east-1', 'us-east-2', 'us-central-1', 'us-west-1', 'us-west-2',
  'sa-east-1', 'ca-central-1',
  'ap-southeast-1', 'ap-southeast-2', 'ap-southeast-3',
  'ap-northeast-1', 'ap-northeast-2', 'ap-northeast-3',
  'ap-south-1', 'ap-east-1',
  'me-central-1', 'me-south-1', 'af-south-1',
];

const CONNECT_TIMEOUT_MS = 6000;

/** Direct connection info derived from the project URL. */
export function postgresConnectionInfo(projectRef) {
  return {
    host: `db.${projectRef}.supabase.co`,
    port: 5432,
    database: 'postgres',
    user: 'postgres',
    ssl: { rejectUnauthorized: false },
  };
}

function poolerConnectionInfo(projectRef, region) {
  return {
    host: `aws-0-${region}.pooler.supabase.com`,
    port: 5432,
    database: 'postgres',
    user: `postgres.${projectRef}`,
    ssl: { rejectUnauthorized: false },
  };
}

async function tryConnect(connection, password) {
  const client = new pg.Client({
    ...connection,
    password,
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
    statement_timeout: 120000,
  });
  const started = Date.now();
  log.info('connect', `attempt ${connection.user}@${connection.host}:${connection.port}`);
  try {
    await client.connect();
    const elapsed = Date.now() - started;
    log.info('connect', `ok in ${elapsed}ms (${connection.user}@${connection.host})`);
    return { ok: true, client };
  } catch (error) {
    const elapsed = Date.now() - started;
    log.error('connect', `failed after ${elapsed}ms`, error);
    return { ok: false, error, code: error?.code };
  }
}

function describeError(error) {
  const message = String(error?.message ?? error);
  if (/password authentication failed/i.test(message)) return 'bad-password';
  if (/does not exist/i.test(message)) return 'unknown-tenant';
  if (/ENOTFOUND|ENETUNREACH|EAI_AGAIN|ETIMEDOUT|ECONNREFUSED|EACCES/i.test(message)) {
    return 'network';
  }
  return 'other';
}

/**
 * Find a working Postgres connection. Prefers the direct IPv6 endpoint; on
 * IPv4-only networks, probes the shared pooler regions until one authenticates.
 * Returns { connection, method } where method is "direct" or "pooler".
 */
export async function findWorkingConnection({ projectRef, password }) {
  log.info('findconnection', `probing direct endpoint db.${projectRef}.supabase.co`);
  const direct = postgresConnectionInfo(projectRef);
  const directResult = await tryConnect(direct, password);
  if (directResult.ok) {
    return { connection: direct, method: 'direct', client: directResult.client };
  }

  // Probe the pooler. Skip hosts that do not resolve; the correct region
  // authenticates with the given password.
  const candidates = [];
  for (const region of SUPABASE_REGIONS) {
    const connection = poolerConnectionInfo(projectRef, region);
    // eslint-disable-next-line no-await-in-loop
    const resolves = await lookup(connection.host);
    log.info(
      'findconnection',
      `dns ${resolves ? 'resolves' : 'NO DNS'} aws-0-${region}.pooler.supabase.com`
    );
    if (resolves) candidates.push({ region, connection });
  }

  let sawPasswordFailure = false;
  for (const { region, connection } of candidates) {
    // eslint-disable-next-line no-await-in-loop
    const result = await tryConnect(connection, password);
    if (result.ok) {
      return { connection, method: 'pooler', region, client: result.client };
    }
    if (describeError(result.error) === 'bad-password') sawPasswordFailure = true;
  }

  const directError = describeError(directResult.error);
  log.warn(
    'findconnection',
    `direct=${directError} poolerCandidates=${candidates.length} badPasswordOnPooler=${sawPasswordFailure}`
  );
  const reasons = [];
  if (directError === 'network') {
    reasons.push(
      'La connexion directe (db.<ref>.supabase.co) est en IPv6 uniquement et n’est pas joignable depuis ce réseau.'
    );
  }
  if (sawPasswordFailure) {
    reasons.push(
      'Le pooler a rejeté les identifiants : le mot de passe de la base de données semble incorrect.'
    );
  }
  if (reasons.length === 0) {
    reasons.push('Aucun point de connexion Supabase n’est joignable depuis ce réseau.');
  }
  throw new Error(reasons.join(' '));
}

export function listMigrationFiles() {
  if (!fs.existsSync(MIGRATIONS_DIR)) return [];
  return fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((file) => /^\d{4}_.*\.sql$/.test(file))
    .sort();
}

/**
 * Reuse the connection method recorded at setup when possible; otherwise probe
 * (direct IPv6 endpoint first, then the shared pooler regions). Returns a
 * connection config — it does not connect, so callers own the pg Client.
 */
export async function resolveConnection(creds, password) {
  const projectRef = new URL(creds.projectUrl).hostname.split('.')[0];
  const stored = creds?.connection;
  if (stored?.method === 'direct') {
    log.info('resolveconnection', `reusing stored direct endpoint (${projectRef})`);
    return { connection: postgresConnectionInfo(projectRef), method: 'direct', region: null };
  }
  if (stored?.method === 'pooler' && stored.region) {
    log.info('resolveconnection', `reusing stored pooler region ${stored.region} (${projectRef})`);
    return {
      connection: poolerConnectionInfo(projectRef, stored.region),
      method: 'pooler',
      region: stored.region,
    };
  }
  log.info('resolveconnection', `no stored connection — probing (${projectRef})`);
  const found = await findWorkingConnection({ projectRef, password });
  if (found.client) {
    try { await found.client.end(); } catch { /* best effort */ }
  }
  return { connection: found.connection, method: found.method, region: found.region ?? null };
}

/**
 * Apply all pending migrations. Each migration runs in its own transaction
 * together with its schema_migrations INSERT, so a failure rolls everything
 * back and leaves the DB on the last good version.
 */
export async function runMigrations(connection, password) {
  const client = new pg.Client({ ...connection, password, statement_timeout: 120000 });
  log.info('migrate', `connecting to apply migrations (${connection.user}@${connection.host})`);
  await client.connect();
  try {
    await client.query(
      `create table if not exists public.schema_migrations (
         version    integer primary key,
         applied_at timestamptz not null default now()
       )`
    );
    const appliedResult = await client.query(
      'select version from public.schema_migrations order by version'
    );
    const applied = new Set(appliedResult.rows.map((row) => row.version));
    log.info('migrate', `already applied on server: [${[...applied].sort((a, b) => a - b).join(', ') || 'none'}]`);

    const newlyApplied = [];
    for (const file of listMigrationFiles()) {
      const version = Number.parseInt(file.slice(0, 4), 10);
      if (!Number.isInteger(version) || applied.has(version)) continue;

      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
      log.info('migrate', `applying ${file} (version ${version})`);
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query(
          'insert into public.schema_migrations (version) values ($1)',
          [version]
        );
        await client.query('COMMIT');
        newlyApplied.push({ version, file });
      } catch (error) {
        await client.query('ROLLBACK');
        log.error('migrate', `migration ${file} failed`, error);
        throw new Error(
          `La migration ${file} a échoué. Le schéma n’a pas été modifié : ${error?.message ?? error}`
        );
      }
    }

    if (newlyApplied.length > 0) {
      log.info('migrate', `applied ${newlyApplied.map((m) => m.file).join(', ')}`);
    } else {
      log.info('migrate', 'no pending migrations');
    }
    return { appliedVersions: [...applied].sort((a, b) => a - b), newlyApplied };
  } finally {
    await client.end();
  }
}
