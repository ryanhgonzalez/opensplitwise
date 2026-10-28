import { Expense } from '../types';
import { moneySign, netForUserOnExpense } from '../lib/calculations';

/** A person's share as spending: negative for their part of a refund. */
export function getShareForUser(expense: Expense, userId: string): number {
  const entry = expense.split.entries.find(e => e.userId === userId);
  return (entry?.amount ?? 0) * moneySign(expense) || 0;
}

/**
 * Re-exported from the calculation layer so there is exactly one definition of
 * "what did this expense do to my balance" in the app. Two copies had already
 * drifted apart once.
 */
export function getNetAmountForUser(expense: Expense, userId: string): number {
  return netForUserOnExpense(expense, userId);
}
