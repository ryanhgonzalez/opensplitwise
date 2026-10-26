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

export interface MonthlyPoint {
  month: string;
  key: string;
  total: number;
  yourShare: number;
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
export function getMonthlyTrend(
  expenses: Expense[],
  userId: string,
  period: Period,
  now = new Date(),
): MonthlyPoint[] {
  const monthCount = monthsBetween(periodStart(expenses, period, now), now);
  const points: Record<string, MonthlyPoint> = {};

  for (let i = monthCount - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    const month = d.toLocaleDateString('en-US', { month: 'short', year: '2-digit' });
    points[key] = { month, key, total: 0, yourShare: 0 };
  }

  for (const expense of expenses) {
    const d = expense.date;
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    if (points[key]) {
      points[key].total += signedAmount(expense);
      points[key].yourShare += getShareForUser(expense, userId);
    }
  }

  return Object.values(points);
}

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
