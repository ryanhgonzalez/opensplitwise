import { describe, it, expect } from 'vitest';
import { filterByPeriod, getGroupContributions, getMonthlyTrend, monthsBetween, periodStart } from './analytics';
import type { Expense, Group, User } from '../types';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const now = new Date(2026, 9, 26); // Oct 26, 2026

const expense = (id: string, date: Date, amount: number, extra: Partial<Expense> = {}): Expense => ({
  id,
  description: id,
  amount,
  currency: 'USD',
  paidBy: 'me',
  groupId: 'trip',
  date,
  category: 'travel',
  split: { type: 'exact', entries: [{ userId: 'me', amount }] },
  createdAt: date,
  updatedAt: date,
  ...extra,
});

// The cruise's shape: deposits 13 months back, a refund this month.
const deposit = expense('deposit', new Date(2025, 8, 25), 1000);
const fare = expense('fare', new Date(2026, 1, 16), 2000);
const july = expense('july', new Date(2026, 6, 28), 50);
const refund = expense('refund', new Date(2026, 9, 14), 480, { refund: {} });
const all = [deposit, fare, july, refund];

// ─── Periods ──────────────────────────────────────────────────────────────────

describe('periods', () => {
  it('cover whole calendar months ending with this one', () => {
    expect(periodStart(all, 3, now)).toEqual(new Date(2026, 7, 1)); // Aug, Sep, Oct
    expect(periodStart(all, 1, now)).toEqual(new Date(2026, 9, 1));
  });

  it('start "All" at the month of the earliest expense', () => {
    expect(periodStart(all, 0, now)).toEqual(new Date(2025, 8, 1));
    expect(monthsBetween(periodStart(all, 0, now), now)).toBe(14);
  });

  it('count the same expenses the chart shows', () => {
    // Jul 28 is outside Aug–Oct, so it's not in the totals either.
    expect(filterByPeriod(all, 3, now).map((e) => e.id)).toEqual(['refund']);
  });
});

describe('getMonthlyTrend', () => {
  it('charts every month of "All", back to the first expense', () => {
    const points = getMonthlyTrend(all, 'me', 0, now);
    expect(points).toHaveLength(14);
    expect(points[0]).toMatchObject({ key: '2025-09', total: 1000 });
    // Everything counted in the totals is on the chart.
    expect(points.reduce((s, p) => s + p.total, 0)).toBe(1000 + 2000 + 50 - 480);
  });

  it('shows a refund month below zero rather than dropping it', () => {
    const october = getMonthlyTrend(all, 'me', 1, now)[0];
    expect(october).toMatchObject({ key: '2026-10', total: -480, yourShare: -480 });
  });
});

describe('getGroupContributions', () => {
  it('uses full names when two members share a first name', () => {
    const users: User[] = ['Me Person', 'Frank Gonzalez', 'Frank Gonzalez Jr'].map((name, i) => ({
      id: ['me', 'frank', 'jr'][i],
      name,
      initials: 'X',
      avatarColor: '#000',
      createdAt: now,
    }));
    const group: Group = {
      id: 'trip',
      name: 'Trip',
      emoji: '',
      color: '#000',
      type: 'trip',
      members: users.map((u) => ({ userId: u.id, role: 'member', joinedAt: now })),
      lastActivity: now,
      createdAt: now,
    };
    const [trip] = getGroupContributions([fare], [group], users, 'me');
    expect(trip.members.map((m) => m.name)).toEqual(['You', 'Frank Gonzalez', 'Frank Gonzalez Jr']);
  });
});
