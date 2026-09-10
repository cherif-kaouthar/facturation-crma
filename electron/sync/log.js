/**
 * Minimal logging for the sync/connection layer.
 *
 * In development, console output goes to the terminal that started the app.
 * In a packaged Electron app there is no visible console, so everything is
 * also appended to <userData>/logs/sync.log. Both sinks are fed the exact
 * same line so debugging a customer's Supabase connection only requires
 * reading that file.
 */

import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';

let logDir = null;

function ensureLogDir() {
  if (logDir !== null) return logDir;
  try {
    logDir = path.join(app.getPath('userData'), 'logs');
    fs.mkdirSync(logDir, { recursive: true });
  } catch {
    logDir = false;
  }
  return logDir;
}

/** Flatten a Node/global fetch/pg error into a single loggable string. */
export function serializeError(error) {
  if (!error) return '';
  const parts = [];
  const walk = (err, depth) => {
    if (!err || depth > 5) return;
    parts.push(String(err?.message ?? err));
    for (const key of ['code', 'errno', 'syscall', 'hostname', 'host', 'port', 'address', 'status', 'statusCode', 'signal', 'type']) {
      const value = err[key];
      if (value !== undefined && value !== null && value !== '') parts.push(`${key}=${value}`);
    }
    if (err?.cause && err.cause !== err) walk(err.cause, depth + 1);
  };
  walk(error, 0);
  return [...new Set(parts)].join(' | ');
}

function write(level, source, message) {
  const line = `[${new Date().toISOString()}] [${level}] [sync:${source}] ${message}`;
  console.log(line);
  const dir = ensureLogDir();
  if (dir) {
    try {
      fs.appendFileSync(path.join(dir, 'sync.log'), `${line}\n`);
    } catch {
      /* best effort — logging must never break the connection flow */
    }
  }
}

export const log = {
  info(source, message) {
    write('INFO', source, message);
  },
  warn(source, message) {
    write('WARN', source, message);
  },
  error(source, message, err) {
    write('ERROR', source, message);
    if (err) write('ERROR', source, serializeError(err));
  },
};