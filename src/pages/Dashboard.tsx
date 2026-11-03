import { useMemo, useState } from 'react';
import { AnimatePresence } from 'framer-motion';
import { Link } from 'react-router-dom';
import Avatar from '../components/Avatar';
import GroupTile from '../components/GroupTile';
import BackupReminder from '../components/BackupReminder';
import SettleModal from '../components/SettleModal';
import RemindSheet from '../components/RemindSheet';
import { useStore, selectCurrentUser, selectOverallBalances } from '../store';
import { outstandingByGroup } from '../lib/calculations';
import { isListed } from '../lib/directGroups';
import { recordCurrency } from '../lib/currency';
import { nextOccurrence } from '../lib/recurring';
import { lastReminder } from '../lib/reminder';
import { formatCurrency, formatRelativeDay, formatSigned } from '../utils';
import type { Group, PaymentMethod, RecurringExpense } from '../types';
import { shortName } from '../utils/user';
import './Dashboard.css';

/** What's open between you and one person, across all your groups, in one currency. */
interface Between {
  userId: string;
  currency: string;
  /** Always positive; `theyOwe` says which way. */
  amount: number;
  theyOwe: boolean;
  /** The groups where they owe you (or you them): what a reminder is about. */
  groupIds: string[];
  /** Every group with something open between you, either way. */
  allGroupIds: string[];
}

/** "€51.70 · $37.50": the currencies with something in them, or zero in the first. */
function amountsList(amounts: { amount: number; currency: string }[]): string {
  const some = amounts.filter((a) => a.amount >= 0.005);
  return (some.length ? some : amounts.slice(0, 1)).map((a) => formatCurrency(a.amount, a.currency)).join(' · ');
}

/** How many upcoming repeats Home lists. */
const COMING_UP = 3;

/**
 * Home: what needs you. Who you pay, who you're waiting on (one line per person,
 * across every group), the next repeats, and a quick way to add to a group.
 * Everything else lives in Groups, People and Activity.
 */
