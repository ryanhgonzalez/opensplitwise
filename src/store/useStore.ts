import { create } from 'zustand';
import { devtools, persist, createJSONStorage } from 'zustand/middleware';
import type {
  User,
  Group,
  Expense,
  Settlement,
  Activity,
  PaymentMethod,
  ExpenseAddedActivity,
  ExpenseUpdatedActivity,
  ExpenseDeletedActivity,
  PaymentActivity,
  SettledActivity,
  CategoryId,
  CustomCategory,
  CustomCategoryId,
  Tombstone,
  RecurringExpense,
  RecurringTemplate,
  RepeatFrequency,
} from '../types';
import { dueRepeats, ruleIdOf } from '../lib/recurring';
import { mergeBundle, type GroupBundle, type MergeOptions, type MergeSummary, type PeopleChoice } from '../lib/groupSync';
import type { ExportPayload, ImportStats } from '../lib/dataExport';
import { cleanCategoryName, findCategoryByName } from '../lib/categories';
import { round, outstandingByGroup, allocatePayment } from '../lib/calculations';

// ─── Action input types ───────────────────────────────────────────────────────

export type AddExpenseInput = Omit<Expense, 'id' | 'createdAt' | 'updatedAt'>;
export type UpdateExpenseInput = Partial<Omit<Expense, 'id' | 'createdAt'>>;
export type CreateGroupInput = Omit<Group, 'id' | 'createdAt' | 'lastActivity'>;
export type UpdateGroupInput = Partial<Omit<Group, 'id' | 'createdAt'>>;
export type AddSettlementInput = Omit<Settlement, 'id' | 'createdAt'>;
export type AddUserInput = { name: string; email?: string };
export type UpdateUserInput = Partial<Pick<User, 'name' | 'email' | 'avatarColor' | 'initials'>>;

/** Everything deleting an expense removed or added, so it can be undone exactly. */
export interface DeletedExpense {
  expense: Expense;
  /** Its add/update feed entries, which deleting drops. */
  activities: Activity[];
  /** The "deleted" feed entry and deletion marker deleting added. */
  deletedActivityId: string;
  deletedAt: Date;
}

/** A payment that is not tied to one group — the app decides which groups it pays down. */
export type SettleWithUserInput = {
  fromUserId: string;
  toUserId: string;
  amount: number;
  currency: string;
  date: Date;
  paymentMethod?: PaymentMethod;
  note?: string;
};

// ─── Store interface ──────────────────────────────────────────────────────────

export type ThemeMode = 'light' | 'dark' | 'system';

export interface AppStore {
  // ── State ──
  //
  // Only raw records live here. Every balance the UI shows — per-friend, per-group,
  // overall — is derived from these by `deriveTotals` behind memoized selectors.
  // Storing them alongside was the source of a string of drift bugs: each action
  // had to patch every total correctly and in both directions, and a single missed
  // term left the numbers permanently wrong with nothing to detect it.
  hasOnboarded: boolean;
  theme: ThemeMode;
  currentUserId: string;
  /**
   * True when the data on hand came from somebody else's export and the person
   * using the app has not yet said which of the imported people they are.
   * While set, the app shows the identity picker instead of the main shell —
   * otherwise the importer would silently be acting as the exporter.
   */
  needsIdentity: boolean;
  users: User[];
  groups: Group[];
  expenses: Expense[];
  settlements: Settlement[];
  activities: Activity[];
  /** Deletion markers, so deletions travel when a group is shared (see groupSync.ts). */
  tombstones: Tombstone[];
  /** Another phone's id for a person → this phone's id for them, learned when receiving groups. */
  userAliases: Record<string, string>;
  /** groupId → when it was last received from someone. */
  groupSyncedAt: Record<string, Date>;
  /** Repeating expenses (rent, bills); each repeat is added as an ordinary expense when due. */
  recurring: RecurringExpense[];

  // ── Theme ──
  setTheme: (theme: ThemeMode) => void;

  // ── Onboarding ──
  completeOnboarding: (name: string) => void;

  // ── User actions ──
  /** Switches whose perspective the whole app is rendered from. */
  setCurrentUser: (userId: string) => void;
  /** Adds a person and immediately becomes them — used when the importer isn't in the file. */
  claimIdentityAsNewUser: (name: string) => User;

