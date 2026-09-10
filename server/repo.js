import { db, getSettings } from './db.js';
import { computeLine, computeTotals, toAmount, round2 } from '../shared/money.js';

export class ApiError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

const nowIso = () => new Date().toISOString();

/* ------------------------------------------------------------------ */
/* Sync bookkeeping — local edits mark rows dirty; hard deletes leave  */
/* a tombstone so the cloud soft-delete can be applied later.          */
/* ------------------------------------------------------------------ */

const insertTombstone = db.prepare(
  `INSERT INTO sync_tombstones (entity, local_id, cloud_id, deleted_at)
   VALUES (?, ?, ?, ?)
   ON CONFLICT(entity, local_id) DO UPDATE SET deleted_at = excluded.deleted_at`
);

function markDeleted(entity, localId) {
  const cloudId = db
    .prepare(`SELECT cloud_id FROM ${entity} WHERE id = ?`)
    .get(localId)?.cloud_id ?? null;
  insertTombstone.run(entity, localId, cloudId, nowIso());
}

/* ------------------------------------------------------------------ */
/* Units                                                               */
/* ------------------------------------------------------------------ */

function mapUnit(row) {
  return {
    id: row.id,
    name: row.name,
    address: row.address,
    archived: !!row.archived,
    invoiceCount: row.invoice_count ?? 0,
    totalBilled: round2(row.total_billed ?? 0),
    createdAt: row.created_at,
  };
}

export function listUnits() {
  const rows = db
    .prepare(
      `SELECT u.*,
              COUNT(i.id)                    AS invoice_count,
              COALESCE(SUM(i.total_amount),0) AS total_billed
         FROM units u
         LEFT JOIN invoices i ON i.unit_id = u.id
        GROUP BY u.id
        ORDER BY u.archived ASC, u.id ASC`
    )
    .all();
  return rows.map(mapUnit);
}

export function getUnit(id) {
  const row = db.prepare('SELECT * FROM units WHERE id = ?').get(id);
  if (!row) throw new ApiError(404, 'Unité introuvable.');
  return mapUnit(row);
}

function requireText(value, field, max = 200) {
  const text = String(value ?? '').trim();
  if (!text) throw new ApiError(400, `Le champ « ${field} » est obligatoire.`);
  if (text.length > max) throw new ApiError(400, `Le champ « ${field} » est trop long.`);
  return text;
}

export function createUnit(payload) {
  const name = requireText(payload?.name, 'nom de l’unité');
  const address = String(payload?.address ?? '').trim().slice(0, 200);
  const ts = nowIso();
  const info = db
    .prepare('INSERT INTO units (name, address, created_at, updated_at, sync_dirty) VALUES (?, ?, ?, ?, 1)')
    .run(name, address, ts, ts);
  return getUnit(info.lastInsertRowid);
}

export function updateUnit(id, payload) {
  getUnit(id);
  const name = requireText(payload?.name, 'nom de l’unité');
  const address = String(payload?.address ?? '').trim().slice(0, 200);
  const archived = payload?.archived ? 1 : 0;
  db.prepare('UPDATE units SET name = ?, address = ?, archived = ?, updated_at = ?, sync_dirty = 1 WHERE id = ?')
    .run(name, address, archived, nowIso(), id);
  return getUnit(id);
}

export function deleteUnit(id) {
  const unit = getUnit(id);
  const { count } = db
    .prepare('SELECT COUNT(*) AS count FROM invoices WHERE unit_id = ?')
    .get(id);
  if (count > 0) {
    throw new ApiError(
      409,
      `« ${unit.name} » porte ${count} facture${count > 1 ? 's' : ''}. Archivez l’unité pour la retirer de la liste sans toucher à ses factures.`
    );
  }
  markDeleted('units', id);
  db.prepare('DELETE FROM units WHERE id = ?').run(id);
  return { id };
}

