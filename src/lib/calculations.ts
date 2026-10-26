/**
 * Pure calculation functions for expense splitting and settlement.
 * No React, Zustand, or UI dependencies — safe to test in isolation.
 */

import type { Expense, ExpenseSplit, Settlement, SplitEntry, SplitType } from '../types';

// ─── Public types ─────────────────────────────────────────────────────────────

/** userId → net balance. Positive = owed to this user; negative = this user owes. */
export type BalanceMap = Record<string, number>;

/** A single payment required to zero out a debt. */
export interface SettlementTransaction {
  from: string; // userId paying
  to: string;   // userId receiving
  amount: number;
}

/** Minimal input for group-level calculations. */
export interface GroupSnapshot {
  expenses: Expense[];
  memberIds: string[];
  /** Payments already marked complete. Omit for balances before any settling. */
  settlements?: Settlement[];
}

// ─── Refunds ──────────────────────────────────────────────────────────────────

/** +1 for money spent, −1 for a refund: money coming back runs every way round. */
export const moneySign = (expense: Pick<Expense, 'refund'>): 1 | -1 => (expense.refund ? -1 : 1);

/** The amount as spending: a refund counts against it. */
export const signedAmount = (expense: Pick<Expense, 'refund' | 'amount'>): number => moneySign(expense) * expense.amount;

// ─── Currency arithmetic ──────────────────────────────────────────────────────

/** Round to the nearest cent. Use this for every balance mutation to prevent float drift. */
export function round(amount: number): number {
  return Math.round(amount * 100) / 100;
}

// Sub-cent amounts are treated as zero throughout all calculations.
const EPSILON = 0.005;

// ─── Split builders ───────────────────────────────────────────────────────────

/**
 * Divide `amount` evenly across participants.
 * Leftover cents (from floor division) are distributed one-cent-at-a-time starting
 * from the first participant, so the split always sums exactly to `amount`.
 */
export function splitEvenly(amount: number, participantIds: string[]): SplitEntry[] {
  const n = participantIds.length;
  if (n === 0) return [];
  const base = Math.floor((amount / n) * 100) / 100;
  const leftoverCents = Math.round((amount - base * n) * 100);
  return participantIds.map((userId, i) => ({
    userId,
    amount: i < leftoverCents ? round(base + 0.01) : base,
  }));
}

/**
 * Divide `amount` by percentage. `percentages` must sum to 100.
 * Leftover cents are given to the participant with the largest allocation.
 */
export function splitByPercentage(
  amount: number,
  percentages: Array<{ userId: string; pct: number }>,
): SplitEntry[] {
  const raw = percentages.map(({ userId, pct }) => ({
    userId,
    amount: Math.floor((amount * pct) / 100 * 100) / 100,
  }));
  const distributed = raw.reduce((s, e) => s + e.amount, 0);
  const remainder = Math.round((amount - distributed) * 100);
  if (remainder !== 0) {
    const maxIdx = raw.reduce((best, e, i) => (e.amount > raw[best].amount ? i : best), 0);
    raw[maxIdx].amount = round(raw[maxIdx].amount + remainder * 0.01);
  }
  return raw;
}

/**
 * Divide `amount` by relative share weights.
 * e.g. shares [1, 2, 1] on $40 → [$10, $20, $10].
 */
export function splitByShares(
  amount: number,
  shares: Array<{ userId: string; shares: number }>,
): SplitEntry[] {
  const total = shares.reduce((s, e) => s + e.shares, 0);
  if (total === 0) return shares.map(({ userId }) => ({ userId, amount: 0 }));
  const pcts = shares.map(({ userId, shares: s }) => ({ userId, pct: (s / total) * 100 }));
  return splitByPercentage(amount, pcts);
}

/**
 * Build a complete `ExpenseSplit` object ready to attach to an `Expense`.
 * Handles all four split types.
 */
