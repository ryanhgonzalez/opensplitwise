import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { dataSnapshot, useStore } from './useStore';
import { selectFriendBalances, selectFriendBalancesByCurrency, selectGroupTotals, selectOverallBalances } from './selectors';
import { round } from '../lib/calculations';
import type { ExpenseUpdatedActivity, Group, RecurringExpense, RecurringTemplate, Tombstone, User } from '../types';
import { reviveDates } from '../lib/dates';
import { getEditBalanceChange, getEditSummary } from '../utils/activity';

// ─── Harness ──────────────────────────────────────────────────────────────────

const state = () => useStore.getState();
const friendBalances = () => selectFriendBalances(state());
const groupTotals = () => selectGroupTotals(state());
const balanceIn = (groupId: string) => groupTotals()[groupId]?.yourBalance ?? 0;

/** Everyone in one group, current user first. */
function setup(names: string[]): { me: User; others: User[]; group: Group } {
  useStore.getState().wipeAllData();
  useStore.getState().completeOnboarding(names[0]);
  const me = state().users[0];
  const others = names.slice(1).map((name) => state().addUser({ name }));
  const group = state().createGroup({
    name: 'Trip',
    emoji: '✈️',
    color: '#7c3aed',
    type: 'trip',
    members: [me, ...others].map((u) => ({ userId: u.id, role: 'member' as const, joinedAt: new Date() })),
  });
  return { me, others, group };
}

/** An expense `payer` fronted, split evenly between `participants`. */
function addEvenExpense(payerId: string, participantIds: string[], amount: number, groupId?: string) {
  const each = round(amount / participantIds.length);
  return state().addExpense({
    description: 'Dinner',
    amount,
    currency: 'USD',
    paidBy: payerId,
    groupId,
    date: new Date(),
    category: 'food',
    split: { type: 'equal', entries: participantIds.map((userId) => ({ userId, amount: each })) },
  });
}

beforeEach(() => {
  useStore.getState().wipeAllData();
});

// ─── Balances are derived, not stored ─────────────────────────────────────────

describe('derived balances', () => {
  it('reflects an expense in both the friend balance and the group', () => {
    const { me, others, group } = setup(['Me', 'Alice', 'Bob']);
    const [alice, bob] = others;
    addEvenExpense(me.id, [me.id, alice.id, bob.id], 90, group.id);

    expect(friendBalances()).toEqual({ [alice.id]: 30, [bob.id]: 30 });
    expect(groupTotals()[group.id]).toEqual({ yourBalance: 60, totalSpent: 90 });
  });

  it('rewinds exactly when an expense is deleted', () => {
    const { me, others, group } = setup(['Me', 'Alice']);
    const [alice] = others;
    const expense = addEvenExpense(me.id, [me.id, alice.id], 50, group.id);
    state().deleteExpense(expense.id);

    expect(friendBalances()[alice.id] ?? 0).toBe(0);
    expect(balanceIn(group.id)).toBe(0);
    expect(groupTotals()[group.id]?.totalSpent ?? 0).toBe(0);
  });

  it('follows an edit that changes the amount and the payer', () => {
    const { me, others, group } = setup(['Me', 'Alice']);
    const [alice] = others;
    const expense = addEvenExpense(me.id, [me.id, alice.id], 50, group.id);
    expect(friendBalances()[alice.id]).toBe(25);

    state().updateExpense(expense.id, {
      amount: 80,
      paidBy: alice.id,
      split: { type: 'equal', entries: [{ userId: me.id, amount: 40 }, { userId: alice.id, amount: 40 }] },
    });

    expect(friendBalances()[alice.id]).toBe(-40);
    expect(balanceIn(group.id)).toBe(-40);
    expect(groupTotals()[group.id].totalSpent).toBe(80);
  });

  it('recomputes from the new perspective when the identity changes', () => {
    const { me, others, group } = setup(['Me', 'Alice']);
    const [alice] = others;
    addEvenExpense(me.id, [me.id, alice.id], 50, group.id);
    expect(balanceIn(group.id)).toBe(25);

    state().setCurrentUser(alice.id);
    expect(balanceIn(group.id)).toBe(-25);
    expect(friendBalances()[me.id]).toBe(-25);
  });

  it('keeps the group balances summing to the overall net', () => {
    const { me, others } = setup(['Me', 'Alice']);
    const [alice] = others;
    const trip = state().groups[0];
    const home = state().createGroup({
      name: 'Home', emoji: '🏠', color: '#0ea5e9', type: 'home',
      members: [me, alice].map((u) => ({ userId: u.id, role: 'member' as const, joinedAt: new Date() })),
    });

    addEvenExpense(me.id, [me.id, alice.id], 150, trip.id);
    addEvenExpense(alice.id, [me.id, alice.id], 50, home.id);
    state().settleWithUser({
      fromUserId: alice.id, toUserId: me.id, amount: 30, currency: 'USD', date: new Date(),
    });

    const grouped = round(Object.values(groupTotals()).reduce((s, g) => s + g.yourBalance, 0));
    expect(grouped).toBe(round(selectOverallBalances(state())[0]?.net ?? 0));
  });
});

