import { describe, it, expect } from 'vitest';
import {
  round,
  splitEvenly,
  splitByPercentage,
  splitByShares,
  splitByItems,
  buildSplit,
  netForUserOnExpense,
  calculateBalances,
  settleBalances,
  calculateSettlements,
  deriveTotals,
  outstandingByGroup,
  allocatePayment,
  directDebts,
  isSimplified,
  suggestedDebts,
} from './calculations';
import type { Expense, Settlement, SplitEntry } from '../types';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const sum = (entries: SplitEntry[]) => round(entries.reduce((s, e) => s + e.amount, 0));

function expense(partial: Partial<Expense> & Pick<Expense, 'amount' | 'paidBy' | 'split'>): Expense {
  return {
    id: 'e1',
    description: 'Test',
    currency: 'USD',
    groupId: 'g1',
    date: new Date('2026-01-01'),
    category: 'food',
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
    ...partial,
  };
}

function settlement(from: string, to: string, amount: number, groupId = 'g1'): Settlement {
  return {
    id: `s-${from}-${to}-${amount}`,
    fromUserId: from,
    toUserId: to,
    amount,
    currency: 'USD',
    groupId,
    date: new Date('2026-01-02'),
    createdAt: new Date('2026-01-02'),
  };
}

// ─── Split builders ───────────────────────────────────────────────────────────

describe('splitEvenly', () => {
  it('divides cleanly when the amount is divisible', () => {
    expect(splitEvenly(90, ['a', 'b', 'c'])).toEqual([
      { userId: 'a', amount: 30 },
      { userId: 'b', amount: 30 },
      { userId: 'c', amount: 30 },
    ]);
  });

  it('distributes leftover cents from the front so the split is exact', () => {
    const entries = splitEvenly(10, ['a', 'b', 'c']);
    expect(entries.map((e) => e.amount)).toEqual([3.34, 3.33, 3.33]);
    expect(sum(entries)).toBe(10);
  });

  it('never loses a cent across awkward amounts', () => {
    for (const amount of [0.01, 0.02, 7.77, 19.99, 100.01, 1234.56]) {
      for (const n of [1, 2, 3, 4, 7]) {
        const ids = Array.from({ length: n }, (_, i) => `u${i}`);
        expect(sum(splitEvenly(amount, ids))).toBe(round(amount));
      }
    }
  });

  it('returns nothing when there are no participants', () => {
    expect(splitEvenly(50, [])).toEqual([]);
  });
});

describe('splitByPercentage', () => {
  it('splits by the given percentages', () => {
    const entries = splitByPercentage(100, [
      { userId: 'a', pct: 25 },
      { userId: 'b', pct: 75 },
    ]);
    expect(entries).toEqual([
      { userId: 'a', amount: 25 },
      { userId: 'b', amount: 75 },
    ]);
  });

  it('gives the rounding remainder to the largest allocation', () => {
    const entries = splitByPercentage(10, [
      { userId: 'a', pct: 33.333 },
      { userId: 'b', pct: 33.333 },
      { userId: 'c', pct: 33.334 },
    ]);
    expect(sum(entries)).toBe(10);
    expect(Math.max(...entries.map((e) => e.amount))).toBe(3.34);
  });
});

describe('splitByShares', () => {
  it('weights by relative shares', () => {
    expect(splitByShares(40, [
      { userId: 'a', shares: 1 },
      { userId: 'b', shares: 2 },
      { userId: 'c', shares: 1 },
    ])).toEqual([
      { userId: 'a', amount: 10 },
      { userId: 'b', amount: 20 },
      { userId: 'c', amount: 10 },
    ]);
  });

  it('yields zeroes rather than dividing by zero when no shares are assigned', () => {
    expect(splitByShares(40, [{ userId: 'a', shares: 0 }])).toEqual([{ userId: 'a', amount: 0 }]);
  });
});

