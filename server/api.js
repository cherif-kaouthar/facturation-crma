import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import multer from 'multer';
import { getSettings, saveSettings, DEFAULT_SETTINGS, db, formatDateStamp } from './db.js';
import { openDatabase } from './sqlite.js';
import * as repo from './repo.js';
import { ApiError } from './repo.js';

const SQLITE_HEADER = Buffer.from('SQLite format 3\0', 'utf8');

function validateSqliteFile(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new ApiError(400, 'Fichier de base de données introuvable.');
  }

  const stat = fs.statSync(filePath);
  if (stat.size === 0) {
    throw new ApiError(400, 'Le fichier de sauvegarde est vide.');
  }

  const fd = fs.openSync(filePath, 'r');
  const buffer = Buffer.alloc(16);
  try {
    fs.readSync(fd, buffer, 0, 16, 0);
  } finally {
    fs.closeSync(fd);
  }

  if (!buffer.equals(SQLITE_HEADER)) {
    throw new ApiError(400, 'Le fichier fourni n’est pas un fichier de base de données SQLite valide.');
  }

  try {
    const testDb = openDatabase(filePath);
    const result = testDb.prepare('PRAGMA quick_check;').get();
    testDb.close();
    const val = result ? Object.values(result)[0] : null;
    if (val !== 'ok') {
      throw new Error(`Quick check error: ${val}`);
    }
  } catch (err) {
    throw new ApiError(400, 'Le fichier de sauvegarde est corrompu ou illisible par SQLite.');
  }
}

/** Wrap a handler so thrown ApiErrors become clean JSON responses. */
function handle(fn) {
  return async (req, res) => {
    try {
      const result = await fn(req, res);
      if (result !== undefined && !res.headersSent) res.json(result);
    } catch (error) {
      if (error instanceof ApiError) {
        res.status(error.status).json({ error: error.message, details: error.details });
        return;
      }
      if (String(error?.message || '').includes('UNIQUE constraint failed: invoices.year, invoices.seq')) {
        res.status(409).json({ error: 'Ce numéro de facture vient d’être attribué. Réessayez.' });
        return;
      }
      console.error('[api]', error);
      res.status(500).json({ error: error?.message || 'Erreur interne du serveur.' });
    }
  };
}

const id = (req) => {
  const value = Number(req.params.id);
  if (!Number.isInteger(value) || value < 1) throw new ApiError(400, 'Identifiant invalide.');
  return value;
};

