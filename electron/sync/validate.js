/**
 * Input validation for the sync setup popup.
 *
 * Runs in the main process only (the DB password never reaches the renderer's
 * logic, but is still validated here before any connection attempt).
 */

import { log } from './log.js';

const PROJECT_URL_RE = /^https:\/\/([a-z0-9-]+)\.supabase\.(co|in)$/i;

export function extractProjectRef(projectUrl) {
  const match = String(projectUrl ?? '').match(PROJECT_URL_RE);
  return match ? match[1].toLowerCase() : null;
}

/**
 * Parse a Supabase "Session pooler" connection string pasted from the
 * dashboard (Connect → Session pooler). The one-line URI carries the exact
 * host, port, user (postgres.<ref>), database and the DB password, so no
 * region probing is needed:
 *
 *   postgresql://postgres.<ref>:<password>@aws-0-<region>.pooler.supabase.com:5432/postgres
 *
 * Returns null when the field is empty; throws a French, actionable message
 * when the URI cannot be interpreted.
 */
export function parsePoolerUri(uri) {
  const text = String(uri ?? '').trim();
  if (!text) return null;

  let url;
  try {
    url = new URL(text);
  } catch {
    throw new Error('La chaîne de connexion est invalide.');
  }

  const scheme = url.protocol.replace(':', '');
  if (scheme !== 'postgres' && scheme !== 'postgresql') {
    throw new Error('La chaîne de connexion doit commencer par « postgresql:// ».');
  }

  const host = url.hostname.toLowerCase();
  if (!host.endsWith('.pooler.supabase.com')) {
    throw new Error(
      'Utilisez la chaîne « Session pooler » du tableau de bord Supabase (connecteur aws-0-<région>.pooler.supabase.com).'
    );
  }

  const regionMatch = host.match(/^aws-0-(.+)\.pooler\.supabase\.com$/);
  if (!regionMatch) {
    throw new Error('Impossible de détecter la région depuis la chaîne de connexion.');
  }

  const user = decodeURIComponent(url.username || '').trim();
  const refMatch = user.match(/^postgres\.([a-z0-9]+)$/i);
  if (!refMatch) {
    throw new Error('Le nom d’utilisateur doit être « postgres.<ref> » (format « Session pooler » de Supabase).');
  }

  return {
    host,
    port: url.port ? Number(url.port) : 5432,
    database: (url.pathname || '').replace(/^\//, '') || 'postgres',
    user,
    password: decodeURIComponent(url.password || ''),
    region: regionMatch[1],
    projectRef: refMatch[1].toLowerCase(),
    projectUrl: `https://${refMatch[1].toLowerCase()}.supabase.co`,
  };
}

export function validateSetup(payload) {
  const errors = [];
  const projectUrl = String(payload?.projectUrl ?? '').trim().replace(/\/+$/, '');
  const publishableKey = String(payload?.publishableKey ?? '').trim();
  const databasePassword = String(payload?.databasePassword ?? '');
  const connectionUri = String(payload?.connectionUri ?? '').trim();

  let parsedUri = null;
  if (connectionUri) {
    try {
      parsedUri = parsePoolerUri(connectionUri);
    } catch (error) {
      errors.push(error?.message ?? 'La chaîne de connexion est invalide.');
    }
  }

  // A pasted session-pooler URI is authoritative: it carries its own host,
  // password, project ref and region, so the URL field is not needed then.
  const projectRef = parseProjectRefFor(parsedUri, projectUrl);
  if (!projectRef) {
    errors.push(
      'L’URL du projet est invalide. Format attendu : https://<ref>.supabase.co (ou fournissez la chaîne de connexion du pooler).'
    );
  }

  // The publishable key is optional: it only enables the friendly health-check
  // preflight and is never used for the actual Postgres/pooler connection.
  // When provided, it is still format-checked so a half-copied key does not
  // surface later as a confusing connection error.
  if (publishableKey) {
    if (/\s/.test(publishableKey)) {
      errors.push('La clé semble incomplète : elle contient un espace. Collez la clé publishable complète en une seule ligne.');
    } else if (!publishableKey.startsWith('sb_publishable_')) {
      errors.push('La clé doit être une clé publishable (préfixe « sb_publishable_… »).');
    }
  }

  const hasUriPassword = (parsedUri?.password?.length ?? 0) > 0;
  if (!databasePassword && !hasUriPassword) {
    errors.push('Le mot de passe de la base de données est obligatoire pour la configuration initiale.');
  }

  return {
    errors,
    projectRef,
    projectUrl: parsedUri?.projectUrl ?? projectUrl,
    publishableKey,
    databasePassword,
    connectionUri,
    parsedUri,
  };
}

function parseProjectRefFor(parsedUri, projectUrl) {
  if (parsedUri) return parsedUri.projectRef;
  return extractProjectRef(projectUrl);
}

/**
 * Probe the project's auth health endpoint with the publishable key.
 * Distinguishes a genuinely unreachable project from a rejected key so the
 * popup can show the right, actionable message.
 */
export async function checkProjectHealth(projectUrl, publishableKey) {
  const url = `${projectUrl.replace(/\/+$/, '')}/auth/v1/health`;
  const started = Date.now();
  log.info('healthcheck', `GET ${url}`);
  try {
    const res = await fetch(url, {
      headers: { apikey: publishableKey },
      signal: AbortSignal.timeout(10000),
    });
    const body = await res.text().catch(() => '');
    const elapsed = Date.now() - started;
    log.info(
      'healthcheck',
      `status=${res.status} duration=${elapsed}ms body=${JSON.stringify(body).slice(0, 500)}`
    );
    if (res.ok) return { ok: true, reason: 'ok' };
    if (/invalid api key/i.test(body)) {
      log.warn('healthcheck', 'rejected as invalid key');
      return { ok: false, reason: 'invalid-key' };
    }
    log.warn('healthcheck', `non-200 response (${res.status})`);
    return { ok: false, reason: `http-${res.status}` };
  } catch (error) {
    const elapsed = Date.now() - started;
    log.error('healthcheck', `request failed after ${elapsed}ms`, error);
    return { ok: false, reason: 'unreachable' };
  }
}