describe('splitByItems', () => {
  it('spreads tax and tip proportionally to each person’s item subtotal', () => {
    // Latte $4.50 (A), croissant $3.25 (B), sandwich $8.75 (A+B); $17.99 charged.
    const entries = splitByItems(
      17.99,
      16.5,
      [
        { price: 4.5, assigned: ['a'] },
        { price: 3.25, assigned: ['b'] },
        { price: 8.75, assigned: ['a', 'b'] },
      ],
      ['a', 'b'],
    );
    expect(sum(entries)).toBe(17.99);
    // A ordered more, so A absorbs more of the surcharge.
    const a = entries.find((e) => e.userId === 'a')!.amount;
    const b = entries.find((e) => e.userId === 'b')!.amount;
    expect(a).toBeGreaterThan(b);
    expect(a).toBeCloseTo(9.68, 2);
    expect(b).toBeCloseTo(8.31, 2);
  });

  it('handles a discount (total below the item sum)', () => {
    const entries = splitByItems(
      9,
      10,
      [
        { price: 5, assigned: ['a'] },
        { price: 5, assigned: ['b'] },
      ],
      ['a', 'b'],
    );
    expect(sum(entries)).toBe(9);
    expect(entries.every((e) => e.amount === 4.5)).toBe(true);
  });

  it('ignores items assigned to nobody and drops members who owe nothing', () => {
    const entries = splitByItems(
      5,
      5,
      [
        { price: 5, assigned: ['a'] },
        { price: 3, assigned: [] },
      ],
      ['a', 'b'],
    );
    expect(entries).toEqual([{ userId: 'a', amount: 5 }]);
  });
});

describe('buildSplit', () => {
  it('produces entries that add up to the amount', () => {
    const split = buildSplit(10, 'equal', [{ userId: 'a' }, { userId: 'b' }, { userId: 'c' }]);
    expect(sum(split.entries)).toBe(10);
  });
});

// ─── Per-expense net ──────────────────────────────────────────────────────────

describe('netForUserOnExpense', () => {
  it('credits the payer for what they fronted for others', () => {
    const e = expense({
      amount: 90,
      paidBy: 'a',
      split: { type: 'equal', entries: [{ userId: 'a', amount: 30 }, { userId: 'b', amount: 30 }, { userId: 'c', amount: 30 }] },
    });
    expect(netForUserOnExpense(e, 'a')).toBe(60);
    expect(netForUserOnExpense(e, 'b')).toBe(-30);
  });

  // Regression: an earlier version short-circuited on a zero share, so paying
  // entirely on someone else's behalf registered as no effect at all.
  it('counts an expense paid entirely for other people', () => {
    const e = expense({
      amount: 500,
      paidBy: 'a',
      split: { type: 'exact', entries: [{ userId: 'b', amount: 250 }, { userId: 'c', amount: 250 }] },
    });
    expect(netForUserOnExpense(e, 'a')).toBe(500);
  });

  it('is zero for someone with no involvement', () => {
    const e = expense({
      amount: 50,
      paidBy: 'a',
      split: { type: 'equal', entries: [{ userId: 'a', amount: 25 }, { userId: 'b', amount: 25 }] },
    });
    expect(netForUserOnExpense(e, 'z')).toBe(0);
  });
});

// ─── Balances ─────────────────────────────────────────────────────────────────

