export type ExpenseCategory =
  | 'food'
  | 'groceries'
  | 'transport'
  | 'travel'
  | 'accommodation'
  | 'shopping'
  | 'entertainment'
  | 'utilities'
  | 'rent'
  | 'healthcare'
  | 'gifts'
  | 'education'
  | 'subscriptions'
  | 'personal-care'
  | 'other';

export const CATEGORY_ICONS: Record<ExpenseCategory, string> = {
  food:          '🍽️',
  groceries:     '🛒',
  transport:     '🚗',
  travel:        '✈️',
  accommodation: '🏨',
  shopping:      '🛍️',
  entertainment: '🎬',
  utilities:     '⚡',
  rent:          '🏠',
  healthcare:    '🏥',
  gifts:         '🎁',
  education:     '📚',
  subscriptions: '📱',
  'personal-care': '💆',
  other:         '📦',
};

export const CATEGORY_LABELS: Record<ExpenseCategory, string> = {
  food:          'Food & Drink',
  groceries:     'Groceries',
  transport:     'Transport',
  travel:        'Travel',
  accommodation: 'Accommodation',
  shopping:      'Shopping',
  entertainment: 'Entertainment',
  utilities:     'Utilities',
  rent:          'Rent',
  healthcare:    'Healthcare',
  gifts:         'Gifts',
  education:     'Education',
  subscriptions: 'Subscriptions',
  'personal-care': 'Personal Care',
  other:         'Other',
};

/** A category the people in one group made themselves; see Group.categories. */
export type CustomCategoryId = `custom:${string}`;

/** What an expense stores: a built-in category, or one of its group's custom ones. */
export type CategoryId = ExpenseCategory | CustomCategoryId;

export type SplitType = 'equal' | 'exact' | 'percentage' | 'shares';

export interface SplitEntry {
  userId: string;
  amount: number;
}

export interface ExpenseSplit {
  type: SplitType;
  entries: SplitEntry[];
}

export interface Expense {
  id: string;
  description: string;
  amount: number;
  currency: string;
  paidBy: string;
  groupId?: string;
  date: Date;
  split: ExpenseSplit;
  category: CategoryId;
  /**
   * Set when it was paid in another currency than the group's. `amount` and
   * the split are then the converted figures the balances use; this is what
   * was actually paid, and the rate entered (group currency per 1 unit).
   */
  original?: { amount: number; currency: string; rate: number };
  notes?: string;
  receiptUrl?: string;
  createdAt: Date;
  updatedAt: Date;
}