  // ── Expense actions ──
  addExpense: (input: AddExpenseInput) => Expense;
  updateExpense: (id: string, updates: UpdateExpenseInput) => void;
  /** Returns what was removed, for undoExpenseDelete. */
  deleteExpense: (id: string) => DeletedExpense | undefined;
  /** Puts a just-deleted expense back exactly as it was, as if never deleted. */
  undoExpenseDelete: (deleted: DeletedExpense) => void;

  // ── Group actions ──
  createGroup: (input: CreateGroupInput) => Group;
  updateGroup: (id: string, updates: UpdateGroupInput) => void;
  deleteGroup: (id: string) => void;
  addGroupMember: (groupId: string, userId: string) => void;
  removeGroupMember: (groupId: string, userId: string) => void;
  /**
   * Adds a custom category to the group and returns its id. A name that
   * matches an existing category (ignoring case) returns that one instead.
   * Null when the name is blank or the group doesn't exist.
   */
  addGroupCategory: (groupId: string, name: string) => CategoryId | null;
  /** Removes a custom category; the group's expenses that used it move to Other. */
  removeGroupCategory: (groupId: string, categoryId: CustomCategoryId) => void;

  // ── Settlement actions ──
  /** Records a payment against one specific group. */
  addSettlement: (input: AddSettlementInput) => Settlement;
  /**
   * Records a payment against the running total with someone, spreading it
   * across the groups the debt actually sits in.
   */
  settleWithUser: (input: SettleWithUserInput) => Settlement[];
  deleteSettlement: (id: string) => void;

  // ── User actions ──
  addUser: (input: AddUserInput) => User;
  updateUser: (id: string, updates: UpdateUserInput) => void;
  deleteUser: (id: string) => void;

  // ── Import actions ──
  restoreAllData: (payload: ExportPayload) => void;
  mergeImportData: (payload: ExportPayload) => ImportStats;

  // ── Recurring ──
  /** Sets up a repeating expense and adds any repeats already due (the first, if it starts today or earlier). */
  addRecurring: (input: {
    groupId: string;
    frequency: RepeatFrequency;
    startDate: Date;
    template: RecurringTemplate;
    /** A receipt photo for the first repeat (the one on the start date). */
    receipt?: Expense['receipt'];
  }) => {
    rule: RecurringExpense;
    added: Expense[];
  };
  /** Stops a repeat; expenses it already added stay. */
  stopRecurring: (id: string) => void;
  /** Adds every repeat that has come due, on its own date. Returns them. */
  addDueRecurring: (today?: Date) => Expense[];

  // ── Sharing ──
  /** Merges a group received from another phone; returns what changed. */
  applyGroupBundle: (bundle: GroupBundle, people: PeopleChoice, options?: MergeOptions) => MergeSummary;

