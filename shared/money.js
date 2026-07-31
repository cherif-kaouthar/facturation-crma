/**
 * Monetary maths shared by the API and the UI so both sides always agree on
 * what a line and an invoice add up to. Every value that is stored or shown
 * passes through round2 — floating point drift never reaches the ledger.
 */

/** Round to two decimals, away from the binary-float edge cases. */
export function round2(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/** Coerce anything user-typed into a non-negative amount. */
export function toAmount(value) {
  const n = typeof value === 'string' ? parseFloat(value.replace(',', '.')) : Number(value);
  if (!Number.isFinite(n) || n < 0) return 0;
  return round2(n);
}

/**
 * Check if a line is VAT-exempt (e.g. Assurance Catastrophe Naturelle).
 * "Assurance Catastrophe Naturelle" is NOT subject to VAT (TVA = 0.00 DA).
 */
export function isVatExemptLine(line) {
  if (!line) return false;
  if (line.isVatExempt || line.vatExempt) return true;
  const obs = String(line.obs || '').toLowerCase().trim();
  if (!obs) return false;
  return (
    obs.includes('catastrophe naturelle') ||
    obs.includes('catastrophe') ||
    obs.includes('cat nat') ||
    obs.includes('catnat') ||
    obs.includes('cat-nat')
  );
}

/**
 * Expand one raw line into its computed form.
 * TVA applies to the net premium only; FGA and stamp duty are not taxed.
 * VAT-exempt services (such as "Assurance Catastrophe Naturelle") carry TVA = 0.
 */
export function computeLine(line, tvaRate) {
  const nette = toAmount(line?.nette);
  const fga = toAmount(line?.fga);
  const timbre = toAmount(line?.timbre);
  const exempt = isVatExemptLine(line);
  const tva = exempt ? 0 : round2(nette * tvaRate);
  return {
    nette,
    fga,
    timbre,
    tva,
    total: round2(nette + tva + fga + timbre),
  };
}

/** Sum computed lines into invoice totals. */
export function computeTotals(lines, tvaRate) {
  return lines.reduce(
    (acc, line) => {
      const c = computeLine(line, tvaRate);
      return {
        nette: round2(acc.nette + c.nette),
        tva: round2(acc.tva + c.tva),
        fga: round2(acc.fga + c.fga),
        timbre: round2(acc.timbre + c.timbre),
        total: round2(acc.total + c.total),
      };
    },
    { nette: 0, tva: 0, fga: 0, timbre: 0, total: 0 }
  );
}

/** Split an amount into whole dinars and centimes, handling the 99.995 rollover. */
export function splitAmount(amount) {
  const value = round2(Math.abs(amount));
  let dinars = Math.floor(value);
  let centimes = Math.round((value - dinars) * 100);
  if (centimes >= 100) {
    dinars += 1;
    centimes = 0;
  }
  return { dinars, centimes };
}

/** Format for display: French grouping, two decimals, currency suffix. */
export function formatMoney(amount, currency = 'DA') {
  const n = Number.isFinite(Number(amount)) ? Number(amount) : 0;
  const formatted = n.toLocaleString('fr-FR', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  // fr-FR uses narrow no-break spaces for grouping; normalise to a plain
  // no-break space so it renders identically in print and in the browser.
  return `${formatted.replace(/ /g, ' ')} ${currency}`;
}
