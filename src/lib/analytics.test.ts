import { describe, it, expect } from 'vitest';
import {
  chooseStep,
  filterByPeriod,
  getGroupContributions,
  getLargestExpenses,
  getSharedWith,
  getTrend,
  monthsBetween,
  periodStart,
  previousRange,
  trendRange,
} from './analytics';
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

describe('trend', () => {
  it('charts every month of "All", back to the first expense', () => {
    const range = trendRange(all, 0, false, now);
    expect(chooseStep(range)).toBe('month');
    const points = getTrend(all, 'me', 'personal', range, 'month', now);
    expect(points).toHaveLength(14);
    expect(points[0]).toMatchObject({ key: '2025-09-01', value: 1000 });
    // Everything counted in the totals is on the chart.
    expect(points.reduce((s, p) => s + p.value, 0)).toBe(1000 + 2000 + 50 - 480);
  });

  it('shows a refund below zero rather than dropping it', () => {
    const range = trendRange(all, 1, false, now);
    const points = getTrend(all, 'me', 'personal', range, chooseStep(range), now);
    expect(points.find((p) => p.value !== 0)).toMatchObject({ key: '2026-10-14', value: -480 });
  });

  it('steps by day for a month, by week for a few months', () => {
    expect(chooseStep(trendRange(all, 1, false, now))).toBe('day');
    const three = trendRange(all, 3, false, now);
    expect(chooseStep(three)).toBe('week');
    const weeks = getTrend(all, 'me', 'personal', three, 'week', now);
    // Weeks start on Monday; the one with today in it is still going.
    expect(weeks[0].start.getDay()).toBe(1);
    expect(weeks[weeks.length - 1].partial).toBe(true);
  });

  it('shows a whole trip by its days, first expense to last', () => {
    const trip = [
      expense('a', new Date(2026, 9, 8, 19), 40),
      expense('b', new Date(2026, 9, 9, 12), 300),
      expense('c', new Date(2026, 9, 14, 9), 20),
    ];
    const range = trendRange(trip, 0, true, now);
    expect(range).toEqual({ start: new Date(2026, 9, 8), end: new Date(2026, 9, 15) });
    expect(chooseStep(range)).toBe('day');
    expect(getTrend(trip, 'me', 'personal', range, 'day', now).map((p) => p.value)).toEqual([40, 300, 0, 0, 0, 0, 20]);
  });

  it('compares with the same number of months just before', () => {
    expect(previousRange(trendRange(all, 3, false, now), 3)).toEqual({ start: new Date(2026, 4, 1), end: new Date(2026, 7, 1) });
    expect(previousRange(trendRange(all, 0, false, now), 0)).toBeNull();
  });
});

describe('getLargestExpenses', () => {
  it('ranks by amount and leaves refunds out', () => {
    expect(getLargestExpenses(all, 2).map((e) => e.id)).toEqual(['fare', 'deposit']);
  });
});

describe('getSharedWith', () => {
  const split = (ids: string[], each: number) => ({ type: 'equal' as const, entries: ids.map((userId) => ({ userId, amount: each })) });
  it('adds up your share of the expenses each person was in', () => {
    const rows = getSharedWith(
      [
        expense('dinner', now, 90, { split: split(['me', 'ben', 'carla'], 30) }),
        expense('taxi', now, 20, { paidBy: 'ben', split: split(['me', 'ben'], 10) }),
      ],
      'me',
    );
    expect(rows).toEqual([
      { userId: 'ben', amount: 40 },
      { userId: 'carla', amount: 30 },
    ]);
  });

  it('says nothing when everyone is in everything', () => {
    expect(getSharedWith([expense('dinner', now, 90, { split: split(['me', 'ben', 'carla'], 30) })], 'me')).toEqual([]);
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
