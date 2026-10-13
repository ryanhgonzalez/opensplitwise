import { useState } from 'react';
import { Activity } from '../types';
import { useStore, selectActivities, selectCurrentUser } from '../store';
import {
  formatCurrency,
  formatDate,
  formatTime,
  getActivityDescription,
  isActivityPositive,
  getActivityAmount,
} from '../utils';
import { expenseAmountLabel, groupCurrency } from '../lib/currency';
import './Activity.css';

type Filter = 'all' | 'expenses' | 'payments';

const FILTER_LABELS: Record<Filter, string> = {
  all: 'All',
  expenses: 'Expenses',
  payments: 'Payments',
};

/** Three-letter mark for each kind of entry, shown in a small tinted box. */
const KIND: Record<Activity['type'], { tag: string; cls: string; label: string }> = {
  expense_added: { tag: 'EXP', cls: 'k-exp', label: 'Expense added' },
  expense_updated: { tag: 'EDT', cls: 'k-exp', label: 'Expense updated' },
  expense_deleted: { tag: 'DEL', cls: 'k-del', label: 'Expense deleted' },
  payment: { tag: 'PAY', cls: 'k-pay', label: 'Payment' },
  settled: { tag: 'PAY', cls: 'k-pay', label: 'Settled up' },
};

function groupByDate(items: Activity[]) {
  const map = new Map<string, Activity[]>();
  for (const item of items) {
    const key = formatDate(item.date);
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push(item);
  }
  return map;
}

export default function ActivityPage() {
  const [filter, setFilter] = useState<Filter>('all');

  const currentUser = useStore(selectCurrentUser)!;
  const allActivities = useStore(selectActivities);
  const users = useStore((s) => s.users);
  const groups = useStore((s) => s.groups);
  const expenses = useStore((s) => s.expenses);

  const getExpenseById = (id: string) => expenses.find((e) => e.id === id);
  const getUserById = (id: string) => users.find((u) => u.id === id);
  const getGroupById = (id: string) => groups.find((g) => g.id === id);

  const filtered = allActivities.filter((a) => {
    if (filter === 'expenses') return a.type === 'expense_added' || a.type === 'expense_updated';
    if (filter === 'payments') return a.type === 'payment' || a.type === 'settled';
    return true;
  });

  const grouped = groupByDate(filtered);

  return (
    <div className="page-content">
      <div className="activity-page">
        <header>
          <h1 className="page-hero-title">Activity</h1>
          <p className="text-secondary activity-count">
            {allActivities.length === 0
              ? 'No activity yet'
              : `${allActivities.length} event${allActivities.length !== 1 ? 's' : ''}`}
          </p>
        </header>

        <div className="activity-tabs" role="tablist" aria-label="Filter activity">
          {(['all', 'expenses', 'payments'] as Filter[]).map((f) => (
            <button
              key={f}
              role="tab"
              aria-selected={filter === f}
              className={`activity-tab ${filter === f ? 'active' : ''}`}
              onClick={() => setFilter(f)}
            >
              {FILTER_LABELS[f]}
            </button>
          ))}
        </div>

        {[...grouped.entries()].map(([date, items]) => (
          <section key={date} className="activity-day">
            <h2 className="num activity-day-label">{date.toUpperCase()}</h2>

            {items.map((activity) => {
              const actor = getUserById(activity.actorId);
              const group = activity.groupId ? getGroupById(activity.groupId) : undefined;
              if (!actor) return null;

              const cur = groupCurrency(group);
              const description = getActivityDescription(activity, currentUser.id, getExpenseById, getUserById, cur);
              const isPositive = isActivityPositive(activity, currentUser.id, getExpenseById);
              const amount = getActivityAmount(activity, currentUser.id, getExpenseById);
              const isPayment = activity.type === 'payment' || activity.type === 'settled';
              const kind = KIND[activity.type];
              const expense =
                activity.type === 'expense_added' || activity.type === 'expense_updated'
                  ? getExpenseById(activity.expenseId)
                  : undefined;

              return (
                <div key={activity.id} className="activity-row">
                  <span className={`num activity-kind ${kind.cls}`} title={kind.label} aria-label={kind.label}>
                    {kind.tag}
                  </span>
                  <span className="activity-content">
                    <span>{description}</span>
                    <span className="text-xs text-secondary">
                      {group ? `${group.name} · ` : ''}
                      {expense ? `${expenseAmountLabel(expense)} · ` : ''}
                      {formatTime(activity.date)}
                    </span>
                  </span>
                  {amount > 0 && (
                    <span className="activity-amount">
                      <span className={`num ${isPositive ? 'pos' : 'neg'}`}>
                        {isPositive ? '+' : '−'}{formatCurrency(amount, cur)}
                      </span>
                      <span className="text-xs text-secondary">
                        {isPayment
                          ? (isPositive ? 'received' : 'paid')
                          : (isPositive ? 'you lent' : 'you borrowed')}
                      </span>
                    </span>
                  )}
                </div>
              );
            })}
          </section>
        ))}

        {filtered.length === 0 && (
          <div className="empty-box">
            <span className="empty-box-title">No activity yet</span>
            <span className="text-secondary">Expenses and payments will show up here as they happen.</span>
          </div>
        )}
      </div>
    </div>
  );
}
