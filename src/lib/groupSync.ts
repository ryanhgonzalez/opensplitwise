import type {
  Activity,
  CustomCategory,
  Expense,
  Group,
  GroupSyncedActivity,
  Settlement,
  Tombstone,
  User,
} from '../types';

// ─────────────────────────────────────────────────────────────────────────────
// Sharing a group between phones, with no server.
//
// The sender packs one group into a bundle (its details, members, expenses,
// payments and deletion markers; not the activity feed). The receiver merges
// it into whatever copy it already has:
//
//   • Records keep their ids on every phone, so a re-share updates rather
//     than duplicates.
//   • For an expense on both phones, the newer edit (`updatedAt`) wins. One
//     edited on both since the last share is listed as a conflict.
//   • A deletion marker removes the other copy unless it was edited after.
//   • Payments never change once made: they're only added or deleted.
//   • Group details (name, look, currency) follow the newer `updatedAt`;
//     members and categories are combined, less any removed on either phone
//     (a member added again after their removal stays).
//   • Each phone has its own id for each person. The first time, the
//     receiver says which incoming person is them and which match people
//     they already have; those matches are remembered (`userAliases`).
//
// Pure: the store applies the result. Encoding to bytes is in groupShare.ts.
// ─────────────────────────────────────────────────────────────────────────────

export const BUNDLE_KIND = 'opensplitwise-group';
export const BUNDLE_VERSION = 1;

export interface GroupBundle {
  kind: typeof BUNDLE_KIND;
  v: typeof BUNDLE_VERSION;
  sentAt: Date;
  /** Who sent it, by their id on the sender's phone. */
  senderId: string;
  group: Group;
  /** Everyone the group's records mention. */
  users: User[];
  expenses: Expense[];
  settlements: Settlement[];
  tombstones: Tombstone[];
}

/** The parts of the store a share reads or changes. */
export interface SyncState {
  currentUserId: string;
  users: User[];
  groups: Group[];
  expenses: Expense[];
  settlements: Settlement[];
  activities: Activity[];
  tombstones: Tombstone[];
  /** Another phone's id for a person → this phone's id for them. */
  userAliases: Record<string, string>;
  /** groupId → when it was last received from someone. */
  groupSyncedAt: Record<string, Date>;
}

const editedAt = (g: Pick<Group, 'updatedAt' | 'createdAt'>) => g.updatedAt ?? g.createdAt;

// ─── Sending ──────────────────────────────────────────────────────────────────

export function buildBundle(state: SyncState, groupId: string, now = new Date()): GroupBundle | null {
  const group = state.groups.find((g) => g.id === groupId);
  if (!group) return null;

  const expenses = state.expenses.filter((e) => e.groupId === groupId);
  const settlements = state.settlements.filter((s) => s.groupId === groupId);

  const mentioned = new Set(group.members.map((m) => m.userId));
  mentioned.add(state.currentUserId);
  for (const e of expenses) {
    mentioned.add(e.paidBy);
    for (const en of e.split.entries) mentioned.add(en.userId);
  }
  for (const s of settlements) {
    mentioned.add(s.fromUserId);
    mentioned.add(s.toUserId);
  }

  return {
    kind: BUNDLE_KIND,
    v: BUNDLE_VERSION,
    sentAt: now,
    senderId: state.currentUserId,
    group: { ...group, updatedAt: editedAt(group) },
    users: state.users.filter((u) => mentioned.has(u.id)),
    expenses,
    settlements,
    tombstones: state.tombstones.filter((t) => t.groupId === groupId),
  };
}

// ─── People ───────────────────────────────────────────────────────────────────

/** How an incoming person relates to the people on this phone. */
export interface PersonMatch {
  incoming: User;
  /** This phone's person they are, if known or likely. */
  localId?: string;
  /** same-id: shared before; remembered: matched on an earlier share; same-name: a guess to confirm. */
  reason: 'same-id' | 'remembered' | 'same-name' | 'none';
}

/** incoming person id → this phone's id for them, or 'new' to add them as a new person. */
export type PeopleChoice = Record<string, string>;

export const NEW_PERSON = 'new';

export function matchPeople(state: SyncState, bundle: GroupBundle): PersonMatch[] {
  const byName = new Map<string, string>();
  for (const u of state.users) byName.set(u.name.trim().toLowerCase(), u.id);
  return bundle.users.map((incoming) => {
    if (state.users.some((u) => u.id === incoming.id)) return { incoming, localId: incoming.id, reason: 'same-id' };
    const remembered = state.userAliases[incoming.id];
    if (remembered && state.users.some((u) => u.id === remembered)) {
      return { incoming, localId: remembered, reason: 'remembered' };
    }
    const named = byName.get(incoming.name.trim().toLowerCase());
    if (named) return { incoming, localId: named, reason: 'same-name' };
    return { incoming, reason: 'none' };
  });
}

