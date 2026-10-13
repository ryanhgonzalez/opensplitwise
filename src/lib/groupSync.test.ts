import { describe, expect, it } from 'vitest';
import type { Expense, Group, Settlement, User } from '../types';
import {
  NEW_PERSON,
  buildBundle,
  defaultChoice,
  matchPeople,
  mergeBundle,
  needsSelfChoice,
  type SyncState,
} from './groupSync';

// Two phones, each with its own ids for the same people.
const T = (minutes: number) => new Date(Date.UTC(2026, 9, 1, 12, minutes));

const user = (id: string, name: string): User => ({ id, name, initials: name[0], avatarColor: '#000', createdAt: T(0) });

const expense = (id: string, paidBy: string, ids: string[], amount: number, at = T(1), description = id): Expense => ({
  id,
  description,
  amount,
  currency: 'EUR',
  paidBy,
  groupId: 'trip',
  date: at,
  split: { type: 'equal', entries: ids.map((userId) => ({ userId, amount: amount / ids.length })) },
  category: 'food',
  createdAt: at,
  updatedAt: at,
});

const trip = (members: string[], over: Partial<Group> = {}): Group => ({
  id: 'trip',
  name: 'Lisbon',
  emoji: '✈️',
  color: '#000',
  type: 'trip',
  currency: 'EUR',
  members: members.map((userId) => ({ userId, role: 'member' as const, joinedAt: T(0) })),
  lastActivity: T(0),
  createdAt: T(0),
  ...over,
});

const phone = (me: User, others: User[], over: Partial<SyncState> = {}): SyncState => ({
  currentUserId: me.id,
  users: [me, ...others],
  groups: [],
  expenses: [],
  settlements: [],
  activities: [],
  tombstones: [],
  userAliases: {},
  groupSyncedAt: {},
  recurring: [],
  ...over,
});

// Ana's phone: Ana (a1) made the group with Ben as a1's "b1".
const ana = user('a1', 'Ana');
const benOnAna = user('b1', 'Ben');
// Ben's phone: Ben is "b2", and he already has someone called Ana ("a2").
const ben = user('b2', 'Ben');
const anaOnBen = user('a2', 'Ana');

const anasPhone = () =>
  phone(ana, [benOnAna], {
    groups: [trip(['a1', 'b1'])],
    expenses: [expense('dinner', 'a1', ['a1', 'b1'], 80)],
  });

/** Ben receives Ana's group and says he is incoming "b1"; incoming "a1" is his "a2". */
function benReceivesFirst() {
  const bundle = buildBundle(anasPhone(), 'trip', T(10))!;
  const bens = phone(ben, [anaOnBen]);
  const matches = matchPeople(bens, bundle);
  const choice = { ...defaultChoice(matches), b1: ben.id };
  return { bundle, matches, ...mergeBundle(bens, bundle, choice, T(10), () => 'act') };
}

describe('first share', () => {
  it('asks who you are, and guesses the others by name', () => {
    const bundle = buildBundle(anasPhone(), 'trip', T(10))!;
    const bens = phone(ben, [anaOnBen]);
    const matches = matchPeople(bens, bundle);
    expect(needsSelfChoice(bens, matches)).toBe(true);
    expect(matches.map((m) => [m.incoming.id, m.localId, m.reason])).toEqual([
      ['a1', 'a2', 'same-name'],
      ['b1', 'b2', 'same-name'],
    ]);
  });

  it('adds the group with everyone mapped to this phone’s people, and remembers the matches', () => {
    const { state, summary } = benReceivesFirst();
    expect(summary).toMatchObject({ isNewGroup: true, added: 1, updated: 0, deleted: 0, newPeople: 0 });
    expect(state.groups[0].members.map((m) => m.userId)).toEqual(['a2', 'b2']);
    expect(state.expenses[0]).toMatchObject({ paidBy: 'a2', groupId: 'trip' });
    expect(state.expenses[0].split.entries.map((e) => e.userId)).toEqual(['a2', 'b2']);
    expect(state.userAliases).toEqual({ a1: 'a2', b1: 'b2' });
    expect(state.activities[0]).toMatchObject({ type: 'group_synced', fromName: 'Ana', actorId: 'a2', added: 1 });
  });

  it('adds people this phone doesn’t have', () => {
    const bundle = buildBundle(anasPhone(), 'trip', T(10))!;
    const bens = phone(ben, []);
    const { state, summary } = mergeBundle(bens, bundle, { b1: 'b2', a1: NEW_PERSON }, T(10));
    expect(summary.newPeople).toBe(1);
    expect(state.users.map((u) => u.id)).toEqual(['b2', 'a1']);
  });
});