export function createApi() {
  const api = express.Router();

  // Logos arrive as data: URLs, so the JSON body can legitimately be large.
  api.use(express.json({ limit: '6mb' }));

  api.get('/health', handle(() => ({ ok: true, driver: 'sqlite' })));

  /* Settings ------------------------------------------------------- */
  api.get('/settings', handle(() => getSettings()));

  api.put('/settings', handle((req) => {
    const patch = req.body ?? {};
    const logo = patch.branding?.logo;
    if (typeof logo === 'string' && logo && !/^data:image\/(png|jpeg|jpg|gif|webp|svg\+xml);base64,/.test(logo)) {
      throw new ApiError(400, 'Le logo doit être une image PNG, JPEG, GIF, WebP ou SVG.');
    }
    if (typeof logo === 'string' && logo.length > 4_000_000) {
      throw new ApiError(413, 'Le logo dépasse 3 Mo. Choisissez une image plus légère.');
    }
    const rate = patch.billing?.tvaRate;
    if (rate !== undefined && (!Number.isFinite(Number(rate)) || Number(rate) < 0 || Number(rate) > 1)) {
      throw new ApiError(400, 'Le taux de TVA doit être compris entre 0 et 1 (0,19 pour 19 %).');
    }
    return saveSettings(patch);
  }));

  api.post('/settings/reset', handle(() => saveSettings(DEFAULT_SETTINGS)));

  /* Database Backup & Restore -------------------------------------- */
  const upload = multer({
    dest: os.tmpdir(),
    limits: { fileSize: 100 * 1024 * 1024 }, // 100 MB max
    fileFilter: (_req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase();
      if (ext === '.db' || ext === '.sqlite') {
        cb(null, true);
      } else {
        cb(new ApiError(400, 'Seuls les fichiers avec extension .db ou .sqlite sont acceptés.'));
      }
    },
  });

  api.post(
    '/settings/database/backup',
    handle(async (_req, res) => {
      db.checkpoint();

      const dbPath = db.getDbFilePath();
      if (!fs.existsSync(dbPath)) {
        throw new ApiError(404, 'Fichier de base de données introuvable.');
      }

      const timestamp = formatDateStamp();
      const filename = `invoice_backup_${timestamp}.db`;
      const tempPath = path.join(os.tmpdir(), `temp_backup_${Date.now()}_${filename}`);

      fs.copyFileSync(dbPath, tempPath);

      if (!fs.existsSync(tempPath) || fs.statSync(tempPath).size === 0) {
        if (fs.existsSync(tempPath)) {
          try { fs.unlinkSync(tempPath); } catch {}
        }
        throw new ApiError(500, 'Échec de la création du fichier de sauvegarde.');
      }

      res.setHeader('Content-Type', 'application/x-sqlite3');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

      res.download(tempPath, filename, (err) => {
        if (fs.existsSync(tempPath)) {
          try { fs.unlinkSync(tempPath); } catch {}
        }
        if (err && !res.headersSent) {
          console.error('[backup download error]', err);
        }
      });
    })
  );

  api.post(
    '/settings/database/restore',
    (req, res, next) => {
      upload.single('file')(req, res, (err) => {
        if (err) {
          if (err instanceof multer.MulterError) {
            return res.status(400).json({ error: `Erreur de téléversement : ${err.message}` });
          }
          return res.status(400).json({ error: err.message || 'Échec du téléversement du fichier.' });
        }
        next();
      });
    },
    handle(async (req) => {
      if (!req.file) {
        throw new ApiError(400, 'Aucun fichier de base de données n’a été téléversé.');
      }

      const uploadPath = req.file.path;

      try {
        validateSqliteFile(uploadPath);
        await db.restoreFromBackup(uploadPath);
        return { ok: true, message: 'La base de données a été restaurée avec succès.' };
      } finally {
        if (fs.existsSync(uploadPath)) {
          try { fs.unlinkSync(uploadPath); } catch {}
        }
      }
    })
  );

  /* Units ---------------------------------------------------------- */
  api.get('/units', handle(() => repo.listUnits()));
  api.post('/units', handle((req, res) => {
    res.status(201);
    return repo.createUnit(req.body);
  }));
  api.put('/units/:id', handle((req) => repo.updateUnit(id(req), req.body)));
  api.delete('/units/:id', handle((req) => repo.deleteUnit(id(req))));

  /* Clients -------------------------------------------------------- */
  api.get('/clients', handle(() => repo.listClients()));
  api.get('/clients/:id', handle((req) => repo.getClient(id(req))));
  api.post('/clients', handle((req, res) => {
    res.status(201);
    return repo.createClient(req.body);
  }));
  api.put('/clients/:id', handle((req) => repo.updateClient(id(req), req.body)));
  api.delete('/clients/:id', handle((req) => repo.deleteClient(id(req))));

  /* Invoices ------------------------------------------------------- */
  api.get('/invoices', handle((req) => repo.listInvoices(req.query)));
  api.get('/invoices/next', handle((req) =>
    repo.peekNextNumber(Number(req.query.year) || new Date().getFullYear())
  ));
  api.get('/invoices/:id', handle((req) => repo.getInvoice(id(req))));
  api.post('/invoices', handle((req, res) => {
    res.status(201);
    return repo.createInvoice(req.body);
  }));
  api.post('/invoices/:id/duplicate', handle((req, res) => {
    res.status(201);
    return repo.duplicateInvoice(id(req));
  }));
  api.put('/invoices/:id', handle((req) => repo.updateInvoice(id(req), req.body)));
  api.delete('/invoices/:id', handle((req) => repo.deleteInvoice(id(req))));

  /* Numbering ------------------------------------------------------ */
  api.put('/numbering/:year', handle((req) =>
    repo.setNextSeq(req.params.year, req.body?.nextSeq)
  ));

  /* Stats & export ------------------------------------------------- */
  api.get('/stats', handle((req) => repo.getStats(req.query.unitId)));

  api.get('/export.csv', handle((req, res) => {
    const csv = repo.exportCsv(req.query);
    const stamp = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="factures-crma-${stamp}.csv"`);
    res.send(csv);
  }));

  api.use((_req, res) => res.status(404).json({ error: 'Route inconnue.' }));

  return api;
}
