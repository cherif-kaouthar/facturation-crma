import type { Client, Invoice, InvoiceDraft, Settings, Stats, Unit } from '../types';

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/api${path}`, {
      headers: init?.body ? { 'Content-Type': 'application/json' } : undefined,
      ...init,
    });
  } catch {
    throw new ApiError('Impossible de joindre le serveur. Vérifiez qu’il est démarré.', 0);
  }

  if (response.status === 204) return undefined as T;

  const text = await response.text();
  let payload: any = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = null;
  }

  if (!response.ok) {
    throw new ApiError(payload?.error ?? `Erreur ${response.status}.`, response.status);
  }
  return payload as T;
}

const body = (data: unknown) => JSON.stringify(data);
const query = (params: Record<string, string | number | undefined | null>) => {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') search.set(key, String(value));
  }
  const string = search.toString();
  return string ? `?${string}` : '';
};

export const api = {
  getSettings: () => request<Settings>('/settings'),
  saveSettings: (patch: Partial<Settings>) =>
    request<Settings>('/settings', { method: 'PUT', body: body(patch) }),
  resetSettings: () => request<Settings>('/settings/reset', { method: 'POST' }),

  listUnits: () => request<Unit[]>('/units'),
  createUnit: (data: { name: string; address: string }) =>
    request<Unit>('/units', { method: 'POST', body: body(data) }),
  updateUnit: (id: number, data: { name: string; address: string; archived?: boolean }) =>
    request<Unit>(`/units/${id}`, { method: 'PUT', body: body(data) }),
  deleteUnit: (id: number) => request<{ id: number }>(`/units/${id}`, { method: 'DELETE' }),

  listClients: () => request<Client[]>('/clients'),
  getClient: (id: number) => request<Client>(`/clients/${id}`),
  createClient: (data: Partial<Client>) =>
    request<Client>('/clients', { method: 'POST', body: body(data) }),
  updateClient: (id: number, data: Partial<Client>) =>
    request<Client>(`/clients/${id}`, { method: 'PUT', body: body(data) }),
  deleteClient: (id: number) => request<{ id: number }>(`/clients/${id}`, { method: 'DELETE' }),

  listInvoices: (params: { unitId?: number; clientId?: number; year?: number; q?: string } = {}) =>
    request<Invoice[]>(`/invoices${query(params)}`),
  getInvoice: (id: number) => request<Invoice>(`/invoices/${id}`),
  nextNumber: (year?: number) =>
    request<{ year: number; seq: number; number: string }>(`/invoices/next${query({ year })}`),
  createInvoice: (draft: InvoiceDraft) =>
    request<Invoice>('/invoices', { method: 'POST', body: body(draft) }),
  updateInvoice: (id: number, draft: InvoiceDraft) =>
    request<Invoice>(`/invoices/${id}`, { method: 'PUT', body: body(draft) }),
  duplicateInvoice: (id: number) =>
    request<Invoice>(`/invoices/${id}/duplicate`, { method: 'POST' }),
  deleteInvoice: (id: number) =>
    request<{ id: number }>(`/invoices/${id}`, { method: 'DELETE' }),

  setNextSeq: (year: number, nextSeq: number) =>
    request<{ year: number; seq: number; number: string }>(`/numbering/${year}`, {
      method: 'PUT',
      body: body({ nextSeq }),
    }),

  getStats: (unitId?: number) => request<Stats>(`/stats${query({ unitId })}`),

  exportCsvUrl: (params: { unitId?: number; clientId?: number; year?: number; q?: string } = {}) =>
    `/api/export.csv${query(params)}`,

  downloadDatabaseBackup: async () => {
    let response: Response;
    try {
      response = await fetch('/api/settings/database/backup', { method: 'POST' });
    } catch {
      throw new ApiError('Impossible de joindre le serveur. Vérifiez qu’il est démarré.', 0);
    }

    if (!response.ok) {
      const errData = await response.json().catch(() => ({}));
      throw new ApiError(errData.error || 'Échec de la création de la sauvegarde.', response.status);
    }

    const blob = await response.blob();
    const disposition = response.headers.get('Content-Disposition');
    let filename = `invoice_backup_${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.db`;
    if (disposition) {
      const match = disposition.match(/filename="?([^";]+)"?/);
      if (match && match[1]) filename = match[1];
    }

    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.URL.revokeObjectURL(url);
  },

  restoreDatabaseBackup: async (file: File) => {
    const formData = new FormData();
    formData.append('file', file);

    let response: Response;
    try {
      response = await fetch('/api/settings/database/restore', {
        method: 'POST',
        body: formData,
      });
    } catch {
      throw new ApiError('Impossible de joindre le serveur. Vérifiez qu’il est démarré.', 0);
    }

    const text = await response.text();
    let payload: any = null;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      payload = null;
    }

    if (!response.ok) {
      throw new ApiError(payload?.error || 'Échec de la restauration de la base de données.', response.status);
    }

    return payload as { ok: boolean; message: string };
  },
};