describe('calculateBalances', () => {
  it('credits the payer and debits each participant', () => {
    const e = expense({
      amount: 90,
      paidBy: 'alice',
      split: { type: 'equal', entries: [{ userId: 'alice', amount: 30 }, { userId: 'bob', amount: 30 }, { userId: 'carol', amount: 30 }] },
    });
    expect(calculateBalances({ expenses: [e], memberIds: ['alice', 'bob', 'carol'] })).toEqual({
      alice: 60,
      bob: -30,
      carol: -30,
    });
  });

  it('applies completed settlements on top', () => {
    const e = expense({
      amount: 90,
      paidBy: 'alice',
      split: { type: 'equal', entries: [{ userId: 'alice', amount: 30 }, { userId: 'bob', amount: 30 }, { userId: 'carol', amount: 30 }] },
    });
    expect(
      calculateBalances({
        expenses: [e],
        memberIds: ['alice', 'bob', 'carol'],
        settlements: [settlement('bob', 'alice', 30)],
      }),
    ).toEqual({ alice: 30, bob: 0, carol: -30 });
  });

  it('always sums to zero', () => {
    const expenses = [
      expense({
        id: 'e1',
        amount: 100,
        paidBy: 'alice',
        split: { type: 'exact', entries: [{ userId: 'bob', amount: 60 }, { userId: 'carol', amount: 40 }] },
      }),
      expense({
        id: 'e2',
        amount: 33.33,
        paidBy: 'bob',
        split: splitEvenly(33.33, ['alice', 'bob', 'carol']).length
          ? { type: 'equal', entries: splitEvenly(33.33, ['alice', 'bob', 'carol']) }
          : { type: 'equal', entries: [] },
      }),
    ];
    const balances = calculateBalances({ expenses, memberIds: ['alice', 'bob', 'carol'] });
    expect(round(Object.values(balances).reduce((s, v) => s + v, 0))).toBe(0);
  });
});

describe('settleBalances', () => {
  it('pairs debtors with creditors in the fewest transfers', () => {
    expect(settleBalances({ alice: 60, bob: -30, carol: -30 })).toEqual([
      { from: 'bob', to: 'alice', amount: 30 },
      { from: 'carol', to: 'alice', amount: 30 },
    ]);
  });

  it('produces no transfers when everyone is square', () => {
    expect(settleBalances({ alice: 0, bob: 0 })).toEqual([]);
  });

  it('ignores sub-cent dust', () => {
    expect(settleBalances({ alice: 0.004, bob: -0.004 })).toEqual([]);
  });

  it('every transfer settles the group exactly', () => {
    const balances = { a: 75.5, b: -20.25, c: -40.1, d: -15.15 };
    const txns = settleBalances(balances);
    const applied = { ...balances } as Record<string, number>;
    for (const t of txns) {
      applied[t.from] = round(applied[t.from] + t.amount);
      applied[t.to] = round(applied[t.to] - t.amount);
    }
    for (const v of Object.values(applied)) expect(Math.abs(v)).toBeLessThan(0.01);
  });

  it('reports only what is still outstanding after settlements', () => {
    const e = expense({
      amount: 90,
      paidBy: 'alice',
      split: { type: 'equal', entries: [{ userId: 'alice', amount: 30 }, { userId: 'bob', amount: 30 }, { userId: 'carol', amount: 30 }] },
    });
    expect(
      calculateSettlements({
        expenses: [e],
        memberIds: ['alice', 'bob', 'carol'],
        settlements: [settlement('bob', 'alice', 30)],
      }),
    ).toEqual([{ from: 'carol', to: 'alice', amount: 30 }]);
  });
});

// ─── Derived totals ───────────────────────────────────────────────────────────

