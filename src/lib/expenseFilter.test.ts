import { describe, it, expect } from 'vitest';
import {
  EMPTY_FILTER,
  categoryOptions,
  filterExpenses,
  isFilterActive,
  matchesQuery,
  parseISODate,
  resolveDateRange,
  type ExpenseFilter,
} from './expenseFilter';
import type { Expense, ExpenseCategory } from '../types';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const NOW = new Date(2026, 7, 10, 14, 30); // 10 Aug 2026, local

function expense(
  id: string,
  description: string,
  amount: number,
  date: Date,
  extra: { paidBy?: string; category?: ExpenseCategory; notes?: string } = {},
): Expense {
  return {
    id,
    description,
    amount,
    currency: 'USD',
    paidBy: extra.paidBy ?? 'alice',
    groupId: 'trip',
    date,
    category: extra.category ?? 'food',
    notes: extra.notes,
    split: { type: 'equal', entries: [{ userId: 'alice', amount }] },
    createdAt: date,
    updatedAt: date,
  };
}

const NAMES: Record<string, string> = { alice: 'Alice Chen', bob: 'Bob Ray' };
const payerName = (id: string) => NAMES[id] ?? 'Unknown';

const today = expense('today', 'Airport taxi', 42.5, new Date(2026, 7, 10, 9, 0), {
  category: 'transport',
  paidBy: 'bob',
});
const lastWeek = expense('lastWeek', 'Beach dinner', 120, new Date(2026, 7, 4), {
  notes: 'Split with the Hendersons',
});
const lastMonth = expense('lastMonth', 'Hotel deposit', 800, new Date(2026, 6, 2), {
  category: 'accommodation',
});
const lastYear = expense('lastYear', 'Flight booking', 1290, new Date(2025, 10, 15), {
  category: 'travel',
});

const ALL = [today, lastWeek, lastMonth, lastYear];
const ids = (list: Expense[]) => list.map((e) => e.id);

const filter = (overrides: Partial<ExpenseFilter> = {}): ExpenseFilter => ({
  ...EMPTY_FILTER,
  ...overrides,
});

// ─── Date parsing ─────────────────────────────────────────────────────────────

describe('parseISODate', () => {
  it('parses in local time, not UTC', () => {
    const parsed = parseISODate('2026-08-01')!;
    // The UTC-parsing trap: this lands on 31 July for anyone west of Greenwich.
    expect(parsed.getFullYear()).toBe(2026);
    expect(parsed.getMonth()).toBe(7);
    expect(parsed.getDate()).toBe(1);
  });

  it('rejects malformed and impossible dates', () => {
    for (const value of ['', '  ', 'yesterday', '2026-8-1', '08-01-2026', '2026-02-31', '2026-13-01']) {
      expect(parseISODate(value)).toBeUndefined();
    }
    expect(parseISODate(undefined)).toBeUndefined();
  });

  it('reads the date input format as local midnight', () => {
    expect(parseISODate('2026-01-05')!.getTime()).toBe(new Date(2026, 0, 5).getTime());
  });
});

// ─── Date ranges ──────────────────────────────────────────────────────────────

describe('resolveDateRange', () => {
  it('leaves both ends open for "any time"', () => {
    expect(resolveDateRange(filter(), NOW)).toEqual({});
  });

  it('counts today as day one of a rolling window', () => {
    const { start, end } = resolveDateRange(filter({ preset: '7d' }), NOW);
    expect(start).toEqual(new Date(2026, 7, 4)); // 4th–10th inclusive is 7 days
    expect(end!.getHours()).toBe(23);
  });

  it('covers the whole of the boundary days', () => {
    const { start, end } = resolveDateRange(
      filter({ preset: 'custom', from: '2026-08-01', to: '2026-08-10' }),
      NOW,
    );
    expect(start).toEqual(new Date(2026, 7, 1, 0, 0, 0, 0));
    expect(end).toEqual(new Date(2026, 7, 10, 23, 59, 59, 999));
  });

  it('allows a half-open custom range', () => {
    expect(resolveDateRange(filter({ preset: 'custom', from: '2026-08-01' }), NOW).end).toBeUndefined();
    expect(resolveDateRange(filter({ preset: 'custom', to: '2026-08-01' }), NOW).start).toBeUndefined();
  });

  it('ignores a custom range that cannot be parsed', () => {
    expect(resolveDateRange(filter({ preset: 'custom', from: 'nonsense' }), NOW)).toEqual({
      start: undefined,
      end: undefined,
    });
  });
});

// ─── Text matching ────────────────────────────────────────────────────────────

describe('matchesQuery', () => {
  it('matches nothing in particular when the query is blank', () => {
    expect(matchesQuery(today, '   ', payerName)).toBe(true);
  });

  it('matches the description, case-insensitively', () => {
    expect(matchesQuery(today, 'TAXI', payerName)).toBe(true);
    expect(matchesQuery(today, 'hotel', payerName)).toBe(false);
  });

  it('matches who paid', () => {
    expect(matchesQuery(today, 'bob', payerName)).toBe(true);
    expect(matchesQuery(lastWeek, 'alice', payerName)).toBe(true);
  });

  it('matches the category label rather than its raw value', () => {
    expect(matchesQuery(lastMonth, 'accommodation', payerName)).toBe(true);
    expect(matchesQuery(today, 'transport', payerName)).toBe(true);
  });

  it('matches notes', () => {
    expect(matchesQuery(lastWeek, 'henderson', payerName)).toBe(true);
  });

  it('matches an amount typed with or without cents', () => {
    expect(matchesQuery(today, '42.5', payerName)).toBe(true);
    expect(matchesQuery(today, '42.50', payerName)).toBe(true);
    expect(matchesQuery(lastWeek, '120', payerName)).toBe(true);
  });

  it('requires every term to match, so terms narrow rather than widen', () => {
    expect(matchesQuery(today, 'taxi bob', payerName)).toBe(true);
    expect(matchesQuery(today, 'taxi alice', payerName)).toBe(false);
  });
});