// ─── deleteUser ───────────────────────────────────────────────────────────────

describe('deleteUser', () => {
  it('refuses to remove the current user', () => {
    const { me } = setup(['Me', 'Alice']);
    state().deleteUser(me.id);
    expect(state().users.some((u) => u.id === me.id)).toBe(true);
  });

  // Regression: this rebuilt balances from the surviving expenses alone, which
  // silently reverted every payment that had been marked complete.
  it('preserves settlements with everyone else', () => {
    const { me, others, group } = setup(['Me', 'Alice', 'Bob']);
    const [alice, bob] = others;

    addEvenExpense(me.id, [me.id, alice.id, bob.id], 90, group.id);
    state().addSettlement({
      fromUserId: bob.id, toUserId: me.id, amount: 30, currency: 'USD',
      groupId: group.id, date: new Date(), paymentMethod: 'venmo',
    });
    expect(friendBalances()[bob.id] ?? 0).toBe(0);

    state().deleteUser(alice.id);

    // The dinner is purged along with Alice, so Bob's $30 payment now stands
    // alone — I owe him. What must not happen is the payment vanishing.
    expect(state().settlements).toHaveLength(1);
    expect(friendBalances()[bob.id]).toBe(-30);
    expect(balanceIn(group.id)).toBe(-30);
  });

  it('purges only the expenses that involve them', () => {
    const { me, others, group } = setup(['Me', 'Alice', 'Bob']);
    const [alice, bob] = others;
    addEvenExpense(me.id, [me.id, alice.id], 50, group.id);
    const withBob = addEvenExpense(me.id, [me.id, bob.id], 20, group.id);

    state().deleteUser(alice.id);

    expect(state().expenses.map((e) => e.id)).toEqual([withBob.id]);
    expect(friendBalances()[bob.id]).toBe(10);
  });

  it('leaves no dangling references behind', () => {
    const { me, others, group } = setup(['Me', 'Alice', 'Bob']);
    const [alice, bob] = others;
    addEvenExpense(me.id, [me.id, alice.id, bob.id], 90, group.id);
    state().addSettlement({
      fromUserId: alice.id, toUserId: me.id, amount: 30, currency: 'USD',
      groupId: group.id, date: new Date(), paymentMethod: 'cash',
    });

    state().deleteUser(alice.id);

    const userIds = new Set(state().users.map((u) => u.id));
    const expenseIds = new Set(state().expenses.map((e) => e.id));

    expect(state().groups[0].members.some((m) => m.userId === alice.id)).toBe(false);
    expect(friendBalances()[alice.id]).toBeUndefined();
    for (const activity of state().activities) {
      expect(userIds.has(activity.actorId)).toBe(true);
      if (activity.type === 'payment' || activity.type === 'settled') {
        expect(userIds.has(activity.fromUserId) && userIds.has(activity.toUserId)).toBe(true);
      }
      if (activity.type === 'expense_added' || activity.type === 'expense_updated') {
        expect(expenseIds.has(activity.expenseId)).toBe(true);
      }
    }
  });

  it('stops repeating expenses they were part of', () => {
    const { me, others, group } = setup(['Me', 'Alice', 'Bob']);
    const [alice, bob] = others;
    // Starting far ahead, so nothing is due yet.
    const repeat = (description: string, withId: string): RecurringTemplate => ({
      description, amount: 100, currency: 'USD', paidBy: me.id, category: 'rent',
      split: { type: 'equal', entries: [{ userId: me.id, amount: 50 }, { userId: withId, amount: 50 }] },
    });
    for (const [what, who] of [['Rent', alice.id], ['Netflix', bob.id]]) {
      state().addRecurring({ groupId: group.id, frequency: 'monthly', startDate: new Date(2099, 0, 1), template: repeat(what, who) });
    }

    state().deleteUser(alice.id);

    // Left behind, each new month of rent would name someone who no longer exists.
    expect(state().recurring.map((r) => r.template.description)).toEqual(['Netflix']);
  });
});

// ─── Merging a backup ─────────────────────────────────────────────────────────

