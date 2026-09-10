export type ClientType = 'company' | 'person';

export interface Client {
  id: number;
  name: string;
  type: ClientType;
  location: string;
  nif?: string;
  art?: string;
  phone?: string;
  email?: string;
  archived?: boolean;
  invoiceCount?: number;
  totalBilled?: number;
  createdAt?: string;
  updatedAt?: string;
}

export interface Unit {
  id: number;
  name: string;
  address: string;
  archived: boolean;
  invoiceCount: number;
  totalBilled: number;
  createdAt?: string;
}

export interface InvoiceLine {
  id: string;
  police: string;
  echeance: string;
  nette: number;
  fga: number;
  timbre: number;
  obs: string;
}

export interface InvoiceTotals {
  nette: number;
  tva: number;
  fga: number;
  timbre: number;
  total: number;
}

export interface Invoice {
  id: number;
  unitId: number;
  unitName: string;
  unitAddress: string;
  clientId?: number | null;
  clientName: string;
  clientType: ClientType;
  clientLocation: string;
  clientNif?: string;
  clientArt?: string;
  clientPhone?: string;
  seq: number;
  number: string;
  year: number;
  /** Display identity, e.g. "0012/2026". */
  reference: string;
  date: string;
  notes: string;
  tvaRate: number;
  pageOrientation?: PageOrientation;
  totals: InvoiceTotals;
  totalAmount: number;
  lineCount: number;
  policies: string;
  lines: InvoiceLine[];
  createdAt?: string;
  updatedAt?: string;
}

export interface InvoiceDraft {
  unitId: number;
  clientId?: number | null;
  clientName?: string;
  clientType?: ClientType;
  clientLocation?: string;
  clientNif?: string;
  clientArt?: string;
  clientPhone?: string;
  date: string;
  year?: number;
  notes: string;
  pageOrientation?: PageOrientation;
  lines: Array<Omit<InvoiceLine, 'id'> & { id?: string }>;
}

export interface CustomField {
  label: string;
  value: string;
}

export interface CompanyProfile {
  name: string;
  address: string;
  agrement: string;
  nif: string;
  art: string;
  bna: string;
  ccp: string;
  tel: string;
  fax: string;
  city: string;
  customFields: CustomField[];
}

export interface ClientProfile {
  name: string;
  customFields: CustomField[];
}

export type PageOrientation = 'portrait' | 'landscape';

export interface BillingConfig {
  tvaRate: number;
  defaultTimbre: number;
  defaultObs: string;
  numberPadding: number;
  currency: string;
  observationPresets: string[];
  pageOrientation: PageOrientation;
}

export interface Settings {
  company: CompanyProfile;
  client: ClientProfile;
  billing: BillingConfig;
  branding: { logo: string };
  app: { language: string };
}

export interface NextNumber {
  year: number;
  seq: number;
  number: string;
}

export interface Stats {
  count: number;
  billed: number;
  tva: number;
  yearCount: number;
  yearBilled: number;
  year: number;
  latest: { reference: string; date: string } | null;
  next: NextNumber;
}

/* ------------------------------------------------------------------ */
/* Yearly statistics                                                   */
/* ------------------------------------------------------------------ */

export interface ServiceStat {
  /** Stable identifier for React lists (not a fixed category). */
  key: string;
  /** The observation/service label; null when a line carried no label. */
  label: string | null;
  invoiceCount: number;
  totalAmount: number;
}

export interface YearlyStats {
  year: number;
  /** Years the selector can offer, including the current and next one. */
  years: number[];
  totalInvoices: number;
  totalAmount: number;
  services: ServiceStat[];
}

/* ------------------------------------------------------------------ */
/* Cloud sync                                                          */
/* ------------------------------------------------------------------ */

export interface SyncConnection {
  /** How this device reached the database: direct IPv6 endpoint or shared pooler. */
  method: 'direct' | 'pooler';
  /** Region used by the pooler, e.g. "eu-central-1". */
  region: string | null;
}

/** Which kinds of data the user has chosen to share with the cloud. */
export interface SyncScopes {
  units: boolean;
  clients: boolean;
  invoices: boolean;
  settings: boolean;
}

export type SyncScopeKey = keyof SyncScopes;

export interface SyncStatus {
  enabled: boolean;
  configured: boolean;
  projectUrl: string | null;
  projectRef: string | null;
  hasDbPassword: boolean;
  connection: SyncConnection | null;
  scopes: SyncScopes | null;
  lastSyncAt: string | null;
  lastError: string | null;
  /** Per-entity failure from the last cycle, e.g. { invoices: "envoi : …" }. */
  issues: Partial<Record<SyncScopeKey | 'tombstones', string>>;
  /** Non-fatal things the user should know, e.g. an invoice was renumbered. */
  notices: string[];
}

export interface SyncSetupPayload {
  projectUrl: string;
  publishableKey: string;
  databasePassword: string;
  /** Optional Supabase "Session pooler" connection string (Connect → Session
   *  pooler). When present, it supplies host/port/user/db/password/region and
   *  skips the automatic region probing. */
  connectionUri?: string;
}

export interface SyncResult {
  ok: boolean;
  errors?: string[];
  error?: string | null;
  enabled?: boolean;
  configured?: boolean;
  projectUrl?: string | null;
  projectRef?: string | null;
  hasDbPassword?: boolean;
  connection?: SyncConnection | null;
  scopes?: SyncScopes | null;
  newlyApplied?: Array<{ version: number; file: string }>;
  lastSyncAt?: string | null;
  lastError?: string | null;
  issues?: Partial<Record<SyncScopeKey | 'tombstones', string>>;
  notices?: string[];
}