// ─── Filtering ────────────────────────────────────────────────────────────────

describe('isFilterActive', () => {
  it('is inactive when nothing is set', () => {
    expect(isFilterActive(EMPTY_FILTER)).toBe(false);
    expect(isFilterActive(filter({ query: '   ' }))).toBe(false);
  });

  it('is inactive for a custom range with no bounds filled in', () => {
    expect(isFilterActive(filter({ preset: 'custom' }))).toBe(false);
    expect(isFilterActive(filter({ preset: 'custom', from: '2026-08-01' }))).toBe(true);
  });

  it('is active for a query or a preset window', () => {
    expect(isFilterActive(filter({ query: 'taxi' }))).toBe(true);
    expect(isFilterActive(filter({ preset: '30d' }))).toBe(true);
  });
});

describe('filterExpenses', () => {
  it('returns the original list untouched when nothing is filtered', () => {
    expect(filterExpenses(ALL, EMPTY_FILTER, payerName, NOW)).toBe(ALL);
  });

  it('narrows to a rolling window', () => {
    expect(ids(filterExpenses(ALL, filter({ preset: '7d' }), payerName, NOW))).toEqual(['today', 'lastWeek']);
    expect(ids(filterExpenses(ALL, filter({ preset: '30d' }), payerName, NOW))).toEqual(['today', 'lastWeek']);
    expect(ids(filterExpenses(ALL, filter({ preset: '3m' }), payerName, NOW))).toEqual([
      'today', 'lastWeek', 'lastMonth',
    ]);
  });

  it('includes expenses dated on the range boundaries', () => {
    const onBoundaries = filter({ preset: 'custom', from: '2026-07-02', to: '2026-08-04' });
    expect(ids(filterExpenses(ALL, onBoundaries, payerName, NOW))).toEqual(['lastWeek', 'lastMonth']);
  });

  it('combines text and date, requiring both', () => {
    const both = filter({ query: 'alice', preset: '7d' });
    expect(ids(filterExpenses(ALL, both, payerName, NOW))).toEqual(['lastWeek']);
  });

  it('returns nothing when the query matches outside the window', () => {
    const impossible = filter({ query: 'flight', preset: '7d' });
    expect(filterExpenses(ALL, impossible, payerName, NOW)).toEqual([]);
  });

  it('preserves the order it was given', () => {
    const reversed = [...ALL].reverse();
    expect(ids(filterExpenses(reversed, filter({ preset: '3m' }), payerName, NOW))).toEqual([
      'lastMonth', 'lastWeek', 'today',
    ]);
  });
});

describe('category filter', () => {
  const at = (id: string, category: Expense['category']): Expense => ({
    ...ALL[0],
    id,
    category,
  });
  const list = [at('a', 'food'), at('b', 'groceries'), at('c', 'food'), at('d', 'custom:ski')];

  it('keeps only the chosen categories, and counts as an active filter', () => {
    const f = filter({ categories: ['food', 'custom:ski'] });
    expect(isFilterActive(f)).toBe(true);
    expect(ids(filterExpenses(list, f, payerName, NOW))).toEqual(['a', 'c', 'd']);
  });

  it('treats an empty selection as no filter', () => {
    expect(isFilterActive(filter({ categories: [] }))).toBe(false);
    expect(filterExpenses(list, filter({ categories: [] }), payerName, NOW)).toBe(list);
  });

  it('combines with the text search', () => {
    expect(ids(filterExpenses(list, filter({ categories: ['food'], query: 'nothing-matches' }), payerName, NOW))).toEqual([]);
  });

  it('offers the categories in use, most used first, merging ones that read the same', () => {
    const name = (c: Expense['category']) => (c === 'custom:ski' ? 'Ski passes' : c === 'custom:gone' ? 'Other' : c === 'other' ? 'Other' : c);
    const opts = categoryOptions([...list, at('e', 'other'), at('f', 'custom:gone')], name);
    expect(opts).toEqual([
      { ids: ['food'], label: 'food', count: 2 },
      { ids: ['other', 'custom:gone'], label: 'Other', count: 2 },
      { ids: ['groceries'], label: 'groceries', count: 1 },
      { ids: ['custom:ski'], label: 'Ski passes', count: 1 },
    ]);
  });
});

describe('search by receipt item', () => {
  it('finds an expense by one of its items', () => {
    const e = { ...ALL[0], items: [{ description: 'Pastéis de nata', amount: 6, assigned: [] }] };
    expect(matchesQuery(e, 'nata', payerName)).toBe(true);
    expect(matchesQuery(ALL[0], 'nata', payerName)).toBe(false);
  });
});
