import { app, BrowserWindow, Menu, dialog, nativeImage, shell } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { registerSyncIpc } from './sync/ipc.js';
import { startSyncScheduler, runSyncCycle, syncEvents } from './sync/engine.js';
import { loadCredentials } from './sync/credentials.js';
import pkg from 'electron-updater';
const { autoUpdater } = pkg;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const isDev = !app.isPackaged;

/* ------------------------------------------------------------------ */
/*  Database directory – use OS-standard userData path                 */
/* ------------------------------------------------------------------ */
const userDataPath = app.getPath('userData');
// In dev the API runs inside Vite (server/data), so the sync engine must
// share that same file; in production the app owns everything under userData.
const dataDir = isDev
  ? path.resolve(__dirname, '..', 'data')
  : path.join(userDataPath, 'data');
process.env.LFB_DATA_DIR = dataDir;

/* ------------------------------------------------------------------ */
/*  State                                                              */
/* ------------------------------------------------------------------ */
let mainWindow = null;
let httpServer = null;
let updateCheckInterval = null;

/* ------------------------------------------------------------------ */
/*  Express server (production only)                                    */
/* ------------------------------------------------------------------ */
async function startServer() {
  if (isDev) return 3000;

  const express = (await import('express')).default;
  const { createApi } = await import('../server/api.js');
  const distPath = path.resolve(__dirname, '..', 'dist');

  if (!fs.existsSync(distPath)) {
    dialog.showErrorBox('Build manquant', 'Le dossier dist/ est introuvable. Exécutez `npm run build` d\'abord.');
    app.quit();
    return;
  }

  const serverApp = express();
  serverApp.use('/api', createApi());
  serverApp.use(express.static(distPath, { index: false, maxAge: '1h' }));
  serverApp.get('*', (_req, res) => res.sendFile(path.join(distPath, 'index.html')));

  return new Promise((resolve, reject) => {
    httpServer = serverApp.listen(0, '127.0.0.1', () => {
      const port = httpServer.address().port;
      console.log(`Serveur démarré sur le port ${port}`);
      resolve(port);
    });
    httpServer.on('error', reject);
  });
}

/* ------------------------------------------------------------------ */
/*  Application menu                                                   */
/* ------------------------------------------------------------------ */
function buildAppMenu() {
  const template = [
    {
      label: 'Fichier',
      submenu: [
        { role: 'reload', label: 'Recharger' },
        { role: 'forceReload', label: 'Recharger (cache ignoré)' },
        { type: 'separator' },
        { role: 'quit', label: 'Quitter' },
      ],
    },
    {
      label: 'Affichage',
      submenu: [
        { role: 'resetZoom', label: 'Zoom par défaut' },
        { role: 'zoomIn', label: 'Zoom avant' },
        { role: 'zoomOut', label: 'Zoom arrière' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: 'Plein écran' },
      ],
    },
    {
      label: 'Aide',
      submenu: [
        {
          label: 'Outils de développement',
          accelerator: process.platform === 'darwin' ? 'Cmd+Option+I' : 'Ctrl+Shift+I',
          click: () => mainWindow?.webContents.toggleDevTools(),
        },
      ],
    },
  ];

  if (process.platform === 'darwin') {
    template.unshift({
      label: app.name,
      submenu: [
        { role: 'about', label: 'À propos' },
        { type: 'separator' },
        { role: 'hide', label: 'Masquer' },
        { role: 'hideOthers', label: 'Masquer les autres' },
        { role: 'unhide', label: 'Tout afficher' },
        { type: 'separator' },
        { role: 'quit', label: 'Quitter' },
      ],
    });
  }

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/* ------------------------------------------------------------------ */
/*  Window creation                                                    */
/* ------------------------------------------------------------------ */
async function createWindow() {
  buildAppMenu();

  const iconPath = path.join(__dirname, '..', 'logo.png');
  const appIcon = nativeImage.createFromPath(iconPath);

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 1024,
    minHeight: 720,
    icon: appIcon,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  /* Allow navigation only to the app origin */
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const allowed = isDev
      ? url.startsWith('http://localhost:3000')
      : url.startsWith('http://127.0.0.1');
    if (!allowed) event.preventDefault();
  });

  /* Intercept new-window (target=_blank etc.) — open externally */
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    const allowed = isDev
      ? url.startsWith('http://localhost:3000')
      : url.startsWith('http://127.0.0.1');
    if (!allowed) {
      try { shell.openExternal(url); } catch { /* best effort */ }
    }
    return { action: allowed ? 'allow' : 'deny' };
  });

  /* Native "Save As" dialog for file downloads (backups, PDF exports) */
  mainWindow.webContents.session.on('will-download', (_event, item) => {
    item.setSaveDialogOptions({
      title: 'Enregistrer sous',
    });
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  /* Load the app */
  const port = await startServer();
  const url = isDev ? 'http://localhost:3000' : `http://127.0.0.1:${port}`;
  mainWindow.loadURL(url);
}

/* ------------------------------------------------------------------ */
/*  Auto-update (production only)                                      */
/* ------------------------------------------------------------------ */
function setupAutoUpdater() {
  if (!app.isPackaged) return;

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('checking-for-update', () => {
    console.log('Auto-updater: checking for update…');
  });
  autoUpdater.on('update-available', (info) => {
    console.log(`Auto-updater: update available — v${info.version}`);
  });
  autoUpdater.on('update-not-available', () => {
    console.log('Auto-updater: no update available.');
  });
  autoUpdater.on('download-progress', (progress) => {
    console.log(`Auto-updater: downloading ${Math.round(progress.percent)}%`);
  });
  autoUpdater.on('update-downloaded', (info) => {
    console.log(`Auto-updater: update downloaded — v${info.version}`);
    dialog
      .showMessageBox(mainWindow ?? BrowserWindow.getFocusedWindow(), {
        type: 'info',
        title: 'Mise à jour disponible',
        message: `La version ${info.version} a été téléchargée. Voulez-vous redémarrer maintenant pour l'installer ?`,
        buttons: ['Redémarrer', 'Plus tard'],
        defaultId: 0,
        cancelId: 1,
      })
      .then(({ response }) => {
        if (response === 0) autoUpdater.quitAndInstall();
      });
  });
  autoUpdater.on('error', (err) => {
    console.error('Auto-updater error:', err?.message ?? err);
  });

  autoUpdater.checkForUpdatesAndNotify();

  updateCheckInterval = setInterval(
    () => autoUpdater.checkForUpdatesAndNotify(),
    4 * 60 * 60 * 1000,
  );
}

/* ------------------------------------------------------------------ */
/*  App lifecycle                                                      */
/* ------------------------------------------------------------------ */
app.whenReady().then(() => {
  registerSyncIpc();

  // Tell the renderer when a cycle actually brought data down, otherwise
  // pulled changes sit invisible in SQLite until the user happens to navigate.
  syncEvents.on('changed', (payload) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('sync:changed', payload);
    }
  });

  startSyncScheduler();
  const creds = loadCredentials();
  if (creds?.enabled) runSyncCycle();

  setupAutoUpdater();

  return createWindow();
});

app.on('window-all-closed', () => {
  if (updateCheckInterval) {
    clearInterval(updateCheckInterval);
    updateCheckInterval = null;
  }
  if (httpServer) {
    httpServer.close();
    httpServer = null;
  }
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (mainWindow === null) createWindow();
});
