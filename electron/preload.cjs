const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  platform: process.platform,
  isElectron: true,
  onMenuAction: (callback) => {
    ipcRenderer.on('menu-action', (_event, action) => callback(action));
  },
});

/**
 * Cloud-sync bridge. The narrow surface defined by the main process:
 * status / setup / toggle / forget. No generic SQL bridge, no Node APIs.
 * The DB password is passed to setup once and only ever used for schema
 * migrations in the main process.
 */
contextBridge.exposeInMainWorld('syncAPI', {
  status: () => ipcRenderer.invoke('sync:status'),
  setup: (payload) => ipcRenderer.invoke('sync:setup', payload),
  toggle: (enabled) => ipcRenderer.invoke('sync:toggle', enabled),
  setScopes: (scopes) => ipcRenderer.invoke('sync:scopes', scopes),
  forget: () => ipcRenderer.invoke('sync:forget'),
  syncNow: () => ipcRenderer.invoke('sync:now'),
  /**
   * Fires after a sync cycle applied cloud changes to the local database.
   * Returns an unsubscribe function so React effects can clean up.
   */
  onChanged: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('sync:changed', listener);
    return () => ipcRenderer.removeListener('sync:changed', listener);
  },
});