describe('mergeImportData', () => {
  it('brings in the file\'s repeating expenses and deletion markers', () => {
    const { me, others, group } = setup(['Me', 'Alice']);
    const [alice] = others;
    const here = addEvenExpense(me.id, [me.id, alice.id], 20, group.id);
    const at = new Date(2026, 0, 1);
    const rule: RecurringExpense = {
      id: 'rule-1', groupId: group.id, frequency: 'monthly', startDate: new Date(2099, 0, 1), createdAt: at, updatedAt: at,
      template: {
        description: 'Rent', amount: 100, currency: 'USD', paidBy: me.id, category: 'rent',
        split: { type: 'equal', entries: [{ userId: me.id, amount: 50 }, { userId: alice.id, amount: 50 }] },
      },
    };
    // One marker for an expense deleted on the file's phone, one for an expense this phone still has.
    const gone: Tombstone = { id: 'deleted-there', kind: 'expense', groupId: group.id, deletedAt: at };
    const stillHere: Tombstone = { id: here.id, kind: 'expense', groupId: group.id, deletedAt: at };

    state().mergeImportData({ ...dataSnapshot(state()), friendBalances: {}, recurring: [rule], tombstones: [gone, stillHere] });

    expect(state().recurring.map((r) => r.id)).toEqual(['rule-1']);
    // A merge only adds: the expense here stays, and so no marker says it's gone.
    expect(state().tombstones.map((t) => t.id)).toEqual(['deleted-there']);
    expect(state().expenses.some((e) => e.id === here.id)).toBe(true);
  });
});

// ─── Saving ───────────────────────────────────────────────────────────────────

describe('saved data', () => {
  it('comes back with every date a Date', () => {
    // One of each kind of record, then a save and reload (JSON and back).
    const { me, others, group } = setup(['Me', 'Alice']);
    const [alice] = others;
    const dinner = addEvenExpense(me.id, [me.id, alice.id], 20, group.id);
    state().addSettlement({ fromUserId: alice.id, toUserId: me.id, amount: 5, currency: 'USD', groupId: group.id, date: new Date(), paymentMethod: 'cash' });
    state().addRecurring({
      groupId: group.id, frequency: 'monthly', startDate: new Date(2099, 0, 1),
      template: { description: 'Rent', amount: 10, currency: 'USD', paidBy: me.id, category: 'rent', split: { type: 'exact', entries: [{ userId: alice.id, amount: 10 }] } },
    });
    state().updateExpense(dinner.id, { description: '2026-10-12T10:00:00 dinner' });
    state().deleteExpense(addEvenExpense(me.id, [me.id], 1, group.id).id);
    useStore.setState({ groupSyncedAt: { [group.id]: new Date() } });

    const snapshot = dataSnapshot(state());
    expect(JSON.parse(JSON.stringify(snapshot), reviveDates)).toEqual(snapshot);
  });
});

// ─── settleWithUser ───────────────────────────────────────────────────────────