describe('deriveTotals', () => {
  const dinner = expense({
    id: 'e1',
    amount: 90,
    paidBy: 'me',
    groupId: 'trip',
    split: { type: 'equal', entries: [{ userId: 'me', amount: 30 }, { userId: 'alice', amount: 30 }, { userId: 'bob', amount: 30 }] },
  });

  it('builds friend balances and group totals in one pass', () => {
    const { friendBalances, groupTotals } = deriveTotals([dinner], [], 'me');
    expect(friendBalances).toEqual({ alice: 30, bob: 30 });
    expect(groupTotals).toEqual({ trip: { yourBalance: 60, totalSpent: 90 } });
  });

  it('applies settlements to both the friend balance and the group', () => {
    const { friendBalances, groupTotals } = deriveTotals([dinner], [settlement('bob', 'me', 30, 'trip')], 'me');
    // Bob is square, so he drops out; settled people have no balance.
    expect(friendBalances).toEqual({ alice: 30 });
    expect(groupTotals.trip.yourBalance).toBe(30);
    // A payment is not spending — it must not inflate the group's total.
    expect(groupTotals.trip.totalSpent).toBe(90);
  });

  it('counts an expense paid entirely on other people’s behalf', () => {
    const fronted = expense({
      id: 'e2',
      amount: 500,
      paidBy: 'me',
      groupId: 'trip',
      split: { type: 'exact', entries: [{ userId: 'alice', amount: 250 }, { userId: 'bob', amount: 250 }] },
    });
    const { friendBalances, groupTotals } = deriveTotals([fronted], [], 'me');
    expect(friendBalances).toEqual({ alice: 250, bob: 250 });
    expect(groupTotals.trip.yourBalance).toBe(500);
  });

  it('ignores expenses and settlements the current user is not part of', () => {
    const theirs = expense({
      id: 'e3',
      amount: 40,
      paidBy: 'alice',
      groupId: 'trip',
      split: { type: 'equal', entries: [{ userId: 'alice', amount: 20 }, { userId: 'bob', amount: 20 }] },
    });
    const { friendBalances, groupTotals } = deriveTotals([theirs], [settlement('bob', 'alice', 20, 'trip')], 'me');
    expect(friendBalances).toEqual({});
    expect(groupTotals.trip.yourBalance).toBe(0);
    // Still someone's spending, so it counts toward what the group has spent.
    expect(groupTotals.trip.totalSpent).toBe(40);
  });

  it('keeps group balances summing to the overall net once payments are grouped', () => {
    const rent = expense({
      id: 'e4',
      amount: 100,
      paidBy: 'alice',
      groupId: 'home',
      split: { type: 'equal', entries: [{ userId: 'me', amount: 50 }, { userId: 'alice', amount: 50 }] },
    });
    const { friendBalances, groupTotals } = deriveTotals(
      [dinner, rent],
      [settlement('me', 'alice', 20, 'home')],
      'me',
    );
    const overall = round(Object.values(friendBalances).reduce((s, v) => s + v, 0));
    const grouped = round(Object.values(groupTotals).reduce((s, g) => s + g.yourBalance, 0));
    expect(grouped).toBe(overall);
  });

  it('is independent of the order records arrive in', () => {
    const rent = expense({
      id: 'e5',
      amount: 100,
      paidBy: 'alice',
      groupId: 'home',
      split: { type: 'equal', entries: [{ userId: 'me', amount: 50 }, { userId: 'alice', amount: 50 }] },
    });
    const forward = deriveTotals([dinner, rent], [], 'me');
    const backward = deriveTotals([rent, dinner], [], 'me');
    expect(forward.friendBalances).toEqual(backward.friendBalances);
    expect(forward.groupTotals).toEqual(backward.groupTotals);
  });
});

// ─── Payment allocation ───────────────────────────────────────────────────────