export default function Dashboard() {
  const [settling, setSettling] = useState<Between | null>(null);
  const [reminding, setReminding] = useState<Between | null>(null);

  const currentUser = useStore(selectCurrentUser)!;
  const overall = useStore(selectOverallBalances);
  const groups = useStore((s) => s.groups);
  const users = useStore((s) => s.users);
  const expenses = useStore((s) => s.expenses);
  const payments = useStore((s) => s.settlements);
  const recurring = useStore((s) => s.recurring);
  const activities = useStore((s) => s.activities);
  const settleWithUser = useStore((s) => s.settleWithUser);

  const me = currentUser.id;
  const getUserById = (id: string) => users.find((u) => u.id === id);
  const getGroupById = (id?: string) => (id ? groups.find((g) => g.id === id) : undefined);
  const firstName = (id: string) => {
    if (id === me) return 'You';
    const name = getUserById(id)?.name;
    return name ? shortName(name, users.map((u) => u.name)) : 'Someone';
  };

  // Your groups, the one with the latest expense first. A group with none yet
  // counts from when it was made, so a new one comes first.
  const myGroups = useMemo(() => {
    const latest = new Map<string, number>();
    for (const e of expenses) {
      if (e.groupId) latest.set(e.groupId, Math.max(latest.get(e.groupId) ?? 0, e.date.getTime()));
    }
    const lastUsed = (g: Group) => latest.get(g.id) ?? g.createdAt.getTime();
    return groups
      .filter((g) => g.members.some((m) => m.userId === me))
      .sort((a, b) => lastUsed(b) - lastUsed(a));
  }, [groups, expenses, me]);

  // Each opens its group's Insights: named groups that aren't archived.
  const quickGroups = useMemo(() => myGroups.filter(isListed), [myGroups]);

  // One line per person and currency, the same balances People shows.
  const between = useMemo<Between[]>(() => {
    const groupsOf = (debtor: string, creditor: string, currency: string) =>
      outstandingByGroup(expenses, payments, debtor, creditor, currency, groups)
        .map((b) => b.groupId)
        .filter((id): id is string => !!id);
    const line = (userId: string, currency: string, amount: number, theyOwe: boolean): Between => {
      const owedToMe = groupsOf(userId, me, currency);
      const iOwe = groupsOf(me, userId, currency);
      return {
        userId,
        currency,
        amount,
        theyOwe,
        groupIds: theyOwe ? owedToMe : iOwe,
        allGroupIds: [...new Set([...(theyOwe ? owedToMe : iOwe), ...(theyOwe ? iOwe : owedToMe)])],
      };
    };
    return overall.flatMap((b) => [
      ...b.oweToFriend.map((f) => line(f.userId, b.currency, f.amount, false)),
      ...b.owedByFriend.map((f) => line(f.userId, b.currency, f.amount, true)),
    ]);
  }, [overall, expenses, payments, groups, me]);
  const youPay = between.filter((b) => !b.theyOwe).sort((a, b) => b.amount - a.amount);
  const waitingOn = between.filter((b) => b.theyOwe).sort((a, b) => b.amount - a.amount);
  const waitingPeople = new Set(waitingOn.map((b) => b.userId)).size;

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
    const paidSince = payments.some((p) => p.fromUserId === personId && p.toUserId === me && p.date > last.date);
    return paidSince ? undefined : formatRelativeDay(last.date);
  };

  /** "Flat", "Lisbon trip, Friends", "3 groups". */
  const groupsLabel = (ids: string[]) =>
    ids.length > 2 ? `${ids.length} groups` : ids.map((id) => getGroupById(id)?.name).filter(Boolean).join(', ');

  // The headline: where you stand overall.
  const settled = overall.length === 0;
  const multiCurrency = overall.length > 1;
  const net = overall[0]?.net ?? 0;
  const lastPayment = useMemo(
    () =>
      payments
        .filter((p) => p.fromUserId === me || p.toUserId === me)
        .reduce<(typeof payments)[number] | undefined>((a, p) => (!a || p.date > a.date ? p : a), undefined),
    [payments, me],
  );
  const lead = settled
    ? 'Nobody owes anything'
    : multiCurrency
      ? 'Overall'
      : net > 0
        ? "Overall, you're owed"
        : 'Overall, you owe';

  const hour = new Date().getHours();
  const greeting = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';

  const confirmSettle = (amount: number, method: PaymentMethod) => {
    if (!settling) return;
    settleWithUser({
      fromUserId: settling.theyOwe ? settling.userId : me,
      toUserId: settling.theyOwe ? me : settling.userId,
      amount,
      currency: settling.currency,
      date: new Date(),
      paymentMethod: method,
    });
  };

  const personRow = (b: Between) => {
    const user = getUserById(b.userId);
    const when = b.theyOwe ? reminded(b.userId) : undefined;
    const meta = [groupsLabel(b.allGroupIds), when && `reminded ${when}`].filter(Boolean).join(' · ');
    return (
      <div key={`${b.userId}-${b.currency}`} className="dash-person">
        <Link to={`/people/${b.userId}`} className="dash-person-link">
          {user && <Avatar user={user} size="md" />}
          <span className="dash-person-info">
            <span className="dash-person-name">{firstName(b.userId)}</span>
            {meta && <span className="dash-person-meta">{meta}</span>}
          </span>
        </Link>
        <span className={`num dash-person-amount ${b.theyOwe ? 'pos' : 'neg'}`}>{formatCurrency(b.amount, b.currency)}</span>
        {b.theyOwe ? (
          <button className="btn btn-secondary btn-sm" onClick={() => setReminding(b)}>
            Remind
          </button>
        ) : (
          <button className="btn btn-primary btn-sm" onClick={() => setSettling(b)}>
            Pay
          </button>
        )}
      </div>
    );
  };

  return (
    <div className="page-content">
      <div className="dash">
        <header className="dash-header">
          <h1 className="dash-greeting">
            {greeting}, {currentUser.name.split(' ')[0]}
          </h1>
          <Link to="/scan" state={{ from: '/' }} className="dash-scan-btn">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden>
              <path
                d="M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3M4 12h16"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
              />
            </svg>
            Scan
          </Link>
          <Link to="/settings" className="dash-account-btn" aria-label="Settings">
            <Avatar user={currentUser} size="lg" />
          </Link>
        </header>

        <BackupReminder />

        {/* Where you stand */}
        <section className="dash-standing" aria-label="Overall balance">
          <p className="dash-standing-lead">{lead}</p>
          {settled ? (
            <p className="dash-standing-figure even">All settled up</p>
          ) : (
            <p className="dash-standing-figures">
              {overall.map((b) => (
                <span
                  key={b.currency}
                  className={`num dash-standing-figure ${multiCurrency ? 'multi' : ''} ${b.net > 0 ? 'pos' : b.net < 0 ? 'neg' : ''}`}
                >
                  {multiCurrency ? formatSigned(b.net, b.currency) : formatCurrency(Math.abs(b.net), b.currency)}
                </span>
              ))}
            </p>
          )}
          <p className="dash-standing-sub">
            {settled
              ? lastPayment
                ? `Last payment: ${firstName(lastPayment.fromUserId)} paid ${lastPayment.toUserId === me ? 'you' : firstName(lastPayment.toUserId)} ${formatCurrency(lastPayment.amount, recordCurrency(lastPayment))}, ${lastPayment.date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`
                : myGroups.length
                  ? 'Add an expense to a group to get started.'
                  : 'Make a group, add who you share costs with, and start adding expenses.'
              : [
                  overall.some((b) => b.totalOwed >= 0.005) &&
                    `${amountsList(overall.map((b) => ({ amount: b.totalOwed, currency: b.currency })))} coming in`,
                  overall.some((b) => b.totalOwe >= 0.005) &&
                    `${amountsList(overall.map((b) => ({ amount: b.totalOwe, currency: b.currency })))} going out`,
                ]
                  .filter(Boolean)
                  .join(' · ')}
          </p>
          {myGroups.length === 0 && (
            <Link to="/groups" className="btn btn-primary dash-first-group">
              Make your first group
            </Link>
          )}
        </section>

        <div className="dash-columns">
          <div className="dash-main">
            {youPay.length > 0 && (
              <section aria-labelledby="dash-pay-title">
                <div className="dash-section-head">
                  <h2 id="dash-pay-title" className="cap">You pay</h2>
                </div>
                <div className="ruled">{youPay.map(personRow)}</div>
              </section>
            )}

            {waitingOn.length > 0 && (
              <section aria-labelledby="dash-waiting-title">
                <div className="dash-section-head">
                  <h2 id="dash-waiting-title" className="cap">Waiting on</h2>
                  <span className="text-xs text-secondary">
                    {waitingPeople} {waitingPeople === 1 ? 'person' : 'people'}
                  </span>
                </div>
                <div className="ruled">{waitingOn.map(personRow)}</div>
                <p className="dash-hint">One line per person, across all your groups. Tap someone to mark it received.</p>
              </section>
            )}
          </div>

          {(comingUp.length > 0 || quickGroups.length > 0) && (
            <aside className="dash-side">
              {comingUp.length > 0 && (
                <ComingUp items={comingUp} groupName={(id) => getGroupById(id)?.name ?? ''} />
              )}

              {quickGroups.length > 0 && (
                <section aria-labelledby="dash-add-title">
                  <div className="dash-section-head">
                    <h2 id="dash-add-title" className="cap">Insights</h2>
                  </div>
                  <div className="dash-quick-add">
                    {quickGroups.map((g) => (
                      <Link
                        key={g.id}
                        to={`/insights?group=${g.id}`}
                        className="dash-quick"
                        aria-label={`Insights for ${g.name}`}
                      >
                        <GroupTile group={g} size={30} />
                        <span className="dash-quick-name">{g.name}</span>
                        <svg className="dash-quick-go" width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden>
                          <path d="M9 6l6 6-6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                      </Link>
                    ))}
                  </div>
                </section>
              )}
            </aside>
          )}
        </div>
      </div>

      <AnimatePresence>
        {reminding && (
          <RemindSheet
            personId={reminding.userId}
            amount={reminding.amount}
            currency={reminding.currency}
            groupIds={reminding.groupIds}
            onClose={() => setReminding(null)}
          />
        )}
      </AnimatePresence>

      <AnimatePresence>
        {settling && (
          <SettleModal
            fromUserId={settling.theyOwe ? settling.userId : me}
            toUserId={settling.theyOwe ? me : settling.userId}
            amount={settling.amount}
            currency={settling.currency}
            groupLabel={settling.allGroupIds.length ? groupsLabel(settling.allGroupIds) : undefined}
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
}

function ComingUp({ items, groupName }: ComingUpProps) {
  return (
    <section aria-labelledby="dash-coming-title">
      <div className="dash-section-head">
        <h2 id="dash-coming-title" className="cap">Coming up</h2>
      </div>
      <div className="dash-coming">
        {items.map(({ rule, date }) => (
          <Link key={rule.id} to={`/groups/${rule.groupId}`} className="dash-coming-row">
            <span className="dash-coming-icon" aria-hidden>↻</span>
            <span className="dash-coming-text">
              <span className="dash-coming-name">{rule.template.description}</span>{' '}
              <span className="text-secondary">
                repeats {date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} · {groupName(rule.groupId)}
              </span>
            </span>
            <span className="num">{formatCurrency(rule.template.amount, recordCurrency(rule.template))}</span>
          </Link>
        ))}
      </div>
    </section>
  );
}
