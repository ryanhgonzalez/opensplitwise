import type { CustomCategoryId } from './expense';

export type GroupType = 'trip' | 'home' | 'couple' | 'family' | 'friends' | 'work' | 'event' | 'other';

export interface GroupMember {
  userId: string;
  role: 'owner' | 'member';
  joinedAt: Date;
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
  /** Categories made for this group, offered next to the built-in ones. Absent on older data. */
  categories?: CustomCategory[];
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
