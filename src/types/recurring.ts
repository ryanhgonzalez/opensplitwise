import type { Expense } from './expense';

export type RepeatFrequency = 'weekly' | 'biweekly' | 'monthly' | 'yearly';

/** What each repeat of a recurring expense is made from. */
export type RecurringTemplate = Pick<
  Expense,
  'description' | 'amount' | 'currency' | 'original' | 'paidBy' | 'split' | 'category' | 'items'
>;

/**
 * An expense that repeats: rent, utilities, subscriptions. Each repeat is an
 * ordinary expense, added when its date comes (src/lib/recurring.ts), with
 * the id `${id}:YYYY-MM-DD` so any phone adding it makes the same one.
 */
export interface RecurringExpense {
  id: string;
  groupId: string;
  frequency: RepeatFrequency;
  /** The first repeat's date. Monthly and yearly repeats keep its day of the month. */
  startDate: Date;
  template: RecurringTemplate;
  createdAt: Date;
  /** When the template or frequency last changed; the newer version wins when shared. */
  updatedAt: Date;
}
