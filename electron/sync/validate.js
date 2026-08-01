/**
 * Input validation for the sync setup popup.
 *
 * Runs in the main process only (the DB password never reaches the renderer's
 * logic, but is still validated here before any connection attempt).
 */

const PROJECT_URL_RE = /^https:\/\/([a-z0-9-]+)\.supabase\.(co|in)$/i;

export function extractProjectRef(projectUrl) {
  const match = String(projectUrl ?? '').match(PROJECT_URL_RE);
  return match ? match[1].toLowerCase() : null;
}

export function validateSetup(payload) {
  const errors = [];
  const projectUrl = String(payload?.projectUrl ?? '').trim().replace(/\/+$/, '');
  const publishableKey = String(payload?.publishableKey ?? '').trim();
  const databasePassword = String(payload?.databasePassword ?? '');

  const projectRef = extractProjectRef(projectUrl);
  if (!projectRef) {
    errors.push(
      'L’URL du projet est invalide. Format attendu : https://<ref>.supabase.co'
    );
  }

  if (!publishableKey) {
    errors.push('La clé publishable est obligatoire.');
  } else if (/\s/.test(publishableKey)) {
    errors.push('La clé semble incomplète : elle contient un espace. Collez la clé publishable complète en une seule ligne.');
  } else if (!publishableKey.startsWith('sb_publishable_')) {
    errors.push('La clé doit être une clé publishable (préfixe « sb_publishable_… »).');
  }

  if (!databasePassword) {
    errors.push('Le mot de passe de la base de données est obligatoire pour la configuration initiale.');
  }

  return { errors, projectRef, projectUrl, publishableKey, databasePassword };
}

/**
 * Probe the project's auth health endpoint with the publishable key.
 * Distinguishes a genuinely unreachable project from a rejected key so the
 * popup can show the right, actionable message.
 */
export async function checkProjectHealth(projectUrl, publishableKey) {
  try {
    const res = await fetch(`${projectUrl.replace(/\/+$/, '')}/auth/v1/health`, {
      headers: { apikey: publishableKey },
      signal: AbortSignal.timeout(10000),
    });
    if (res.ok) return { ok: true, reason: 'ok' };
    const body = await res.text().catch(() => '');
    if (/invalid api key/i.test(body)) return { ok: false, reason: 'invalid-key' };
    return { ok: false, reason: `http-${res.status}` };
  } catch {
    return { ok: false, reason: 'unreachable' };
  }
}