describe('outstandingByGroup', () => {
  const tripDinner = expense({
    id: 'e1',
    amount: 150,
    paidBy: 'alice',
    groupId: 'trip',
    split: { type: 'equal', entries: [{ userId: 'me', amount: 75 }, { userId: 'alice', amount: 75 }] },
  });
  const rent = expense({
    id: 'e2',
    amount: 50,
    paidBy: 'alice',
    groupId: 'home',
    split: { type: 'equal', entries: [{ userId: 'me', amount: 25 }, { userId: 'alice', amount: 25 }] },
  });

  it('breaks a debt down by the group it sits in, largest first', () => {
    expect(outstandingByGroup([tripDinner, rent], [], 'me', 'alice')).toEqual([
      { groupId: 'trip', outstanding: 75 },
      { groupId: 'home', outstanding: 25 },
    ]);
  });

  it('nets out debts running the other way within a group', () => {
    const iPaid = expense({
      id: 'e3',
      amount: 40,
      paidBy: 'me',
      groupId: 'trip',
      split: { type: 'equal', entries: [{ userId: 'me', amount: 20 }, { userId: 'alice', amount: 20 }] },
    });
    expect(outstandingByGroup([tripDinner, iPaid], [], 'me', 'alice')).toEqual([
      { groupId: 'trip', outstanding: 55 },
    ]);
  });

  it('drops groups already settled and those owing the other direction', () => {
    const buckets = outstandingByGroup([tripDinner, rent], [settlement('me', 'alice', 25, 'home')], 'me', 'alice');
    expect(buckets).toEqual([{ groupId: 'trip', outstanding: 75 }]);
  });

  it('collects expenses with no group into a single undefined bucket', () => {
    const loose = expense({
      id: 'e4',
      amount: 20,
      paidBy: 'alice',
      groupId: undefined,
      split: { type: 'equal', entries: [{ userId: 'me', amount: 10 }, { userId: 'alice', amount: 10 }] },
    });
    expect(outstandingByGroup([loose], [], 'me', 'alice')).toEqual([
      { groupId: undefined, outstanding: 10 },
    ]);
  });
});

describe('allocatePayment', () => {
  const buckets = [
    { groupId: 'trip', outstanding: 75 },
    { groupId: 'home', outstanding: 25 },
  ];

  it('splits a partial payment proportionally', () => {
    expect(allocatePayment(40, buckets)).toEqual([
      { groupId: 'trip', amount: 30 },
      { groupId: 'home', amount: 10 },
    ]);
  });

  it('clears every bucket when the whole balance is paid', () => {
    expect(allocatePayment(100, buckets)).toEqual([
      { groupId: 'trip', amount: 75 },
      { groupId: 'home', amount: 25 },
    ]);
  });

  it('always allocates exactly the amount paid, to the cent', () => {
    const awkward = [
      { groupId: 'a', outstanding: 33.33 },
      { groupId: 'b', outstanding: 33.33 },
      { groupId: 'c', outstanding: 33.34 },
    ];
    for (const amount of [0.01, 0.07, 10, 33.33, 51.11, 99.99, 100]) {
      const allocations = allocatePayment(amount, awkward);
      const total = round(allocations.reduce((s, a) => s + a.amount, 0));
      expect(total).toBe(round(amount));
    }
  });

  it('never allocates more to a group than it has outstanding', () => {
    for (const allocation of allocatePayment(100, buckets)) {
      const bucket = buckets.find((b) => b.groupId === allocation.groupId)!;
      expect(allocation.amount).toBeLessThanOrEqual(bucket.outstanding);
    }
  });

  it('parks an overpayment in an ungrouped allocation', () => {
    expect(allocatePayment(120, buckets)).toEqual([
      { groupId: 'trip', amount: 75 },
      { groupId: 'home', amount: 25 },
      { groupId: undefined, amount: 20 },
    ]);
  });

  it('records a payment made when nothing is owed as ungrouped', () => {
    expect(allocatePayment(25, [])).toEqual([{ groupId: undefined, amount: 25 }]);
  });

  it('ignores a zero payment', () => {
    expect(allocatePayment(0, buckets)).toEqual([]);
  });
});

// ─── Refunds ──────────────────────────────────────────────────────────────────

