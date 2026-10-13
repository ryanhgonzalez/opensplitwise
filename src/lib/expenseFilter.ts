/**
 * Search, date and category filtering for expense lists.
 *
 * Pure — no React, no store — so the matching rules can be tested directly and
 * reused by any list that shows expenses.
 */

import type { CategoryId, Expense } from '../types';
import { categoryLabel } from './categories';

// ─── Public types ─────────────────────────────────────────────────────────────

/** `custom` reads `from`/`to`; the rest are rolling windows ending today. */
export type DatePreset = 'all' | '7d' | '30d' | '3m' | 'custom';

export interface ExpenseFilter {
  /** Free text. Multiple words must all match, in any field. */
  query: string;
  preset: DatePreset;
  /** `YYYY-MM-DD`, inclusive. Only read when `preset` is `custom`. */
  from?: string;
  /** `YYYY-MM-DD`, inclusive. Only read when `preset` is `custom`. */
  to?: string;
  /** Only expenses in one of these categories. Empty or absent: any category. */
  categories?: CategoryId[];
}

export const EMPTY_FILTER: ExpenseFilter = { query: '', preset: 'all' };

export const DATE_PRESET_LABELS: Record<DatePreset, string> = {
  all: 'Any time',
  '7d': '7 days',
  '30d': '30 days',
  '3m': '3 months',
  custom: 'Range',
};

/** How many people paid for the expenses on screen — used to name the payer in search. */
export type PayerName = (userId: string) => string;
export type CategoryName = (category: CategoryId) => string;

// ─── Date helpers ─────────────────────────────────────────────────────────────

const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const endOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999);

/**
 * Parses `YYYY-MM-DD` in local time.
 *
 * `new Date('2026-08-01')` is parsed as UTC midnight, which lands on July 31st
 * for anyone west of Greenwich — and expenses are dated in local time, so that
 * would silently drop a day's worth at the edge of the range.
 */
export function parseISODate(value: string | undefined): Date | undefined {
  if (!value) return undefined;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!match) return undefined;
  const [, year, month, day] = match;
  const date = new Date(Number(year), Number(month) - 1, Number(day));
  // Rejects impossible dates like 2026-02-31, which would roll over into March.
  if (date.getMonth() !== Number(month) - 1 || date.getDate() !== Number(day)) return undefined;
  return date;
}

/** Formats a date as `YYYY-MM-DD` in local time, for `<input type="date">`. */
export function toISODateInput(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/**
 * The inclusive window a filter describes, or `undefined` bounds where it is
 * open-ended. Rolling windows count today as day one, so `7d` covers today plus
 * the six days before it.
 */
export function resolveDateRange(
  filter: ExpenseFilter,
  now: Date = new Date(),
): { start?: Date; end?: Date } {
  const daysBack = (n: number) => {
    const start = startOfDay(now);
    start.setDate(start.getDate() - (n - 1));
    return { start, end: endOfDay(now) };
  };

  switch (filter.preset) {
    case '7d':
      return daysBack(7);
    case '30d':
      return daysBack(30);
    case '3m': {
      const start = startOfDay(now);
      start.setMonth(start.getMonth() - 3);
      start.setDate(start.getDate() + 1);
      return { start, end: endOfDay(now) };
    }
    case 'custom': {
      const from = parseISODate(filter.from);
      const to = parseISODate(filter.to);
      return {
        start: from ? startOfDay(from) : undefined,
        end: to ? endOfDay(to) : undefined,
      };
    }
    case 'all':
    default:
      return {};
  }
}

// ─── Matching ─────────────────────────────────────────────────────────────────

/**
 * Everything a query can match on, lowercased: what it was, who paid, which
 * category, any note, the receipt's item names, and the amount.
 *
 * The amount goes in twice — as typed (`42.5`) and cent-padded (`42.50`) — so
 * both "42.5" and "42.50" find the same expense.
 */
function haystack(expense: Expense, payerName: PayerName, categoryName: CategoryName): string {
  return [
    expense.description,
    payerName(expense.paidBy),
    categoryName(expense.category),
    expense.notes ?? '',
    ...(expense.items ?? []).map((it) => it.description),
    String(expense.amount),
    expense.amount.toFixed(2),
  ]
    .join(' ')
    .toLowerCase();
}

/** True when every whitespace-separated term appears somewhere in the expense. */
export function matchesQuery(
  expense: Expense,
  query: string,
  payerName: PayerName,
  categoryName: CategoryName = categoryLabel,
): boolean {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return true;
  const target = haystack(expense, payerName, categoryName);
  return terms.every((term) => target.includes(term));
}

/** True when the filter would narrow the list at all. */
export function isFilterActive(filter: ExpenseFilter): boolean {
  if (filter.query.trim() !== '') return true;
  if (filter.categories?.length) return true;
  if (filter.preset === 'custom') return Boolean(filter.from || filter.to);
  return filter.preset !== 'all';
}

/**
 * Narrows `expenses` to those matching both the text query and the date window.
 * Input order is preserved — sort before or after, whichever the caller prefers.
 */
export function filterExpenses(
  expenses: Expense[],
  filter: ExpenseFilter,
  payerName: PayerName,
  now: Date = new Date(),
  /** Custom categories need the group to be named; built-in ones don't. */
  categoryName: CategoryName = categoryLabel,
): Expense[] {
  if (!isFilterActive(filter)) return expenses;

  const { start, end } = resolveDateRange(filter, now);

  return expenses.filter((expense) => {
    const when = expense.date.getTime();
    if (start && when < start.getTime()) return false;
    if (end && when > end.getTime()) return false;
    if (filter.categories?.length && !filter.categories.includes(expense.category)) return false;
    return matchesQuery(expense, filter.query, payerName, categoryName);
  });
}

// ─── Category choices ─────────────────────────────────────────────────────────

/** One category the list can be narrowed to, as offered in the filter bar. */
export interface CategoryOption {
  /**
   * Usually one id. Several when they share a name: a custom category that
   * can't be found reads as Other, so it's offered together with Other.
   */
  ids: CategoryId[];
  label: string;
  count: number;
}

/** The categories `expenses` actually use, most used first, then by name. */
export function categoryOptions(expenses: Expense[], categoryName: CategoryName = categoryLabel): CategoryOption[] {
  const byLabel = new Map<string, CategoryOption>();
  for (const expense of expenses) {
    const label = categoryName(expense.category);
    const option = byLabel.get(label) ?? { ids: [], label, count: 0 };
    if (!option.ids.includes(expense.category)) option.ids.push(expense.category);
    option.count++;
    byLabel.set(label, option);
  }
  return [...byLabel.values()].sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}
