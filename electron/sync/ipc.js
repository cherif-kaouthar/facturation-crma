/**
 * IPC surface for cloud sync.
 *
 * Narrow, explicit channels only — there is deliberately no generic
 * "run arbitrary SQL" bridge. The renderer can query status, run the
 * one-time setup (project URL + publishable key + DB password), toggle
 * sync activity, or forget the stored credentials. The DB password never
 * leaves this module's handlers.
 */

import { ipcMain } from 'electron';
import {
  loadCredentials,
  saveCredentials,
  setEnabled,
  setScopes,
  clearCredentials,
  SYNC_SCOPES,
} from './credentials.js';
import { runMigrations, resolveConnection } from './migrator.js';
import { validateSetup, checkProjectHealth } from './validate.js';
import { runSyncCycle, getLastSync, resetConnection } from './engine.js';
import { log } from './log.js';

export function statusPayload() {
  const creds = loadCredentials();
  const last = getLastSync();
  let projectRef = null;
  if (creds?.projectUrl) {
    try {
      projectRef = new URL(creds.projectUrl).hostname.split('.')[0];
    } catch {
      projectRef = null;
    }
  }
  return {
    enabled: !!creds?.enabled,
    configured: !!creds?.projectUrl,
    projectUrl: creds?.projectUrl ?? null,
    projectRef,
    hasDbPassword: !!creds?.hasDbPassword,
    connection: creds?.connection ?? null,
    scopes: creds?.scopes ?? null,
    lastSyncAt: last.lastSyncAt,
    lastError: last.lastError,
    issues: last.issues ?? {},
    notices: last.notices ?? [],
  };
}

export function registerSyncIpc() {
  ipcMain.handle('sync:status', () => statusPayload());

  ipcMain.handle('sync:setup', async (_event, payload) => {
    const {
      errors,
      projectRef,
      projectUrl,
      publishableKey,
      databasePassword,
      connectionUri,
      parsedUri,
    } = validateSetup(payload);
    if (errors.length > 0) {
      log.warn('setup', `validation failed: ${errors.join(' | ')}`);
      return { ok: false, errors };
    }

    // A pasted "Session pooler" URI supplies the project URL and the database
    // password: prefer its values over the (possibly empty) text fields.
    const finalProjectUrl = parsedUri?.projectUrl ?? projectUrl;
    const finalPassword = parsedUri?.password ? parsedUri.password : databasePassword;
    const finalProjectRef = parsedUri?.projectRef ?? projectRef;

    if (parsedUri) {
      log.info('setup', `session-pooler URI provided (${parsedUri.host}), skipping probe`);
    } else {
      log.info('setup', `health check for project ${finalProjectRef} (no key: ${!publishableKey})`);
    }
    if (publishableKey) {
      // Preflight only: distinguishing a wrong project from an unreachable one
      // gives a clearer error than letting the Postgres attempt fail slowly.
      const health = await checkProjectHealth(finalProjectUrl, publishableKey);
      if (!health.ok) {
        log.warn('setup', `health check failed (${health.reason})`);
        if (health.reason === 'invalid-key') {
          return {
            ok: false,
            errors: [
              'La clé publishable est invalide. Vérifiez qu’elle a été copiée en entier, sans espaces ni saut de ligne.',
            ],
          };
        }
        return {
          ok: false,
          errors: [
            'Le projet Supabase est injoignable. Vérifiez l’URL et la connexion internet.',
          ],
        };
      }
    }

    try {
      let connection;
      let method;
      let region;
      if (parsedUri) {
        // The one-line session-pooler string is exact: no probing, no region
        // guesswork. Everything needed for the direct pg connection is in it.
        connection = {
          host: parsedUri.host,
          port: parsedUri.port,
          database: parsedUri.database,
          user: parsedUri.user,
          ssl: { rejectUnauthorized: false },
        };
        method = 'pooler';
        region = parsedUri.region;
        log.info('setup', `connecting with session pooler ${parsedUri.user}@${parsedUri.host}:${parsedUri.port}`);
      } else {
        log.info('setup', `health check ok — resolving Postgres connection for ${finalProjectRef}`);
        const resolved = await resolveConnection({ projectUrl: finalProjectUrl }, finalPassword);
        connection = resolved.connection;
        method = resolved.method;
        region = resolved.region ?? null;
        log.info('setup', `connection resolved via ${method}${region ? ` (${region})` : ''}`);
      }
      const result = await runMigrations(connection, finalPassword);
      log.info('setup', `migrations ok: ${result.newlyApplied.length} applied, ${result.appliedVersions.length} total on server`);
      await saveCredentials({
        projectUrl: finalProjectUrl,
        publishableKey,
        databasePassword: finalPassword,
        connection: { method, region: region ?? null },
      });
      await resetConnection(); // credentials changed — drop any cached client
      runSyncCycle(); // first background sync (enabled is set by saveCredentials)
      return {
        ok: true,
        ...result,
        projectUrl: finalProjectUrl,
        projectRef: finalProjectRef,
        connection: { method, region: region ?? null },
      };
    } catch (error) {
      log.error('setup', 'database connection or migration failed', error);
      return {
        ok: false,
        errors: [
          error?.message ||
            'La connexion à la base de données a échoué. Vérifiez le mot de passe puis réessayez.',
        ],
      };
    }
  });

  ipcMain.handle('sync:toggle', async (_event, enabled) => {
    const creds = loadCredentials();
    if (enabled && !creds?.projectUrl) {
      log.warn('toggle', 'refused: credentials not configured yet');
      return {
        ok: false,
        errors: ['Configurez d’abord les identifiants du projet Supabase.'],
      };
    }
    await setEnabled(!!enabled);
    log.info('toggle', enabled ? 'sync enabled' : 'sync disabled');
    if (enabled) {
      // Kick off an immediate sync; the background scheduler takes over after.
      runSyncCycle();
    }
    return { ok: true, ...statusPayload() };
  });

  ipcMain.handle('sync:scopes', async (_event, patch) => {
    const creds = loadCredentials();
    if (!creds) return { ok: false, errors: ['Configurez d’abord la synchronisation.'] };

    const clean = {};
    for (const key of SYNC_SCOPES) {
      if (typeof patch?.[key] === 'boolean') clean[key] = patch[key];
    }
    await setScopes(clean);
    log.info('scopes', JSON.stringify(clean));
    // Apply the new selection straight away rather than after the next tick.
    if (loadCredentials()?.enabled) runSyncCycle();
    return { ok: true, ...statusPayload() };
  });

  ipcMain.handle('sync:now', async () => {
    let result = await runSyncCycle();
    // A cycle was already in flight, so this request only queued a rerun.
    // Wait for a real one rather than reporting a success that never ran.
    if (result.skipped) {
      await new Promise((resolve) => setTimeout(resolve, 1200));
      result = await runSyncCycle();
    }
    log.info('now', `cycle ok=${result.ok} error=${result.error ?? 'none'}`);
    return { ok: result.ok, error: result.error ?? null, ...statusPayload() };
  });

  ipcMain.handle('sync:forget', async () => {
    await clearCredentials();
    await resetConnection();
    log.info('forget', 'credentials cleared');
    return { ok: true, ...statusPayload() };
  });
}