describe('refunds', () => {
  // Ryan paid 416.34 for the three of them; 60 of it came back to Ryan's card.
  const hotel = expense({
    id: 'hotel',
    amount: 416.34,
    paidBy: 'ryan',
    split: { type: 'equal', entries: [{ userId: 'ryan', amount: 138.78 }, { userId: 'eddie', amount: 138.78 }, { userId: 'tai', amount: 138.78 }] },
  });
  const refund = expense({
    id: 'refund',
    amount: 60,
    paidBy: 'ryan',
    refund: { of: 'hotel' },
    split: { type: 'equal', entries: [{ userId: 'ryan', amount: 20 }, { userId: 'eddie', amount: 20 }, { userId: 'tai', amount: 20 }] },
  });

  it('runs the other way: whoever received it owes the others their shares', () => {
    expect(netForUserOnExpense(refund, 'ryan')).toBe(-40);
    expect(netForUserOnExpense(refund, 'eddie')).toBe(20);
  });

  it('leaves everyone where editing the original down to 356.34 would', () => {
    const balances = calculateBalances({ expenses: [hotel, refund], memberIds: ['ryan', 'eddie', 'tai'] });
    expect(balances).toEqual({ ryan: 237.56, eddie: -118.78, tai: -118.78 });
    expect(calculateSettlements({ expenses: [hotel, refund], memberIds: ['ryan', 'eddie', 'tai'] })).toEqual([
      { from: 'eddie', to: 'ryan', amount: 118.78 },
      { from: 'tai', to: 'ryan', amount: 118.78 },
    ]);
  });

  it('comes off what was spent, and off the balances between people', () => {
    const { friendBalances, groupTotals } = deriveTotals([hotel, refund], [], 'eddie');
    expect(groupTotals.g1).toEqual({ yourBalance: -118.78, totalSpent: 356.34 });
    expect(friendBalances.ryan).toBe(-118.78);
    expect(outstandingByGroup([hotel, refund], [], 'eddie', 'ryan')).toEqual([{ groupId: 'g1', outstanding: 118.78 }]);
  });

  it('can be received by someone who didn’t pay: they pass the others their part', () => {
    const toTai = { ...refund, paidBy: 'tai' };
    const balances = calculateBalances({ expenses: [hotel, toTai], memberIds: ['ryan', 'eddie', 'tai'] });
    expect(balances).toEqual({ ryan: 297.56, eddie: -118.78, tai: -178.78 });
  });
});

// ─── Direct debts ─────────────────────────────────────────────────────────────

describe('directDebts', () => {
  it('has each participant owe the payer their share', () => {
    const e = expense({
      id: 'dinner',
      description: 'Dinner',
      amount: 90,
      paidBy: 'a',
      split: { type: 'equal', entries: [{ userId: 'a', amount: 30 }, { userId: 'b', amount: 30 }, { userId: 'c', amount: 30 }] },
    });
    const debts = directDebts({ expenses: [e], memberIds: ['a', 'b', 'c'] });
    expect(debts).toHaveLength(2);
    expect(debts.find((d) => d.from === 'b')).toMatchObject({ to: 'a', amount: 30 });
    expect(debts[0].items).toEqual([{ id: 'dinner', kind: 'expense', description: 'Dinner', amount: 30 }]);
  });

  it('nets debts both ways between a pair and orients the result', () => {
    const e1 = expense({ id: 'x', amount: 20, paidBy: 'a', split: { type: 'exact', entries: [{ userId: 'b', amount: 20 }] } });
    const e2 = expense({ id: 'y', amount: 50, paidBy: 'b', split: { type: 'exact', entries: [{ userId: 'a', amount: 50 }] } });
    const [d] = directDebts({ expenses: [e1, e2], memberIds: ['a', 'b'] });
    expect(d).toMatchObject({ from: 'a', to: 'b', amount: 30 });
    expect(d.items.map((i) => i.amount)).toEqual([-20, 50]);
  });

  it('counts payments against the debt and drops settled pairs', () => {
    const e = expense({ amount: 40, paidBy: 'a', split: { type: 'exact', entries: [{ userId: 'b', amount: 40 }] } });
    expect(directDebts({ expenses: [e], memberIds: ['a', 'b'], settlements: [settlement('b', 'a', 40)] })).toEqual([]);
  });

  it('runs a refund the other way', () => {
    const r = expense({ amount: 10, paidBy: 'a', refund: {}, split: { type: 'exact', entries: [{ userId: 'b', amount: 10 }] } });
    expect(directDebts({ expenses: [r], memberIds: ['a', 'b'] })[0]).toMatchObject({ from: 'a', to: 'b', amount: 10 });
  });
});

