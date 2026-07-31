import type { SyncResult, SyncSetupPayload, SyncStatus } from '../types';

/**
 * Typed wrapper around the Electron preload bridge (window.syncAPI).
 *
 * In the packaged desktop app the bridge is exposed by preload.js; in a plain
 * browser (dev without Electron) it is absent and every call returns null so
 * the UI can degrade gracefully.
 */
export interface SyncAPI {
  status: () => Promise<SyncStatus>;
  setup: (payload: SyncSetupPayload) => Promise<SyncResult>;
  toggle: (enabled: boolean) => Promise<SyncResult>;
  forget: () => Promise<SyncResult>;
  syncNow: () => Promise<SyncResult>;
}

declare global {
  interface Window {
    syncAPI?: SyncAPI;
  }
}

export function getSyncAPI(): SyncAPI | null {
  return typeof window !== 'undefined' ? (window.syncAPI ?? null) : null;
}
