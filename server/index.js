/**
 * Production entry: serves the built UI and the SQLite API from one port.
 * Run `npm run build` first, then `npm start`.
 */
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { createApi } from './api.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(__dirname, '..', 'dist');
const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';

if (!fs.existsSync(DIST)) {
  console.error('dist/ is missing. Run `npm run build` before `npm start`.');
  process.exit(1);
}

const app = express();
app.use('/api', createApi());
app.use(express.static(DIST, { index: false, maxAge: '1h' }));
app.get('*', (_req, res) => res.sendFile(path.join(DIST, 'index.html')));

app.listen(PORT, HOST, () => {
  console.log(`Facturation CRMA — http://localhost:${PORT}`);
});
