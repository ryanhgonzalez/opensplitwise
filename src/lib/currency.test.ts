import { describe, expect, it } from 'vitest';
import { convertSplit, currencySymbol, groupCurrency } from './currency';
import { formatCurrency, formatSigned } from '../utils/format';

describe('convertSplit', () => {
  it('converts each share and keeps the total exact', () => {
    // €10 three ways at 1.0837 → $10.84 total
    const entries = [
      { userId: 'a', amount: 3.34 },
      { userId: 'b', amount: 3.33 },
      { userId: 'c', amount: 3.33 },
    ];
    const out = convertSplit(entries, 1.0837, 10.84);
    expect(out.reduce((s, e) => Math.round((s + e.amount) * 100) / 100, 0)).toBe(10.84);
    expect(out.map((e) => e.amount)).toEqual([3.62, 3.61, 3.61]);
  });
});

describe('currency display', () => {
  it('formats in the given currency, with its own decimals', () => {
    expect(formatCurrency(12.5, 'EUR')).toBe('€12.50');
    expect(formatCurrency(1250, 'JPY')).toBe('¥1,250');
    expect(formatCurrency(12.5)).toBe('$12.50');
    expect(formatSigned(-3, 'GBP')).toBe('−£3.00');
  });

  it('reads older groups as US dollars, and finds symbols', () => {
    expect(groupCurrency({})).toBe('USD');
    expect(groupCurrency({ currency: 'EUR' })).toBe('EUR');
    expect(currencySymbol('EUR')).toBe('€');
    expect(currencySymbol('CAD')).toBe('CA$');
  });
});