describe('re-sharing', () => {
  it('sends back only what changed, matching people without asking', () => {
    const { state: bens } = benReceivesFirst();
    // Ben adds lunch and shares the group back to Ana.
    const withLunch = { ...bens, expenses: [...bens.expenses, expense('lunch', 'b2', ['a2', 'b2'], 30, T(20))] };
    const back = buildBundle(withLunch, 'trip', T(21))!;

    const anas = anasPhone();
    const matches = matchPeople(anas, back);
    // Ana has never seen Ben's ids; she's matched by name and nothing is new.
    expect(matches.map((m) => [m.incoming.id, m.localId])).toEqual([
      ['b2', 'b1'],
      ['a2', 'a1'],
    ]);
    const { state, summary } = mergeBundle(anas, back, defaultChoice(matches), T(21));
    expect(summary).toMatchObject({ added: 1, updated: 0, deleted: 0, newPeople: 0 });
    expect(state.expenses.find((e) => e.id === 'lunch')).toMatchObject({ paidBy: 'b1' });
    // Only lunch came from Ben, so only its receipt photo would be taken.
    expect(summary.receivedIds).toEqual(['lunch']);
    expect(state.expenses.find((e) => e.id === 'dinner')?.paidBy).toBe('a1');

    // Next time Ben's phone needn't ask: Ana remembered.
    expect(needsSelfChoice(state, matchPeople(state, back))).toBe(false);
  });

  it('keeps the newer edit, and lists one edited on both phones since the last share', () => {
    const { state: bens } = benReceivesFirst();
    // After that share, both edit the dinner: Ana at :30, Ben at :40.
    const anas = {
      ...anasPhone(),
      groupSyncedAt: { trip: T(10) },
      expenses: [{ ...expense('dinner', 'a1', ['a1', 'b1'], 90), updatedAt: T(30) }],
    };
    const bensEdit = {
      ...bens,
      expenses: [{ ...bens.expenses[0], amount: 100, description: 'Dinner', updatedAt: T(40) }],
    };
    const { state, summary } = mergeBundle(anas, buildBundle(bensEdit, 'trip', T(41))!, { b2: 'b1', a2: 'a1' }, T(41));
    expect(state.expenses[0].amount).toBe(100);
    expect(summary.updated).toBe(1);
    expect(summary.conflicts).toEqual([{ description: 'Dinner', kept: 'theirs' }]);
  });

  it('keeps your newer edit over an older incoming one', () => {
    const anas = { ...anasPhone(), expenses: [{ ...expense('dinner', 'a1', ['a1', 'b1'], 90), updatedAt: T(50) }] };
    const older = buildBundle(anasPhone(), 'trip', T(51))!;
    const { state, summary } = mergeBundle(anas, older, { a1: 'a1', b1: 'b1' }, T(51));
    expect(state.expenses[0].amount).toBe(90);
    expect(summary.updated).toBe(0);
  });
});

