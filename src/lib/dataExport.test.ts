import { describe, it, expect } from 'vitest';
import { buildFullExport, buildGroupExport, parseAndValidate, withoutLegacyTotals, type ExportPayload } from './dataExport';
import type { Expense, Group, User } from '../types';

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
});
