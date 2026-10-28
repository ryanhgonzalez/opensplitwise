import type { Expense } from './expense';

/** The parts of an expense an edit can change that the feed reports on. */
export type ExpenseSnapshot = Pick<Expense, 'description' | 'amount' | 'paidBy' | 'split' | 'refund'>;

interface BaseActivity {
  id: string;
  date: Date;
  actorId: string;
  groupId?: string;
}

export interface ExpenseAddedActivity extends BaseActivity {
  type: 'expense_added';
  expenseId: string;
}

export interface ExpenseUpdatedActivity extends BaseActivity {
  type: 'expense_updated';
  expenseId: string;
  /**
   * The expense just before and just after this edit, so the feed can say what
   * changed and what it did to each person's balance. Absent on entries from
   * before this was recorded.
   */
  before?: ExpenseSnapshot;
  after?: ExpenseSnapshot;
}

export interface ExpenseDeletedActivity extends BaseActivity {
  type: 'expense_deleted';
  expenseDescription: string;
}

export interface PaymentActivity extends BaseActivity {
  type: 'payment';
  settlementId: string;
  fromUserId: string;
  toUserId: string;
  amount: number;
}

export interface SettledActivity extends BaseActivity {
  type: 'settled';
  settlementId: string;
  fromUserId: string;
  toUserId: string;
  amount: number;
}

/** One entry per group received from someone, instead of their whole feed. */
export interface GroupSyncedActivity extends BaseActivity {
  type: 'group_synced';
  /** The sender, as named in the file. */
  fromName: string;
  added: number;
  updated: number;
  deleted: number;
}

/** You reminded someone what they owe. Nothing changes hands. */
export interface ReminderSentActivity extends BaseActivity {
  type: 'reminder_sent';
  toUserId: string;
  amount: number;
  currency: string;
  /** How it went out: a text, the share sheet, or copied to paste somewhere. */
  via: 'text' | 'share' | 'copy';
}

export type Activity =
  | GroupSyncedActivity
  | ReminderSentActivity
  | ExpenseAddedActivity
  | ExpenseUpdatedActivity
  | ExpenseDeletedActivity
  | PaymentActivity
  | SettledActivity;