describe('settleWithUser', () => {
  function twoGroups() {
    const { me, others } = setup(['Me', 'Alice']);
    const [alice] = others;
    const trip = state().groups[0];
    const home = state().createGroup({
      name: 'Home', emoji: '🏠', color: '#0ea5e9', type: 'home',
      members: [me, alice].map((u) => ({ userId: u.id, role: 'member' as const, joinedAt: new Date() })),
    });
    // Alice fronted both: I owe 75 on the trip and 25 at home.
    addEvenExpense(alice.id, [me.id, alice.id], 150, trip.id);
    addEvenExpense(alice.id, [me.id, alice.id], 50, home.id);
    return { me, alice, trip, home };
  }

  it('spreads a payment across groups in proportion to what is owed', () => {
    const { me, alice, trip, home } = twoGroups();
    expect(friendBalances()[alice.id]).toBe(-100);

    const created = state().settleWithUser({
      fromUserId: me.id, toUserId: alice.id, amount: 40, currency: 'USD',
      date: new Date(), paymentMethod: 'venmo',
    });

    expect(created).toHaveLength(2);
    expect(balanceIn(trip.id)).toBe(-45);
    expect(balanceIn(home.id)).toBe(-15);
    expect(friendBalances()[alice.id]).toBe(-60);
  });

  // The defect this action exists to fix: a payment attributed to no group moved
  // the overall balance while every group balance stayed put.
  it('keeps group balances and the overall net in agreement', () => {
    const { me, alice } = twoGroups();
    state().settleWithUser({
      fromUserId: me.id, toUserId: alice.id, amount: 40, currency: 'USD', date: new Date(),
    });

    const grouped = round(Object.values(groupTotals()).reduce((s, g) => s + g.yourBalance, 0));
    expect(grouped).toBe(friendBalances()[alice.id]);
  });

  it('clears every group when the whole balance is paid', () => {
    const { me, alice, trip, home } = twoGroups();
    state().settleWithUser({
      fromUserId: me.id, toUserId: alice.id, amount: 100, currency: 'USD', date: new Date(),
    });

    expect(friendBalances()[alice.id] ?? 0).toBe(0);
    expect(balanceIn(trip.id)).toBe(0);
    expect(balanceIn(home.id)).toBe(0);
  });

  it('pays whoever is owed directly when the group does not simplify', () => {
    // Me fronts 100 for Alice; Alice fronts 14 for Bob. Simplified, Bob pays me.
    const { me, others, group } = setup(['Me', 'Alice', 'Bob']);
    const [alice, bob] = others;
    addEvenExpense(me.id, [alice.id], 100, group.id);
    addEvenExpense(alice.id, [bob.id], 14, group.id);
    expect(friendBalances()[bob.id]).toBe(14);

    state().updateGroup(group.id, { simplifyDebts: false });
    expect(friendBalances()[bob.id] ?? 0).toBe(0);
    expect(friendBalances()[alice.id]).toBe(100);

    // Paying Alice in full clears the direct debt, and nothing goes unassigned.
    const created = state().settleWithUser({
      fromUserId: alice.id, toUserId: me.id, amount: 100, currency: 'USD', date: new Date(),
    });
    expect(created).toHaveLength(1);
    expect(created[0].groupId).toBe(group.id);
    expect(friendBalances()[alice.id] ?? 0).toBe(0);
  });

  it('works when the money is coming to you', () => {
    const { me, others, group } = setup(['Me', 'Alice']);
    const [alice] = others;
    addEvenExpense(me.id, [me.id, alice.id], 100, group.id);
    expect(friendBalances()[alice.id]).toBe(50);

    state().settleWithUser({
      fromUserId: alice.id, toUserId: me.id, amount: 50, currency: 'USD', date: new Date(),
    });

    expect(friendBalances()[alice.id] ?? 0).toBe(0);
    expect(balanceIn(group.id)).toBe(0);
  });

  it('says "settled up" exactly once, and only when the balance is cleared', () => {
    const { me, alice } = twoGroups();

    state().settleWithUser({ fromUserId: me.id, toUserId: alice.id, amount: 40, currency: 'USD', date: new Date() });
    expect(state().activities.filter((a) => a.type === 'settled')).toHaveLength(0);
    expect(state().activities.filter((a) => a.type === 'payment')).toHaveLength(2);

    state().settleWithUser({ fromUserId: me.id, toUserId: alice.id, amount: 60, currency: 'USD', date: new Date() });
    expect(state().activities.filter((a) => a.type === 'settled')).toHaveLength(1);
  });

  it('records an overpayment without losing the excess', () => {
    const { me, alice } = twoGroups();
    const created = state().settleWithUser({
      fromUserId: me.id, toUserId: alice.id, amount: 130, currency: 'USD', date: new Date(),
    });

    expect(round(created.reduce((s, c) => s + c.amount, 0))).toBe(130);
    expect(created.some((c) => c.groupId === undefined)).toBe(true);
    expect(friendBalances()[alice.id]).toBe(30);
  });

  it('is undoable one slice at a time', () => {
    const { me, alice, trip, home } = twoGroups();
    const created = state().settleWithUser({
      fromUserId: me.id, toUserId: alice.id, amount: 40, currency: 'USD', date: new Date(),
    });

    const tripSlice = created.find((s) => s.groupId === trip.id)!;
    state().deleteSettlement(tripSlice.id);

    expect(balanceIn(trip.id)).toBe(-75);
    expect(balanceIn(home.id)).toBe(-15);
    expect(state().activities.some((a) => 'settlementId' in a && a.settlementId === tripSlice.id)).toBe(false);
  });
});

// ─── Group deletion ───────────────────────────────────────────────────────────

describe('deleteGroup', () => {
  it('removes the group’s records and the balances that came from them', () => {
    const { me, others, group } = setup(['Me', 'Alice']);
    const [alice] = others;
    addEvenExpense(me.id, [me.id, alice.id], 90, group.id);
    state().addSettlement({
      fromUserId: alice.id, toUserId: me.id, amount: 20, currency: 'USD',
      groupId: group.id, date: new Date(), paymentMethod: 'cash',
    });

    state().deleteGroup(group.id);

    expect(state().expenses).toHaveLength(0);
    expect(state().settlements).toHaveLength(0);
    expect(state().activities).toHaveLength(0);
    expect(friendBalances()[alice.id] ?? 0).toBe(0);
  });
});

// ─── Persistence migration ────────────────────────────────────────────────────

