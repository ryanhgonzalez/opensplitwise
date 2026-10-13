import { describe, expect, it } from 'vitest';
import type { RecurringExpense } from '../types';
import { dayKey, dueRepeats, nextOccurrence, occurrence, occurrenceId, ruleIdOf } from './recurring';

const d = (y: number, m: number, day: number) => new Date(y, m - 1, day);
const days = (dates: Date[]) => dates.map(dayKey);

const rent = (over: Partial<RecurringExpense> = {}): RecurringExpense => ({
  id: 'rent',
  groupId: 'flat',
  frequency: 'monthly',
  startDate: d(2026, 1, 31),
  template: {
    description: 'Rent', amount: 1200, currency: 'EUR', paidBy: 'a', category: 'rent',
    split: { type: 'equal', entries: [{ userId: 'a', amount: 600 }, { userId: 'b', amount: 600 }] },
  },
  createdAt: d(2026, 1, 31),
  updatedAt: d(2026, 1, 31),
  ...over,
});

describe('occurrence', () => {
  it('keeps the day of the month, or the month’s last day when it’s shorter', () => {
    expect(days([0, 1, 2, 3].map((n) => occurrence(d(2026, 1, 31), 'monthly', n)))).toEqual([
      '2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30',
    ]);
    expect(dayKey(occurrence(d(2024, 2, 29), 'yearly', 1))).toBe('2025-02-28');
  });

  it('steps weeks across month ends', () => {
    expect(days([0, 1, 2].map((n) => occurrence(d(2026, 10, 25), 'biweekly', n)))).toEqual([
      '2026-10-25', '2026-11-08', '2026-11-22',
    ]);
  });

  it('finds the next repeat on or after a date', () => {
    expect(dayKey(nextOccurrence(rent(), d(2026, 3, 1)))).toBe('2026-03-31');
    expect(dayKey(nextOccurrence(rent(), d(2026, 3, 31)))).toBe('2026-03-31');
  });
});

describe('dueRepeats', () => {
  it('adds each missed repeat on its own date, with ids any phone would choose', () => {
    const due = dueRepeats(rent(), d(2026, 4, 15), () => false);
    expect(due.map((e) => e.id)).toEqual(['rent:2026-01-31', 'rent:2026-02-28', 'rent:2026-03-31']);
    expect(due[1]).toMatchObject({ description: 'Rent', amount: 1200, groupId: 'flat', date: d(2026, 2, 28), updatedAt: d(2026, 2, 28) });
  });

  it('skips repeats already here or deleted, and nothing is due before the start', () => {
    const have = new Set(['rent:2026-01-31', 'rent:2026-02-28']);
    expect(dueRepeats(rent(), d(2026, 4, 15), (id) => have.has(id)).map((e) => e.id)).toEqual(['rent:2026-03-31']);
    expect(dueRepeats(rent({ startDate: d(2026, 5, 1) }), d(2026, 4, 15), () => false)).toEqual([]);
  });

  it('knows a repeat’s rule from its id', () => {
    expect(ruleIdOf(occurrenceId({ id: 'abc-123' }, d(2026, 2, 28)))).toBe('abc-123');
    expect(ruleIdOf('6f1c2b8e-plain-expense-id')).toBeUndefined();
  });
});
