import { describe, expect, it } from 'vitest';
import {
  round2,
  toAmount,
  isVatExemptLine,
  computeLine,
  computeTotals,
  splitAmount,
  formatMoney,
} from './money.js';

describe('round2', () => {
  it('rounds to two decimals away from float drift', () => {
    expect(round2(1.005)).toBe(1.01);
    expect(round2(19.999999)).toBe(20);
  });

  it('returns 0 for non-finite input', () => {
    expect(round2(NaN)).toBe(0);
    expect(round2(Infinity)).toBe(0);
  });
});

describe('toAmount', () => {
  it('parses comma-decimal strings', () => {
    expect(toAmount('12,5')).toBe(12.5);
  });

  it('rejects negative and invalid values', () => {
    expect(toAmount(-5)).toBe(0);
    expect(toAmount('abc')).toBe(0);
  });
});

describe('isVatExemptLine', () => {
  it('flags explicit exempt markers', () => {
    expect(isVatExemptLine({ isVatExempt: true })).toBe(true);
    expect(isVatExemptLine({ vatExempt: true })).toBe(true);
  });

  it('flags catastrophe naturelle by observation text, case-insensitively', () => {
    expect(isVatExemptLine({ obs: 'Assurance Catastrophe Naturelle' })).toBe(true);
    expect(isVatExemptLine({ obs: 'cat-nat 2024' })).toBe(true);
    expect(isVatExemptLine({ obs: 'incendie' })).toBe(false);
  });

  it('handles missing input', () => {
    expect(isVatExemptLine(null)).toBe(false);
    expect(isVatExemptLine({})).toBe(false);
  });
});

describe('computeLine', () => {
  it('applies TVA to nette only', () => {
    const line = { nette: 1000, fga: 50, timbre: 40 };
    const result = computeLine(line, 0.19);
    expect(result).toEqual({ nette: 1000, fga: 50, timbre: 40, tva: 190, total: 1280 });
  });

  it('zeroes TVA on exempt lines', () => {
    const line = { nette: 1000, fga: 50, timbre: 40, obs: 'Catastrophe Naturelle' };
    const result = computeLine(line, 0.19);
    expect(result.tva).toBe(0);
    expect(result.total).toBe(1090);
  });
});

describe('computeTotals', () => {
  it('sums computed lines', () => {
    const lines = [
      { nette: 1000, fga: 50, timbre: 40 },
      { nette: 500, fga: 0, timbre: 40, obs: 'catnat' },
    ];
    const totals = computeTotals(lines, 0.19);
    expect(totals).toEqual({ nette: 1500, tva: 190, fga: 50, timbre: 80, total: 1820 });
  });

  it('returns zeroed totals for an empty invoice', () => {
    expect(computeTotals([], 0.19)).toEqual({ nette: 0, tva: 0, fga: 0, timbre: 0, total: 0 });
  });
});

describe('splitAmount', () => {
  it('splits dinars and centimes', () => {
    expect(splitAmount(1280.5)).toEqual({ dinars: 1280, centimes: 50 });
  });

  it('rolls centimes over into dinars at the 99.995 edge', () => {
    expect(splitAmount(99.999)).toEqual({ dinars: 100, centimes: 0 });
  });
});

describe('formatMoney', () => {
  it('formats with French grouping and currency suffix', () => {
    expect(formatMoney(1280.5)).toBe('1 280,50 DA');
  });

  it('falls back to 0 for non-finite amounts', () => {
    expect(formatMoney(NaN, 'EUR')).toBe('0,00 EUR');
  });
});