describe('custom categories', () => {
  const groupOf = (id: string) => state().groups.find((g) => g.id === id)!;

  it('adds a category to the group and keeps it for later expenses', () => {
    const { group } = setup(['Me']);
    const id = state().addGroupCategory(group.id, '  Ski   passes ');
    expect(id).toMatch(/^custom:/);
    expect(groupOf(group.id).categories).toEqual([{ id, name: 'Ski passes' }]);
  });

  it('reuses an existing category instead of making a duplicate', () => {
    const { group } = setup(['Me']);
    const id = state().addGroupCategory(group.id, 'Gas');
    expect(state().addGroupCategory(group.id, 'gas')).toBe(id);
    expect(state().addGroupCategory(group.id, 'groceries')).toBe('groceries');
    expect(groupOf(group.id).categories).toHaveLength(1);
  });

  it('refuses a blank name or an unknown group', () => {
    const { group } = setup(['Me']);
    expect(state().addGroupCategory(group.id, '   ')).toBeNull();
    expect(state().addGroupCategory('nope', 'Gas')).toBeNull();
  });

  it('moves the group’s expenses to Other when a category is removed', () => {
    const { me, group } = setup(['Me']);
    const other = state().createGroup({ name: 'Home', emoji: '🏠', color: '#000', type: 'home', members: [] });
    const gas = state().addGroupCategory(group.id, 'Gas')!;
    const inGroup = addEvenExpense(me.id, [me.id], 40, group.id);
    const elsewhere = addEvenExpense(me.id, [me.id], 10, other.id);
    state().updateExpense(inGroup.id, { category: gas });
    // Same id in another group's expense must be left alone (it can't resolve there anyway).
    state().updateExpense(elsewhere.id, { category: gas });

    state().removeGroupCategory(group.id, gas as `custom:${string}`);

    expect(groupOf(group.id).categories).toEqual([]);
    expect(state().expenses.find((e) => e.id === inGroup.id)!.category).toBe('other');
    expect(state().expenses.find((e) => e.id === elsewhere.id)!.category).toBe(gas);
  });

  it('brings in categories a merged file has for a group already here', () => {
    const { group } = setup(['Me']);
    const mine = state().addGroupCategory(group.id, 'Gas')!;
    const theirs = { id: 'custom:theirs' as const, name: 'Ferry' };
    const file = {
      currentUserId: state().currentUserId,
      friendBalances: {},
      users: state().users,
      groups: [{ ...groupOf(group.id), categories: [{ id: mine as `custom:${string}`, name: 'Gas' }, theirs] }],
      expenses: [],
      settlements: [],
      activities: [],
    };
    state().mergeImportData(file);
    expect(groupOf(group.id).categories).toEqual([{ id: mine, name: 'Gas' }, theirs]);
  });
});

describe('currencies', () => {
  /** A second group in another currency, with the same people. */
  function euroGroup(members: User[]): Group {
    return state().createGroup({
      name: 'Paris',
      emoji: '🗼',
      color: '#000',
      type: 'trip',
      currency: 'EUR',
      members: members.map((u) => ({ userId: u.id, role: 'member' as const, joinedAt: new Date() })),
    });
  }
  const addIn = (group: Group, payerId: string, ids: string[], amount: number) =>
    state().addExpense({
      description: 'x', amount, currency: group.currency ?? 'USD', paidBy: payerId, groupId: group.id, date: new Date(),
      category: 'food', split: { type: 'equal', entries: ids.map((userId) => ({ userId, amount: round(amount / ids.length) })) },
    });

  it('keeps balances in different currencies apart', () => {
    const { me, others, group } = setup(['Me', 'Alice']);
    const [alice] = others;
    const paris = euroGroup([me, alice]);
    addIn(group, me.id, [me.id, alice.id], 50); // Alice owes $25
    addIn(paris, me.id, [me.id, alice.id], 80); // Alice owes €40

    const byCurrency = selectFriendBalancesByCurrency(state());
    expect(byCurrency).toEqual({ USD: { [alice.id]: 25 }, EUR: { [alice.id]: 40 } });
    expect(selectOverallBalances(state()).map((b) => [b.currency, b.net])).toEqual([['EUR', 40], ['USD', 25]]);
  });

  it('pays down only debts in the payment’s currency', () => {
    const { me, others, group } = setup(['Me', 'Alice']);
    const [alice] = others;
    const paris = euroGroup([me, alice]);
    addIn(group, me.id, [me.id, alice.id], 50);
    addIn(paris, me.id, [me.id, alice.id], 80);

    const created = state().settleWithUser({ fromUserId: alice.id, toUserId: me.id, amount: 40, currency: 'EUR', date: new Date() });
    expect(created.map((s) => [s.groupId, s.amount, s.currency])).toEqual([[paris.id, 40, 'EUR']]);
    expect(selectFriendBalancesByCurrency(state())).toEqual({ USD: { [alice.id]: 25 } });
  });

  it('relabels a group’s amounts when its currency changes, without converting them', () => {
    const { me, others, group } = setup(['Me', 'Alice']);
    const [alice] = others;
    addIn(group, me.id, [me.id, alice.id], 50);
    state().updateGroup(group.id, { currency: 'EUR' });
    expect(state().expenses.map((e) => [e.amount, e.currency])).toEqual([[50, 'EUR']]);
    expect(selectFriendBalancesByCurrency(state())).toEqual({ EUR: { [alice.id]: 25 } });
  });
});

