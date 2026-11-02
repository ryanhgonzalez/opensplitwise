import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { AnimatePresence } from 'framer-motion';
import { useStore, selectCurrentUser, selectFriendBalancesByCurrency } from '../store';
import Avatar from '../components/Avatar';
import GroupTile from '../components/GroupTile';
import PersonSheet from '../components/PersonSheet';
import SettleModal from '../components/SettleModal';
import RemindSheet from '../components/RemindSheet';
import TransferExplainer from '../components/TransferExplainer';
import { directDebts, moneySign, outstandingByGroup, type SettlementTransaction } from '../lib/calculations';
import { groupCurrency, recordCurrency } from '../lib/currency';
import { lastReminder } from '../lib/reminder';
import { formatCurrency, formatDate, formatLedgerDate, formatRelativeDay, formatSigned } from '../utils';
import type { PaymentMethod } from '../types';
import './Person.css';

const PAYMENT_METHOD_LABELS: Record<PaymentMethod, string> = {
  venmo: 'Venmo',
  cashapp: 'Cash App',
  zelle: 'Zelle',
  cash: 'Cash',
  other: 'Other',
};

/** History rows listed before "Show all". */
const HISTORY_SHOWN = 5;

const signClass = (n: number) => (Math.abs(n) < 0.005 ? 'zero' : n > 0 ? 'pos' : 'neg');

interface HistoryRow {
  id: string;
  /** For an expense: its page. */
  to?: string;
  date: Date;
  title: string;
  meta: string;
  /** Positive: it moved money your way. Payments are shown unsigned. */
  amount: number;
  currency: string;
  payment: boolean;
}

/** A history row: a link to the expense, or plain for a payment. */
function HistoryLine({ to, children }: { to?: string; children: React.ReactNode }) {
  return to ? (
    <Link to={to} className="person-history-row person-history-link">{children}</Link>
  ) : (
    <div className="person-history-row">{children}</div>
  );
}

