import type { SyncResult, SyncScopes, SyncSetupPayload, SyncStatus } from '../types';

/**
 * Typed wrapper around the Electron preload bridge (window.syncAPI).
 *
 * In the packaged desktop app the bridge is exposed by preload.js; in a plain
 * browser (dev without Electron) it is absent and every call returns null so
 * the UI can degrade gracefully.
 */
export interface SyncChange {
  pulled: { units: number; clients: number; settings: number; invoices: number };
}

export interface SyncAPI {
  status: () => Promise<SyncStatus>;
  setup: (payload: SyncSetupPayload) => Promise<SyncResult>;
  toggle: (enabled: boolean) => Promise<SyncResult>;
  /** Choose which kinds of data are shared. Partial patches are merged. */
  setScopes: (scopes: Partial<SyncScopes>) => Promise<SyncResult>;
  forget: () => Promise<SyncResult>;
  syncNow: () => Promise<SyncResult>;
  /** Subscribe to "cloud data just landed locally"; returns an unsubscribe fn. */
  onChanged: (callback: (change: SyncChange) => void) => () => void;
}

declare global {
  interface Window {
    syncAPI?: SyncAPI;
  }
}

export function getSyncAPI(): SyncAPI | null {
  return typeof window !== 'undefined' ? (window.syncAPI ?? null) : null;
}