describe('recurring expenses', () => {
  const day = (y: number, m: number, d: number) => new Date(y, m - 1, d);
  // Setting one up adds what's due by today, so "today" is pinned to mid-July 2026.
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(day(2026, 7, 15));
  });
  afterEach(() => vi.useRealTimers());
  function rent(me: User, alice: User, group: Group, startDate: Date) {
    return state().addRecurring({
      groupId: group.id,
      frequency: 'monthly',
      startDate,
      template: {
        description: 'Rent', amount: 1000, currency: 'USD', paidBy: me.id, category: 'rent',
        split: { type: 'equal', entries: [{ userId: me.id, amount: 500 }, { userId: alice.id, amount: 500 }] },
      },
    });
  }
  const rentIds = () => state().expenses.filter((e) => e.description === 'Rent').map((e) => e.id.slice(-10)).sort();

  it('adds each due month on its own date, once', () => {
    const { me, others, group } = setup(['Me', 'Alice']);
    const { rule } = rent(me, others[0], group, day(2026, 7, 1));
    state().addDueRecurring(day(2026, 9, 15));
    expect(rentIds()).toEqual(['2026-07-01', '2026-08-01', '2026-09-01']);
    const count = state().expenses.length;
    state().addDueRecurring(day(2026, 9, 15));
    expect(state().expenses.length).toBe(count);
    expect(state().expenses.every((e) => e.id.startsWith(rule.id))).toBe(true);
  });

  it('doesn’t bring back a deleted month', () => {
    const { me, others, group } = setup(['Me', 'Alice']);
    const { rule } = rent(me, others[0], group, day(2026, 7, 1));
    state().addDueRecurring(day(2026, 8, 15));
    state().deleteExpense(`${rule.id}:2026-08-01`);
    state().addDueRecurring(day(2026, 9, 15));
    expect(rentIds()).toEqual(['2026-07-01', '2026-09-01']);
  });

  it('uses the latest month’s edited amount from then on; editing an older month doesn’t', () => {
    const { me, others, group } = setup(['Me', 'Alice']);
    const { rule } = rent(me, others[0], group, day(2026, 7, 1));
    state().addDueRecurring(day(2026, 8, 15));
    const split = { type: 'equal' as const, entries: [{ userId: me.id, amount: 550 }, { userId: others[0].id, amount: 550 }] };
    state().updateExpense(`${rule.id}:2026-07-01`, { amount: 900 });
    expect(state().recurring[0].template.amount).toBe(1000);
    state().updateExpense(`${rule.id}:2026-08-01`, { amount: 1100, split });
    expect(state().recurring[0].template.amount).toBe(1100);
    state().addDueRecurring(day(2026, 9, 15));
    expect(state().expenses.find((e) => e.id === `${rule.id}:2026-09-01`)?.amount).toBe(1100);
  });

  it('stops: no more months, the old ones stay, and a marker records it', () => {
    const { me, others, group } = setup(['Me', 'Alice']);
    const { rule } = rent(me, others[0], group, day(2026, 7, 1));
    state().addDueRecurring(day(2026, 7, 15));
    state().stopRecurring(rule.id);
    state().addDueRecurring(day(2026, 12, 15));
    expect(rentIds()).toEqual(['2026-07-01']);
    expect(state().tombstones.map((t) => t.kind)).toEqual(['recurring']);
  });
});

describe('undoing a delete', () => {
  it('puts the expense, its feed entries and balances back, and withdraws the deletion marker', () => {
    const { me, others, group } = setup(['Me', 'Alice']);
    const [alice] = others;
    const expense = addEvenExpense(me.id, [me.id, alice.id], 40, group.id);
    const before = { activities: state().activities.map((a) => a.id).sort(), balance: friendBalances()[alice.id] };

    const deleted = state().deleteExpense(expense.id)!;
    expect(state().expenses).toEqual([]);
    expect(state().tombstones).toHaveLength(1);

    state().undoExpenseDelete(deleted);
    expect(state().expenses).toEqual([expense]);
    expect(state().activities.map((a) => a.id).sort()).toEqual(before.activities);
    expect(friendBalances()[alice.id]).toBe(before.balance);
    expect(state().tombstones).toEqual([]);
  });
});

