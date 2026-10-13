import type { Expense, Group, SplitEntry } from '../types';
import { formatCurrency } from '../utils/format';
import { round } from './calculations';

// ─────────────────────────────────────────────────────────────────────────────
// Currencies.
//
// Each group has one currency (absent on older data: US dollars), and every
// expense and payment in it is stored in that currency, so balances never mix
// two. An expense paid in another currency keeps its converted amount for the
// balances plus `original` (amount, currency, the rate the person entered).
// Totals that span groups are kept per currency; nothing here converts
// between them, so no exchange rates are ever fetched or assumed.
// ─────────────────────────────────────────────────────────────────────────────

export const DEFAULT_CURRENCY = 'USD';

/** Offered first in pickers; every other ISO code follows. */
export const COMMON_CURRENCIES = [
  'USD', 'EUR', 'GBP', 'CAD', 'AUD', 'MXN', 'JPY', 'CHF', 'NZD', 'SEK', 'NOK', 'DKK',
  'PLN', 'CZK', 'HUF', 'BRL', 'INR', 'CNY', 'KRW', 'SGD', 'HKD', 'THB', 'ZAR', 'TRY',
];

/** Every currency the browser knows, common ones first. */
export function allCurrencies(): string[] {
  let all: string[] = [];
  try {
    all = Intl.supportedValuesOf('currency');
  } catch {
    // Older browsers: the common list is enough.
  }
  return [...COMMON_CURRENCIES, ...all.filter((c) => !COMMON_CURRENCIES.includes(c))];
}

/** "Euro", from the browser's own names. */
export function currencyName(code: string): string {
  try {
    return new Intl.DisplayNames(['en'], { type: 'currency' }).of(code) ?? code;
  } catch {
    return code;
  }
}

/** "€", "$", "CA$", as the amounts themselves show it. */
export function currencySymbol(code: string): string {
  try {
    return (
      new Intl.NumberFormat('en-US', { style: 'currency', currency: code })
        .formatToParts(0)
        .find((p) => p.type === 'currency')?.value ?? code
    );
  } catch {
    return code;
  }
}

export const groupCurrency = (group: Pick<Group, 'currency'> | undefined): string =>
  group?.currency || DEFAULT_CURRENCY;

/** The currency a stored expense or payment is in. */
export const recordCurrency = (record: { currency?: string }): string => record.currency || DEFAULT_CURRENCY;

/**
 * Converts a split entered in another currency into the group's currency.
 * Each share is converted and rounded to cents; the rounding difference goes
 * to the largest share so the shares still add up to `total`.
 */
export function convertSplit(entries: SplitEntry[], rate: number, total: number): SplitEntry[] {
  const converted = entries.map((e) => ({ ...e, amount: round(e.amount * rate) }));
  const diff = round(total - converted.reduce((s, e) => s + e.amount, 0));
  if (diff !== 0 && converted.length > 0) {
    const largest = converted.reduce((best, e, i) => (e.amount > converted[best].amount ? i : best), 0);
    converted[largest] = { ...converted[largest], amount: round(converted[largest].amount + diff) };
  }
  return converted;
}

/**
 * What an expense cost, as people will recognise it: "€50.00 (= $54.00)" when
 * it was paid in another currency than its group's, otherwise "$54.00".
 */
export function expenseAmountLabel(expense: Pick<Expense, 'amount' | 'currency' | 'original'>): string {
  const inGroup = formatCurrency(expense.amount, recordCurrency(expense));
  const o = expense.original;
  if (!o || o.currency === recordCurrency(expense)) return inGroup;
  return `${formatCurrency(o.amount, o.currency)} (= ${inGroup})`;
}

const REGION_CURRENCY: Record<string, string> = {
  US: 'USD', GB: 'GBP', CA: 'CAD', AU: 'AUD', NZ: 'NZD', MX: 'MXN', JP: 'JPY', CH: 'CHF', SE: 'SEK',
  NO: 'NOK', DK: 'DKK', PL: 'PLN', CZ: 'CZK', HU: 'HUF', BR: 'BRL', IN: 'INR', CN: 'CNY', KR: 'KRW',
  SG: 'SGD', HK: 'HKD', TH: 'THB', ZA: 'ZAR', TR: 'TRY',
  AT: 'EUR', BE: 'EUR', CY: 'EUR', DE: 'EUR', EE: 'EUR', ES: 'EUR', FI: 'EUR', FR: 'EUR', GR: 'EUR',
  HR: 'EUR', IE: 'EUR', IT: 'EUR', LT: 'EUR', LU: 'EUR', LV: 'EUR', MT: 'EUR', NL: 'EUR', PT: 'EUR',
  SI: 'EUR', SK: 'EUR',
};

/** A first guess from the device's region ("en-GB" → GBP); US dollars when there's no region or no match. */
export function localeCurrency(): string {
  try {
    const region = new Intl.Locale(navigator.language).maximize().region;
    return (region && REGION_CURRENCY[region]) || DEFAULT_CURRENCY;
  } catch {
    return DEFAULT_CURRENCY;
  }
}