/* ------------------------------------------------------------------ */
/* Clients                                                            */
/* ------------------------------------------------------------------ */

function mapClient(row) {
  return {
    id: row.id,
    name: row.name,
    type: row.type || 'company',
    location: row.location || '',
    nif: row.nif || '',
    art: row.art || '',
    phone: row.phone || '',
    email: row.email || '',
    archived: !!row.archived,
    invoiceCount: row.invoice_count ?? 0,
    totalBilled: round2(row.total_billed ?? 0),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function listClients() {
  const rows = db
    .prepare(
      `SELECT c.*,
              COUNT(i.id)                    AS invoice_count,
              COALESCE(SUM(i.total_amount),0) AS total_billed
         FROM clients c
         LEFT JOIN invoices i ON i.client_id = c.id
        GROUP BY c.id
        ORDER BY c.archived ASC, c.name ASC`
    )
    .all();
  return rows.map(mapClient);
}

export function getClient(id) {
  const row = db
    .prepare(
      `SELECT c.*,
              COUNT(i.id)                    AS invoice_count,
              COALESCE(SUM(i.total_amount),0) AS total_billed
         FROM clients c
         LEFT JOIN invoices i ON i.client_id = c.id
        WHERE c.id = ?
        GROUP BY c.id`
    )
    .get(id);
  if (!row) throw new ApiError(404, 'Client introuvable.');
  return mapClient(row);
}

export function createClient(payload) {
  const name = requireText(payload?.name, 'nom du client');
  const type = payload?.type === 'person' ? 'person' : 'company';
  const location = String(payload?.location ?? '').trim().slice(0, 300);
  const nif = type === 'company' ? String(payload?.nif ?? '').trim().slice(0, 100) : '';
  const art = type === 'company' ? String(payload?.art ?? '').trim().slice(0, 100) : '';
  const phone = String(payload?.phone ?? '').trim().slice(0, 50);
  const email = String(payload?.email ?? '').trim().slice(0, 100);
  const ts = nowIso();

  const info = db
    .prepare(
      `INSERT INTO clients (name, type, location, nif, art, phone, email, created_at, updated_at, sync_dirty)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`
    )
    .run(name, type, location, nif, art, phone, email, ts, ts);

  return getClient(info.lastInsertRowid);
}

export function updateClient(id, payload) {
  getClient(id);
  const name = requireText(payload?.name, 'nom du client');
  const type = payload?.type === 'person' ? 'person' : 'company';
  const location = String(payload?.location ?? '').trim().slice(0, 300);
  const nif = type === 'company' ? String(payload?.nif ?? '').trim().slice(0, 100) : '';
  const art = type === 'company' ? String(payload?.art ?? '').trim().slice(0, 100) : '';
  const phone = String(payload?.phone ?? '').trim().slice(0, 50);
  const email = String(payload?.email ?? '').trim().slice(0, 100);
  const archived = payload?.archived ? 1 : 0;

  db.prepare(
    `UPDATE clients
        SET name = ?, type = ?, location = ?, nif = ?, art = ?, phone = ?, email = ?, archived = ?, updated_at = ?, sync_dirty = 1
      WHERE id = ?`
  ).run(name, type, location, nif, art, phone, email, archived, nowIso(), id);

  return getClient(id);
}

export function deleteClient(id) {
  const client = getClient(id);
  const { count } = db
    .prepare('SELECT COUNT(*) AS count FROM invoices WHERE client_id = ?')
    .get(id);
  if (count > 0) {
    throw new ApiError(
      409,
      `« ${client.name} » porte ${count} facture${count > 1 ? 's' : ''}. Archivez le client pour le masquer de la liste.`
    );
  }
  markDeleted('clients', id);
  db.prepare('DELETE FROM clients WHERE id = ?').run(id);
  return { id };
}

/* ------------------------------------------------------------------ */
/* Invoice numbering                                                   */
/* ------------------------------------------------------------------ */

export function formatNumber(seq, padding = 4) {
  return String(seq).padStart(Math.max(1, Math.min(8, padding)), '0');
}

/**
 * Reserve the next sequence for `year`. Always called inside the same
 * transaction as the INSERT, so two saves can never claim the same number;
 * UNIQUE(year, seq) is the backstop if a counter is ever tampered with.
 */
function allocateSeq(year) {
  const counter = db.prepare('SELECT next_seq FROM counters WHERE year = ?').get(year);
  const used = db.prepare('SELECT MAX(seq) AS max_seq FROM invoices WHERE year = ?').get(year);
  const seq = Math.max(counter?.next_seq ?? 1, (used?.max_seq ?? 0) + 1);
  db.prepare(
    `INSERT INTO counters (year, next_seq) VALUES (?, ?)
     ON CONFLICT(year) DO UPDATE SET next_seq = excluded.next_seq`
  ).run(year, seq + 1);
  return seq;
}

/** What the next invoice of `year` will be numbered, without reserving it. */
export function peekNextNumber(year) {
  const counter = db.prepare('SELECT next_seq FROM counters WHERE year = ?').get(year);
  const used = db.prepare('SELECT MAX(seq) AS max_seq FROM invoices WHERE year = ?').get(year);
  const seq = Math.max(counter?.next_seq ?? 1, (used?.max_seq ?? 0) + 1);
  return { year, seq, number: formatNumber(seq, getSettings().billing.numberPadding) };
}

/**
 * Next number for every calendar year that already holds at least one invoice,
 * sorted oldest year first. Years without invoices are omitted.
 */
export function listNextNumbers() {
  const years = db
    .prepare('SELECT DISTINCT year FROM invoices ORDER BY year ASC')
    .all()
    .map((row) => row.year);
  return years.map((year) => peekNextNumber(year));
}

/** Move the counter for a year. Refuses to rewind onto numbers already issued. */
export function setNextSeq(year, nextSeq) {
  const y = Number(year);
  const value = Math.floor(Number(nextSeq));
  if (!Number.isInteger(y) || y < 2000 || y > 2100) {
    throw new ApiError(400, 'Année invalide.');
  }
  if (!Number.isInteger(value) || value < 1) {
    throw new ApiError(400, 'Le prochain numéro doit être un entier positif.');
  }
  const used = db.prepare('SELECT MAX(seq) AS max_seq FROM invoices WHERE year = ?').get(y);
  const floor = (used?.max_seq ?? 0) + 1;
  if (value < floor) {
    throw new ApiError(
      409,
      `Le numéro ${formatNumber(value)} est déjà utilisé en ${y}. Le plus petit numéro disponible est ${formatNumber(floor)}.`
    );
  }
  db.transaction(() => {
    db.prepare(
      `INSERT INTO counters (year, next_seq, sync_dirty) VALUES (?, ?, 1)
       ON CONFLICT(year) DO UPDATE SET next_seq = excluded.next_seq, sync_dirty = 1`
    ).run(y, value);
    // Drop any block reserved from the cloud: it starts at the old position,
    // so keeping it would drag the numbering straight back where it was.
    db.prepare('DELETE FROM seq_batches WHERE year = ?').run(y);
  })();
  return peekNextNumber(y);
}

/* ------------------------------------------------------------------ */
/* Invoices                                                            */
/* ------------------------------------------------------------------ */

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function normaliseLines(rawLines, tvaRate) {
  if (!Array.isArray(rawLines) || rawLines.length === 0) {
    throw new ApiError(400, 'Ajoutez au moins une ligne à la facture.');
  }
  if (rawLines.length > 200) {
    throw new ApiError(400, 'Une facture ne peut pas dépasser 200 lignes.');
  }
  const lines = rawLines.map((line, index) => {
    const echeance = String(line?.echeance ?? '').trim();
    if (echeance && !ISO_DATE.test(echeance)) {
      throw new ApiError(400, `Ligne ${index + 1} : échéance invalide.`);
    }
    const computed = computeLine(line, tvaRate);
    return {
      position: index,
      police: String(line?.police ?? '').trim().slice(0, 80),
      echeance: echeance || null,
      nette: computed.nette,
      fga: computed.fga,
      timbre: computed.timbre,
      obs: String(line?.obs ?? '').trim().slice(0, 300),
    };
  });
  if (lines.every((l) => l.nette === 0 && l.fga === 0 && l.timbre === 0)) {
    throw new ApiError(400, 'Saisissez au moins un montant avant d’enregistrer.');
  }
  return lines;
}

function validateHeader(payload) {
  const unitId = Number(payload?.unitId);
  if (!Number.isInteger(unitId)) throw new ApiError(400, 'Sélectionnez une unité de production.');
  getUnit(unitId);

  let clientId = payload?.clientId ? Number(payload.clientId) : null;
  let clientName = String(payload?.clientName ?? '').trim();
  let clientType = payload?.clientType === 'person' ? 'person' : 'company';
  let clientLocation = String(payload?.clientLocation ?? '').trim();
  let clientNif = String(payload?.clientNif ?? '').trim();
  let clientArt = String(payload?.clientArt ?? '').trim();
  let clientPhone = String(payload?.clientPhone ?? '').trim();

  if (clientId) {
    try {
      const client = getClient(clientId);
      if (!clientName) clientName = client.name;
      clientType = client.type;
      if (!clientLocation) clientLocation = client.location;
      if (!clientPhone) clientPhone = client.phone || '';
      if (clientType === 'company') {
        if (!clientNif) clientNif = client.nif || '';
        if (!clientArt) clientArt = client.art || '';
      } else {
        clientNif = '';
        clientArt = '';
      }
    } catch {
      clientId = null;
    }
  }

  // Fallback to default client if clientName is blank
  if (!clientName) {
    const settings = getSettings();
    clientName = settings.client?.name || '';
  }

  const date = String(payload?.date ?? '').trim();
  if (!ISO_DATE.test(date)) throw new ApiError(400, 'Date de facturation invalide.');

  return {
    unitId,
    clientId,
    clientName,
    clientType,
    clientLocation,
    clientNif,
    clientArt,
    clientPhone,
    date,
    notes: String(payload?.notes ?? '').trim().slice(0, 500),
  };
}

const selectInvoice = `
  SELECT i.*, u.name AS unit_name, u.address AS unit_address
    FROM invoices i
    JOIN units u ON u.id = i.unit_id`;

function mapInvoice(row, lines) {
  const settings = getSettings();
  const defaultClientName = settings.client?.name || '';

  return {
    id: row.id,
    unitId: row.unit_id,
    unitName: row.unit_name,
    unitAddress: row.unit_address,
    clientId: row.client_id || null,
    clientName: row.client_name || defaultClientName,
    clientType: row.client_type || 'company',
    clientLocation: row.client_location || '',
    clientNif: row.client_nif || '',
    clientArt: row.client_art || '',
    clientPhone: row.client_phone || '',
    seq: row.seq,
    number: row.number,
    year: row.year,
    reference: `${row.number}/${row.year}`,
    date: row.date,
    notes: row.notes,
    tvaRate: row.tva_rate,
    pageOrientation: row.page_orientation ?? 'portrait',
    totals: {
      nette: row.total_nette,
      tva: row.total_tva,
      fga: row.total_fga,
      timbre: row.total_timbre,
      total: row.total_amount,
    },
    totalAmount: row.total_amount,
    lineCount: row.line_count ?? lines?.length ?? 0,
    policies: row.policies ?? '',
    lines: lines ?? [],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function loadLines(invoiceId) {
  return db
    .prepare('SELECT * FROM invoice_lines WHERE invoice_id = ? ORDER BY position ASC, id ASC')
    .all(invoiceId)
    .map((l) => ({
      id: String(l.id),
      police: l.police,
      echeance: l.echeance ?? '',
      nette: l.nette,
      fga: l.fga,
      timbre: l.timbre,
      obs: l.obs,
    }));
}

export function getInvoice(id) {
  const row = db.prepare(`${selectInvoice} WHERE i.id = ?`).get(id);
  if (!row) throw new ApiError(404, 'Facture introuvable.');
  return mapInvoice(row, loadLines(row.id));
}

export function listInvoices({ unitId, clientId, year, q } = {}) {
  const where = [];
  const params = [];
  if (unitId !== undefined && unitId !== null && unitId !== '') {
    where.push('i.unit_id = ?');
    params.push(Number(unitId));
  }
  if (clientId !== undefined && clientId !== null && clientId !== '') {
    where.push('i.client_id = ?');
    params.push(Number(clientId));
  }
  if (year) {
    where.push('i.year = ?');
    params.push(Number(year));
  }
  const search = String(q ?? '').trim();
  if (search) {
    where.push(`(
      i.number LIKE ? OR
      CAST(i.year AS TEXT) LIKE ? OR
      i.date LIKE ? OR
      i.notes LIKE ? OR
      i.client_name LIKE ? OR
      i.client_nif LIKE ? OR
      EXISTS (SELECT 1 FROM invoice_lines l
               WHERE l.invoice_id = i.id AND (l.police LIKE ? OR l.obs LIKE ?))
    )`);
    const like = `%${search}%`;
    params.push(like, like, like, like, like, like, like, like);
  }

  const rows = db
    .prepare(
      `SELECT i.*, u.name AS unit_name, u.address AS unit_address,
              (SELECT COUNT(*) FROM invoice_lines l WHERE l.invoice_id = i.id) AS line_count,
              (SELECT GROUP_CONCAT(NULLIF(TRIM(l.police), ''), ' · ')
                 FROM invoice_lines l WHERE l.invoice_id = i.id)               AS policies
         FROM invoices i
         JOIN units u ON u.id = i.unit_id
        ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY i.year DESC, i.seq DESC`
    )
    .all(params);

  return rows.map((row) => mapInvoice(row, null));
}

export const createInvoice = db.transaction((payload) => {
  const settings = getSettings();
  const header = validateHeader(payload);
  const tvaRate = round2(settings.billing.tvaRate * 100) / 100;
  const lines = normaliseLines(payload?.lines, tvaRate);
  const totals = computeTotals(lines, tvaRate);

  const year = Number(payload?.year) || Number(header.date.slice(0, 4));
  const seq = allocateSeq(year);
  const number = formatNumber(seq, settings.billing.numberPadding);
  const ts = nowIso();

  const pageOrientation = payload?.pageOrientation === 'landscape' ? 'landscape' : 'portrait';

  const info = db
    .prepare(
      `INSERT INTO invoices
         (unit_id, client_id, client_name, client_type, client_location, client_nif, client_art, client_phone,
          seq, number, year, date, notes, tva_rate, page_orientation,
          total_nette, total_tva, total_fga, total_timbre, total_amount, created_at, updated_at, sync_dirty)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`
    )
    .run(
      header.unitId, header.clientId, header.clientName, header.clientType, header.clientLocation, header.clientNif, header.clientArt, header.clientPhone,
      seq, number, year, header.date, header.notes, tvaRate, pageOrientation,
      totals.nette, totals.tva, totals.fga, totals.timbre, totals.total, ts, ts
    );

  insertLines(info.lastInsertRowid, lines);
  return getInvoice(info.lastInsertRowid);
});

function insertLines(invoiceId, lines) {
  const stmt = db.prepare(
    `INSERT INTO invoice_lines (invoice_id, position, police, echeance, nette, fga, timbre, obs)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  );
  for (const line of lines) {
    stmt.run(invoiceId, line.position, line.police, line.echeance, line.nette, line.fga, line.timbre, line.obs);
  }
}

/** Editing never renumbers: the issued number is the document's identity. */
export const updateInvoice = db.transaction((id, payload) => {
  const existing = getInvoice(id);
  const header = validateHeader(payload);
  const tvaRate = existing.tvaRate;
  const lines = normaliseLines(payload?.lines, tvaRate);
  const totals = computeTotals(lines, tvaRate);

  const pageOrientation = payload?.pageOrientation === 'landscape' ? 'landscape' : 'portrait';

  db.prepare(
    `UPDATE invoices
        SET unit_id = ?, client_id = ?, client_name = ?, client_type = ?, client_location = ?, client_nif = ?, client_art = ?, client_phone = ?,
            date = ?, notes = ?, page_orientation = ?,
            total_nette = ?, total_tva = ?, total_fga = ?, total_timbre = ?, total_amount = ?,
            updated_at = ?, sync_dirty = 1
      WHERE id = ?`
  ).run(
    header.unitId, header.clientId, header.clientName, header.clientType, header.clientLocation, header.clientNif, header.clientArt, header.clientPhone,
    header.date, header.notes, pageOrientation,
    totals.nette, totals.tva, totals.fga, totals.timbre, totals.total,
    nowIso(), id
  );

  db.prepare('DELETE FROM invoice_lines WHERE invoice_id = ?').run(id);
  insertLines(id, lines);
  return getInvoice(id);
});

/** Copy an invoice's content onto a freshly numbered one — recurring premiums. */
export function duplicateInvoice(id) {
  const source = getInvoice(id);
  return createInvoice({
    unitId: source.unitId,
    clientId: source.clientId,
    clientName: source.clientName,
    clientType: source.clientType,
    clientLocation: source.clientLocation,
    clientNif: source.clientNif,
    clientArt: source.clientArt,
    clientPhone: source.clientPhone,
    date: new Date().toISOString().slice(0, 10),
    year: new Date().getFullYear(),
    notes: source.notes,
    lines: source.lines,
  });
}

export function deleteInvoice(id) {
  getInvoice(id);
  markDeleted('invoices', id);
  db.prepare('DELETE FROM invoices WHERE id = ?').run(id);
  return { id: Number(id) };
}

/* ------------------------------------------------------------------ */
/* Yearly statistics                                                   */
/* ------------------------------------------------------------------ */

/**
 * Statistics for a single calendar year, computed exclusively from that
 * year's invoices. Service types are never hardcoded: they are the distinct
 * observations actually written on the year's invoice lines, so a service
 * only appears once at least one invoice of the selected year uses it.
 * Amounts are broken down per service by summing each line's computed total
 * (nette + TVA + FGA + timbre); an invoice spanning several services
 * contributes to each of them.
 */
export function getYearlyStats(year, unitId) {
  const y = Number(year);
  if (!Number.isInteger(y) || y < 2000 || y > 2100) {
    throw new ApiError(400, 'Année invalide.');
  }

  const where = ['i.year = ?'];
  const params = [y];
  if (unitId !== undefined && unitId !== null && unitId !== '') {
    where.push('i.unit_id = ?');
    params.push(Number(unitId));
  }

  const invoices = db
    .prepare(
      `SELECT i.id, i.tva_rate, i.total_amount
         FROM invoices i
        WHERE ${where.join(' AND ')}`
    )
    .all(params);

  const totalInvoices = invoices.length;
  const totalAmount = round2(invoices.reduce((sum, inv) => sum + inv.total_amount, 0));

  // Group the year's lines by their observation text.
  const byObservation = new Map();
  if (invoices.length > 0) {
    const ids = invoices.map((inv) => inv.id);
    const tvaByInvoice = new Map(invoices.map((inv) => [inv.id, inv.tva_rate]));
    const lines = db
      .prepare(
        `SELECT invoice_id, nette, fga, timbre, obs
           FROM invoice_lines
          WHERE invoice_id IN (${ids.map(() => '?').join(',')})`
      )
      .all(...ids);
    for (const line of lines) {
      const obs = String(line.obs ?? '').trim();
      const group = byObservation.get(obs) ?? { ids: new Set(), amount: 0 };
      group.ids.add(line.invoice_id);
      const tvaRate = tvaByInvoice.get(line.invoice_id) ?? 0;
      group.amount += computeLine(line, tvaRate).total;
      byObservation.set(obs, group);
    }
  }

  const services = [...byObservation.entries()]
    .map(([obs, group], index) => ({
      key: `service-${index}`,
      label: obs || null,
      invoiceCount: group.ids.size,
      totalAmount: round2(group.amount),
    }))
    .sort((a, b) => b.totalAmount - a.totalAmount || (a.label ?? '').localeCompare(b.label ?? ''));

  // Years worth selecting: every year present in the data, plus the current
  // and next calendar year so the operator can look ahead even when empty.
  const availableYears = db
    .prepare('SELECT DISTINCT year FROM invoices ORDER BY year ASC')
    .all()
    .map((row) => row.year);
  const now = new Date().getFullYear();
  for (const candidate of [now, now + 1]) {
    if (!availableYears.includes(candidate)) availableYears.push(candidate);
  }
  availableYears.sort((a, b) => a - b);

  return {
    year: y,
    years: availableYears,
    totalInvoices,
    totalAmount,
    services,
  };
}

/* ------------------------------------------------------------------ */
/* Stats & export                                                      */
/* ------------------------------------------------------------------ */

export function getStats(unitId) {
  const scoped = unitId !== undefined && unitId !== null && unitId !== '';
  const where = scoped ? 'WHERE unit_id = ?' : '';
  const params = scoped ? [Number(unitId)] : [];

  const totals = db
    .prepare(
      `SELECT COUNT(*) AS count,
              COALESCE(SUM(total_amount), 0) AS billed,
              COALESCE(SUM(total_tva), 0)    AS tva
         FROM invoices ${where}`
    )
    .get(params);

  const latest = db
    .prepare(`SELECT number, year, date FROM invoices ${where} ORDER BY year DESC, seq DESC LIMIT 1`)
    .get(params);

  const thisYear = new Date().getFullYear();
  const currentYear = db
    .prepare(
      `SELECT COUNT(*) AS count, COALESCE(SUM(total_amount), 0) AS billed
         FROM invoices ${where ? `${where} AND` : 'WHERE'} year = ?`
    )
    .get([...params, thisYear]);

  return {
    count: totals.count,
    billed: round2(totals.billed),
    tva: round2(totals.tva),
    yearCount: currentYear.count,
    yearBilled: round2(currentYear.billed),
    year: thisYear,
    latest: latest ? { reference: `${latest.number}/${latest.year}`, date: latest.date } : null,
    next: peekNextNumber(thisYear),
  };
}

const CSV_HEADERS = [
  'N° Facture', 'Année', 'Date', 'Unité', 'Polices', 'Lignes',
  'Cotisation nette', 'TVA', 'FGA', 'Timbre', 'Total',
];

function csvCell(value) {
  return `"${String(value ?? '').replace(/"/g, '""')}"`;
}

export function exportCsv({ unitId, year, q } = {}) {
  const invoices = listInvoices({ unitId, year, q });
  const rows = invoices.map((inv) => [
    inv.reference, inv.year, inv.date, inv.unitName, inv.policies, inv.lineCount,
    inv.totals.nette, inv.totals.tva, inv.totals.fga, inv.totals.timbre, inv.totals.total,
  ]);
  // BOM + semicolons so Excel in a French locale opens it correctly.
  return `﻿${[CSV_HEADERS, ...rows].map((r) => r.map(csvCell).join(';')).join('\r\n')}\r\n`;
}

export { toAmount };
