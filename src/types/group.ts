import type { CustomCategoryId } from './expense';

export type GroupType = 'trip' | 'home' | 'couple' | 'family' | 'friends' | 'work' | 'event' | 'other';

/** The colours a group can be given. */
export const GROUP_COLORS = ['#7c3aed', '#0ea5e9', '#10b981', '#f59e0b', '#ec4899', '#ef4444'];

export interface GroupMember {
  userId: string;
  role: 'owner' | 'member';
  joinedAt: Date;
}

export interface DefaultSplit {
  type: 'shares' | 'percentage';
  /** Shares, or percentages adding to 100. Someone not listed has 1 share, or 0%. */
  entries: { userId: string; value: number }[];
}

export interface CustomCategory {
  id: CustomCategoryId;
  name: string;
}

export interface Group {
  id: string;
  name: string;
  emoji: string;
  color: string;
  type: GroupType;
  members: GroupMember[];
  /** ISO 4217 code every amount in this group is in. Absent on older data, which is US dollars. */
  currency?: string;
  /**
   * Whether the payments to settle up are simplified: the fewest payments,
   * which can have someone pay a person they don't owe directly. Off, everyone
   * pays who they owe. Absent (older data, and new groups) means on.
   */
  simplifyDebts?: boolean;
  /**
   * How a new expense starts out split: by shares (2:1 for a couple) or by
   * percent (60/40). Absent means equally. Each expense can still change it.
   */
  defaultSplit?: DefaultSplit;
  /** Categories made for this group, offered next to the built-in ones. Absent on older data. */
  categories?: CustomCategory[];
  /**
   * Just you and one other person, outside any named group. It isn't listed
   * under Groups; it's on that person's page. Shared like any group.
   */
  direct?: boolean;
  /**
   * When it was archived on this phone: it leaves the Groups list and the
   * pickers, but its balances still count. Not shared with others.
   */
  archivedAt?: Date;
  lastActivity: Date;
  createdAt: Date;
  /**
   * When the shared details last changed: name, look, currency, members,
   * categories. When a group is shared, the newer version of these wins.
   * Absent on older data; createdAt stands in.
   */
  updatedAt?: Date;
}
// `yourBalance` and `totalSpent` used to live here. They are derived from the
// expenses and settlements now — see `deriveTotals` and the store's balance
// selectors — because a stored copy could disagree with the records it came from.
