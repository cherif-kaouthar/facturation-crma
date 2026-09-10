/**
 * Spells monetary amounts for the "Arrêté la présente facture à la somme de"
 * line, in French, for Algerian dinars and centimes.
 */
import { splitAmount } from '@/shared/money';

/* ------------------------------------------------------------------ */
/* French                                                              */
/* ------------------------------------------------------------------ */

const FR_UNDER_20 = [
  'zéro', 'un', 'deux', 'trois', 'quatre', 'cinq', 'six', 'sept', 'huit', 'neuf',
  'dix', 'onze', 'douze', 'treize', 'quatorze', 'quinze', 'seize',
  'dix-sept', 'dix-huit', 'dix-neuf',
];

const FR_TENS = ['', '', 'vingt', 'trente', 'quarante', 'cinquante', 'soixante', 'soixante', 'quatre-vingt', 'quatre-vingt'];

/**
 * `pluralOk` carries the agreement rule: "quatre-vingts" and "cents" keep
 * their s at the end of a number or before a noun (millions), but drop it
 * before the invariable "mille" — quatre-vingt mille, deux cent mille.
 */
function frUnder100(n: number, pluralOk: boolean): string {
  if (n < 20) return FR_UNDER_20[n];

  const tens = Math.floor(n / 10);
  const unit = n % 10;

  // 70–79 and 90–99 count on from soixante / quatre-vingt using the teens.
  if (tens === 7 || tens === 9) {
    if (tens === 7 && unit === 1) return 'soixante et onze';
    return `${FR_TENS[tens]}-${FR_UNDER_20[10 + unit]}`;
  }

  if (unit === 0) return tens === 8 && pluralOk ? 'quatre-vingts' : FR_TENS[tens];
  if (unit === 1 && tens !== 8) return `${FR_TENS[tens]} et un`;
  return `${FR_TENS[tens]}-${FR_UNDER_20[unit]}`;
}

function frUnder1000(n: number, pluralOk: boolean): string {
  const hundreds = Math.floor(n / 100);
  const rest = n % 100;

  if (hundreds === 0) return frUnder100(rest, pluralOk);

  const head = hundreds === 1 ? 'cent' : `${FR_UNDER_20[hundreds]} cent`;
  if (rest === 0) return hundreds > 1 && pluralOk ? `${head}s` : head;
  return `${head} ${frUnder100(rest, pluralOk)}`;
}

function frInteger(value: number): string {
  if (value === 0) return 'zéro';

  const parts: string[] = [];
  const billions = Math.floor(value / 1_000_000_000);
  const millions = Math.floor((value % 1_000_000_000) / 1_000_000);
  const thousands = Math.floor((value % 1_000_000) / 1000);
  const rest = value % 1000;

  if (billions > 0) {
    parts.push(billions === 1 ? 'un milliard' : `${frUnder1000(billions, true)} milliards`);
  }
  if (millions > 0) {
    parts.push(millions === 1 ? 'un million' : `${frUnder1000(millions, true)} millions`);
  }
  if (thousands > 0) {
    // "mille" is invariable and suppresses the plural s on the group before it.
    parts.push(thousands === 1 ? 'mille' : `${frUnder1000(thousands, false)} mille`);
  }
  if (rest > 0) {
    parts.push(frUnder1000(rest, true));
  }

  return parts.join(' ');
}

const capitalise = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

export function numberToWordsFr(amount: number): string {
  const { dinars, centimes } = splitAmount(amount);
  const words = frInteger(dinars);
  // A number ending on "million"/"milliard" takes "de" before the unit:
  // un million de dinars, but un million deux cent mille dinars.
  const liaison = /\b(millions?|milliards?)$/.test(words) ? 'de ' : '';
  let result = `${capitalise(words)} ${liaison}${dinars > 1 ? 'dinars algériens' : 'dinar algérien'}`;
  if (centimes > 0) {
    result += ` et ${frInteger(centimes)} ${centimes > 1 ? 'centimes' : 'centime'}`;
  }
  return result;
}

export function amountInWords(amount: number): string {
  return numberToWordsFr(amount);
}
