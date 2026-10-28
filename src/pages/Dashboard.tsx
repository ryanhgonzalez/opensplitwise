import { useMemo, useState } from 'react';
import { AnimatePresence } from 'framer-motion';
import { Link, useNavigate } from 'react-router-dom';
import Avatar from '../components/Avatar';
import GroupTile from '../components/GroupTile';
import BackupReminder from '../components/BackupReminder';
import SettleModal from '../components/SettleModal';
import RemindSheet from '../components/RemindSheet';
import TransferExplainer from '../components/TransferExplainer';
import { useStore, selectCurrentUser, selectMainCurrency, selectOverallBalances, selectRecentExpenses, selectGroupTotals } from '../store';
import { directDebts, groupTransfers, simplifies } from '../lib/calculations';
import { expenseAmountLabel, groupCurrency, recordCurrency } from '../lib/currency';
import { nextOccurrence } from '../lib/recurring';
import { lastReminder } from '../lib/reminder';
import { formatCurrency, formatDate, formatLedgerDate, formatRelativeDay, formatSigned, getNetAmountForUser } from '../utils';
import type { PaymentMethod, RecurringExpense } from '../types';
import './Dashboard.css';

/** One payment that would square up a group, with you on one side of it. */
interface ToSettle {
  groupId: string;
  from: string;
  to: string;
  amount: number;
  currency: string;
  /** Not a direct debt: simplifying sent it this way, so it gets a "Why?". */
  rerouted: boolean;
}

/** "€51.70 · $37.50": the currencies with something in them, or zero in the first. */
function amountsList(amounts: { amount: number; currency: string }[]): string {
  const some = amounts.filter((a) => a.amount >= 0.005);
  return (some.length ? some : amounts.slice(0, 1)).map((a) => formatCurrency(a.amount, a.currency)).join(' · ');
}

/** How many upcoming repeats Home lists. */
const COMING_UP = 4;