export function buildSplit(
  amount: number,
  type: SplitType,
  participants: Array<{ userId: string; value?: number }>,
): ExpenseSplit {
  let entries: SplitEntry[];

  switch (type) {
    case 'equal':
      entries = splitEvenly(amount, participants.map((p) => p.userId));
      break;
    case 'exact':
      entries = participants.map(({ userId, value = 0 }) => ({ userId, amount: round(value) }));
      break;
    case 'percentage':
      entries = splitByPercentage(
        amount,
        participants.map(({ userId, value = 0 }) => ({ userId, pct: value })),
      );
      break;
    case 'shares':
      entries = splitByShares(
        amount,
        participants.map(({ userId, value = 1 }) => ({ userId, shares: value })),
      );
      break;
  }

  return { type, entries };
}

/** One receipt line item and the members sharing it. */
export interface ItemAssignment {
  price: number;
  assigned: string[]; // userIds sharing this item
}

/**
 * Itemized split: each item is divided equally among its assignees, then any
 * remaining tax/tip (`total − itemsSum`) is distributed proportionally to each
 * member's item subtotal. Returns exact per-member entries that sum to `total`.
 *
 * @example
 * // Latte $4.50 (A), Croissant $3.25 (B), Sandwich $8.75 (A+B); total $17.99
 * splitByItems(17.99, 16.50, items, ['A','B']) // → [{A, 9.68}, {B, 8.31}]
 */
export function splitByItems(
  total: number,
  itemsSum: number,
  items: ItemAssignment[],
  memberIds: string[],
): SplitEntry[] {
  const per: Record<string, number> = {};
  for (const id of memberIds) per[id] = 0;

  for (const it of items) {
    const who = it.assigned.filter((id) => memberIds.includes(id));
    if (it.price <= 0 || who.length === 0) continue;
    const share = it.price / who.length;
    for (const id of who) per[id] += share;
  }

  const extra = total - itemsSum; // tax + tip (or discount, if negative)
  if (itemsSum > 0 && Math.abs(extra) > EPSILON) {
    for (const id of memberIds) per[id] += extra * (per[id] / itemsSum);
  }

  const entries = memberIds
    .map((id) => ({ userId: id, amount: round(per[id]) }))
    .filter((e) => e.amount > 0);

  // Correct any rounding drift so entries sum exactly to `total`.
  const sum = round(entries.reduce((s, e) => s + e.amount, 0));
  const diff = round(total - sum);
  if (Math.abs(diff) >= 0.01 && entries.length > 0) {
    const idx = entries.reduce((best, e, i) => (e.amount > entries[best].amount ? i : best), 0);
    entries[idx] = { ...entries[idx], amount: round(entries[idx].amount + diff) };
  }

  return entries;
}

// ─── Split validation ─────────────────────────────────────────────────────────

/** Returns true when the split entries sum to within one cent of the expense amount. */
export function validateSplit(expense: Expense): boolean {
  const total = expense.split.entries.reduce((s, e) => s + e.amount, 0);
  return Math.abs(total - expense.amount) < 0.01;
}

// ─── Per-expense net ──────────────────────────────────────────────────────────

/**
 * Net amount for `userId` from a single expense.
 * Positive → others owe this user. Negative → this user owes the payer.
 *
 * Having no share is NOT the same as having no effect: paying $500 that is split
 * entirely between two other people leaves you $500 up. An earlier version
 * short-circuited on a zero share and so dropped those expenses from group
 * balances — the drift the v1 persistence migration exists to repair.
 */
export function netForUserOnExpense(
  expense: Pick<Expense, 'amount' | 'paidBy' | 'split' | 'refund'>,
  userId: string,
): number {
  const share = expense.split.entries.find((e) => e.userId === userId)?.amount ?? 0;
  const sign = moneySign(expense);
  // Guard the sign of zero: `-0` renders as "-$0.00" and compares unequal to 0
  // under Object.is, which is a confusing thing to leak into a balance.
  if (expense.paidBy === userId) return round(expense.amount - share) * sign || 0;
  return share === 0 ? 0 : -share * sign;
}

/** Net amount for `userId` summed across multiple expenses. */
export function netForUser(expenses: Expense[], userId: string): number {
  return round(expenses.reduce((sum, e) => sum + netForUserOnExpense(e, userId), 0));
}

// ─── Core: calculateBalances ──────────────────────────────────────────────────

