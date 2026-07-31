import { formatMoney } from '@/shared/money';
import type { Language } from '../types';

export { round2, toAmount, isVatExemptLine, computeLine, computeTotals, formatMoney } from '@/shared/money';

export function money(amount: number, currency = 'DA'): string {
  return formatMoney(amount, currency);
}

/** Date formatted as DD/MM/YYYY for the printed sheet. */
export function longDate(iso: string, _lang: Language): string {
  if (!iso) return '—';
  const [y, m, d] = iso.split('-');
  if (y && m && d) return `${d}/${m}/${y}`;
  const date = new Date(`${iso}T00:00:00`);
  if (Number.isNaN(date.getTime())) return iso;
  const dd = String(date.getDate()).padStart(2, '0');
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const yyyy = date.getFullYear();
  return `${dd}/${mm}/${yyyy}`;
}

/** Compact date for dense table cells. */
export function shortDate(iso: string, lang: Language): string {
  if (!iso) return '—';
  const date = new Date(`${iso}T00:00:00`);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleDateString(lang === 'ar' ? 'ar-DZ' : 'fr-DZ', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  });
}

export function percent(rate: number, lang: Language): string {
  return new Intl.NumberFormat(lang === 'ar' ? 'ar-DZ' : 'fr-FR', {
    style: 'percent',
    maximumFractionDigits: 2,
  }).format(rate);
}

export const todayIso = () => new Date().toISOString().slice(0, 10);
