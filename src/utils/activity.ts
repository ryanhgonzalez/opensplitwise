import { Activity, Expense, ExpenseUpdatedActivity, User } from '../types';
import { netForUserOnExpense } from '../lib/calculations';
import { getNetAmountForUser } from './expense';
import { formatCurrency } from './format';

type GetExpense = (id: string) => Expense | undefined;
type GetUser = (id: string) => User | undefined;

export function getActivityDescription(
  activity: Activity,
  currentUserId: string,
  getExpense: GetExpense,
  getUser: GetUser,
  /** The activity's group currency; payments don't record their own. */
  currency = 'USD',
): string {
  const actorName =
    activity.actorId === currentUserId
      ? 'You'
      : (getUser(activity.actorId)?.name ?? 'Someone');

  switch (activity.type) {
    case 'group_synced': {
      const parts = [
        activity.added && `${activity.added} new`,
        activity.updated && `${activity.updated} changed`,
        activity.deleted && `${activity.deleted} deleted`,
      ].filter(Boolean);
      return `Received the group from ${activity.fromName}${parts.length ? `: ${parts.join(', ')}` : ', nothing new'}`;
    }
    case 'expense_added': {
      const expense = getExpense(activity.expenseId);
      const what = `"${expense?.description ?? 'an expense'}"`;
      return expense?.refund ? `${actorName} added a refund: ${what}` : `${actorName} added ${what}`;
    }
    case 'expense_updated': {
      const expense = getExpense(activity.expenseId);
      return `${actorName} updated "${expense?.description ?? 'an expense'}"`;
    }
    case 'expense_deleted':
      return `${actorName} deleted "${activity.expenseDescription}"`;
    case 'payment': {
      const toName =
        activity.toUserId === currentUserId
          ? 'you'
          : (getUser(activity.toUserId)?.name ?? 'someone');
      if (activity.actorId === currentUserId) {
        return `You paid ${toName} ${formatCurrency(activity.amount, currency)}`;
      }
      return `${actorName} paid ${toName} ${formatCurrency(activity.amount, currency)}`;
    }
    case 'settled': {
      const toName =
        activity.toUserId === currentUserId
          ? 'you'
          : (getUser(activity.toUserId)?.name ?? 'someone');
      if (activity.actorId === currentUserId) {
        return `You settled up with ${toName}`;
      }
      return `${actorName} settled up with ${toName}`;
    }
    case 'reminder_sent': {
      const toName = getUser(activity.toUserId)?.name ?? 'someone';
      return `${actorName} reminded ${toName} about ${formatCurrency(activity.amount, activity.currency)}`;
    }
  }
}

/**
 * What one edit did to your balance: after minus before. Undefined for edits
 * recorded before the feed kept a copy of the expense either side.
 */
export function getEditBalanceChange(activity: ExpenseUpdatedActivity, currentUserId: string): number | undefined {
  if (!activity.before || !activity.after) return undefined;
  const change = netForUserOnExpense(activity.after, currentUserId) - netForUserOnExpense(activity.before, currentUserId);
  return Math.round(change * 100) / 100;
}

/**
 * What an edit changed, in a few words: "Amount $700.00 → $791.96 · Paid by
 * You → Elvira". Empty for older entries, or when nothing it reports on changed.
 */
export function getEditSummary(
  activity: ExpenseUpdatedActivity,
  currentUserId: string,
  getUser: GetUser,
  currency = 'USD',
): string {
  const { before, after } = activity;
  if (!before || !after) return '';
  const name = (id: string) => (id === currentUserId ? 'You' : (getUser(id)?.name.split(' ')[0] ?? 'Someone'));
  const shares = (s: typeof before.split) =>
    s.entries
      .filter((e) => e.amount > 0.005)
      .map((e) => `${e.userId}:${e.amount.toFixed(2)}`)
      .sort()
      .join();

  const parts: string[] = [];
  if (before.description !== after.description) parts.push(`Renamed from "${before.description}"`);
  if (Math.abs(before.amount - after.amount) >= 0.005) {
    parts.push(`Amount ${formatCurrency(before.amount, currency)} → ${formatCurrency(after.amount, currency)}`);
  }
  if (before.paidBy !== after.paidBy) parts.push(`Paid by ${name(before.paidBy)} → ${name(after.paidBy)}`);
  // A new amount reshapes an equal split on its own; only call out the split
  // when who's in it or how it's divided changed beyond that.
  const amountOnly =
    before.split.type === after.split.type &&
    before.split.type === 'equal' &&
    before.split.entries.map((e) => e.userId).sort().join() === after.split.entries.map((e) => e.userId).sort().join();
  if (shares(before.split) !== shares(after.split) && !amountOnly) parts.push('Split changed');
  if (!!before.refund !== !!after.refund) parts.push(after.refund ? 'Now a refund' : 'No longer a refund');
  return parts.join(' · ');
}

export function isActivityPositive(
  activity: Activity,
  currentUserId: string,
  getExpense: GetExpense,
): boolean {
  switch (activity.type) {
    case 'expense_added': {
      // Follows the effect on your balance, not who happened to log it —
      // recording an expense somebody else paid still leaves you owing.
      const expense = getExpense(activity.expenseId);
      return !expense || getNetAmountForUser(expense, currentUserId) >= 0;
    }
    case 'expense_updated':
      return (getEditBalanceChange(activity, currentUserId) ?? 0) >= 0;
    case 'expense_deleted':
    case 'group_synced':
    case 'reminder_sent':
      return false;
    case 'payment':
    case 'settled':
      return activity.toUserId === currentUserId;
  }
}

export function getActivityAmount(
  activity: Activity,
  currentUserId: string,
  getExpense: GetExpense
): number {
  switch (activity.type) {
    case 'expense_added': {
      const expense = getExpense(activity.expenseId);
      if (!expense) return 0;
      // What the expense did to your balance, not what your slice of it was.
      // Fronting $500 for two other people is +$500 to you even though none of
      // the split is yours — using the share would show nothing at all.
      return Math.abs(getNetAmountForUser(expense, currentUserId));
    }
    case 'expense_updated':
      // Only this edit's effect. Older entries didn't record one, and showing
      // the expense's current total instead read as if each edit moved it.
      return Math.abs(getEditBalanceChange(activity, currentUserId) ?? 0);
    case 'expense_deleted':
    case 'group_synced':
    case 'reminder_sent': // moves no money; the amount is in its description
      return 0;
    case 'payment':
    case 'settled':
      return activity.amount;
  }
}
