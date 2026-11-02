import { create } from 'zustand';

/** How long a group page marks what a swap brought in. */
const SHOWN_FOR_MS = 60 * 60 * 1000;

interface RecentSwap {
  groupId?: string;
  at: number;
  /** Expenses new on this phone, and ones the other phone's newer edit replaced. */
  added: Set<string>;
  edited: Set<string>;
  mark: (groupId: string, added: string[], edited: string[]) => void;
  clear: () => void;
}

/**
 * What the last swap brought in, so the group page can tag those expenses
 * "New" and "Edited" for a while. Kept in memory only: a reload forgets it.
 */
export const useRecentSwap = create<RecentSwap>((set) => ({
  at: 0,
  added: new Set(),
  edited: new Set(),
  mark: (groupId, added, edited) => set({ groupId, at: Date.now(), added: new Set(added), edited: new Set(edited) }),
  clear: () => set({ groupId: undefined, at: 0, added: new Set(), edited: new Set() }),
}));

/** The tag for an expense on a group's page: what the last swap did to it, if recent. */
export function swapTag(
  swap: Pick<RecentSwap, 'groupId' | 'at' | 'added' | 'edited'>,
  groupId: string,
  expense: { id: string; updatedAt: Date },
  now = Date.now(),
): 'New' | 'Edited' | undefined {
  if (swap.groupId !== groupId || now - swap.at > SHOWN_FOR_MS) return undefined;
  // Edited here since: no longer what the swap brought.
  if (expense.updatedAt.getTime() > swap.at) return undefined;
  if (swap.added.has(expense.id)) return 'New';
  if (swap.edited.has(expense.id)) return 'Edited';
  return undefined;
}