/**
 * Returns each member's net balance within a group.
 *
 * Algorithm: for each expense, the payer is credited the amount they fronted for
 * others (total paid − their own share), and each non-paying participant is
 * debited their share. Completed settlements are then applied on top: paying
 * someone moves the payer toward zero and reduces what the recipient is owed.
 *
 * The sum of all balances is always 0.
 *
 * @example
 * // $90 dinner, Alice paid, split evenly with Bob & Charlie
 * calculateBalances({ expenses, memberIds: ['alice', 'bob', 'charlie'] })
 * // → { alice: 60, bob: -30, charlie: -30 }
 * // …then Bob marks his $30 as paid
 * // → { alice: 30, bob: 0, charlie: -30 }
 */
export function calculateBalances({
  expenses,
  memberIds,
  settlements = [],
}: GroupSnapshot): BalanceMap {
  const balances: BalanceMap = {};
  for (const id of memberIds) balances[id] = 0;

  for (const expense of expenses) {
    // A refund runs the other way: whoever received it owes the others their shares.
    const sign = moneySign(expense);
    const payerShare =
      expense.split.entries.find((e) => e.userId === expense.paidBy)?.amount ?? 0;

    // Credit payer for what they fronted on behalf of everyone else.
    balances[expense.paidBy] = round(
      (balances[expense.paidBy] ?? 0) + sign * (expense.amount - payerShare),
    );

    // Debit each non-paying participant their share.
    for (const entry of expense.split.entries) {
      if (entry.userId !== expense.paidBy) {
        balances[entry.userId] = round((balances[entry.userId] ?? 0) - sign * entry.amount);
      }
    }
  }

  for (const settlement of settlements) {
    balances[settlement.fromUserId] = round(
      (balances[settlement.fromUserId] ?? 0) + settlement.amount,
    );
    balances[settlement.toUserId] = round(
      (balances[settlement.toUserId] ?? 0) - settlement.amount,
    );
  }

  return balances;
}

// ─── Core: calculateSettlements ───────────────────────────────────────────────

/**
 * Returns the minimum set of transactions still required to fully settle a group,
 * i.e. what remains outstanding after any completed settlements.
 *
 * Delegates to `settleBalances` — exposed separately so callers who already have
 * a `BalanceMap` can skip recomputing it.
 *
 * @example
 * calculateSettlements({ expenses, memberIds: ['alice', 'bob', 'charlie'] })
 * // → [{ from: 'bob', to: 'alice', amount: 30 }, { from: 'charlie', to: 'alice', amount: 30 }]
 */
export function calculateSettlements(snapshot: GroupSnapshot): SettlementTransaction[] {
  return settleBalances(calculateBalances(snapshot));
}

/**
 * Given a `BalanceMap`, returns the minimum number of transactions to zero everything out.
 *
 * Algorithm: greedy matching — repeatedly pair the largest creditor with the
 * largest debtor, transferring the lesser of the two amounts. This produces an
 * optimal (or near-optimal) transaction count in O(n log n).
 */
export function settleBalances(balances: BalanceMap): SettlementTransaction[] {
  const creditors = Object.entries(balances)
    .filter(([, v]) => v > EPSILON)
    .map(([userId, amount]) => ({ userId, amount }))
    .sort((a, b) => b.amount - a.amount);

  const debtors = Object.entries(balances)
    .filter(([, v]) => v < -EPSILON)
    .map(([userId, amount]) => ({ userId, amount: -amount }))
    .sort((a, b) => b.amount - a.amount);

  const transactions: SettlementTransaction[] = [];
  let ci = 0;
  let di = 0;

  while (ci < creditors.length && di < debtors.length) {
    const creditor = creditors[ci];
    const debtor = debtors[di];
    const amount = round(Math.min(creditor.amount, debtor.amount));

    if (amount > 0) {
      transactions.push({ from: debtor.userId, to: creditor.userId, amount });
    }

    creditor.amount = round(creditor.amount - amount);
    debtor.amount = round(debtor.amount - amount);

    if (creditor.amount <= EPSILON) ci++;
    if (debtor.amount <= EPSILON) di++;
  }

  return transactions;
}

// ─── Direct debts (the unsimplified view) ─────────────────────────────────────

/** One expense or payment's part in a direct debt. Positive adds to the debt. */
export interface DirectDebtItem {
  /** The expense or settlement id. */
  id: string;
  kind: 'expense' | 'payment';
  /** The expense description; empty for payments. */
  description: string;
  amount: number;
}