describe('isSimplified', () => {
  it('is false when the transfers are just the direct debts', () => {
    const e = expense({ amount: 30, paidBy: 'a', split: { type: 'exact', entries: [{ userId: 'b', amount: 30 }] } });
    const snap = { expenses: [e], memberIds: ['a', 'b'] };
    expect(isSimplified(calculateSettlements(snap), directDebts(snap))).toBe(false);
  });

  it('is true when someone pays a person they owe nothing directly', () => {
    // Ryan fronts a lot for Jr; Frank owes Jr a little. Simplified: Frank pays Ryan.
    const big = expense({ id: 'big', amount: 100, paidBy: 'ryan', split: { type: 'exact', entries: [{ userId: 'jr', amount: 100 }] } });
    const small = expense({ id: 'small', amount: 14.17, paidBy: 'jr', split: { type: 'exact', entries: [{ userId: 'frank', amount: 14.17 }] } });
    const snap = { expenses: [big, small], memberIds: ['ryan', 'jr', 'frank'] };
    const transfers = calculateSettlements(snap);
    expect(transfers).toContainEqual({ from: 'frank', to: 'ryan', amount: 14.17 });
    expect(directDebts(snap).some((d) => d.from === 'frank' && d.to === 'ryan')).toBe(false);
    expect(isSimplified(transfers, directDebts(snap))).toBe(true);
  });
});

// ─── Person balances follow the group's suggested payments ────────────────────

describe('person balances match the group screen', () => {
  // The cruise case: Ryan fronts a lot for Jr; Frank owes Jr a little.
  const big = expense({ id: 'big', amount: 100, paidBy: 'ryan', split: { type: 'exact', entries: [{ userId: 'jr', amount: 100 }] } });
  const small = expense({ id: 'small', amount: 14.17, paidBy: 'jr', split: { type: 'exact', entries: [{ userId: 'frank', amount: 14.17 }] } });

  it('shows a rerouted payment as owed to the person it goes to', () => {
    const { friendBalances } = deriveTotals([big, small], [], 'ryan');
    expect(friendBalances).toEqual({ frank: 14.17, jr: 85.83 });
  });

  it('clears every person once the suggested payments are made', () => {
    const plan = calculateSettlements({ expenses: [big, small], memberIds: [] });
    const paid = plan.map((t) => settlement(t.from, t.to, t.amount));
    expect(deriveTotals([big, small], paid, 'ryan').friendBalances).toEqual({});
    expect(deriveTotals([big, small], paid, 'frank').friendBalances).toEqual({});
  });

  it('settles up with a person by paying down what the group suggests', () => {
    expect(outstandingByGroup([big, small], [], 'frank', 'ryan')).toEqual([{ groupId: 'g1', outstanding: 14.17 }]);
    // Frank owes Jr nothing on the plan: the debt goes to Ryan instead.
    expect(outstandingByGroup([big, small], [], 'frank', 'jr')).toEqual([]);
  });

  it('leaves expenses outside any group as direct debts', () => {
    const loose = { ...small, groupId: undefined };
    const looseBig = { ...big, groupId: undefined };
    expect(suggestedDebts([looseBig, loose], [])).toEqual([
      { groupId: undefined, currency: 'USD', from: 'jr', to: 'ryan', amount: 100 },
      { groupId: undefined, currency: 'USD', from: 'frank', to: 'jr', amount: 14.17 },
    ]);
  });

  it('keeps each currency in a group separate', () => {
    const eur = { ...small, id: 'eur', currency: 'EUR' };
    const debts = suggestedDebts([big, eur], []);
    expect(debts).toContainEqual({ groupId: 'g1', currency: 'EUR', from: 'frank', to: 'jr', amount: 14.17 });
    expect(debts).toContainEqual({ groupId: 'g1', currency: 'USD', from: 'jr', to: 'ryan', amount: 100 });
  });
});
