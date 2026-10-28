import { describe, it, expect } from 'vitest';
import { buildFullExport, buildGroupExport, parseAndValidate, remapForNewGroup, withoutLegacyTotals, type ExportPayload } from './dataExport';
import type { Expense, Group, PaymentActivity, Settlement, User } from '../types';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const when = new Date('2026-01-01');
const user = (id: string): User => ({ id, name: id, initials: id[0].toUpperCase(), avatarColor: '#000', createdAt: when });

const group = (id: string, memberIds: string[]): Group => ({
  id,
  name: id,
  emoji: '',
  color: '#000',
  type: 'trip',
  members: memberIds.map((userId) => ({ userId, role: 'member', joinedAt: when })),
  lastActivity: when,
  createdAt: when,
});

/** `paidBy` fronted `amount` for `owedBy` alone. */
const expense = (id: string, groupId: string, paidBy: string, owedBy: string, amount: number): Expense => ({
  id,
  description: id,
  amount,
  currency: 'USD',
  paidBy,
  groupId,
  date: when,
  category: 'food',
  split: { type: 'exact', entries: [{ userId: owedBy, amount }] },
  createdAt: when,
  updatedAt: when,
});

// Me and Alice share two groups: she owes me 30 in the trip and 10 at home.
const payload = (): ExportPayload => ({
  currentUserId: 'me',
  users: [user('me'), user('alice')],
  groups: [
    { ...group('trip', ['me', 'alice']), yourBalance: 999, totalSpent: 999 } as Group,
    group('home', ['me', 'alice']),
  ],
  expenses: [expense('dinner', 'trip', 'me', 'alice', 30), expense('rent', 'home', 'me', 'alice', 10)],
  settlements: [],
  activities: [],
  friendBalances: { alice: 40 },
});

// ─── Legacy group totals ──────────────────────────────────────────────────────

describe('withoutLegacyTotals', () => {
  it('drops the stored balance and total', () => {
    const cleaned = withoutLegacyTotals(payload().groups[0]);
    expect(cleaned).not.toHaveProperty('yourBalance');
    expect(cleaned).not.toHaveProperty('totalSpent');
    expect(cleaned.name).toBe('trip');
  });

  it('returns a clean group as it is', () => {
    const clean = group('home', ['me']);
    expect(withoutLegacyTotals(clean)).toBe(clean);
  });
});

describe('exports', () => {
  it('leave the stored totals out of a full backup', () => {
    const file = buildFullExport(payload());
    expect(file.data.groups[0]).not.toHaveProperty('yourBalance');
  });

  it('leave the stored totals out of a group export', () => {
    const file = buildGroupExport(payload(), 'trip')!;
    expect(file.data.groups[0]).not.toHaveProperty('totalSpent');
  });

  it('give balances for the exported group only', () => {
    // Alice owes 40 across both groups, but only 30 of it is in the trip.
    expect(buildGroupExport(payload(), 'trip')!.data.friendBalances).toEqual({ alice: 30 });
  });
});

describe('parseAndValidate', () => {
  it('cleans the stored totals out of an older file', () => {
    const json = JSON.stringify(buildFullExport(payload())).replace('"name":"trip"', '"name":"trip","yourBalance":1,"totalSpent":2');
    const result = parseAndValidate(json);
    expect(result.ok).toBe(true);
    expect(result.data!.data.groups[0]).not.toHaveProperty('yourBalance');
    expect(result.data!.data.groups[0]).not.toHaveProperty('totalSpent');
  });

  it('gives dates back as Dates, and leaves text that only looks like one', () => {
    const p = payload();
    p.expenses[0] = { ...p.expenses[0], description: '2026-10-12T10:00:00 dinner' };
    const { data } = parseAndValidate(JSON.stringify(buildFullExport({ ...p, groupSyncedAt: { trip: when } }))).data!;
    expect(data.expenses[0].description).toBe('2026-10-12T10:00:00 dinner');
    expect(data.expenses[0].date).toEqual(when);
    expect(data.groups[0].members[0].joinedAt).toEqual(when);
    expect(data.groupSyncedAt!.trip).toEqual(when);
  });
});

describe('remapForNewGroup', () => {
  it('moves item assignments and payment entries onto the new ids', () => {
    // A receipt split by item, and a payment with its feed entry.
    const p = payload();
    p.expenses[0] = {
      ...p.expenses[0],
      items: [
        { description: 'Pasta', amount: 18, assigned: ['me'] },
        { description: 'Wine', amount: 12, assigned: ['me', 'alice'] },
      ],
    };
    const pay: Settlement = { id: 'pay', fromUserId: 'alice', toUserId: 'me', amount: 5, currency: 'USD', groupId: 'trip', date: when, createdAt: when };
    const entry: PaymentActivity = { id: 'feed', type: 'payment', actorId: 'alice', settlementId: 'pay', fromUserId: 'alice', toUserId: 'me', amount: 5, groupId: 'trip', date: when };
    const file = buildGroupExport({ ...p, settlements: [pay], activities: [entry] }, 'trip')!;

    // Imported by someone else, who says they're "me" in the file.
    const result = remapForNewGroup(file, [user('carol')], 'carol', 'me');
    const dinner = result.expenses.find((e) => e.description === 'dinner')!;
    expect(dinner.items!.map((it) => it.assigned)).toEqual([['carol'], ['carol', 'alice']]);
    const feed = result.activities[0] as PaymentActivity;
    expect(feed.settlementId).toBe(result.settlements[0].id);
    expect(feed.settlementId).not.toBe('pay');
  });
});
