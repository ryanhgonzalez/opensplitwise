import { Activity, Expense, User } from '../types';
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
  }
}

export function isActivityPositive(
  activity: Activity,
  currentUserId: string,
  getExpense: GetExpense,
): boolean {
  switch (activity.type) {
    case 'expense_added':
    case 'expense_updated': {
      // Follows the effect on your balance, not who happened to log it —
      // recording an expense somebody else paid still leaves you owing.
      const expense = getExpense(activity.expenseId);
      return !expense || getNetAmountForUser(expense, currentUserId) >= 0;
    }
    case 'expense_deleted':
    case 'group_synced':
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
    case 'expense_added':
    case 'expense_updated': {
      const expense = getExpense(activity.expenseId);
      if (!expense) return 0;
      // What the expense did to your balance, not what your slice of it was.
      // Fronting $500 for two other people is +$500 to you even though none of
      // the split is yours — using the share would show nothing at all.
      return Math.abs(getNetAmountForUser(expense, currentUserId));
    }
    case 'expense_deleted':
    case 'group_synced':
      return 0;
    case 'payment':
    case 'settled':
      return activity.amount;
  }
}