  // ── Danger zone ──
  wipeAllData: () => void;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function uid(): string {
  return crypto.randomUUID();
}

function makeUser(name: string, index: number): User {
  const palette = ['#7c3aed', '#0ea5e9', '#10b981', '#f59e0b', '#ec4899', '#ef4444', '#8b5cf6', '#06b6d4'];
  const trimmed = name.trim();
  const initials = trimmed.split(/\s+/).map((p) => p[0]).join('').toUpperCase().slice(0, 2);
  return {
    id: uid(),
    name: trimmed,
    initials,
    avatarColor: palette[index % palette.length],
    createdAt: new Date(),
  };
}

/** Sub-cent remainders are treated as fully paid. */
const EPSILON = 0.005;

/**
 * Whether `fromUserId` still owes `toUserId` anything once `settlements` are
 * applied — scoped to one group when `groupId` is given, otherwise across
 * everything. Decides whether a payment reads as "paid" or "settled up".
 */
function debtCleared(
  expenses: Expense[],
  settlements: Settlement[],
  fromUserId: string,
  toUserId: string,
  groupId?: string,
  currency?: string,
): boolean {
  const buckets = outstandingByGroup(expenses, settlements, fromUserId, toUserId, currency);
  const inScope = groupId ? buckets.filter((b) => b.groupId === groupId) : buckets;
  return inScope.reduce((sum, b) => sum + b.outstanding, 0) <= EPSILON;
}

/** What a recurring expense repeats, taken from one of its expenses. */
function templateOf(e: Expense): RecurringTemplate {
  return {
    description: e.description,
    amount: e.amount,
    currency: e.currency,
    original: e.original,
    paidBy: e.paidBy,
    split: e.split,
    category: e.category,
    items: e.items,
  };
}

function touchGroups(groups: Group[], groupIds: Set<string>, when: Date): Group[] {
  return groups.map((g) => (groupIds.has(g.id) ? { ...g, lastActivity: when } : g));
}

/**
 * Re-attributes payments that were recorded against no group at all.
 *
 * Settle Up used to write these, which moved the overall balance while leaving
 * every group balance untouched — so the group balances no longer summed to the
 * net and no amount of settling could bring them back in line. Replayed in date
 * order so each payment is allocated against what was actually outstanding when
 * it was made.
 */
function attributeLooseSettlements(expenses: Expense[], settlements: Settlement[]): Settlement[] {
  const attributed = settlements.filter((s) => s.groupId);
  const loose = settlements
    .filter((s) => !s.groupId)
    .sort((a, b) => a.date.getTime() - b.date.getTime());

  for (const payment of loose) {
    const buckets = outstandingByGroup(expenses, attributed, payment.fromUserId, payment.toUserId);
    const allocations = allocatePayment(payment.amount, buckets);

    // Nothing to attribute it to (the debt was never group-based) — keep as-is.
    if (allocations.length === 0) {
      attributed.push(payment);
      continue;
    }

    // The first slice keeps the original ID so the activity feed entry that
    // references this payment still resolves.
    attributed.push(
      ...allocations.map((allocation, i) => ({
        ...payment,
        id: i === 0 ? payment.id : uid(),
        groupId: allocation.groupId,
        amount: allocation.amount,
      })),
    );
  }

  return attributed;
}

// ─── Persistence ──────────────────────────────────────────────────────────────

const ISO_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;

const persistStorage = createJSONStorage(() => localStorage, {
  reviver: (_key: string, value: unknown) =>
    typeof value === 'string' && ISO_DATE.test(value) ? new Date(value) : value,
});

// ─── Store ───────────────────────────────────────────────────────────────────

export const useStore = create<AppStore>()(
  devtools(
    persist(
      (set, get) => ({
        // ── Initial state ────────────────────────────────────────────────────

        hasOnboarded: false,
        theme: 'system' as ThemeMode,
        currentUserId: '',
        needsIdentity: false,
        users: [],
        groups: [],
        expenses: [],
        settlements: [],
        activities: [],
        tombstones: [],
        userAliases: {},
        groupSyncedAt: {},
        recurring: [],

        // ── Theme ────────────────────────────────────────────────────────────

        setTheme: (theme) => set({ theme }, false, 'setTheme'),

        // ── Onboarding ───────────────────────────────────────────────────────

        completeOnboarding: (name) => {
          const user = makeUser(name, 0);
          set(
            { hasOnboarded: true, needsIdentity: false, currentUserId: user.id, users: [user] },
            false,
            'completeOnboarding',
          );
        },

        // ── User ─────────────────────────────────────────────────────────────

        setCurrentUser: (userId) => {
          if (!get().users.some((u) => u.id === userId)) return;
          // Balances are derived from the current user, so switching identity
          // needs nothing but the ID — every total re-reads on the next render.
          set({ currentUserId: userId, needsIdentity: false }, false, 'setCurrentUser');
        },

        claimIdentityAsNewUser: (name) => {
          const { users } = get();
          const user = makeUser(name, users.length);
          set(
            { users: [...users, user], currentUserId: user.id, needsIdentity: false },
            false,
            'claimIdentityAsNewUser',
          );
          return user;
        },

        // ── Expenses ─────────────────────────────────────────────────────────

        addExpense: (input) => {
          const { currentUserId, groups, expenses, activities } = get();
          const id = uid();
          const now = new Date();
          const expense: Expense = { ...input, id, createdAt: now, updatedAt: now };

          const activity: ExpenseAddedActivity = {
            id: uid(),
            type: 'expense_added',
            actorId: currentUserId,
            expenseId: id,
            groupId: input.groupId,
            date: now,
          };

          set(
            {
              expenses: [...expenses, expense],
              activities: [activity, ...activities],
              groups: input.groupId ? touchGroups(groups, new Set([input.groupId]), now) : groups,
            },
            false,
            'addExpense',
          );

          return expense;
        },

        updateExpense: (id, updates) => {
          const { currentUserId, expenses, groups, activities } = get();
          const old = expenses.find((e) => e.id === id);
          if (!old) return;

          const now = new Date();
          const updated: Expense = { ...old, ...updates, id, updatedAt: now };

          const activity: ExpenseUpdatedActivity = {
            id: uid(),
            type: 'expense_updated',
            actorId: currentUserId,
            expenseId: id,
            groupId: updated.groupId,
            date: now,
          };

          // An expense can be moved between groups, so both ends need touching.
          const touched = new Set([old.groupId, updated.groupId].filter(Boolean) as string[]);

          // Editing a recurring expense's latest repeat (this month's bill) sets
          // what the next ones are: "the last amount".
          const ruleId = ruleIdOf(id);
          const rule = ruleId ? get().recurring.find((r) => r.id === ruleId) : undefined;
          const latest = rule
            ? expenses.filter((e) => ruleIdOf(e.id) === rule.id).every((e) => e.date <= old.date)
            : false;

          set(
            {
              expenses: expenses.map((e) => (e.id === id ? updated : e)),
              activities: [activity, ...activities],
              groups: touchGroups(groups, touched, now),
              ...(rule && latest && {
                recurring: get().recurring.map((r) =>
                  r.id === rule.id ? { ...r, template: templateOf(updated), updatedAt: now } : r,
                ),
              }),
            },
            false,
            'updateExpense',
          );
        },

        deleteExpense: (id) => {
          const { currentUserId, expenses, groups, activities, tombstones } = get();
          const expense = expenses.find((e) => e.id === id);
          if (!expense) return;

          const now = new Date();
          const activity: ExpenseDeletedActivity = {
            id: uid(),
            type: 'expense_deleted',
            actorId: currentUserId,
            expenseDescription: expense.description,
            groupId: expense.groupId,
            date: now,
          };

          const pointsAtIt = (a: Activity) =>
            (a.type === 'expense_added' || a.type === 'expense_updated') && a.expenseId === id;

          set(
            {
              expenses: expenses.filter((e) => e.id !== id),
              // The add/update entries point at an expense that no longer exists;
              // the deletion entry it leaves behind is the record of what happened.
              activities: [activity, ...activities.filter((a) => !pointsAtIt(a))],
              groups: expense.groupId ? touchGroups(groups, new Set([expense.groupId]), now) : groups,
              tombstones: expense.groupId
                ? [...tombstones, { id, kind: 'expense', groupId: expense.groupId, deletedAt: now }]
                : tombstones,
            },
            false,
            'deleteExpense',
          );
          return { expense, activities: activities.filter(pointsAtIt), deletedActivityId: activity.id, deletedAt: now };
        },

        undoExpenseDelete: ({ expense, activities: removed, deletedActivityId, deletedAt }) => {
          const { expenses, activities, tombstones } = get();
          if (expenses.some((e) => e.id === expense.id)) return;
          set(
            {
              expenses: [...expenses, expense],
              activities: [...removed, ...activities.filter((a) => a.id !== deletedActivityId)],
              // Withdraw the deletion marker, or sharing the group would still delete it elsewhere.
              tombstones: tombstones.filter(
                (t) => !(t.kind === 'expense' && t.id === expense.id && t.deletedAt.getTime() === deletedAt.getTime()),
              ),
            },
            false,
            'undoExpenseDelete',
          );
        },

        // ── Groups ───────────────────────────────────────────────────────────

        createGroup: (input) => {
          const now = new Date();
          const group: Group = { ...input, id: uid(), lastActivity: now, createdAt: now };
          set({ groups: [...get().groups, group] }, false, 'createGroup');
          return group;
        },

        updateGroup: (id, updates) => {
          const { groups, expenses, settlements } = get();
          const before = groups.find((g) => g.id === id);
          // A new currency relabels the group's amounts; it doesn't convert them.
          // (The usual reason: the group predates currencies and was never in dollars.)
          const relabel = updates.currency && updates.currency !== (before?.currency || 'USD') ? updates.currency : undefined;
          set(
            {
              groups: groups.map((g) => (g.id === id ? { ...g, ...updates, updatedAt: new Date() } : g)),
              ...(relabel && {
                expenses: expenses.map((e) => (e.groupId === id ? { ...e, currency: relabel } : e)),
                settlements: settlements.map((st) => (st.groupId === id ? { ...st, currency: relabel } : st)),
              }),
            },
            false,
            'updateGroup',
          );
        },

        deleteGroup: (id) => {
          const { groups, expenses, settlements, activities, tombstones, groupSyncedAt } = get();
          const syncedAt = { ...groupSyncedAt };
          delete syncedAt[id];
          set(
            {
              groups: groups.filter((g) => g.id !== id),
              expenses: expenses.filter((e) => e.groupId !== id),
              settlements: settlements.filter((s) => s.groupId !== id),
              activities: activities.filter((a) => a.groupId !== id),
              tombstones: tombstones.filter((t) => t.groupId !== id),
              groupSyncedAt: syncedAt,
              recurring: get().recurring.filter((r) => r.groupId !== id),
            },
            false,
            'deleteGroup',
          );
        },

        addGroupCategory: (groupId, rawName) => {
          const group = get().groups.find((g) => g.id === groupId);
          const name = cleanCategoryName(rawName);
          if (!group || !name) return null;

          const existing = findCategoryByName(name, group);
          if (existing) return existing;

          const category: CustomCategory = { id: `custom:${uid()}`, name };
          set(
            {
              groups: get().groups.map((g) =>
                g.id === groupId ? { ...g, categories: [...(g.categories ?? []), category], updatedAt: new Date() } : g,
              ),
            },
            false,
            'addGroupCategory',
          );
          return category.id;
        },

        removeGroupCategory: (groupId, categoryId) => {
          const now = new Date();
          set(
            {
              groups: get().groups.map((g) =>
                g.id === groupId
                  ? { ...g, categories: (g.categories ?? []).filter((c) => c.id !== categoryId), updatedAt: now }
                  : g,
              ),
              tombstones: [...get().tombstones, { id: categoryId, kind: 'category', groupId, deletedAt: now }],
              expenses: get().expenses.map((e) =>
                e.groupId === groupId && e.category === categoryId ? { ...e, category: 'other', updatedAt: now } : e,
              ),
            },
            false,
            'removeGroupCategory',
          );
        },

        addGroupMember: (groupId, userId) =>
          set(
            {
              groups: get().groups.map((g) => {
                if (g.id !== groupId || g.members.some((m) => m.userId === userId)) return g;
                return {
                  ...g,
                  members: [...g.members, { userId, role: 'member', joinedAt: new Date() }],
                  updatedAt: new Date(),
                };
              }),
            },
            false,
            'addGroupMember',
          ),

        removeGroupMember: (groupId, userId) => {
          const now = new Date();
          set(
            {
              groups: get().groups.map((g) =>
                g.id === groupId
                  ? { ...g, members: g.members.filter((m) => m.userId !== userId), updatedAt: now }
                  : g,
              ),
              tombstones: [...get().tombstones, { id: userId, kind: 'member', groupId, deletedAt: now }],
            },
            false,
            'removeGroupMember',
          );
        },

        // ── Settlements ──────────────────────────────────────────────────────

        addSettlement: (input) => {
          const { settlements, groups, expenses, activities } = get();
          const now = new Date();
          const settlement: Settlement = { ...input, amount: round(input.amount), id: uid(), createdAt: now };
          const nextSettlements = [...settlements, settlement];

          const cleared = debtCleared(
            expenses,
            nextSettlements,
            settlement.fromUserId,
            settlement.toUserId,
            settlement.groupId,
          );

          const activity: PaymentActivity | SettledActivity = {
            id: uid(),
            type: cleared ? 'settled' : 'payment',
            actorId: settlement.fromUserId,
            settlementId: settlement.id,
            fromUserId: settlement.fromUserId,
            toUserId: settlement.toUserId,
            amount: settlement.amount,
            groupId: settlement.groupId,
            date: now,
          };

          set(
            {
              settlements: nextSettlements,
              activities: [activity, ...activities],
              groups: settlement.groupId
                ? touchGroups(groups, new Set([settlement.groupId]), now)
                : groups,
            },
            false,
            'addSettlement',
          );

          return settlement;
        },

        /**
         * Splits one payment across the groups the debt sits in, proportional to
         * what is outstanding in each, and records a settlement per slice.
         *
         * Settle Up works on the running total with a person rather than on one
         * group, but a payment attributed to no group moves only the overall
         * balance — leaving the group balances stranded above it forever. Paying
         * each group down in proportion keeps the two consistent.
         */
        settleWithUser: (input) => {
          const { settlements, groups, expenses, activities } = get();
          const now = new Date();

          // Only debts in the payment's currency can be paid down by it.
          const buckets = outstandingByGroup(expenses, settlements, input.fromUserId, input.toUserId, input.currency);
          const allocations = allocatePayment(input.amount, buckets);
          if (allocations.length === 0) return [];

          const created: Settlement[] = allocations.map((allocation) => ({
            fromUserId: input.fromUserId,
            toUserId: input.toUserId,
            amount: allocation.amount,
            currency: input.currency,
            groupId: allocation.groupId,
            date: input.date,
            paymentMethod: input.paymentMethod,
            note: input.note,
            id: uid(),
            createdAt: now,
          }));

          const nextSettlements = [...settlements, ...created];
          const clearedOverall = debtCleared(
            expenses,
            nextSettlements,
            input.fromUserId,
            input.toUserId,
            undefined,
            input.currency,
          );

          // One feed entry per slice, each tagged with its group so the feed
          // stays readable. Only the last carries "settled up", so a payment
          // that clears the balance says so exactly once.
          const newActivities: Array<PaymentActivity | SettledActivity> = created.map((settlement, i) => ({
            id: uid(),
            type: clearedOverall && i === created.length - 1 ? 'settled' : 'payment',
            actorId: settlement.fromUserId,
            settlementId: settlement.id,
            fromUserId: settlement.fromUserId,
            toUserId: settlement.toUserId,
            amount: settlement.amount,
            groupId: settlement.groupId,
            date: now,
          }));

          const touched = new Set(created.map((s) => s.groupId).filter(Boolean) as string[]);

          set(
            {
              settlements: nextSettlements,
              activities: [...newActivities.reverse(), ...activities],
              groups: touchGroups(groups, touched, now),
            },
            false,
            'settleWithUser',
          );

          return created;
        },

        /** Undo a payment that was marked complete — balances rewind to before it. */
        deleteSettlement: (id) => {
          const { settlements, activities, tombstones } = get();
          const settlement = settlements.find((s) => s.id === id);
          if (!settlement) return;

          set(
            {
              settlements: settlements.filter((s) => s.id !== id),
              // Drop the payment / settled entry this settlement produced.
              activities: activities.filter(
                (a) => !((a.type === 'payment' || a.type === 'settled') && a.settlementId === id),
              ),
              tombstones: settlement.groupId
                ? [...tombstones, { id, kind: 'settlement', groupId: settlement.groupId, deletedAt: new Date() }]
                : tombstones,
            },
            false,
            'deleteSettlement',
          );
        },

        // ── Users ────────────────────────────────────────────────────────────

        addUser: ({ name, email }) => {
          const user = { ...makeUser(name, get().users.length), email };
          set({ users: [...get().users, user] }, false, 'addUser');
          return user;
        },

        updateUser: (id, updates) =>
          set(
            { users: get().users.map((u) => (u.id === id ? { ...u, ...updates } : u)) },
            false,
            'updateUser',
          ),

        deleteUser: (id) => {
          const { currentUserId, users, groups, expenses, settlements, activities } = get();
          if (id === currentUserId) return;

          const purgedExpenseIds = new Set(
            expenses
              .filter((e) => e.paidBy === id || e.split.entries.some((en) => en.userId === id))
              .map((e) => e.id),
          );

          // Drop every activity that points at the removed person or at an expense
          // that went with them. The feed already skips rows whose actor is gone,
          // so leaving them behind only inflates the event count with entries that
          // never render — and payment rows name the other party, who may be gone.
          const remainingActivities = activities.filter((a) => {
            if (a.actorId === id) return false;
            if (a.type === 'payment' || a.type === 'settled') {
              return a.fromUserId !== id && a.toUserId !== id;
            }
            if (a.type === 'expense_added' || a.type === 'expense_updated') {
              return !purgedExpenseIds.has(a.expenseId);
            }
            return true;
          });

          set(
            {
              users: users.filter((u) => u.id !== id),
              expenses: expenses.filter((e) => !purgedExpenseIds.has(e.id)),
              settlements: settlements.filter((s) => s.fromUserId !== id && s.toUserId !== id),
              groups: groups.map((g) => ({
                ...g,
                members: g.members.filter((m) => m.userId !== id),
              })),
              activities: remainingActivities,
            },
            false,
            'deleteUser',
          );
        },

        // ── Import ───────────────────────────────────────────────────────────

        restoreAllData: (payload) => {
          const { currentUserId, users, groups, expenses, settlements, activities } = payload;
          const { tombstones = [], userAliases = {}, groupSyncedAt = {}, recurring = [] } = payload;
          set(
            {
              hasOnboarded: true,
              // The file carries its author's identity. If more than one person
              // is in it we can't know whether this is the author restoring a
              // backup or someone they shared it with, so ask before letting
              // the app render from the author's perspective.
              needsIdentity: users.length > 1,
              currentUserId,
              users,
              groups,
              expenses,
              settlements,
              activities,
              tombstones,
              userAliases,
              groupSyncedAt,
              recurring,
            },
            false,
            'restoreAllData',
          );
        },

        mergeImportData: (payload) => {
          const state = get();
          const existingUserIds  = new Set(state.users.map((u) => u.id));
          const existingGroupIds = new Set(state.groups.map((g) => g.id));
          const existingExpIds   = new Set(state.expenses.map((e) => e.id));
          const existingSetIds   = new Set(state.settlements.map((s) => s.id));
          const existingActIds   = new Set(state.activities.map((a) => a.id));

          const newUsers       = payload.users.filter((u) => !existingUserIds.has(u.id));
          const newGroups      = payload.groups.filter((g) => !existingGroupIds.has(g.id));
          // A group already here keeps its own fields, but gains any custom
          // categories the file has that it doesn't, so imported expenses
          // that use them still show their name.
          const incomingCategories = new Map(payload.groups.map((g) => [g.id, g.categories ?? []]));
          const mergedGroups = state.groups.map((g) => {
            const have = new Set((g.categories ?? []).map((c) => c.id));
            const extra = (incomingCategories.get(g.id) ?? []).filter((c) => !have.has(c.id));
            return extra.length ? { ...g, categories: [...(g.categories ?? []), ...extra] } : g;
          });
          const newExpenses    = payload.expenses.filter((e) => !existingExpIds.has(e.id));
          const newSettlements = payload.settlements.filter((s) => !existingSetIds.has(s.id));
          const newActivities  = payload.activities.filter((a) => !existingActIds.has(a.id));

          set(
            {
              users:       [...state.users, ...newUsers],
              groups:      [...mergedGroups, ...newGroups],
              expenses:    [...state.expenses, ...newExpenses],
              settlements: [...state.settlements, ...newSettlements],
              activities:  [...state.activities, ...newActivities],
            },
            false,
            'mergeImportData',
          );

          return {
            usersAdded:       newUsers.length,
            groupsAdded:      newGroups.length,
            expensesAdded:    newExpenses.length,
            settlementsAdded: newSettlements.length,
          };
        },

        // ── Recurring ──────────────────────────────────────────────────────────

        addRecurring: ({ groupId, frequency, startDate, template, receipt }) => {
          const now = new Date();
          const rule: RecurringExpense = { id: uid(), groupId, frequency, startDate, template, createdAt: now, updatedAt: now };
          set({ recurring: [...get().recurring, rule] }, false, 'addRecurring');
          let added = get().addDueRecurring(now).filter((e) => ruleIdOf(e.id) === rule.id);
          const first = added.find((e) => e.date.getTime() === added[0]?.date.getTime());
          if (receipt && first) {
            set({ expenses: get().expenses.map((e) => (e.id === first.id ? { ...e, receipt } : e)) }, false, 'addRecurring');
            added = added.map((e) => (e.id === first.id ? { ...e, receipt } : e));
          }
          return { rule, added };
        },

        stopRecurring: (id) => {
          const rule = get().recurring.find((r) => r.id === id);
          if (!rule) return;
          set(
            {
              recurring: get().recurring.filter((r) => r.id !== id),
              // So stopping it travels when the group is shared.
              tombstones: [...get().tombstones, { id, kind: 'recurring', groupId: rule.groupId, deletedAt: new Date() }],
            },
            false,
            'stopRecurring',
          );
        },

        addDueRecurring: (today = new Date()) => {
          const { recurring, expenses, tombstones, activities, groups, currentUserId } = get();
          if (recurring.length === 0) return [];
          const have = new Set(expenses.map((e) => e.id));
          const deleted = new Set(tombstones.filter((t) => t.kind === 'expense').map((t) => t.id));
          const added = recurring
            .filter((r) => groups.some((g) => g.id === r.groupId))
            .flatMap((r) => dueRepeats(r, today, (id) => have.has(id) || deleted.has(id)));
          if (added.length === 0) return [];

          const now = new Date();
          const entries: ExpenseAddedActivity[] = added.map((e) => ({
            id: uid(),
            type: 'expense_added',
            actorId: currentUserId,
            expenseId: e.id,
            groupId: e.groupId,
            date: e.date,
          }));
          set(
            {
              expenses: [...expenses, ...added],
              activities: [...entries, ...activities],
              groups: touchGroups(groups, new Set(added.map((e) => e.groupId!)), now),
            },
            false,
            'addDueRecurring',
          );
          return added;
        },

        // ── Sharing ────────────────────────────────────────────────────────────

        applyGroupBundle: (bundle, people, options) => {
          const s = get();
          const { state, summary } = mergeBundle(
            {
              currentUserId: s.currentUserId,
              users: s.users,
              groups: s.groups,
              expenses: s.expenses,
              settlements: s.settlements,
              activities: s.activities,
              tombstones: s.tombstones,
              userAliases: s.userAliases,
              groupSyncedAt: s.groupSyncedAt,
        recurring: s.recurring,
            },
            bundle,
            people,
            undefined,
            undefined,
            options,
          );
          set(
            {
              users: state.users,
              groups: state.groups,
              expenses: state.expenses,
              settlements: state.settlements,
              activities: state.activities,
              tombstones: state.tombstones,
              userAliases: state.userAliases,
              groupSyncedAt: state.groupSyncedAt,
              recurring: state.recurring,
            },
            false,
            'applyGroupBundle',
          );
          return summary;
        },

        // ── Danger zone ────────────────────────────────────────────────────────

        wipeAllData: () =>
          set(
            {
              hasOnboarded: false,
              theme: 'system' as ThemeMode,
              currentUserId: '',
              needsIdentity: false,
              users: [],
              groups: [],
              expenses: [],
              settlements: [],
              activities: [],
              tombstones: [],
              userAliases: {},
              groupSyncedAt: {},
              recurring: [],
            },
            false,
            'wipeAllData',
          ),
      }),
      {
        // Predates the rename to OpenSplitwise. Changing the storage key would
        // leave every existing user's saved data behind under the old one.
        name: 'opensplit-v2',
        storage: persistStorage,
        version: 2,
        /**
         * v0/v1 kept `friendBalances` on the state and `yourBalance` / `totalSpent`
         * on each group, maintained by hand as actions ran. They are derived now,
         * so the stored copies are dropped — stale numbers that outrank the real
         * ones are worse than no numbers.
         *
         * v1 also let Settle Up record payments against no group, which the group
         * balances could never account for; those get re-attributed here.
         */
        migrate: (persisted, fromVersion) => {
          const state = persisted as Partial<AppStore> & { friendBalances?: unknown };
          if (!state) return state as unknown as AppStore;

          if (fromVersion < 2) {
            delete state.friendBalances;

            type LegacyGroup = Group & { yourBalance?: number; totalSpent?: number };
            state.groups = ((state.groups ?? []) as LegacyGroup[]).map((group) => {
              const cleaned: LegacyGroup = { ...group };
              delete cleaned.yourBalance;
              delete cleaned.totalSpent;
              return cleaned as Group;
            });

            state.settlements = attributeLooseSettlements(
              state.expenses ?? [],
              state.settlements ?? [],
            );
          }

          return state as AppStore;
        },
        partialize: (state) => ({
          hasOnboarded:  state.hasOnboarded,
          theme:         state.theme,
          currentUserId: state.currentUserId,
          needsIdentity: state.needsIdentity,
          users:         state.users,
          groups:        state.groups,
          expenses:      state.expenses,
          settlements:   state.settlements,
          activities:    state.activities,
          tombstones:    state.tombstones,
          userAliases:   state.userAliases,
          groupSyncedAt: state.groupSyncedAt,
          recurring:     state.recurring,
        }),
      },
    ),
    { name: 'splitwise-store' },
  ),
);
