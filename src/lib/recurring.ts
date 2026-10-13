import type { Expense, RecurringExpense, RepeatFrequency } from '../types';

// ─────────────────────────────────────────────────────────────────────────────
// Recurring expenses: when each repeat falls, and which are due.
//
// A repeat's id is the rule's id plus its date, so the same repeat added on
// two phones is one expense when the group is shared. Its createdAt and
// updatedAt are its own date, not when it was added: a deletion marker made
// after that date then wins over another phone adding it later.
// ─────────────────────────────────────────────────────────────────────────────

export const FREQUENCY_LABELS: Record<RepeatFrequency, string> = {
  weekly: 'Weekly',
  biweekly: 'Every 2 weeks',
  monthly: 'Monthly',
  yearly: 'Yearly',
};

/** Repeats added in one go at most, should a rule's start be far in the past. */
const MAX_CATCH_UP = 120;

const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());

/** The day of the month, kept if the month is long enough, else its last day (Jan 31 → Feb 28). */
function onDay(year: number, month: number, day: number): Date {
  const last = new Date(year, month + 1, 0).getDate();
  return new Date(year, month, Math.min(day, last));
}

/** The n-th repeat's date (0 = the start). */
export function occurrence(start: Date, frequency: RepeatFrequency, n: number): Date {
  const s = startOfDay(start);
  switch (frequency) {
    case 'weekly':
      return new Date(s.getFullYear(), s.getMonth(), s.getDate() + 7 * n);
    case 'biweekly':
      return new Date(s.getFullYear(), s.getMonth(), s.getDate() + 14 * n);
    case 'monthly':
      return onDay(s.getFullYear(), s.getMonth() + n, s.getDate());
    case 'yearly':
      return onDay(s.getFullYear() + n, s.getMonth(), s.getDate());
  }
}

/** YYYY-MM-DD in local time. */
export const dayKey = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

export const occurrenceId = (rule: Pick<RecurringExpense, 'id'>, date: Date) => `${rule.id}:${dayKey(date)}`;

/** The rule a repeat came from, from its id; undefined for an ordinary expense. */
export const ruleIdOf = (expenseId: string) => (/:\d{4}-\d{2}-\d{2}$/.test(expenseId) ? expenseId.slice(0, -11) : undefined);

/** The first repeat on or after `from`. */
export function nextOccurrence(rule: Pick<RecurringExpense, 'startDate' | 'frequency'>, from: Date): Date {
  const target = startOfDay(from).getTime();
  for (let n = 0; n < 100_000; n++) {
    const d = occurrence(rule.startDate, rule.frequency, n);
    if (d.getTime() >= target) return d;
  }
  return occurrence(rule.startDate, rule.frequency, 0);
}

/**
 * The repeats due by `today` that aren't here yet: not already an expense and
 * not deleted (`skip`). Oldest first; at most MAX_CATCH_UP, the most recent.
 */
export function dueRepeats(rule: RecurringExpense, today: Date, skip: (id: string) => boolean): Expense[] {
  const end = startOfDay(today).getTime();
  const due: Expense[] = [];
  for (let n = 0; ; n++) {
    const date = occurrence(rule.startDate, rule.frequency, n);
    if (date.getTime() > end) break;
    const id = occurrenceId(rule, date);
    if (skip(id)) continue;
    due.push({ ...rule.template, id, groupId: rule.groupId, date, createdAt: date, updatedAt: date });
  }
  return due.slice(-MAX_CATCH_UP);
}