/** What `from` owes `to` from the expenses between just the two of them. */
export interface DirectDebt {
  from: string;
  to: string;
  amount: number;
  items: DirectDebtItem[];
}

/**
 * Who owes whom before any simplifying: for every expense, each participant owes
 * the payer their share, and payments count against what the payer owed.
 * Each pair appears at most once, oriented so `amount` is positive.
 *
 * This is the "why" behind `calculateSettlements`, which only looks at each
 * person's net and so may have someone pay a person they owe nothing directly.
 */
export function directDebts({ expenses, settlements = [] }: GroupSnapshot): DirectDebt[] {
  // Keyed by the pair in sorted order; a positive amount means `a` owes `b`.
  const pairs = new Map<string, { a: string; b: string; amount: number; items: DirectDebtItem[] }>();

  const add = (debtor: string, creditor: string, amount: number, item: Omit<DirectDebtItem, 'amount'>) => {
    if (debtor === creditor || Math.abs(amount) < EPSILON) return;
    const [a, b] = debtor < creditor ? [debtor, creditor] : [creditor, debtor];
    const signed = debtor === a ? amount : -amount;
    const key = `${a}|${b}`;
    let pair = pairs.get(key);
    if (!pair) {
      pair = { a, b, amount: 0, items: [] };
      pairs.set(key, pair);
    }
    pair.amount += signed;
    pair.items.push({ ...item, amount: signed });
  };

  for (const expense of expenses) {
    const sign = moneySign(expense);
    for (const entry of expense.split.entries) {
      add(entry.userId, expense.paidBy, sign * entry.amount, {
        id: expense.id,
        kind: 'expense',
        description: expense.description,
      });
    }
  }

  for (const settlement of settlements) {
    // Paying someone takes that much off what you owe them.
    add(settlement.fromUserId, settlement.toUserId, -settlement.amount, {
      id: settlement.id,
      kind: 'payment',
      description: '',
    });
  }

  const debts: DirectDebt[] = [];
  for (const { a, b, amount, items } of pairs.values()) {
    const net = round(amount);
    if (Math.abs(net) < EPSILON) continue;
    const flip = net < 0;
    debts.push({
      from: flip ? b : a,
      to: flip ? a : b,
      amount: Math.abs(net),
      items: items.map((i) => ({ ...i, amount: round(flip ? -i.amount : i.amount) })),
    });
  }
  return debts.sort((x, y) => y.amount - x.amount);
}

/**
 * True when the suggested transfers are not just the direct debts, i.e. some
 * transfer reroutes money through a third person or nets several debts together.
 */
export function isSimplified(transfers: SettlementTransaction[], direct: DirectDebt[]): boolean {
  if (transfers.length !== direct.length) return true;
  return transfers.some(
    (t) => !direct.some((d) => d.from === t.from && d.to === t.to && Math.abs(d.amount - t.amount) < EPSILON),
  );
}

// ─── Suggested debts (what everyone sees as owed) ─────────────────────────────

/** One payment the app suggests, in the ledger it belongs to. */
export interface SuggestedDebt {
  /** Undefined for expenses and payments that belong to no group. */
  groupId?: string;
  currency: string;
  from: string;
  to: string;
  amount: number;
}

/**
 * Every payment still needed to settle up, across all groups.
 *
 * Inside a group these are the simplified transfers from `calculateSettlements`,
 * the same ones the group screen lists, so "Frank owes you" means the same
 * thing on every screen and settling the group clears it everywhere. Records
 * with no group aren't simplified: each pair's direct debt stands on its own.
 *
 * Each group and currency is its own ledger: a debt in one never offsets another.
 */