describe('deletions', () => {
  it('travel with the share', () => {
    const { state: bens } = benReceivesFirst();
    const anas = { ...anasPhone(), expenses: [], tombstones: [{ id: 'dinner', kind: 'expense' as const, groupId: 'trip', deletedAt: T(30) }] };
    const { state, summary } = mergeBundle(bens, buildBundle(anas, 'trip', T(31))!, { a1: 'a2', b1: 'b2' }, T(31));
    expect(state.expenses).toEqual([]);
    expect(summary.deleted).toBe(1);
    // Ben's own activity entries for it go too; the marker stays to pass on.
    expect(state.tombstones.map((t) => t.id)).toEqual(['dinner']);
  });

  it('lose to an edit made after them', () => {
    const { state: bens } = benReceivesFirst();
    const edited = { ...bens, expenses: [{ ...bens.expenses[0], updatedAt: T(40) }] };
    const anas = { ...anasPhone(), expenses: [], tombstones: [{ id: 'dinner', kind: 'expense' as const, groupId: 'trip', deletedAt: T(30) }] };
    const { state } = mergeBundle(edited, buildBundle(anas, 'trip', T(41))!, { a1: 'a2', b1: 'b2' }, T(41));
    expect(state.expenses.map((e) => e.id)).toEqual(['dinner']);
  });

  it('remove a deleted payment and never re-add it', () => {
    const payment: Settlement = { id: 'p1', fromUserId: 'b1', toUserId: 'a1', amount: 40, currency: 'EUR', groupId: 'trip', date: T(5), createdAt: T(5) };
    const withPayment = { ...anasPhone(), settlements: [payment] };
    const { state: bens } = mergeBundle(phone(ben, [anaOnBen]), buildBundle(withPayment, 'trip', T(10))!, { a1: 'a2', b1: 'b2' }, T(10));
    expect(bens.settlements.map((s) => [s.id, s.fromUserId, s.toUserId])).toEqual([['p1', 'b2', 'a2']]);

    const deleted = { ...anasPhone(), tombstones: [{ id: 'p1', kind: 'settlement' as const, groupId: 'trip', deletedAt: T(20) }] };
    const { state } = mergeBundle(bens, buildBundle(deleted, 'trip', T(21))!, { a1: 'a2', b1: 'b2' }, T(21));
    expect(state.settlements).toEqual([]);
  });
});

describe('group details', () => {
  it('take the newer name and currency, and combine members and categories', () => {
    const { state: bens } = benReceivesFirst();
    const carl = user('c1', 'Carl');
    const anas = {
      ...anasPhone(),
      users: [ana, benOnAna, carl],
      groups: [
        trip(['a1', 'b1', 'c1'], {
          name: 'Lisbon & Porto',
          currency: 'GBP',
          updatedAt: T(30),
          categories: [{ id: 'custom:wine' as const, name: 'Wine' }],
        }),
      ],
    };
    const bensWithCategory = {
      ...bens,
      groups: [{ ...bens.groups[0], categories: [{ id: 'custom:fado' as const, name: 'Fado' }], updatedAt: T(20) }],
    };
    const { state } = mergeBundle(bensWithCategory, buildBundle(anas, 'trip', T(31))!, { a1: 'a2', b1: 'b2', c1: NEW_PERSON }, T(31));
    const g = state.groups[0];
    expect([g.name, g.currency]).toEqual(['Lisbon & Porto', 'GBP']);
    expect(g.members.map((m) => m.userId)).toEqual(['a2', 'b2', 'c1']);
    expect(g.categories?.map((c) => c.name)).toEqual(['Fado', 'Wine']);
    // Amounts are relabelled with the group's currency, not converted.
    expect(state.expenses.every((e) => e.currency === 'GBP')).toBe(true);
  });

  it('drop a category deleted on the other phone', () => {
    const { state: bens } = benReceivesFirst();
    const withWine = { ...bens, groups: [{ ...bens.groups[0], categories: [{ id: 'custom:wine' as const, name: 'Wine' }] }] };
    const anas = { ...anasPhone(), tombstones: [{ id: 'custom:wine', kind: 'category' as const, groupId: 'trip', deletedAt: T(30) }] };
    const { state } = mergeBundle(withWine, buildBundle(anas, 'trip', T(31))!, { a1: 'a2', b1: 'b2' }, T(31));
    expect(state.groups[0].categories).toEqual([]);
  });
});

