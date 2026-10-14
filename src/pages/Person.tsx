import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { AnimatePresence } from 'framer-motion';
import { useStore, selectCurrentUser, selectFriendBalancesByCurrency } from '../store';
import Avatar from '../components/Avatar';
import GroupTile from '../components/GroupTile';
import PersonSheet from '../components/PersonSheet';
import SettleModal, { type SettleMode } from '../components/SettleModal';
import { moneySign, outstandingByGroup } from '../lib/calculations';
import { groupCurrency, recordCurrency } from '../lib/currency';
import { formatCurrency, formatDate, formatLedgerDate, formatSigned } from '../utils';
import type { PaymentMethod } from '../types';
import './Person.css';

const PAYMENT_METHOD_LABELS: Record<PaymentMethod, string> = {
  venmo: 'Venmo',
  cashapp: 'Cash App',
  zelle: 'Zelle',
  cash: 'Cash',
  other: 'Other',
};

/** History rows listed before "Show older". */
const HISTORY_SHOWN = 15;

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

  const [editing, setEditing] = useState(false);
  const [settling, setSettling] = useState<{ currency: string; amount: number; theyOwe: boolean; mode: SettleMode } | null>(null);
  const [showAllHistory, setShowAllHistory] = useState(false);

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
        const theyOwe = inGroup(outstandingByGroup(expenses, payments, id, me, currency));
        const iOwe = inGroup(outstandingByGroup(expenses, payments, me, id, currency));
        return { group: g, currency, net: theyOwe - iOwe };
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
        .map((p) => p.group.name),
    }));

  // Expenses one of you paid with the other in the split, and payments between you.
  const history = useMemo<HistoryRow[]>(() => {
    const groupName = (gid?: string) => groups.find((g) => g.id === gid)?.name;
    const shareOf = (e: (typeof expenses)[number], uid: string) =>
      e.split.entries.find((en) => en.userId === uid)?.amount ?? 0;
    const rows: HistoryRow[] = [];
    for (const e of expenses) {
      const theyPaid = e.paidBy === id && e.split.entries.some((en) => en.userId === me);
      const iPaid = e.paidBy === me && e.split.entries.some((en) => en.userId === id);
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
  // With one currency the header's buttons act on it; with several, each row has its own.
  const single = between.length === 1 ? between[0] : undefined;

  const openSettle = (b: { currency: string; amount: number }, mode: SettleMode) =>
    setSettling({ currency: b.currency, amount: Math.abs(b.amount), theyOwe: b.amount > 0, mode });

  const confirmSettle = (amount: number, method: PaymentMethod) => {
    if (!settling || settling.mode === 'remind') return;
    settleWithUser({
      fromUserId: settling.theyOwe ? id : me,
      toUserId: settling.theyOwe ? me : id,
      amount,
      currency: settling.currency,
      date: new Date(),
      paymentMethod: method,
    });
  };

  const actions = (b: { currency: string; amount: number }, small = false) => (
    <>
      {b.amount > 0 && (
        <button className={`btn btn-secondary ${small ? 'btn-sm' : ''}`} onClick={() => openSettle(b, 'remind')}>
          Remind
        </button>
      )}
      <button className={`btn btn-primary ${small ? 'btn-sm' : ''}`} onClick={() => openSettle(b, 'settle')}>
        Settle up
      </button>
    </>
  );

  return (
    <div className="page-content">
      <div className="person-page">
        <header className="person-header">
          <div className="person-title-block">
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
            </div>
          </div>
          <div className="person-header-actions">
            <button className="btn btn-secondary" onClick={() => setEditing(true)}>Edit</button>
            {single && actions(single)}
          </div>
        </header>

        <div className="person-columns">
          <div className="person-col">
            <section aria-labelledby="person-between">
              <h2 id="person-between" className="cap person-label">Between you</h2>
              <div className="person-between">
                {between.length === 0 ? (
                  <p className="person-settled">You and {firstName} are settled up.</p>
                ) : (
                  between.map((b) => (
                    <div key={b.currency} className="person-between-row">
                      <span className="person-between-text">
                        <span className="person-between-who">
                          {b.amount > 0 ? `${firstName} owes you` : `You owe ${firstName}`}
                        </span>
                        {b.groups.length > 0 && <span className="text-xs text-secondary">{b.groups.join(', ')}</span>}
                      </span>
                      <span className={`num person-between-amount ${signClass(b.amount)}`}>
                        {formatCurrency(Math.abs(b.amount), b.currency)}
                      </span>
                      {!single && <span className="person-row-actions">{actions(b, true)}</span>}
                    </div>
                  ))
                )}
              </div>
              {between.length > 0 && (
                <p className="text-xs text-secondary person-note">
                  Settle up records a payment {between.length > 1 ? 'in one currency at a time' : 'either way'}. It's
                  spread across the groups the balance sits in.
                </p>
              )}
            </section>

            {perGroup.length > 0 && (
              <section aria-labelledby="person-groups">
                <h2 id="person-groups" className="cap person-label">Groups together</h2>
                <div className="ruled">
                  {perGroup.map(({ group, currency, net }) => (
                    <Link key={group.id} to={`/groups/${group.id}`} className="person-group">
                      <GroupTile group={group} size={32} />
                      <span className="person-group-name">{group.name}</span>
                      <span className={`person-group-bal ${Math.abs(net) < 0.005 ? 'zero' : `num ${signClass(net)}`}`}>
                        {Math.abs(net) < 0.005 ? 'settled' : formatSigned(net, currency)}
                      </span>
                    </Link>
                  ))}
                </div>
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
                Show older ({history.length - shownHistory.length})
              </button>
            )}
          </section>
        </div>
      </div>

      <AnimatePresence>
        {editing && <PersonSheet open={editing} onClose={() => setEditing(false)} userId={id} />}
      </AnimatePresence>

      <AnimatePresence>
        {settling && (
          <SettleModal
            fromUserId={settling.theyOwe ? id : me}
            toUserId={settling.theyOwe ? me : id}
            amount={settling.amount}
            currency={settling.currency}
            mode={settling.mode}
            onClose={() => setSettling(null)}
            onConfirm={confirmSettle}
          />
        )}
      </AnimatePresence>
    </div>
  );
}
