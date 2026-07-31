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
  clearCredentials,
} from './credentials.js';
import { runMigrations, resolveConnection } from './migrator.js';
import { validateSetup, checkProjectHealth } from './validate.js';
import { runSyncCycle, getLastSync } from './engine.js';

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
    configured: !!(creds?.projectUrl && creds?.publishableKey),
    projectUrl: creds?.projectUrl ?? null,
    projectRef,
    hasDbPassword: !!creds?.hasDbPassword,
    connection: creds?.connection ?? null,
    lastSyncAt: last.lastSyncAt,
    lastError: last.lastError,
  };
}

export function registerSyncIpc() {
  ipcMain.handle('sync:status', () => statusPayload());

  ipcMain.handle('sync:setup', async (_event, payload) => {
    const { errors, projectRef, projectUrl, publishableKey, databasePassword } =
      validateSetup(payload);
    if (errors.length > 0) return { ok: false, errors };

    const health = await checkProjectHealth(projectUrl, publishableKey);
    if (!health.ok) {
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

    try {
      const { connection, method, region } = await resolveConnection(
        { projectUrl },
        databasePassword
      );
      const result = await runMigrations(connection, databasePassword);
      await saveCredentials({
        projectUrl,
        publishableKey,
        databasePassword,
        connection: { method, region: region ?? null },
      });
      runSyncCycle(); // first background sync (enabled is set by saveCredentials)
      return {
        ok: true,
        ...result,
        projectUrl,
        projectRef,
        connection: { method, region: region ?? null },
      };
    } catch (error) {
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
    if (enabled && !(creds?.projectUrl && creds?.publishableKey)) {
      return {
        ok: false,
        errors: ['Configurez d’abord les identifiants du projet Supabase.'],
      };
    }
    await setEnabled(!!enabled);
    if (enabled) {
      // Kick off an immediate sync; the background scheduler takes over after.
      runSyncCycle();
    }
    return { ok: true, ...statusPayload() };
  });

  ipcMain.handle('sync:now', async () => {
    const result = await runSyncCycle();
    return { ok: result.ok, error: result.error ?? null, ...statusPayload() };
  });

  ipcMain.handle('sync:forget', async () => {
    await clearCredentials();
    return { ok: true, ...statusPayload() };
  });
}
