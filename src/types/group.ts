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
  /** Categories made for this group, offered next to the built-in ones. Absent on older data. */
  categories?: CustomCategory[];
  lastActivity: Date;
  createdAt: Date;
}
// `yourBalance` and `totalSpent` used to live here. They are derived from the
// expenses and settlements now — see `deriveTotals` and the store's balance
// selectors — because a stored copy could disagree with the records it came from.
