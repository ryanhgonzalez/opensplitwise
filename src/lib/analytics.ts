import type { Expense, ExpenseCategory, Group, User } from '../types';
import { categoryInfo, isCustomCategory } from './categories';
import { getShareForUser } from '../utils/expense';
import { signedAmount } from './calculations';

// ── Config ────────────────────────────────────────────────────────────────────

export type Period = 1 | 3 | 6 | 0;
export type ViewMode = 'personal' | 'total';

export const CATEGORY_COLORS: Record<ExpenseCategory, string> = {
  food:            '#f59e0b',
  groceries:       '#84cc16',
  transport:       '#60a5fa',
  travel:          '#34d399',
  accommodation:   '#22d3ee',
  shopping:        '#fb923c',
  entertainment:   '#f472b6',
  utilities:       '#a78bfa',
  rent:            '#818cf8',
  healthcare:      '#f87171',
  gifts:           '#c084fc',
  education:       '#4ade80',
  subscriptions:   '#38bdf8',
  'personal-care': '#fb7185',
  other:           '#94a3b8',
};

// ── Types ─────────────────────────────────────────────────────────────────────

/** Custom categories have no colour of their own. */
const CUSTOM_CATEGORY_COLOR = '#94a3b8';

export interface CategoryBreakdown {
  /** A built-in category id, or `name:<lowercased name>` for custom ones. */
  category: string;
  label: string;
  icon: string;
  amount: number;
  percentage: number;
  color: string;
}

export interface MemberContribution {
  userId: string;
  name: string;
  initials: string;
  avatarColor: string;
  paid: number;
  share: number;
}

export interface GroupContribution {
  groupId: string;
  name: string;
  emoji: string;
  color: string;
  totalSpent: number;
  members: MemberContribution[];
}

// ── Computations ──────────────────────────────────────────────────────────────

/**
 * The first day of the first month a period covers. Periods are whole calendar
 * months ending with this one, so the totals and the monthly chart always cover
 * the same expenses. "All" starts at the earliest expense.
 */
export function periodStart(expenses: Expense[], period: Period, now = new Date()): Date {
  if (period === 0) {
    const first = expenses.reduce<Date | null>((min, e) => (!min || e.date < min ? e.date : min), null);
    const from = first ?? now;
    return new Date(from.getFullYear(), from.getMonth(), 1);
  }
  return new Date(now.getFullYear(), now.getMonth() - (period - 1), 1);
}

/** Calendar months from `start` to `now`, inclusive. */
export function monthsBetween(start: Date, now = new Date()): number {
  return (now.getFullYear() - start.getFullYear()) * 12 + now.getMonth() - start.getMonth() + 1;
}

export function filterByPeriod(expenses: Expense[], period: Period, now = new Date()): Expense[] {
  if (period === 0) return expenses;
  const start = periodStart(expenses, period, now);
  return expenses.filter(e => e.date >= start);
}

/**
 * Spending per category. Custom categories are per group, so two groups that
 * each made "Gas" would otherwise show twice; they're combined by name.
 */
export function getCategoryBreakdown(
  expenses: Expense[],
  userId: string,
  mode: ViewMode,
  groups: Group[] = [],
): CategoryBreakdown[] {
  const groupById = new Map(groups.map((g) => [g.id, g]));
  const totals = new Map<string, { label: string; icon: string; color: string; amount: number }>();

  for (const expense of expenses) {
    // Refunds count against their category.
    const amount = mode === 'personal' ? getShareForUser(expense, userId) : signedAmount(expense);
    if (amount === 0) continue;

    const group = expense.groupId ? groupById.get(expense.groupId) : undefined;
    const custom = isCustomCategory(expense.category)
      ? group?.categories?.find((c) => c.id === expense.category)
      : undefined;
    // A custom id that no longer resolves reads as Other, so it's counted there.
    const builtIn: ExpenseCategory = isCustomCategory(expense.category) ? 'other' : expense.category;
    const key = custom ? `name:${custom.name.toLowerCase()}` : builtIn;
    const { label, icon } = categoryInfo(custom ? custom.id : builtIn, group);
    const color = custom ? CUSTOM_CATEGORY_COLOR : CATEGORY_COLORS[builtIn];

    const entry = totals.get(key) ?? { label, icon, color, amount: 0 };
    entry.amount += amount;
    totals.set(key, entry);
  }

  // A category refunded down to nothing (or below) has no spending to show.
  for (const [key, t] of totals) if (t.amount < 0.005) totals.delete(key);
  const grandTotal = [...totals.values()].reduce((s, v) => s + v.amount, 0);

  return [...totals.entries()]
    .map(([category, t]) => ({
      category,
      label: t.label,
      icon: t.icon,
      amount: t.amount,
      percentage: grandTotal > 0 ? (t.amount / grandTotal) * 100 : 0,
      color: t.color,
    }))
    .sort((a, b) => b.amount - a.amount);
}

/**
 * Spending per calendar month across the period. "All" runs from the month of
 * the earliest expense, so nothing counted in the totals is left off the chart.
 */