/**
 * Whether the person using this phone still has to say which incoming person
 * they are: nobody in the bundle is already known to be them.
 */
export function needsSelfChoice(state: SyncState, matches: PersonMatch[]): boolean {
  return !matches.some(
    (m) => m.localId === state.currentUserId && (m.reason === 'same-id' || m.reason === 'remembered'),
  );
}

/** The choice the matches suggest, before the person adjusts it. */
export function defaultChoice(matches: PersonMatch[]): PeopleChoice {
  return Object.fromEntries(matches.map((m) => [m.incoming.id, m.localId ?? NEW_PERSON]));
}

// ─── Merging ──────────────────────────────────────────────────────────────────

export interface MergeSummary {
  groupName: string;
  isNewGroup: boolean;
  added: number;
  updated: number;
  deleted: number;
  newPeople: number;
  /** Names of members who join or leave this phone's copy of an existing group. */
  membersAdded: string[];
  membersRemoved: string[];
  /** Descriptions of expenses edited on both phones since the last share, and whose edit was kept. */
  conflicts: { description: string; kept: 'theirs' | 'yours' }[];
}

export interface MergeResult {
  state: SyncState;
  summary: MergeSummary;
}

/** Same expense, same edit: nothing to do. */
const sameEdit = (a: Expense, b: Expense) => a.updatedAt.getTime() === b.updatedAt.getTime();