export default function Dashboard() {
  const navigate = useNavigate();
  const [settling, setSettling] = useState<ToSettle | null>(null);
  const [reminding, setReminding] = useState<ToSettle | null>(null);
  const [explaining, setExplaining] = useState<ToSettle | null>(null);

  const currentUser = useStore(selectCurrentUser)!;
  const balances = useStore(selectOverallBalances);
  const mainCurrency = useStore(selectMainCurrency);
  const recentExpenses = useStore(selectRecentExpenses(5));
  const groups = useStore((s) => s.groups);
  const users = useStore((s) => s.users);
  const expenses = useStore((s) => s.expenses);
  const payments = useStore((s) => s.settlements);
  const recurring = useStore((s) => s.recurring);
  const activities = useStore((s) => s.activities);
  const groupTotals = useStore(selectGroupTotals);
  const addSettlement = useStore((s) => s.addSettlement);

  const getUserById = (id: string) => users.find((u) => u.id === id);
  const getGroupById = (id?: string) => (id ? groups.find((g) => g.id === id) : undefined);
  // First name, unless someone else has the same one ("Frank" and "Frank Jr").
  const firstName = (id: string) => {
    const name = getUserById(id)?.name;
    if (!name) return 'Someone';
    const first = name.split(' ')[0];
    return users.filter((u) => u.name.split(' ')[0] === first).length > 1 ? name : first;
  };
  const balanceOf = (groupId: string) => groupTotals[groupId]?.yourBalance ?? 0;
  const myGroups = groups.filter((g) => g.members.some((m) => m.userId === currentUser.id));

  // One entry per currency with a balance. With none, show zero in the main currency.
  const shown = balances.length ? balances : [{ currency: mainCurrency, net: 0, totalOwed: 0, totalOwe: 0 }];
  const multiCurrency = shown.length > 1;
  const settled = balances.length === 0;
  const isPositive = shown[0].net > 0;
  const activeGroups = groups.filter((g) => Math.abs(balanceOf(g.id)) >= 0.005).length;
  const hour = new Date().getHours();
  const greeting = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';

  // The same payments each group suggests, kept to the ones you're part of.
  // Settling them group by group is what clears the balances shown above.
  const toSettle = useMemo<ToSettle[]>(() => {
    const rows = groups.flatMap((g) => {
      const memberIds = g.members.map((m) => m.userId);
      if (!memberIds.includes(currentUser.id)) return [];
      const groupExpenses = expenses.filter((e) => e.groupId === g.id);
      if (groupExpenses.length === 0) return [];
      const groupPayments = payments.filter((p) => p.groupId === g.id);
      const snapshot = { expenses: groupExpenses, memberIds, settlements: groupPayments };
      const direct = directDebts(snapshot);
      return groupTransfers(snapshot, simplifies(g))
        .filter((t) => t.from === currentUser.id || t.to === currentUser.id)
        .map((t) => ({
          ...t,
          groupId: g.id,
          currency: groupCurrency(g),
          rerouted: !direct.some((d) => d.from === t.from && d.to === t.to && Math.abs(d.amount - t.amount) < 0.005),
        }));
    });
    // Money coming to you first, then what you owe; largest first within each.
    return rows.sort((a, b) => Number(a.from === currentUser.id) - Number(b.from === currentUser.id) || b.amount - a.amount);
  }, [groups, expenses, payments, currentUser.id]);

  // The next repeat of each rule in your groups, soonest first. Today's has
  // already been added, so look from tomorrow.
  const comingUp = useMemo(() => {
    const now = new Date();
    const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
    const mine = new Set(myGroups.map((g) => g.id));
    return recurring
      .filter((r) => mine.has(r.groupId))
      .map((r) => ({ rule: r, date: nextOccurrence(r, tomorrow) }))
      .sort((a, b) => a.date.getTime() - b.date.getTime())
      .slice(0, COMING_UP);
  }, [recurring, myGroups]);

  /** "3 days ago" when you've reminded them since they last paid you. */
  const reminded = (personId: string): string | undefined => {
    const last = lastReminder(activities, personId);
    if (!last) return undefined;
    const paidSince = payments.some((p) => p.fromUserId === personId && p.toUserId === currentUser.id && p.date > last.date);
    return paidSince ? undefined : formatRelativeDay(last.date);
  };

  const confirmSettle = (amount: number, method: PaymentMethod) => {
    if (!settling) return;
    addSettlement({
      fromUserId: settling.from,
      toUserId: settling.to,
      amount,
      currency: settling.currency,
      groupId: settling.groupId,
      date: new Date(),
      paymentMethod: method,
    });
  };

  return (
    <div className="page-content">
      <div className="dash">
        <header className="dash-header">
          <div>
            <p className="text-secondary text-sm">{greeting}</p>
            <h1 className="dash-name">{currentUser.name}</h1>
          </div>
          <Link to="/settings" className="dash-account-btn" aria-label="Settings">
            <Avatar user={currentUser} size="lg" />
          </Link>
        </header>

        {/* Overall balance */}
        <section className="statement dash-statement" aria-label="Overall balance">
          <div>
            <span className="cap">
              {settled ? 'All settled up' : multiCurrency ? 'Overall balance' : isPositive ? 'Overall, you are owed' : 'Overall, you owe'}
            </span>
            <span className="dash-nets">
              {shown.map((b) => (
                <span
                  key={b.currency}
                  className={`num dash-net ${multiCurrency ? 'dash-net-multi' : ''} ${Math.abs(b.net) < 0.005 ? 'zero' : b.net > 0 ? 'pos' : 'neg'}`}
                >
                  {formatSigned(b.net, b.currency)}
                </span>
              ))}
            </span>
            {activeGroups > 0 && (
              <span className="text-xs text-secondary">
                across {activeGroups} {activeGroups === 1 ? 'group' : 'groups'}
              </span>
            )}
          </div>
          <div className="dash-statement-part">
            <span className="cap">Owed to you</span>
            <span className="num pos dash-part-amount">
              {amountsList(shown.map((b) => ({ amount: b.totalOwed, currency: b.currency })))}
            </span>
          </div>
          <div className="dash-statement-part">
            <span className="cap">You owe</span>
            <span className="num neg dash-part-amount">
              {amountsList(shown.map((b) => ({ amount: b.totalOwe, currency: b.currency })))}
            </span>
          </div>
        </section>

        <BackupReminder />

        <div className="dash-columns">
          <div className="dash-main">
            {/* Payments that would settle your part */}
            <section aria-labelledby="dash-settle-title">
              <div className="dash-section-head">
                <h2 id="dash-settle-title">To settle</h2>
                {toSettle.length > 0 && (
                  <span className="text-xs text-secondary">
                    {toSettle.length === 1 ? '1 payment squares' : `${toSettle.length} payments square`} everything
                  </span>
                )}
              </div>
              <div className="ruled">
                {toSettle.length === 0 ? (
                  <p className="dash-empty text-secondary">Nothing to settle. You're all square.</p>
                ) : (
                  toSettle.map((t) => {
                    const theyOwe = t.to === currentUser.id;
                    const other = theyOwe ? t.from : t.to;
                    const group = getGroupById(t.groupId);
                    return (
                      <div key={`${t.groupId}-${t.from}-${t.to}`} className="dash-settle">
                        <span className="dash-settle-info">
                          <span className="dash-settle-who">
                            {theyOwe ? `${firstName(other)} owes you` : `You owe ${firstName(other)}`}
                          </span>
                          <span className="dash-settle-meta">
                            <Link to={`/groups/${t.groupId}`} className="dash-settle-group">
                              {group?.name}
                            </Link>
                            {t.rerouted && (
                              <button className="dash-settle-why" onClick={() => setExplaining(t)}>
                                Why?
                              </button>
                            )}
                            {theyOwe && reminded(other) && (
                              <span className="dash-settle-reminded">Reminded {reminded(other)}</span>
                            )}
                          </span>
                        </span>
                        <span className={`num dash-settle-amount ${theyOwe ? 'pos' : 'neg'}`}>
                          {formatCurrency(t.amount, t.currency)}
                        </span>
                        <span className="dash-settle-actions">
                          {theyOwe && (
                            <button
                              className="btn btn-secondary btn-sm dash-remind"
                              onClick={() => setReminding(t)}
                            >
                              Remind
                            </button>
                          )}
                          <button
                            className={`btn btn-sm ${theyOwe ? 'btn-outline' : 'btn-primary'}`}
                            onClick={() => setSettling(t)}
                          >
                            {theyOwe ? (
                              <>
                                <span className="dash-wide-only">Mark received</span>
                                <span className="dash-narrow-only">Received</span>
                              </>
                            ) : (
                              'Pay'
                            )}
                          </button>
                        </span>
                      </div>
                    );
                  })
                )}
              </div>
            </section>

            {/* Repeats still to come: on phones, here; on desktop, in the side column */}
            {comingUp.length > 0 && (
              <ComingUp className="dash-narrow-only" items={comingUp} groupName={(id) => getGroupById(id)?.name ?? ''} />
            )}

            {/* Recent expenses */}
            {recentExpenses.length > 0 && (
              <section aria-labelledby="dash-recent-title">
                <div className="dash-section-head">
                  <h2 id="dash-recent-title">Recent</h2>
                  <Link to="/activity" className="dash-link">All activity</Link>
                </div>
                <div className="ruled">
                  {recentExpenses.map((expense) => {
                    const isPaidByMe = expense.paidBy === currentUser.id;
                    const net = getNetAmountForUser(expense, currentUser.id);
                    const group = getGroupById(expense.groupId);
                    return (
                      <Link
                        key={expense.id}
                        to={expense.groupId ? `/groups/${expense.groupId}/expenses/${expense.id}` : '/groups'}
                        className="dash-expense dash-expense-link"
                      >
                        <span className="num dash-expense-date" title={formatDate(expense.date)}>
                          {formatLedgerDate(expense.date)}
                        </span>
                        <span className="dash-expense-info">
                          <span className="dash-expense-desc">{expense.description}</span>
                          <span className="text-xs text-secondary">
                            {isPaidByMe ? 'You' : firstName(expense.paidBy)} {expense.refund ? 'got back' : 'paid'}{' '}
                            {expenseAmountLabel(expense)}
                            {group && <span className="dash-narrow-only"> · {group.name}</span>}
                          </span>
                        </span>
                        <span className="dash-expense-group">{group?.name ?? ''}</span>
                        <span className={`num dash-expense-share ${net > 0.005 ? 'pos' : net < -0.005 ? 'neg' : 'zero'}`}>
                          {formatSigned(net, recordCurrency(expense))}
                        </span>
                      </Link>
                    );
                  })}
                </div>
              </section>
            )}
            {/* Insights left the tab bar for Activity; this keeps it a tap away */}
            <Link to="/insights" className="dash-insights">
              <span className="dash-insights-text">
                <span className="dash-insights-title">Spending insights</span>
                <span className="text-xs text-secondary">Where the money went, by category and month</span>
              </span>
              <span aria-hidden className="dash-insights-arrow">→</span>
            </Link>
          </div>

          <aside className="dash-side">
            {comingUp.length > 0 && (
              <ComingUp items={comingUp} groupName={(id) => getGroupById(id)?.name ?? ''} />
            )}

            <section className="dash-groups" aria-labelledby="dash-groups-title">
              <div className="dash-section-head">
                <h2 id="dash-groups-title">Groups</h2>
                <Link to="/groups" className="dash-link">All groups</Link>
              </div>
              <div className="dash-group-list">
                {myGroups.map((group) => {
                  const bal = balanceOf(group.id);
                  const even = Math.abs(bal) < 0.005;
                  return (
                    <button
                      key={group.id}
                      className="dash-group"
                      onClick={() => navigate(`/groups/${group.id}`)}
                    >
                      <GroupTile group={group} size={36} />
                      <span className="dash-group-info">
                        <span className="dash-group-name">{group.name}</span>
                        <span className="dash-group-meta text-xs text-secondary">
                          {group.members.length} members · {groupCurrency(group)}
                        </span>
                      </span>
                      <span className={`${even ? '' : 'num'} dash-group-bal ${even ? 'zero' : bal > 0 ? 'pos' : 'neg'}`}>
                        {even ? 'settled' : formatSigned(bal, groupCurrency(group))}
                      </span>
                    </button>
                  );
                })}
              </div>
            </section>
          </aside>
        </div>
      </div>

      <AnimatePresence>
        {explaining && (
          <TransferExplainer
            groupId={explaining.groupId}
            transfer={explaining}
            showGroup
            onClose={() => setExplaining(null)}
          />
        )}
      </AnimatePresence>

      <AnimatePresence>
        {reminding && (
          <RemindSheet
            personId={reminding.from}
            amount={reminding.amount}
            currency={reminding.currency}
            groupIds={[reminding.groupId]}
            onClose={() => setReminding(null)}
          />
        )}
      </AnimatePresence>

      <AnimatePresence>
        {settling && (
          <SettleModal
            fromUserId={settling.from}
            toUserId={settling.to}
            amount={settling.amount}
            currency={settling.currency}
            groupLabel={getGroupById(settling.groupId)?.name}
            onClose={() => setSettling(null)}
            onConfirm={confirmSettle}
          />
        )}
      </AnimatePresence>
    </div>
  );
}

interface ComingUpProps {
  items: { rule: RecurringExpense; date: Date }[];
  groupName: (groupId: string) => string;
  className?: string;
}

function ComingUp({ items, groupName, className = '' }: ComingUpProps) {
  return (
    <section className={`dash-coming ${className}`} aria-labelledby={`dash-coming-${className || 'side'}`}>
      <div className="dash-section-head">
        <h2 id={`dash-coming-${className || 'side'}`}>Coming up</h2>
      </div>
      <div className="ruled">
        {items.map(({ rule, date }) => (
          <Link key={rule.id} to={`/groups/${rule.groupId}`} className="dash-expense dash-coming-row">
            <span className="num dash-expense-date">{formatLedgerDate(date)}</span>
            <span className="dash-expense-info">
              <span className="dash-expense-desc">
                {rule.template.description} <span className="text-secondary" title="Repeats">↻</span>
              </span>
              <span className="text-xs text-secondary">{groupName(rule.groupId)}</span>
            </span>
            <span className="num dash-coming-amount">{formatCurrency(rule.template.amount, recordCurrency(rule.template))}</span>
          </Link>
        ))}
      </div>
    </section>
  );
}