export function suggestedDebts(expenses: Expense[], settlements: Settlement[]): SuggestedDebt[] {
  const ledgers = new Map<string, { groupId?: string; currency: string; expenses: Expense[]; settlements: Settlement[] }>();
  const ledgerOf = (groupId: string | undefined, currency: string | undefined) => {
    // Records from before groups had a currency are US dollars.
    const cur = currency || 'USD';
    const key = `${groupId ?? ''}|${cur}`;
    let ledger = ledgers.get(key);
    if (!ledger) {
      ledger = { groupId, currency: cur, expenses: [], settlements: [] };
      ledgers.set(key, ledger);
    }
    return ledger;
  };
  for (const e of expenses) ledgerOf(e.groupId, e.currency).expenses.push(e);
  for (const s of settlements) ledgerOf(s.groupId, s.currency).settlements.push(s);

  const debts: SuggestedDebt[] = [];
  for (const { groupId, currency, expenses: ex, settlements: st } of ledgers.values()) {
    const snapshot = { expenses: ex, settlements: st, memberIds: [] };
    const pairs = groupId ? calculateSettlements(snapshot) : directDebts(snapshot);
    for (const { from, to, amount } of pairs) debts.push({ groupId, currency, from, to, amount });
  }
  return debts;
}

// ─── Core: deriveTotals ───────────────────────────────────────────────────────

/** Per-group running totals from the current user's perspective. */
export interface GroupTotals {
  yourBalance: number;
  totalSpent: number;
}

export interface DerivedTotals {
  /**
   * userId → what they owe the current user, summed across every group, from
   * the suggested payments (see `suggestedDebts`).
   * Positive → they owe the current user. Negative → the current user owes them.
   * Only meaningful when everything is in one currency; kept for the export
   * file's format. Screens use `friendBalancesByCurrency`.
   */
  friendBalances: BalanceMap;
  /** currency → userId → net balance, as in `friendBalances` but never mixing currencies. */
  friendBalancesByCurrency: Record<string, BalanceMap>;
  /** groupId → that group's totals. Groups with no expenses are absent. */
  groupTotals: Record<string, GroupTotals>;
}

/**
 * Rebuilds every balance the UI displays from the raw records.
 *
 * This is the single source of truth for `friendBalances`, `yourBalance` and
 * `totalSpent`. Those used to be stored on the state and patched incrementally
 * by each action, which meant any action that forgot a term — or reversed one
 * incorrectly — left the numbers permanently wrong with no way to notice.
 * Deriving them on read costs a pass over the expense list and cannot drift.
 */
export function deriveTotals(
  expenses: Expense[],
  settlements: Settlement[],
  currentUserId: string,
): DerivedTotals {
  const friendBalances: BalanceMap = {};
  const friendBalancesByCurrency: Record<string, BalanceMap> = {};
  const groupTotals: Record<string, GroupTotals> = {};

  const bump = (userId: string, currency: string, delta: number) => {
    friendBalances[userId] = (friendBalances[userId] ?? 0) + delta;
    const inCurrency = (friendBalancesByCurrency[currency] ??= {});
    inCurrency[userId] = (inCurrency[userId] ?? 0) + delta;
  };

  for (const debt of suggestedDebts(expenses, settlements)) {
    if (debt.to === currentUserId) bump(debt.from, debt.currency, debt.amount);
    else if (debt.from === currentUserId) bump(debt.to, debt.currency, -debt.amount);
  }

  const totalsFor = (groupId?: string): GroupTotals | undefined => {
    if (!groupId) return undefined;
    let totals = groupTotals[groupId];
    if (!totals) {
      totals = { yourBalance: 0, totalSpent: 0 };
      groupTotals[groupId] = totals;
    }
    return totals;
  };

  for (const expense of expenses) {
    const totals = totalsFor(expense.groupId);
    if (totals) {
      totals.yourBalance += netForUserOnExpense(expense, currentUserId);
      totals.totalSpent += signedAmount(expense);
    }
  }

  for (const settlement of settlements) {
    const totals = totalsFor(settlement.groupId);
    if (!totals) continue;
    if (settlement.fromUserId === currentUserId) totals.yourBalance += settlement.amount;
    else if (settlement.toUserId === currentUserId) totals.yourBalance -= settlement.amount;
  }

  for (const userId of Object.keys(friendBalances)) {
    friendBalances[userId] = round(friendBalances[userId]);
  }
  for (const balances of Object.values(friendBalancesByCurrency)) {
    for (const userId of Object.keys(balances)) balances[userId] = round(balances[userId]);
  }
  for (const groupId of Object.keys(groupTotals)) {
    groupTotals[groupId].yourBalance = round(groupTotals[groupId].yourBalance);
    groupTotals[groupId].totalSpent = round(groupTotals[groupId].totalSpent);
  }

  return { friendBalances, friendBalancesByCurrency, groupTotals };
}

