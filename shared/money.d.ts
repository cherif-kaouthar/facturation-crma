export interface RawLine {
  nette?: number | string;
  fga?: number | string;
  timbre?: number | string;
  obs?: string;
  isVatExempt?: boolean;
  vatExempt?: boolean;
}

export interface ComputedLine {
  nette: number;
  fga: number;
  timbre: number;
  tva: number;
  total: number;
}

export interface Totals {
  nette: number;
  tva: number;
  fga: number;
  timbre: number;
  total: number;
}

export function round2(value: unknown): number;
export function toAmount(value: unknown): number;
export function isVatExemptLine(line?: RawLine | null): boolean;
export function computeLine(line: RawLine, tvaRate: number): ComputedLine;
export function computeTotals(lines: RawLine[], tvaRate: number): Totals;
export function splitAmount(amount: number): { dinars: number; centimes: number };
export function formatMoney(amount: number, currency?: string): string;
