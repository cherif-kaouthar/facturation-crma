/**
 * Credential store for cloud sync.
 *
 * Lives in the main process only. Holds the non-secret project URL and
 * publishable key in plain JSON under userData; the database password is
 * encrypted with Electron's safeStorage (fallback: keytar), and is only ever
 * decrypted to run schema migrations — never sent to the renderer.
 */

import { app, safeStorage } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { resolveScopes, SYNC_SCOPES } from './scopes.js';

export { resolveScopes, SYNC_SCOPES };

const SERVICE = 'facturation-sync';
const ACCOUNT = 'supabase-db-password';

function filePath() {
  return path.join(app.getPath('userData'), 'sync-credentials.json');
}

let keytarModule = null;
async function getKeytar() {
  if (keytarModule !== null) return keytarModule;
  try {
    keytarModule = await import('keytar');
  } catch {
    keytarModule = null;
  }
  return keytarModule;
}

function readFile() {
  try {
    if (!fs.existsSync(filePath())) return null;
    const parsed = JSON.parse(fs.readFileSync(filePath(), 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function writeFile(data) {
  fs.mkdirSync(path.dirname(filePath()), { recursive: true });
  fs.writeFileSync(filePath(), JSON.stringify(data, null, 2), 'utf8');
}

/** Stored credentials, without the decrypted password. */
export function loadCredentials() {
  const raw = readFile();
  if (!raw) return null;
  const connection =
    raw.connection && typeof raw.connection === 'object'
      ? raw.connection
      : null;
  return {
    projectUrl: typeof raw.projectUrl === 'string' ? raw.projectUrl : null,
    publishableKey: typeof raw.publishableKey === 'string' ? raw.publishableKey : null,
    enabled: !!raw.enabled,
    hasDbPassword: !!raw.dbSecret,
    dbSecret: raw.dbSecret ?? null,
    scopes: resolveScopes(raw.scopes),
    connection:
      connection && (connection.method === 'direct' || connection.method === 'pooler')
        ? {
            method: connection.method,
            region: typeof connection.region === 'string' ? connection.region : null,
          }
        : null,
  };
}

async function storeSecret(plainPassword) {
  if (!plainPassword) return null;
  if (safeStorage.isEncryptionAvailable()) {
    const data = safeStorage.encryptString(plainPassword).toString('base64');
    return { algo: 'safeStorage', data };
  }
  const keytar = await getKeytar();
  if (keytar) {
    await keytar.setPassword(SERVICE, ACCOUNT, plainPassword);
    return { algo: 'keytar' };
  }
  // No safe storage available: refuse to persist the password rather than
  // store it in plain text. The user will be asked again for future migrations.
  return null;
}

export async function decryptSecret(dbSecret) {
  if (!dbSecret) return null;
  if (dbSecret.algo === 'safeStorage') {
    try {
      return safeStorage.decryptString(Buffer.from(dbSecret.data, 'base64'));
    } catch {
      return null;
    }
  }
  if (dbSecret.algo === 'keytar') {
    const keytar = await getKeytar();
    if (!keytar) return null;
    return await keytar.getPassword(SERVICE, ACCOUNT);
  }
  return null;
}

export async function saveCredentials({
  projectUrl,
  publishableKey,
  databasePassword,
  connection = null,
}) {
  const previous = readFile();
  const dbSecret = await storeSecret(databasePassword);
  writeFile({
    projectUrl,
    publishableKey,
    enabled: true,
    dbSecret,
    connection,
    // Reconnecting to the same project must not silently reset the user's
    // choice of what to share.
    scopes: resolveScopes(previous?.scopes),
  });
  return loadCredentials();
}

export async function setEnabled(enabled) {
  const raw = readFile();
  if (!raw) return null;
  raw.enabled = !!enabled;
  writeFile(raw);
  return loadCredentials();
}

/** Merge a partial scope map into the stored credentials. */
export async function setScopes(patch) {
  const raw = readFile();
  if (!raw) return null;
  raw.scopes = resolveScopes({ ...resolveScopes(raw.scopes), ...(patch ?? {}) });
  writeFile(raw);
  return loadCredentials();
}

export async function clearCredentials() {
  const raw = readFile();
  if (raw?.dbSecret?.algo === 'keytar') {
    const keytar = await getKeytar();
    if (keytar) {
      try {
        await keytar.deletePassword(SERVICE, ACCOUNT);
      } catch {
        /* best effort */
      }
    }
  }
  if (fs.existsSync(filePath())) {
    try {
      fs.unlinkSync(filePath());
    } catch {
      /* best effort */
    }
  }
}