describe('sharing state', () => {
  it('leaves deletion markers for group expenses, payments and categories', () => {
    const { me, others, group } = setup(['Me', 'Alice']);
    const [alice] = others;
    const expense = addEvenExpense(me.id, [me.id, alice.id], 40, group.id);
    const [payment] = state().settleWithUser({ fromUserId: alice.id, toUserId: me.id, amount: 10, currency: 'USD', date: new Date() });
    const wine = state().addGroupCategory(group.id, 'Wine')!;

    state().deleteExpense(expense.id);
    state().deleteSettlement(payment.id);
    state().removeGroupCategory(group.id, wine as `custom:${string}`);

    expect(state().tombstones.map((t) => [t.kind, t.id, t.groupId])).toEqual([
      ['expense', expense.id, group.id],
      ['settlement', payment.id, group.id],
      ['category', wine, group.id],
    ]);
  });

  it('leaves a marker when a member is removed', () => {
    const { others, group } = setup(['Me', 'Alice']);
    state().removeGroupMember(group.id, others[0].id);
    expect(state().tombstones.map((t) => [t.kind, t.id, t.groupId])).toEqual([['member', others[0].id, group.id]]);
  });

  it('stamps group edits, and forgets a deleted group’s markers', () => {
    const { me, group } = setup(['Me']);
    expect(state().groups[0].updatedAt).toBeUndefined();
    state().updateGroup(group.id, { name: 'Renamed' });
    expect(state().groups[0].updatedAt).toBeInstanceOf(Date);

    state().deleteExpense(addEvenExpense(me.id, [me.id], 5, group.id).id);
    state().deleteGroup(group.id);
    expect(state().tombstones).toEqual([]);
  });
});

describe('v1 → v2 migration', () => {
  const ME = 'user-me';
  const ALICE = 'user-alice';
  const TRIP = 'group-trip';
  const HOME = 'group-home';

  /** A v1 payload: stored balances on the state, and a payment tied to no group. */
  function seedV1() {
    const member = (userId: string) => ({ userId, role: 'member', joinedAt: '2026-01-01T00:00:00.000Z' });
    const evenSplit = (a: number) => ({
      type: 'equal',
      entries: [{ userId: ME, amount: a }, { userId: ALICE, amount: a }],
    });

    localStorage.setItem('opensplit-v2', JSON.stringify({
      version: 1,
      state: {
        hasOnboarded: true,
        theme: 'system',
        currentUserId: ME,
        needsIdentity: false,
        users: [
          { id: ME, name: 'Me', initials: 'M', avatarColor: '#7c3aed', createdAt: '2026-01-01T00:00:00.000Z' },
          { id: ALICE, name: 'Alice', initials: 'A', avatarColor: '#0ea5e9', createdAt: '2026-01-01T00:00:00.000Z' },
        ],
        groups: [
          // Deliberately wrong stored totals — the migration must discard, not trust them.
          { id: TRIP, name: 'Trip', emoji: '✈️', color: '#7c3aed', type: 'trip', members: [member(ME), member(ALICE)],
            yourBalance: 999, totalSpent: 999, lastActivity: '2026-01-02T00:00:00.000Z', createdAt: '2026-01-01T00:00:00.000Z' },
          { id: HOME, name: 'Home', emoji: '🏠', color: '#0ea5e9', type: 'home', members: [member(ME), member(ALICE)],
            yourBalance: -12, totalSpent: -12, lastActivity: '2026-01-02T00:00:00.000Z', createdAt: '2026-01-01T00:00:00.000Z' },
        ],
        expenses: [
          { id: 'exp-trip', description: 'Hotel', amount: 150, currency: 'USD', paidBy: ALICE, groupId: TRIP,
            date: '2026-01-02T00:00:00.000Z', category: 'accommodation', split: evenSplit(75),
            createdAt: '2026-01-02T00:00:00.000Z', updatedAt: '2026-01-02T00:00:00.000Z' },
          { id: 'exp-home', description: 'Internet', amount: 50, currency: 'USD', paidBy: ALICE, groupId: HOME,
            date: '2026-01-02T00:00:00.000Z', category: 'utilities', split: evenSplit(25),
            createdAt: '2026-01-02T00:00:00.000Z', updatedAt: '2026-01-02T00:00:00.000Z' },
        ],
        // The bug: recorded from Settle Up, so attributable to no group at all.
        settlements: [
          { id: 'set-loose', fromUserId: ME, toUserId: ALICE, amount: 40, currency: 'USD',
            date: '2026-01-03T00:00:00.000Z', paymentMethod: 'venmo', createdAt: '2026-01-03T00:00:00.000Z' },
        ],
        activities: [
          { id: 'act-1', type: 'payment', actorId: ME, settlementId: 'set-loose', fromUserId: ME, toUserId: ALICE,
            amount: 40, date: '2026-01-03T00:00:00.000Z' },
        ],
        friendBalances: { [ALICE]: -60 },
      },
    }));
  }

  beforeEach(async () => {
    seedV1();
    await useStore.persist.rehydrate();
  });

  it('drops the stored balances in favour of derived ones', () => {
    expect((state() as unknown as Record<string, unknown>).friendBalances).toBeUndefined();
    for (const group of state().groups) {
      expect(group).not.toHaveProperty('yourBalance');
      expect(group).not.toHaveProperty('totalSpent');
    }
    expect(groupTotals()[TRIP]).toEqual({ yourBalance: -45, totalSpent: 150 });
    expect(groupTotals()[HOME]).toEqual({ yourBalance: -15, totalSpent: 50 });
  });

  it('re-attributes the groupless payment across the groups it paid down', () => {
    const byGroup = Object.fromEntries(state().settlements.map((s) => [s.groupId, s.amount]));
    expect(byGroup).toEqual({ [TRIP]: 30, [HOME]: 10 });
    expect(round(state().settlements.reduce((s, x) => s + x.amount, 0))).toBe(40);
  });

  it('leaves the overall balance exactly where it was', () => {
    expect(friendBalances()[ALICE]).toBe(-60);
  });

  it('reconciles the group balances with the net, which v1 could not', () => {
    const grouped = round(Object.values(groupTotals()).reduce((s, g) => s + g.yourBalance, 0));
    expect(grouped).toBe(friendBalances()[ALICE]);
  });

  it('keeps the activity entry pointing at a settlement that still exists', () => {
    const settlementIds = new Set(state().settlements.map((s) => s.id));
    const activity = state().activities.find((a) => a.id === 'act-1')!;
    expect('settlementId' in activity && settlementIds.has(activity.settlementId)).toBe(true);
  });
});