describe('removed members', () => {
  const carla = user('c1', 'Carla');
  // Ana's group has Carla; Ben received it earlier and knows Carla by his own id "c2".
  const anasWithCarla = () => phone(ana, [benOnAna, carla], { groups: [trip(['a1', 'b1', 'c1'])] });
  const bensWithCarla = (joinedAt = T(0)) =>
    phone(ben, [anaOnBen, user('c2', 'Carla')], {
      groups: [{ ...trip(['a2', 'b2']), members: [...trip(['a2', 'b2']).members, { userId: 'c2', role: 'member' as const, joinedAt }] }],
      userAliases: { a1: 'a2', b1: 'b2', c1: 'c2' },
    });
  const removedOnAna = () => ({
    ...anasWithCarla(),
    groups: [trip(['a1', 'b1'], { updatedAt: T(30) })],
    tombstones: [{ id: 'c1', kind: 'member' as const, groupId: 'trip', deletedAt: T(30) }],
  });

  it('are removed on the other phone, by its own id for them', () => {
    const { state, summary } = mergeBundle(bensWithCarla(), buildBundle(removedOnAna(), 'trip', T(31))!, {}, T(31));
    expect(state.groups[0].members.map((m) => m.userId)).toEqual(['a2', 'b2']);
    expect([summary.membersAdded, summary.membersRemoved]).toEqual([[], ['Carla']]);
    // The marker is kept in this phone's ids, to pass on.
    expect(state.tombstones).toContainEqual({ id: 'c2', kind: 'member', groupId: 'trip', deletedAt: T(30) });
  });

  it('stay when added again after the removal', () => {
    const { state } = mergeBundle(bensWithCarla(T(40)), buildBundle(removedOnAna(), 'trip', T(41))!, {}, T(41));
    expect(state.groups[0].members.map((m) => m.userId)).toEqual(['a2', 'b2', 'c2']);
  });

  it('come back on the removing phone when the other added them again later', () => {
    const readded = bensWithCarla(T(40));
    const { state, summary } = mergeBundle(removedOnAna(), buildBundle(readded, 'trip', T(41))!, { b2: 'b1', a2: 'a1', c2: 'c1' }, T(41));
    expect(state.groups[0].members.map((m) => m.userId)).toEqual(['a1', 'b1', 'c1']);
    expect(summary.membersAdded).toEqual(['Carla']);
  });
});

describe('receipt items', () => {
  it('travel with the expense, with who had each item translated to this phone', () => {
    const withItems = {
      ...anasPhone(),
      expenses: [{ ...expense('dinner', 'a1', ['a1', 'b1'], 80), items: [
        { description: 'Bacalhau', amount: 50, assigned: ['a1'] },
        { description: 'Wine', amount: 30, assigned: ['a1', 'b1'] },
      ] }],
    };
    const { state } = mergeBundle(phone(ben, [anaOnBen]), buildBundle(withItems, 'trip', T(10))!, { a1: 'a2', b1: 'b2' }, T(10));
    expect(state.expenses[0].items?.map((it) => [it.description, it.assigned])).toEqual([
      ['Bacalhau', ['a2']],
      ['Wine', ['a2', 'b2']],
    ]);
  });
});

describe('recurring expenses', () => {
  const rule = {
    id: 'rent', groupId: 'trip', frequency: 'monthly' as const, startDate: T(0), createdAt: T(0), updatedAt: T(0),
    template: {
      description: 'Rent', amount: 1000, currency: 'EUR', paidBy: 'a1', category: 'rent' as const,
      split: { type: 'equal' as const, entries: [{ userId: 'a1', amount: 500 }, { userId: 'b1', amount: 500 }] },
    },
  };

  it('travel with the group, people translated; the same month added on both phones is one expense', () => {
    const month = { ...expense('rent:2026-10-01', 'a1', ['a1', 'b1'], 1000, T(0), 'Rent') };
    const anas = { ...anasPhone(), recurring: [rule], expenses: [month] };
    const bensMonth = { ...month, paidBy: 'a2', split: { type: 'equal' as const, entries: [{ userId: 'a2', amount: 500 }, { userId: 'b2', amount: 500 }] } };
    const bens = phone(ben, [anaOnBen], { groups: [trip(['a2', 'b2'])], expenses: [bensMonth], userAliases: { a1: 'a2', b1: 'b2' } });
    const { state, summary } = mergeBundle(bens, buildBundle(anas, 'trip', T(10))!, {}, T(10));
    expect(state.recurring[0].template.paidBy).toBe('a2');
    expect(state.recurring[0].template.split.entries.map((e) => e.userId)).toEqual(['a2', 'b2']);
    expect(state.expenses.filter((e) => e.description === 'Rent')).toHaveLength(1);
    expect(summary.added).toBe(0);
  });

  it('stopping travels', () => {
    const bens = phone(ben, [anaOnBen], { groups: [trip(['a2', 'b2'])], recurring: [rule], userAliases: { a1: 'a2', b1: 'b2' } });
    const anas = { ...anasPhone(), tombstones: [{ id: 'rent', kind: 'recurring' as const, groupId: 'trip', deletedAt: T(20) }] };
    const { state } = mergeBundle(bens, buildBundle(anas, 'trip', T(21))!, {}, T(21));
    expect(state.recurring).toEqual([]);
  });
});
