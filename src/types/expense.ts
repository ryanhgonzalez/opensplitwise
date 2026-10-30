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

/** One line of a receipt split by item: what it was, its price, and who had it. */
export interface ExpenseItem {
  description: string;
  /** In the currency the expense was entered in: `original.currency` when set, else the group's. */
  amount: number;
  /** Who shares this item (equally). */
  assigned: string[];
}

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
  /**
   * The receipt's lines, when split by item, so it can be reopened and
   * adjusted later. The split holds each person's resulting share; tax, tip
   * or a discount is the difference between the items and the total.
   */
  items?: ExpenseItem[];
  /**
   * Set when a photo of the receipt is kept with the expense. The photo
   * itself is on this device, in IndexedDB under the expense's id
   * (src/lib/receiptPhotos.ts); this just says there is one, and its size.
   */
  receipt?: { bytes: number };
  /**
   * Set when this is money coming back (a refund) rather than money spent.
   * `paidBy` is then who received it, and `split` how it's shared out; the
   * amounts stay positive and every balance and total counts them the other
   * way round. `of` is the expense it refunds, when there is one.
   */
  refund?: { of?: string };
  /**
   * Where it was paid, when "Add location" was tapped: the phone's GPS
   * position, worked out on the phone. `accuracy` is in metres. `place` is set
   * when a nearby place was picked (looked up on OpenStreetMap, only when
   * asked); the coordinates are then the place's.
   */
  location?: {
    lat: number;
    lng: number;
    accuracy?: number;
    place?: { name: string; kind?: string; address?: string };
  };
  createdAt: Date;
  updatedAt: Date;
}