// ─── Payment allocation ───────────────────────────────────────────────────────

/** One group's slice of a debt, or the ungrouped remainder when `groupId` is undefined. */
export interface OutstandingBucket {
  groupId?: string;
  outstanding: number;
}

/** A payment, split into the per-group settlements it should be recorded as. */
export interface PaymentAllocation {
  groupId?: string;
  amount: number;
}

/**
 * How much `debtorId` owes `creditorId`, broken down by the group each part of
 * the debt sits in, from the suggested payments (see `suggestedDebts`). Only
 * buckets where the debt runs in that direction are returned — a group where
 * the money flows the other way cannot be paid down by this transfer. Expenses
 * with no group collapse into a single `undefined` bucket.
 *
 * With `currency`, only records in that currency count: a payment in euros
 * can only pay down debts in euros.
 *
 * Sorted largest first so allocation is deterministic.
 */
export function outstandingByGroup(
  expenses: Expense[],
  settlements: Settlement[],
  debtorId: string,
  creditorId: string,
  currency?: string,
): OutstandingBucket[] {
  const UNGROUPED = ' ungrouped';
  const owed: Record<string, number> = {};
  for (const debt of suggestedDebts(expenses, settlements)) {
    if (currency && debt.currency !== currency) continue;
    if (debt.from !== debtorId || debt.to !== creditorId) continue;
    const key = debt.groupId ?? UNGROUPED;
    owed[key] = (owed[key] ?? 0) + debt.amount;
  }

  return Object.entries(owed)
    .filter(([, outstanding]) => outstanding > EPSILON)
    .map(([key, outstanding]) => ({
      groupId: key === UNGROUPED ? undefined : key,
      outstanding: round(outstanding),
    }))
    .sort((a, b) => b.outstanding - a.outstanding || (a.groupId ?? '').localeCompare(b.groupId ?? ''));
}

/**
 * Divides a payment across the groups the debt actually lives in, proportional
 * to what is outstanding in each.
 *
 * A payment recorded against no group at all moves the overall balance while
 * leaving every group balance untouched, so the two drift apart permanently and
 * can never be reconciled. Splitting it keeps the invariant that the group
 * balances sum to the overall net.
 *
 * Anything paid beyond the outstanding total (an overpayment, or a payment made
 * when nothing is owed) lands in a single ungrouped allocation — it is real
 * money that has to register somewhere, but it belongs to no group's ledger.
 *
 * @example
 * // Owe Alice $75 on a trip and $25 on rent; pay her $40.
 * allocatePayment(40, [{ groupId: 'trip', outstanding: 75 }, { groupId: 'rent', outstanding: 25 }])
 * // → [{ groupId: 'trip', amount: 30 }, { groupId: 'rent', amount: 10 }]
 */
export function allocatePayment(amount: number, buckets: OutstandingBucket[]): PaymentAllocation[] {
  const payment = round(amount);
  if (payment <= EPSILON) return [];

  const total = round(buckets.reduce((s, b) => s + b.outstanding, 0));
  const payable = Math.min(payment, total);
  const allocations: PaymentAllocation[] = [];

  if (payable > EPSILON) {
    // Floor every share to whole cents, then hand the leftover cents out in
    // largest-remainder order so the slices sum to exactly `payable`.
    const shares = buckets.map((b) => {
      const exact = (payable * b.outstanding) / total;
      const floored = Math.floor(exact * 100) / 100;
      return { groupId: b.groupId, amount: floored, remainder: exact - floored };
    });

    let leftoverCents = Math.round((payable - shares.reduce((s, r) => s + r.amount, 0)) * 100);
    const byRemainder = [...shares].sort((a, b) => b.remainder - a.remainder);
    for (let i = 0; leftoverCents > 0; i = (i + 1) % byRemainder.length) {
      byRemainder[i].amount = round(byRemainder[i].amount + 0.01);
      leftoverCents--;
    }

    for (const share of shares) {
      if (share.amount > 0) allocations.push({ groupId: share.groupId, amount: share.amount });
    }
  }

  const excess = round(payment - payable);
  if (excess > EPSILON) allocations.push({ groupId: undefined, amount: excess });

  return allocations;
}