export function mergeBundle(
  state: SyncState,
  bundle: GroupBundle,
  choice: PeopleChoice,
  now = new Date(),
  newId: () => string = () => crypto.randomUUID(),
): MergeResult {
  // ── People: decide each incoming person's id on this phone.
  const aliases = { ...state.userAliases };
  const users = [...state.users];
  let newPeople = 0;
  const idOf = new Map<string, string>();
  for (const incoming of bundle.users) {
    // Unless told otherwise, someone matched on an earlier share is still that person.
    const chosen = choice[incoming.id] ?? state.userAliases[incoming.id];
    if (chosen && chosen !== NEW_PERSON && users.some((u) => u.id === chosen)) {
      idOf.set(incoming.id, chosen);
      if (chosen !== incoming.id) aliases[incoming.id] = chosen;
    } else if (users.some((u) => u.id === incoming.id)) {
      idOf.set(incoming.id, incoming.id);
    } else {
      // New here: keep their id, so later shares recognise them.
      users.push(incoming);
      idOf.set(incoming.id, incoming.id);
      newPeople++;
    }
  }
  const map = (id: string) => idOf.get(id) ?? aliases[id] ?? id;
  const mapExpense = (e: Expense): Expense => ({
    ...e,
    paidBy: map(e.paidBy),
    split: { ...e.split, entries: e.split.entries.map((en) => ({ ...en, userId: map(en.userId) })) },
  });
  const mapSettlement = (s: Settlement): Settlement => ({ ...s, fromUserId: map(s.fromUserId), toUserId: map(s.toUserId) });

  const groupId = bundle.group.id;
  const local = state.groups.find((g) => g.id === groupId);
  const lastSync = state.groupSyncedAt[groupId]?.getTime() ?? 0;

  // ── Deletion markers: everyone's, keeping the latest per record. A member
  // marker names the person by the sender's id, so it's translated first.
  const tombs = new Map<string, Tombstone>();
  const keyOf = (kind: Tombstone['kind'], tombGroupId: string, id: string) => `${kind}:${tombGroupId}:${id}`;
  const incomingTombs = bundle.tombstones.map((t) => (t.kind === 'member' ? { ...t, id: map(t.id) } : t));
  for (const t of [...state.tombstones, ...incomingTombs]) {
    const key = keyOf(t.kind, t.groupId, t.id);
    const have = tombs.get(key);
    if (!have || t.deletedAt > have.deletedAt) tombs.set(key, t);
  }
  const deletedAfter = (kind: Tombstone['kind'], id: string, when: Date) => {
    const t = tombs.get(keyOf(kind, groupId, id));
    return !!t && t.deletedAt.getTime() >= when.getTime();
  };
  const isDeleted = (kind: Tombstone['kind'], id: string) => tombs.has(keyOf(kind, groupId, id));

  /** Both phones' members, the later join date where both have someone, less those removed since. */
  const combineMembers = (lists: Group['members'][]) => {
    const byUser = new Map<string, Group['members'][number]>();
    for (const m of lists.flat()) {
      const have = byUser.get(m.userId);
      if (!have || m.joinedAt > have.joinedAt) byUser.set(m.userId, m);
    }
    return [...byUser.values()].filter((m) => !deletedAfter('member', m.userId, m.joinedAt));
  };

  // ── Group details.
  const incomingMembers = bundle.group.members.map((m) => ({ ...m, userId: map(m.userId) }));
  let group: Group;
  if (!local) {
    group = {
      ...bundle.group,
      members: combineMembers([incomingMembers]),
      categories: (bundle.group.categories ?? []).filter((c) => !isDeleted('category', c.id)),
    };
  } else {
    const theirsNewer = editedAt(bundle.group).getTime() > editedAt(local).getTime();
    const details = theirsNewer ? bundle.group : local;
    const members = combineMembers([local.members, incomingMembers]);
    const categories: CustomCategory[] = [...(local.categories ?? [])];
    for (const c of bundle.group.categories ?? []) if (!categories.some((x) => x.id === c.id)) categories.push(c);
    group = {
      ...local,
      name: details.name,
      emoji: details.emoji,
      color: details.color,
      type: details.type,
      currency: details.currency,
      members,
      categories: categories.filter((c) => !isDeleted('category', c.id)),
      updatedAt: theirsNewer ? editedAt(bundle.group) : editedAt(local),
      lastActivity: bundle.group.lastActivity > local.lastActivity ? bundle.group.lastActivity : local.lastActivity,
    };
  }
  const currency = group.currency || 'USD';

  // ── Expenses.
  let added = 0;
  let updated = 0;
  let deleted = 0;
  const conflicts: MergeSummary['conflicts'] = [];
  const incomingExpenses = new Map(bundle.expenses.map((e) => [e.id, mapExpense(e)]));
  const removedExpenseIds = new Set<string>();
  const expenses: Expense[] = [];

  for (const mine of state.expenses) {
    if (mine.groupId !== groupId) {
      expenses.push(mine);
      continue;
    }
    if (deletedAfter('expense', mine.id, mine.updatedAt)) {
      removedExpenseIds.add(mine.id);
      deleted++;
      continue;
    }
    const theirs = incomingExpenses.get(mine.id);
    incomingExpenses.delete(mine.id);
    if (!theirs || sameEdit(mine, theirs)) {
      expenses.push({ ...mine, currency });
      continue;
    }
    const bothEdited = mine.updatedAt.getTime() > lastSync && theirs.updatedAt.getTime() > lastSync && lastSync > 0;
    if (theirs.updatedAt > mine.updatedAt) {
      expenses.push({ ...theirs, currency });
      updated++;
      if (bothEdited) conflicts.push({ description: theirs.description, kept: 'theirs' });
    } else {
      expenses.push({ ...mine, currency });
      if (bothEdited) conflicts.push({ description: mine.description, kept: 'yours' });
    }
  }
  for (const theirs of incomingExpenses.values()) {
    if (deletedAfter('expense', theirs.id, theirs.updatedAt)) continue;
    expenses.push({ ...theirs, currency });
    added++;
  }

  // ── Payments: added or deleted, never edited.
  const haveSettlement = new Set(state.settlements.map((s) => s.id));
  const removedSettlementIds = new Set<string>();
  const settlements: Settlement[] = [];
  for (const mine of state.settlements) {
    if (mine.groupId === groupId && isDeleted('settlement', mine.id)) {
      removedSettlementIds.add(mine.id);
      deleted++;
    } else {
      settlements.push(mine.groupId === groupId ? { ...mine, currency } : mine);
    }
  }
  for (const s of bundle.settlements) {
    if (haveSettlement.has(s.id) || isDeleted('settlement', s.id)) continue;
    settlements.push({ ...mapSettlement(s), currency });
    added++;
  }

  // ── Activity: drop entries for what's gone, add one summary entry.
  const activities = state.activities.filter((a) => {
    if ((a.type === 'expense_added' || a.type === 'expense_updated') && removedExpenseIds.has(a.expenseId)) return false;
    if ((a.type === 'payment' || a.type === 'settled') && removedSettlementIds.has(a.settlementId)) return false;
    return true;
  });
  const sender = bundle.users.find((u) => u.id === bundle.senderId);
  const entry: GroupSyncedActivity = {
    id: newId(),
    type: 'group_synced',
    actorId: map(bundle.senderId),
    groupId,
    date: now,
    fromName: sender?.name ?? 'someone',
    added,
    updated,
    deleted,
  };

  const nameOf = (id: string) => users.find((u) => u.id === id)?.name ?? 'Someone';
  const before = new Set(local?.members.map((m) => m.userId) ?? []);
  const after = new Set(group.members.map((m) => m.userId));
  const membersAdded = local ? [...after].filter((id) => !before.has(id)).map(nameOf) : [];
  const membersRemoved = local ? [...before].filter((id) => !after.has(id)).map(nameOf) : [];

  return {
    state: {
      ...state,
      users,
      groups: local ? state.groups.map((g) => (g.id === groupId ? group : g)) : [...state.groups, group],
      expenses,
      settlements,
      activities: [entry, ...activities],
      tombstones: [...tombs.values()],
      userAliases: aliases,
      groupSyncedAt: { ...state.groupSyncedAt, [groupId]: now },
    },
    summary: {
      groupName: group.name,
      isNewGroup: !local,
      added,
      updated,
      deleted,
      newPeople,
      membersAdded,
      membersRemoved,
      conflicts,
    },
  };
}
