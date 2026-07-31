import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import { defineConfig, type Plugin } from 'vite';

/**
 * Mounts the SQLite-backed API inside Vite itself, so `npm run dev` serves the
 * UI and its data from a single origin — no second process, no proxy config.
 */
function sqliteApiPlugin(): Plugin {
  const mount = async (server: { middlewares: any }) => {
    const express = (await import('express')).default;
    const { createApi } = await import('./server/api.js');
    const app = express();
    app.use('/api', createApi());
    server.middlewares.use(app);
  };

  return {
    name: 'lfb:sqlite-api',
    configureServer: mount,
    configurePreviewServer: mount,
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), sqliteApiPlugin()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, '.'),
    },
  },
  server: {
    host: '0.0.0.0',
    port: 3000,
    allowedHosts: true,
    // HMR is disabled in AI Studio via DISABLE_HMR env var.
    // Do not modify—file watching is disabled to prevent flickering during agent edits.
    hmr: process.env.DISABLE_HMR !== 'true',
    // Disable file watching when DISABLE_HMR is true to save CPU during agent edits.
    watch: process.env.DISABLE_HMR === 'true' ? null : {},
  },
  preview: {
    host: '0.0.0.0',
    port: 3000,
  },
});
