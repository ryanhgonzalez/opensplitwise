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

export type Activity =
  | GroupSyncedActivity
  | ExpenseAddedActivity
  | ExpenseUpdatedActivity
  | ExpenseDeletedActivity
  | PaymentActivity
  | SettledActivity;

export type ActivityType = Activity['type'];