export default function Person() {
  const { id = '' } = useParams<{ id: string }>();
  const navigate = useNavigate();

  const currentUser = useStore(selectCurrentUser)!;
  const users = useStore((s) => s.users);
  const groups = useStore((s) => s.groups);
  const expenses = useStore((s) => s.expenses);
  const payments = useStore((s) => s.settlements);
  const byCurrency = useStore(selectFriendBalancesByCurrency);
  const settleWithUser = useStore((s) => s.settleWithUser);
  const activities = useStore((s) => s.activities);

  const [editing, setEditing] = useState(false);
  const [settling, setSettling] = useState<{ currency: string; amount: number; theyOwe: boolean } | null>(null);
  const [reminding, setReminding] = useState<{ currency: string; amount: number; groupIds: string[] } | null>(null);
  const [showAllHistory, setShowAllHistory] = useState(false);
  const [explaining, setExplaining] = useState<{ groupId: string; transfer: SettlementTransaction } | null>(null);

  const person = users.find((u) => u.id === id);
  const me = currentUser.id;

  // Deleted (from Edit) or never existed: back to the list.
  useEffect(() => {
    if (!person || id === me) navigate(id === me ? '/settings' : '/people', { replace: true });
  }, [person, id, me, navigate]);

  const sharedGroups = useMemo(
    () => groups.filter((g) => g.members.some((m) => m.userId === id) && g.members.some((m) => m.userId === me)),
    [groups, id, me],
  );

  // What's between you in each shared group, in its currency. Positive: they owe you.
  const perGroup = useMemo(
    () =>
      sharedGroups.map((g) => {
        const currency = groupCurrency(g);
        const inGroup = (buckets: { groupId?: string; outstanding: number }[]) =>
          buckets.find((b) => b.groupId === g.id)?.outstanding ?? 0;
        const theyOwe = inGroup(outstandingByGroup(expenses, payments, id, me, currency, [g]));
        const iOwe = inGroup(outstandingByGroup(expenses, payments, me, id, currency, [g]));
        const net = theyOwe - iOwe;
        // The group's suggested payment between you two, if there is one.
        const transfer: SettlementTransaction | undefined =
          Math.abs(net) < 0.005 ? undefined : { from: net > 0 ? id : me, to: net > 0 ? me : id, amount: Math.abs(net) };
        // Rerouted when it isn't simply what one of you owes the other directly.
        const rerouted =
          !!transfer &&
          !directDebts({
            expenses: expenses.filter((e) => e.groupId === g.id),
            settlements: payments.filter((p) => p.groupId === g.id),
            memberIds: [],
          }).some((d) => d.from === transfer.from && d.to === transfer.to && Math.abs(d.amount - transfer.amount) < 0.005);
        return { group: g, currency, net, transfer, rerouted };
      }),
    [sharedGroups, expenses, payments, id, me],
  );

  // The overall balance, one row per currency, with the groups it sits in.
  const between = Object.entries(byCurrency)
    .map(([currency, balances]) => ({ currency, amount: balances[id] ?? 0 }))
    .filter((b) => Math.abs(b.amount) >= 0.005)
    .sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount))
    .map((b) => ({
      ...b,
      groups: perGroup
        .filter((p) => p.currency === b.currency && Math.abs(p.net) >= 0.005 && Math.sign(p.net) === Math.sign(b.amount))
        .map((p) => p.group),
    }));

  // Expenses one of you paid with the other in the split, and payments between you.
  const history = useMemo<HistoryRow[]>(() => {
    const groupName = (gid?: string) => groups.find((g) => g.id === gid)?.name;
    const shareOf = (e: (typeof expenses)[number], uid: string) =>
      e.split.entries.find((en) => en.userId === uid)?.amount ?? 0;
    const rows: HistoryRow[] = [];
    for (const e of expenses) {
      // Only expenses that moved money between you: a $0 share in the split doesn't count.
      const theyPaid = e.paidBy === id && shareOf(e, me) > 0;
      const iPaid = e.paidBy === me && shareOf(e, id) > 0;
      if (!theyPaid && !iPaid) continue;
      rows.push({
        id: e.id,
        to: e.groupId ? `/groups/${e.groupId}/expenses/${e.id}` : undefined,
        date: e.date,
        title: e.refund ? `Refund: ${e.description}` : e.description,
        meta: [
          `${theyPaid ? person?.name.split(' ')[0] : 'You'} ${e.refund ? 'got back' : 'paid'}`,
          groupName(e.groupId),
        ].filter(Boolean).join(' · '),
        // A refund runs the other way.
        amount: moneySign(e) * (theyPaid ? -shareOf(e, me) : shareOf(e, id)),
        currency: recordCurrency(e),
        payment: false,
      });
    }
    for (const p of payments) {
      const toMe = p.fromUserId === id && p.toUserId === me;
      const fromMe = p.fromUserId === me && p.toUserId === id;
      if (!toMe && !fromMe) continue;
      rows.push({
        id: p.id,
        date: p.date,
        title: toMe ? `${person?.name.split(' ')[0]} paid you` : `You paid ${person?.name.split(' ')[0]}`,
        meta: [p.paymentMethod && PAYMENT_METHOD_LABELS[p.paymentMethod], groupName(p.groupId)].filter(Boolean).join(' · '),
        amount: p.amount,
        currency: recordCurrency(p),
        payment: true,
      });
    }
    return rows.sort((a, b) => b.date.getTime() - a.date.getTime());
  }, [expenses, payments, groups, id, me, person?.name]);

  if (!person) return null;

  const firstName = person.name.split(' ')[0];
  const shownHistory = showAllHistory ? history : history.slice(0, HISTORY_SHOWN);

  const openSettle = (b: { currency: string; amount: number }) =>
    setSettling({ currency: b.currency, amount: Math.abs(b.amount), theyOwe: b.amount > 0 });

  // The last reminder, unless they've paid you since.
  const reminder = lastReminder(activities, id);
  const remindedLine =
    reminder && !payments.some((p) => p.fromUserId === id && p.toUserId === me && p.date > reminder.date)
      ? `Last reminded ${formatRelativeDay(reminder.date)}${reminder.via === 'text' ? ' by text' : ''}`
      : undefined;

  const confirmSettle = (amount: number, method: PaymentMethod) => {
    if (!settling) return;
    settleWithUser({
      fromUserId: settling.theyOwe ? id : me,
      toUserId: settling.theyOwe ? me : id,
      amount,
      currency: settling.currency,
      date: new Date(),
      paymentMethod: method,
    });
  };

  const actions = (b: (typeof between)[number]) => (
    <div className="person-actions">
      {b.amount > 0 && (
        <button
          className="btn btn-secondary"
          onClick={() => setReminding({ currency: b.currency, amount: b.amount, groupIds: b.groups.map((g) => g.id) })}
        >
          Remind
        </button>
      )}
      <button className="btn btn-primary" onClick={() => openSettle(b)}>
        Settle up
      </button>
    </div>
  );

  // Groups with something open between you; when they run both ways, settling up clears them all.
  const openGroups = perGroup.filter((p) => Math.abs(p.net) >= 0.005);
  const runsBothWays = openGroups.some((p) => p.net > 0) && openGroups.some((p) => p.net < 0);

  return (
    <div className="page-content">
      <div className="person-page">
        <header className="person-header">
          <Link to="/people" className="person-crumb">People /</Link>
          <div className="person-title-row">
            <Avatar user={person} size="lg" />
            <span className="person-title-text">
              <h1 className="person-name">{person.name}</h1>
              <span className="text-sm text-secondary">
                {sharedGroups.length === 0
                  ? 'No groups with you'
                  : `In ${sharedGroups.length} ${sharedGroups.length === 1 ? 'group' : 'groups'} with you`}
              </span>
            </span>
            <button className="person-edit" onClick={() => setEditing(true)} aria-label={`Edit ${firstName}`}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden>
                <path d="M4 20h4L19 9l-4-4L4 16v4z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
              </svg>
            </button>
          </div>
        </header>

        <div className="person-columns">
          <div className="person-col">
            {/* Where you stand with them */}
            <section className="person-standing" aria-label="Between you">
              {between.length === 0 ? (
                <>
                  <p className="person-standing-lead">Nothing between you</p>
                  <p className="person-standing-figure even">Settled up</p>
                </>
              ) : (
                between.map((b) => (
                  <div key={b.currency} className="person-standing-block">
                    <p className="person-standing-lead">{b.amount > 0 ? `${firstName} owes you` : `You owe ${firstName}`}</p>
                    <p className={`num person-standing-figure ${between.length > 1 ? 'multi' : ''} ${signClass(b.amount)}`}>
                      {formatCurrency(Math.abs(b.amount), b.currency)}
                    </p>
                    {actions(b)}
                  </div>
                ))
              )}
              {remindedLine && between.some((b) => b.amount > 0) && (
                <p className="person-note">{remindedLine}</p>
              )}
            </section>

            {perGroup.length > 0 && (
              <section aria-labelledby="person-groups">
                <h2 id="person-groups" className="cap person-label">By group</h2>
                <div className="ruled">
                  {perGroup.map(({ group, currency, net, transfer, rerouted }) => {
                    const settled = Math.abs(net) < 0.005;
                    return (
                      <div key={group.id} className="person-group">
                        <Link to={`/groups/${group.id}`} className="person-group-link">
                          <GroupTile group={group} size={32} />
                          <span className="person-group-text">
                            <span className="person-group-name">{group.name}</span>
                            <span className="person-group-sub">
                              {settled ? 'Settled' : net > 0 ? `${firstName} owes you` : `You owe ${firstName}`}
                            </span>
                          </span>
                        </Link>
                        {rerouted && transfer && (
                          <button
                            className="person-why"
                            onClick={() => setExplaining({ groupId: group.id, transfer })}
                            aria-label={`Why, in ${group.name}?`}
                          >
                            Why?
                          </button>
                        )}
                        <span className={`person-group-bal ${settled ? 'zero' : `num ${signClass(net)}`}`}>
                          {settled ? '' : formatCurrency(Math.abs(net), currency)}
                        </span>
                      </div>
                    );
                  })}
                </div>
                {runsBothWays && (
                  <p className="person-note">
                    Settling up clears {openGroups.length === 2 ? 'both groups' : `all ${openGroups.length} groups`}.
                  </p>
                )}
              </section>
            )}
          </div>

          <section className="person-col" aria-labelledby="person-history">
            <h2 id="person-history" className="cap person-label">History together</h2>
            {history.length === 0 ? (
              <p className="person-settled">Nothing yet.</p>
            ) : (
              <div className="ruled">
                {shownHistory.map((r) => (
                  <HistoryLine key={r.id} to={r.to}>
                    <span className="num person-history-date" title={formatDate(r.date)}>{formatLedgerDate(r.date)}</span>
                    <span className="person-history-info">
                      <span className="person-history-title">{r.title}</span>
                      {r.meta && <span className="text-xs text-secondary">{r.meta}</span>}
                    </span>
                    <span className={`num person-history-amount ${r.payment ? '' : signClass(r.amount)}`}>
                      {r.payment ? formatCurrency(r.amount, r.currency) : formatSigned(r.amount, r.currency)}
                    </span>
                  </HistoryLine>
                ))}
              </div>
            )}
            {history.length > shownHistory.length && (
              <button className="person-more" onClick={() => setShowAllHistory(true)}>
                Show all {history.length}
              </button>
            )}
          </section>
        </div>
      </div>

      <AnimatePresence>
        {editing && <PersonSheet open={editing} onClose={() => setEditing(false)} userId={id} />}
      </AnimatePresence>

      <AnimatePresence>
        {explaining && (
          <TransferExplainer
            groupId={explaining.groupId}
            transfer={explaining.transfer}
            showGroup
            onClose={() => setExplaining(null)}
          />
        )}
      </AnimatePresence>

      <AnimatePresence>
        {reminding && (
          <RemindSheet
            personId={id}
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
            fromUserId={settling.theyOwe ? id : me}
            toUserId={settling.theyOwe ? me : id}
            amount={settling.amount}
            currency={settling.currency}
            onClose={() => setSettling(null)}
            onConfirm={confirmSettle}
          />
        )}
      </AnimatePresence>
    </div>
  );
}