export function getGroupContributions(
  expenses: Expense[],
  groups: Group[],
  users: User[],
  currentUserId: string,
): GroupContribution[] {
  return groups
    .map(group => {
      const gExp = expenses.filter(e => e.groupId === group.id);
      const totalSpent = gExp.reduce((s, e) => s + signedAmount(e), 0);
      if (totalSpent === 0) return null;

      // First names, unless two members share one ("Frank" and "Frank Jr").
      const firsts = group.members.map(m => users.find(u => u.id === m.userId)?.name.split(' ')[0]);
      const shortName = (name: string) => {
        const first = name.split(' ')[0];
        return firsts.filter(f => f === first).length > 1 ? name : first;
      };

      const members: MemberContribution[] = group.members
        .map(m => {
          const user = users.find(u => u.id === m.userId);
          if (!user) return null;
          const paid = gExp
            .filter(e => e.paidBy === m.userId)
            .reduce((s, e) => s + signedAmount(e), 0);
          const share = gExp.reduce((s, e) => s + getShareForUser(e, m.userId), 0);
          return {
            userId: m.userId,
            name: m.userId === currentUserId ? 'You' : shortName(user.name),
            initials: user.initials,
            avatarColor: user.avatarColor,
            paid,
            share,
          };
        })
        .filter((m): m is MemberContribution => m !== null);

      return {
        groupId: group.id,
        name: group.name,
        emoji: group.emoji,
        color: group.color,
        totalSpent,
        members,
      };
    })
    .filter((g): g is GroupContribution => g !== null);
}

// ── Trend: the period's spending, by the time step that suits its length ─────

export type Step = 'day' | 'week' | 'month';

/** A span of time; `end` is exclusive. */
export interface Range {
  start: Date;
  end: Date;
}

export interface TrendPoint {
  key: string;
  start: Date;
  end: Date;
  /** Spending in the step: your share, or the group total. Refunds count against it. */
  value: number;
  expenses: Expense[];
  /** The step that's still going (this week so far). */
  partial: boolean;
}

const DAY_MS = 86_400_000;
const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
/** Weeks start on Monday. */
const startOfWeek = (d: Date) => addDays(startOfDay(d), -((d.getDay() + 6) % 7));

/** How an expense counts: your share of it, or all of it. */
export const valueOf = (expense: Expense, userId: string, mode: ViewMode): number =>
  mode === 'personal' ? getShareForUser(expense, userId) : signedAmount(expense);

/**
 * What the page covers. A period is whole months ending with this one (to
 * today). "All" of one group runs from its first expense to its last, so a
 * trip reads as its days; "All" of everything runs to today.
 */
export function trendRange(expenses: Expense[], period: Period, oneGroup: boolean, now = new Date()): Range {
  const tomorrow = addDays(startOfDay(now), 1);
  if (period === 0 && oneGroup && expenses.length > 0) {
    const times = expenses.map((e) => e.date.getTime());
    return { start: startOfDay(new Date(Math.min(...times))), end: addDays(startOfDay(new Date(Math.max(...times))), 1) };
  }
  return { start: periodStart(expenses, period, now), end: tomorrow };
}

/** The period of the same length just before, to compare against. None for "All". */
export function previousRange(range: Range, period: Period): Range | null {
  if (period === 0) return null;
  const s = range.start;
  return { start: new Date(s.getFullYear(), s.getMonth() - period, 1), end: s };
}

/** Days for up to about a month, weeks up to about half a year, months beyond. */
export function chooseStep(range: Range): Step {
  const days = Math.round((range.end.getTime() - range.start.getTime()) / DAY_MS);
  if (days <= 35) return 'day';
  if (days <= 200) return 'week';
  return 'month';
}

/** Every step in the range, oldest first, with its spending. */
export function getTrend(
  expenses: Expense[],
  userId: string,
  mode: ViewMode,
  range: Range,
  step: Step,
  now = new Date(),
): TrendPoint[] {
  const next = (d: Date) =>
    step === 'day' ? addDays(d, 1) : step === 'week' ? addDays(d, 7) : new Date(d.getFullYear(), d.getMonth() + 1, 1);
  let cursor =
    step === 'day' ? startOfDay(range.start)
    : step === 'week' ? startOfWeek(range.start)
    : new Date(range.start.getFullYear(), range.start.getMonth(), 1);
  const points: TrendPoint[] = [];
  while (cursor < range.end) {
    const end = next(cursor);
    const key = `${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, '0')}-${String(cursor.getDate()).padStart(2, '0')}`;
    points.push({ key, start: cursor, end, value: 0, expenses: [], partial: cursor <= now && now < end && step !== 'day' });
    cursor = end;
  }
  for (const e of expenses) {
    const point = points.find((p) => e.date >= p.start && e.date < p.end);
    if (!point) continue;
    point.value += valueOf(e, userId, mode);
    point.expenses.push(e);
  }
  return points;
}

export const inRange = (expenses: Expense[], range: Range): Expense[] =>
  expenses.filter((e) => e.date >= range.start && e.date < range.end);

/** The biggest expenses (not refunds), largest first. */
export function getLargestExpenses(expenses: Expense[], count = 5): Expense[] {
  return expenses.filter((e) => !e.refund && e.amount > 0).sort((a, b) => b.amount - a.amount).slice(0, count);
}

export interface SharedWith {
  userId: string;
  /** Your share of the expenses they were part of. */
  amount: number;
}

/**
 * Who you share spending with: for each person, your share of the expenses
 * they were in (paid for, or had a share of). One expense counts for everyone
 * in it. Empty when it would say nothing: one other person, or everyone the same.
 */
export function getSharedWith(expenses: Expense[], userId: string): SharedWith[] {
  const totals = new Map<string, number>();
  for (const e of expenses) {
    const mine = getShareForUser(e, userId);
    if (Math.abs(mine) < 0.005) continue;
    const others = new Set(e.split.entries.filter((en) => en.amount > 0).map((en) => en.userId));
    others.add(e.paidBy);
    others.delete(userId);
    for (const id of others) totals.set(id, (totals.get(id) ?? 0) + mine);
  }
  const rows = [...totals.entries()]
    .map(([id, amount]) => ({ userId: id, amount: Math.round(amount * 100) / 100 }))
    .filter((r) => r.amount >= 0.005)
    .sort((a, b) => b.amount - a.amount);
  if (rows.length < 2 || rows[0].amount - rows[rows.length - 1].amount < 0.01) return [];
  return rows;
}