// ─── The feed records what an edit changed ────────────────────────────────────

describe('expense edits in the feed', () => {
  const lastEdit = () => state().activities.find((a) => a.type === 'expense_updated') as ExpenseUpdatedActivity;
  const nameOf = (id: string) => state().users.find((u) => u.id === id);

  it('says what changed and what it did to each balance', () => {
    const { me, others, group } = setup(['Me', 'Alice']);
    const [alice] = others;
    const expense = addEvenExpense(me.id, [me.id, alice.id], 50, group.id);

    state().updateExpense(expense.id, {
      amount: 80,
      split: { type: 'equal', entries: [{ userId: me.id, amount: 40 }, { userId: alice.id, amount: 40 }] },
    });

    const edit = lastEdit();
    expect(getEditSummary(edit, me.id, nameOf)).toBe('Amount $50.00 → $80.00');
    // Alice owed me 25, now 40: +15 for me, −15 for her.
    expect(getEditBalanceChange(edit, me.id)).toBe(15);
    expect(getEditBalanceChange(edit, alice.id)).toBe(-15);
  });

  it('keeps each edit to its own change', () => {
    const { me, others, group } = setup(['Me', 'Alice']);
    const [alice] = others;
    const expense = addEvenExpense(me.id, [me.id, alice.id], 50, group.id);
    state().updateExpense(expense.id, { description: 'Supper' });
    state().updateExpense(expense.id, { paidBy: alice.id });

    const [second, first] = state().activities.filter((a) => a.type === 'expense_updated') as ExpenseUpdatedActivity[];
    expect(getEditSummary(first, me.id, nameOf)).toBe('Renamed from "Dinner"');
    expect(getEditBalanceChange(first, me.id)).toBe(0);
    expect(getEditSummary(second, me.id, nameOf)).toBe('Paid by You → Alice');
    // I was owed 25; now I owe 25.
    expect(getEditBalanceChange(second, me.id)).toBe(-50);
  });

  it('reports nothing for entries from before edits were recorded', () => {
    const { me, group } = setup(['Me', 'Alice']);
    const expense = addEvenExpense(me.id, [me.id], 50, group.id);
    const old: ExpenseUpdatedActivity = { id: 'x', type: 'expense_updated', actorId: me.id, expenseId: expense.id, date: new Date() };
    expect(getEditSummary(old, me.id, nameOf)).toBe('');
    expect(getEditBalanceChange(old, me.id)).toBeUndefined();
  });
});
