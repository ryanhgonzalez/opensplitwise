import { useMemo, useState, useEffect, useRef, type ReactNode } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { AnimatePresence, motion } from 'framer-motion';
import { useStore, selectCurrentUser, selectTotalsForGroup } from '../store';
import {
  calculateBalances,
  groupTransfers,
  directDebts,
  isSimplified,
  simplifies,
  moneySign,
  round,
  signedAmount,
  type SettlementTransaction,
} from '../lib/calculations';
import { EMPTY_FILTER, categoryOptions, filterExpenses, isFilterActive, type ExpenseFilter } from '../lib/expenseFilter';
import { formatCurrency, formatDate, formatLedgerDate, formatRelativeDay, formatSigned, getNetAmountForUser } from '../utils';
import { shortName } from '../utils/user';
import '../styles/sheet.css';
import { categoryLabel } from '../lib/categories';
import { PAYMENT_METHOD_LABELS } from '../types';
import type { PaymentMethod } from '../types';
import Avatar from '../components/Avatar';
import GroupTile from '../components/GroupTile';
import AddExpenseSheet from '../components/AddExpenseSheet';
import EditGroupSheet from '../components/EditGroupSheet';
import ReceiptViewer from '../components/ReceiptViewer';
import { showToast } from '../lib/toast';
import { FREQUENCY_LABELS, nextOccurrence, ruleIdOf } from '../lib/recurring';
import PersonSheet from '../components/PersonSheet';
import ExpenseFilterBar from '../components/ExpenseFilterBar';
import SettleModal from '../components/SettleModal';
import { useGroupReport } from '../components/useGroupReport';
import TransferExplainer from '../components/TransferExplainer';
import { expenseAmountLabel, groupCurrency } from '../lib/currency';
import { directOther } from '../lib/directGroups';
import { swapTag, useRecentSwap } from '../lib/recentSwap';
import './GroupDetail.css';

/** Expenses listed before "Show all". */
const EXPENSES_SHOWN = 10;

const signClass = (n: number) => (Math.abs(n) < 0.005 ? 'zero' : n > 0 ? 'pos' : 'neg');

const RECEIPT_ICON = (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden>
    <path d="M6 3h12v18l-3-2-3 2-3-2-3 2V3z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
    <path d="M9 8h6M9 12h6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
  </svg>
);

const REPORT_ICON = (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden>
    <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
    <path d="M14 3v5h5M12 11v6M9.5 14.5L12 17l2.5-2.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

const SWAP_ICON = (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden>
    <path d="M4 8h13l-3.5-3.5M20 16H7l3.5 3.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

const ARCHIVE_ICON = (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden>
    <rect x="3" y="4" width="18" height="4" rx="1" stroke="currentColor" strokeWidth="1.8" />
    <path d="M5 8v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8M10 12h4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
  </svg>
);

const DOTS_ICON = (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden>
    <circle cx="5" cy="12" r="1.7" fill="currentColor" />
    <circle cx="12" cy="12" r="1.7" fill="currentColor" />
    <circle cx="19" cy="12" r="1.7" fill="currentColor" />
  </svg>
);

/** "Ben", "Ben and Carla", "Ben, Carla and Dana", "4 people". */
function joinNames(names: string[]): string {
  if (names.length > 3) return `${names.length} people`;
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

interface MenuItem {
  label: string;
  icon: ReactNode;
  onSelect: () => void;
  disabled?: boolean;
}

/** The "⋯" button: the group's less-used actions, in a small list under it. */
function MoreMenu({ items, className }: { items: MenuItem[]; className: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('pointerdown', away);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('pointerdown', away);
      document.removeEventListener('keydown', esc);
    };
  }, [open]);

  return (
    <div className="gd-menu" ref={ref}>
      <button
        className={className}
        onClick={() => setOpen(v => !v)}
        aria-label="More actions"
        aria-haspopup="menu"
        aria-expanded={open}
      >
        {DOTS_ICON}
      </button>
      {open && (
        <div className="gd-menu-list" role="menu">
          {items.map(item => (
            <button
              key={item.label}
              role="menuitem"
              className="gd-menu-item"
              disabled={item.disabled}
              onClick={() => { setOpen(false); item.onSelect(); }}
            >
              {item.icon}
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export default function GroupDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();

  const [showAddExpense, setShowAddExpense] = useState(false);
  const [showEditGroup, setShowEditGroup] = useState(false);
  const [viewingReceipt, setViewingReceipt] = useState<{ id: string; title: string } | null>(null);
  const [selectedMemberId, setSelectedMemberId] = useState<string | null>(null);
  const [settling, setSettling] = useState<{ from: string; to: string; amount: number } | null>(null);
  const [explaining, setExplaining] = useState<SettlementTransaction | null>(null);
  const [undoPaymentId, setUndoPaymentId] = useState<string | null>(null);
  const [expenseFilter, setExpenseFilter] = useState<ExpenseFilter>(EMPTY_FILTER);
  const [showAllExpenses, setShowAllExpenses] = useState(false);
  const [showPayments, setShowPayments] = useState(false);
  const [showRepeating, setShowRepeating] = useState(false);
  const [showEveryone, setShowEveryone] = useState(false);
  const { downloadReport, makingId } = useGroupReport();

  const users = useStore(s => s.users);
  const groups = useStore(s => s.groups);
  const allExpenses = useStore(s => s.expenses);
  const allSettlements = useStore(s => s.settlements);
  const allRecurring = useStore(s => s.recurring);
  const stopRecurring = useStore(s => s.stopRecurring);
  const [stoppingId, setStoppingId] = useState<string | null>(null);
  const groupRecurring = useMemo(() => allRecurring.filter(r => r.groupId === id), [allRecurring, id]);
  const addSettlement = useStore(s => s.addSettlement);
  const deleteSettlement = useStore(s => s.deleteSettlement);
  const setGroupArchived = useStore(s => s.setGroupArchived);
  const activities = useStore(s => s.activities);
  const recentSwap = useRecentSwap();
  const currentUser = useStore(selectCurrentUser)!;
  const { totalSpent } = useStore(selectTotalsForGroup(id ?? ''));

  const group = useMemo(() => groups.find(g => g.id === id), [groups, id]);
  // Every amount in a group is in its currency.
  const cur = groupCurrency(group);
  const expenses = useMemo(
    () => allExpenses.filter(e => e.groupId === id),
    [allExpenses, id],
  );
  const groupSettlements = useMemo(
    () => allSettlements.filter(s => s.groupId === id),
    [allSettlements, id],
  );
  const sortedExpenses = useMemo(
    () => [...expenses].sort((a, b) => b.date.getTime() - a.date.getTime()),
    [expenses],
  );
  // Only the list below is filtered. Balances, totals and suggested transfers
  // are group truth and keep using the full `expenses` set — narrowing the view
  // must never look like money moved.
  const visibleExpenses = useMemo(
    () => filterExpenses(
      sortedExpenses,
      expenseFilter,
      (uid) => users.find(u => u.id === uid)?.name ?? '',
      undefined,
      (category) => categoryLabel(category, group),
    ),
    [sortedExpenses, expenseFilter, users, group],
  );
  const filtering = isFilterActive(expenseFilter);
  // The latest few until asked for all; a search or filter always shows every match.
  const shownExpenses = filtering || showAllExpenses ? visibleExpenses : visibleExpenses.slice(0, EXPENSES_SHOWN);
  const hiddenCount = visibleExpenses.length - shownExpenses.length;
  // Offered from every expense in the group, not just the visible ones, so a
  // chosen category doesn't vanish from the row as the other filters narrow.
  const expenseCategories = useMemo(
    () => categoryOptions(expenses, (category) => categoryLabel(category, group)),
    [expenses, group],
  );
  const sortedPayments = useMemo(
    () => [...groupSettlements].sort((a, b) => b.date.getTime() - a.date.getTime()),
    [groupSettlements],
  );

  const getUserById = (uid: string) => users.find(u => u.id === uid);
  const memberNames = (group?.members ?? []).map(m => getUserById(m.userId)?.name);
  const nameOf = (uid: string, lower = false) => {
    if (uid === currentUser.id) return lower ? 'you' : 'You';
    const name = getUserById(uid)?.name;
    return name ? shortName(name, memberNames) : 'Unknown';
  };

  // When the group is deleted from the store, navigate away instead of flashing a blank state.
  useEffect(() => {
    if (!group) navigate('/groups', { replace: true });
  }, [group, navigate]);

  if (!group) return null;

  const memberIds = group.members.map(m => m.userId);
  // Completed payments count against the expense totals, so balances and the
  // suggested transfers below both reflect what is actually still outstanding.
  const balances = calculateBalances({ expenses, memberIds, settlements: groupSettlements });
  // As the group's settings say: simplified (fewest payments) unless turned off.
  const settlements = groupTransfers({ expenses, memberIds, settlements: groupSettlements }, simplifies(group));
  // Who owes whom before simplifying, to explain transfers that reroute money.
  const direct = directDebts({ expenses, memberIds, settlements: groupSettlements });
  const simplified = isSimplified(settlements, direct);
  const isDirectTransfer = (t: SettlementTransaction) =>
    direct.some(d => d.from === t.from && d.to === t.to && Math.abs(d.amount - t.amount) < 0.005);
  const myBalance = balances[currentUser.id] ?? 0;
  const hasExpenses = expenses.length > 0;
  const tomorrow = new Date(Date.now() + 86_400_000);
  const nextRepeat = groupRecurring
    .map(r => nextOccurrence(r, tomorrow))
    .sort((a, b) => a.getTime() - b.getTime())[0];

  // What each member put in and what their split came to, for the balance rows.
  const paidBy: Record<string, number> = {};
  const shareOf: Record<string, number> = {};
  for (const e of expenses) {
    // A refund received counts against what someone paid, and their part of it against their share.
    paidBy[e.paidBy] = (paidBy[e.paidBy] ?? 0) + signedAmount(e);
    for (const en of e.split.entries) shareOf[en.userId] = (shareOf[en.userId] ?? 0) + moneySign(e) * en.amount;
  }

  const openAddExpense = () => setShowAddExpense(true);

  const handleSettle = (amount: number, method: PaymentMethod) => {
    if (!settling) return;
    addSettlement({
      fromUserId: settling.from,
      toUserId: settling.to,
      amount,
      currency: cur,
      groupId: id,
      date: new Date(),
      paymentMethod: method,
    });
  };

  const handleUndoPayment = (settlementId: string) => {
    deleteSettlement(settlementId);
    setUndoPaymentId(null);
  };

  const settingsIcon = (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="M4 7h10M18 7h2M4 17h4M12 17h8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      <circle cx="16" cy="7" r="2" stroke="currentColor" strokeWidth="1.8" />
      <circle cx="10" cy="17" r="2" stroke="currentColor" strokeWidth="1.8" />
    </svg>
  );

  // Just you and one person: shown as them, and reached from their page.
  const otherId = group.direct ? directOther(group, currentUser.id) : undefined;
  const other = otherId ? getUserById(otherId) : undefined;
  const homePath = other ? `/people/${other.id}` : '/groups';

  // The last time this phone took in someone's copy of the group.
  const lastSync = activities
    .filter(a => a.type === 'group_synced' && a.groupId === group.id)
    .reduce<(typeof activities)[number] | undefined>((latest, a) => (!latest || a.date > latest.date ? a : latest), undefined);
  const lastSwap = lastSync?.type === 'group_synced'
    ? { name: getUserById(lastSync.actorId)?.name.split(' ')[0] ?? lastSync.fromName.split(' ')[0], date: lastSync.date }
    : undefined;

  const toggleArchived = () => {
    const archiving = !group.archivedAt;
    setGroupArchived(group.id, archiving);
    if (archiving) {
      showToast({ message: `${group.name} archived`, action: { label: 'Undo', run: () => setGroupArchived(group.id, false) } });
      navigate('/groups');
    }
  };

  const menuItems: MenuItem[] = [
    {
      label: other ? `Swap with ${other.name.split(' ')[0]}` : 'Swap with a friend',
      icon: SWAP_ICON,
      onSelect: () => navigate(`/share?group=${group.id}`),
    },
    ...(hasExpenses
      ? [{
          label: makingId === group.id ? 'Making PDF…' : 'PDF report',
          icon: REPORT_ICON,
          onSelect: () => downloadReport(group.id),
          disabled: !!makingId,
        }]
      : []),
    ...(group.direct ? [] : [{ label: group.archivedAt ? 'Unarchive' : 'Archive group', icon: ARCHIVE_ICON, onSelect: toggleArchived }]),
  ];

  // The line at the top: where you stand, in words, then the amount.
  const even = Math.abs(myBalance) < 0.005;
  const owesMe = settlements.filter(s => s.to === currentUser.id).map(s => nameOf(s.from));
  const iOwe = settlements.filter(s => s.from === currentUser.id).map(s => nameOf(s.to));
  let standingLead: string;
  let standingFigure: string;
  if (even) {
    standingLead = settlements.length ? "You don't owe or get anything" : 'Nobody owes anything';
    standingFigure = settlements.length ? "You're settled up" : 'All settled up';
  } else {
    standingFigure = formatCurrency(Math.abs(myBalance), cur);
    if (owesMe.length && !iOwe.length) {
      standingLead = `${joinNames(owesMe)} ${owesMe.length === 1 ? 'owes' : 'owe'} you`;
    } else if (iOwe.length && !owesMe.length) {
      standingLead = `You owe ${joinNames(iOwe)}`;
    } else {
      standingLead = myBalance > 0 ? "You're owed overall" : 'You owe overall';
    }
  }
  const paymentsMade = sortedPayments.length
    ? `${sortedPayments.length} ${sortedPayments.length === 1 ? 'payment' : 'payments'} made`
    : '';

  // Everyone's balance, the note on simplifying, and past payments. In the side
  // column on desktop; in a sheet on phones.
  const everyone = (
    <>
      <div className="ruled gd-balances">
        {group.members.map(m => {
          const u = getUserById(m.userId);
          if (!u) return null;
          const bal = balances[m.userId] ?? 0;
          const settled = Math.abs(bal) < 0.005;
          return (
            <button
              key={m.userId}
              className="gd-balance"
              onClick={() => { setShowEveryone(false); setSelectedMemberId(m.userId); }}
            >
              <Avatar user={u} size="sm" />
              <span className="gd-balance-info">
                <span className="gd-balance-name">{nameOf(m.userId)}</span>
                <span className="gd-balance-meta">
                  Paid {formatCurrency(paidBy[m.userId] ?? 0, cur)} · share {formatCurrency(shareOf[m.userId] ?? 0, cur)}
                </span>
              </span>
              <span className={`gd-balance-amount ${settled ? 'zero' : `num ${signClass(bal)}`}`}>
                {settled ? 'settled up' : formatSigned(bal, cur)}
              </span>
            </button>
          );
        })}
      </div>

      {simplified && settlements.length > 0 && (
        <p className="gd-simplified-note">
          Payments are simplified, so it takes fewer of them. Someone may pay a person they don't owe directly.{' '}
          <button className="gd-note-link" onClick={() => { setShowEveryone(false); setShowEditGroup(true); }}>
            Turn off in settings
          </button>
        </p>
      )}

      {sortedPayments.length > 0 && (
        <>
          <button
            className="gd-toggle"
            onClick={() => setShowPayments(v => !v)}
            aria-expanded={showPayments}
          >
            <span>{paymentsMade}</span>
            <span className="gd-toggle-action">{showPayments ? 'Hide' : 'Show'}</span>
          </button>
          {showPayments && (
            <div className="gd-payments">
              {sortedPayments.map(p => {
                const confirming = undoPaymentId === p.id;
                return (
                  <div key={p.id} className="gd-payment">
                    <span className="gd-payment-info">
                      <span>
                        <strong>{nameOf(p.fromUserId)}</strong>
                        <span className="text-secondary"> paid </span>
                        <strong>{nameOf(p.toUserId, true)}</strong>
                      </span>
                      <span className="num gd-payment-meta">
                        {formatLedgerDate(p.date)}
                        {p.paymentMethod ? ` · ${PAYMENT_METHOD_LABELS[p.paymentMethod].toUpperCase()}` : ''}
                      </span>
                    </span>
                    <span className="num gd-payment-amount">{formatCurrency(p.amount, cur)}</span>
                    {confirming ? (
                      <span className="gd-payment-confirm">
                        <button className="btn btn-secondary btn-sm" onClick={() => setUndoPaymentId(null)}>Keep</button>
                        <button className="btn btn-danger-solid btn-sm" onClick={() => handleUndoPayment(p.id)}>Undo</button>
                      </span>
                    ) : (
                      <button className="gd-undo" onClick={() => setUndoPaymentId(p.id)} aria-label="Undo this payment">
                        Undo
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}
    </>
  );

  return (
    <div className="gd-shell">
      <div className="page-content">
        <div className="gd">
          {/* Header */}
          <header className="gd-header">
            <div className="gd-title-block">
              <Link to={homePath} className="gd-crumb">{other ? 'People /' : 'Groups /'}</Link>
              <div className="gd-title-row">
                {other ? <Avatar user={other} size="lg" /> : <GroupTile group={group} size={40} />}
                <h1 className="gd-title">{other ? `You & ${other.name}` : group.name}</h1>
                {/* Phones only: desktop has labelled buttons */}
                <button className="gd-icon-btn gd-mobile-only gd-settings-mobile" onClick={() => setShowEditGroup(true)} aria-label="Group settings">
                  {settingsIcon}
                </button>
                <div className="gd-mobile-only gd-menu-mobile">
                  <MoreMenu items={menuItems} className="gd-icon-btn" />
                </div>
              </div>
              <p className="gd-subline">
                {other ? 'Just you two' : group.members.map(m => nameOf(m.userId)).join(', ')} · {cur}
              </p>
              {lastSwap && (
                <p className="gd-swapped">
                  {SWAP_ICON}
                  Last swapped with {lastSwap.name} {formatRelativeDay(lastSwap.date)}
                </p>
              )}
              {group.archivedAt && (
                <p className="gd-archived">
                  Archived, so it's hidden from your groups. Its balances still count.
                  <button className="gd-archived-undo" onClick={toggleArchived}>Unarchive</button>
                </p>
              )}
            </div>
            <div className="gd-header-actions">
              <button className="btn btn-secondary" onClick={() => setShowEditGroup(true)}>
                {settingsIcon}
                Settings
              </button>
              <MoreMenu items={menuItems} className="btn btn-secondary gd-more-btn" />
              <button className="btn btn-primary" onClick={openAddExpense}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden>
                  <path d="M12 5V19M5 12H19" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                </svg>
                Add expense
              </button>
            </div>
          </header>

          <div className="gd-grid">
            {/* Where you stand, and who pays whom */}
            {hasExpenses && (
              <section className="gd-area-settle" id="balances" aria-label="Balances and settling up">
                <div className="gd-standing">
                  <p className="gd-standing-lead">{standingLead}</p>
                  <p className={`gd-standing-figure ${even ? 'even' : `num ${signClass(myBalance)}`}`}>{standingFigure}</p>
                  <p className="gd-standing-sub">
                    {formatCurrency(totalSpent, cur)} spent ·{' '}
                    <Link to={`/insights?group=${group.id}`} className="gd-insights-link">Insights →</Link>
                  </p>
                </div>

                {settlements.length > 0 ? (
                  <div className="gd-settle-card">
                    {settlements.map((s, i) => {
                      const isMyDebt = s.from === currentUser.id;
                      const isMyCredit = s.to === currentUser.id;
                      const mine = isMyDebt || isMyCredit;
                      return (
                        <div key={i} className={`gd-transfer ${mine ? '' : 'others'}`}>
                          <button className="gd-transfer-text" onClick={() => setExplaining(s)}>
                            {nameOf(s.from)} {isMyDebt ? 'pay' : 'pays'} {nameOf(s.to, true)}
                            {!isDirectTransfer(s) && <span className="gd-transfer-why">Why?</span>}
                          </button>
                          <span className="num gd-transfer-amount">{formatCurrency(s.amount, cur)}</span>
                          <button
                            className={`btn btn-sm ${isMyDebt ? 'btn-primary' : 'btn-outline'}`}
                            onClick={() => setSettling({ from: s.from, to: s.to, amount: s.amount })}
                          >
                            {isMyDebt ? 'Pay' : isMyCredit ? 'Received' : 'Settle'}
                          </button>
                        </div>
                      );
                    })}
                    <div className="gd-settle-foot gd-mobile-only">
                      <button className="gd-everyone-link" onClick={() => setShowEveryone(true)}>{other ? 'Balances and payments' : "Everyone's balance"}</button>
                      {paymentsMade && <span>{paymentsMade}</span>}
                    </div>
                  </div>
                ) : (
                  <div className="gd-settle-foot gd-settle-foot-plain gd-mobile-only">
                    <button className="gd-everyone-link" onClick={() => setShowEveryone(true)}>{other ? 'Balances and payments' : "Everyone's balance"}</button>
                    {paymentsMade && <span>{paymentsMade}</span>}
                  </div>
                )}

                <div className="gd-everyone-inline">
                  <p className="cap gd-everyone-head">{other ? 'Both of you' : 'Everyone'}</p>
                  {everyone}
                </div>
              </section>
            )}

            {/* Expenses */}
            <section className="gd-area-expenses">
              <div className="gd-section-head">
                <h2 className="gd-h2">Expenses</h2>
                {hasExpenses && (
                  <span className="num text-xs text-secondary">
                    {filtering ? `${visibleExpenses.length} of ${expenses.length}` : expenses.length}
                  </span>
                )}
              </div>

              {hasExpenses && (
                <ExpenseFilterBar
                  value={expenseFilter}
                  onChange={setExpenseFilter}
                  matchCount={visibleExpenses.length}
                  categories={expenseCategories}
                  people={group.members.map(m => ({ id: m.userId, name: nameOf(m.userId) }))}
                />
              )}

              {!hasExpenses ? (
                <div className="empty-box">
                  <span className="empty-box-title">No expenses yet</span>
                  <span className="text-secondary">Add the first expense for this group.</span>
                  <button className="btn btn-primary" onClick={openAddExpense}>Add expense</button>
                </div>
              ) : visibleExpenses.length === 0 ? (
                <div className="empty-box">
                  <span className="empty-box-title">No matches</span>
                  <span className="text-secondary">No expenses match these filters.</span>
                  <button className="btn btn-secondary" onClick={() => setExpenseFilter(EMPTY_FILTER)}>
                    Clear filters
                  </button>
                </div>
              ) : (
                <div className="gd-table" role="table" aria-label="Expenses">
                  <div className="gd-row gd-row-head" role="row">
                    <span role="columnheader" className="cap">Date</span>
                    <span role="columnheader" className="cap">Description</span>
                    <span role="columnheader" className="cap gd-col-wide">Paid by</span>
                    <span role="columnheader" className="cap gd-col-wide gd-right">Amount</span>
                    <span role="columnheader" className="cap gd-right">Your share</span>
                  </div>
                  {shownExpenses.map(expense => {
                    const net = round(getNetAmountForUser(expense, currentUser.id));
                    return (
                      <div key={expense.id} className="gd-expense" role="rowgroup">
                        <div className="gd-row" role="row">
                          <span role="cell" className="num gd-date" title={formatDate(expense.date)}>
                            {formatLedgerDate(expense.date)}
                          </span>
                          <span role="cell" className="gd-desc-cell">
                            <span className="gd-desc">
                              <Link to={`/groups/${group.id}/expenses/${expense.id}`} className="gd-desc-link">
                                {expense.description}
                              </Link>
                              {expense.refund && <span className="gd-refund-tag">Refund</span>}
                              {(() => {
                                const tag = swapTag(recentSwap, group.id, expense);
                                return tag && <span className={`gd-swap-tag ${tag === 'New' ? 'new' : ''}`}>{tag}</span>;
                              })()}
                              {ruleIdOf(expense.id) && allRecurring.some(r => r.id === ruleIdOf(expense.id)) && (
                                <span className="gd-repeat-mark" title="Repeating expense" aria-label="Repeating expense">↻</span>
                              )}
                              {expense.receipt && (
                                <button
                                  className="gd-receipt-btn"
                                  onClick={() => setViewingReceipt({ id: expense.id, title: expense.description })}
                                  aria-label={`Receipt photo for ${expense.description}`}
                                  title="Receipt photo"
                                >
                                  {RECEIPT_ICON}
                                </button>
                              )}
                            </span>
                            <span className="text-xs text-secondary gd-meta-mobile">
                              {nameOf(expense.paidBy)} {expense.refund ? 'got back' : 'paid'} {expenseAmountLabel(expense)}
                            </span>
                          </span>
                          <span role="cell" className="gd-col-wide">{nameOf(expense.paidBy)}</span>
                          <span role="cell" className="num gd-col-wide gd-right gd-amount">
                            {expense.refund ? '−' : ''}{formatCurrency(expense.amount, cur)}
                          </span>
                          <span role="cell" className="gd-right gd-share">
                            <span className={`num ${signClass(net)}`}>{formatSigned(net, cur)}</span>
                          </span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
              {hiddenCount > 0 && (
                <button className="gd-more" onClick={() => setShowAllExpenses(true)}>
                  Show all {visibleExpenses.length}
                </button>
              )}
            </section>

            {/* Repeating expenses, folded into one line until opened */}
            {groupRecurring.length > 0 && (
              <section className="gd-area-repeating" aria-label="Repeating expenses">
                <button
                  className="gd-repeat-summary"
                  onClick={() => setShowRepeating(v => !v)}
                  aria-expanded={showRepeating}
                >
                  <span className="gd-repeat-icon" aria-hidden>↻</span>
                  <span className="gd-repeat-summary-text">
                    {groupRecurring.length} repeating · next {nextRepeat?.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                  </span>
                  <span className="gd-toggle-action">{showRepeating ? 'Done' : 'Manage'}</span>
                </button>
                {showRepeating && (
                    <div className="ruled">
                      {groupRecurring.map(r => (
                        <div key={r.id} className="gd-repeat">
                          <span className="gd-repeat-info">
                            <span className="gd-repeat-name">{r.template.description}</span>
                            <span className="gd-repeat-meta">
                              {FREQUENCY_LABELS[r.frequency]} · next{' '}
                              {nextOccurrence(r, new Date(Date.now() + 86_400_000)).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                              {' · '}{nameOf(r.template.paidBy)} {r.template.paidBy === currentUser.id ? 'pay' : 'pays'}
                            </span>
                          </span>
                          <span className="num">{formatCurrency(r.template.amount, cur)}</span>
                          {stoppingId === r.id ? (
                            <span className="gd-payment-confirm">
                              <button className="btn btn-secondary btn-sm" onClick={() => setStoppingId(null)}>Keep</button>
                              <button
                                className="btn btn-danger-solid btn-sm"
                                onClick={() => {
                                  stopRecurring(r.id);
                                  setStoppingId(null);
                                  showToast({ message: `“${r.template.description}” won’t repeat any more. Past ones stay.` });
                                }}
                              >
                                Stop
                              </button>
                            </span>
                          ) : (
                            <button className="gd-undo" onClick={() => setStoppingId(r.id)}>Stop</button>
                          )}
                        </div>
                      ))}
                    </div>
                )}
              </section>
            )}
          </div>
        </div>
      </div>

      {/* Add expense sheet (editing is on the expense's page) */}
      <AnimatePresence>
        {showAddExpense && (
          <AddExpenseSheet open={showAddExpense} onClose={() => setShowAddExpense(false)} defaultGroupId={id} />
        )}
      </AnimatePresence>

      {/* Edit group sheet */}
      <AnimatePresence>
        {viewingReceipt && (
          <ReceiptViewer
            expenseId={viewingReceipt.id}
            title={viewingReceipt.title}
            onClose={() => setViewingReceipt(null)}
          />
        )}
        {showEditGroup && (
          <EditGroupSheet
            open={showEditGroup}
            onClose={() => setShowEditGroup(false)}
            group={group}
            onDeleted={() => navigate(homePath)}
          />
        )}
      </AnimatePresence>

      {/* Person sheet */}
      <AnimatePresence>
        {selectedMemberId && (
          <PersonSheet
            open={!!selectedMemberId}
            onClose={() => setSelectedMemberId(null)}
            userId={selectedMemberId}
            groupId={id!}
          />
        )}
      </AnimatePresence>

      {/* Phones: everyone's balance and past payments */}
      <AnimatePresence>
        {showEveryone && (
          <motion.div
            className="sheet-overlay"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={() => setShowEveryone(false)}
          >
            <motion.div
              className="sheet-panel gd-everyone-sheet"
              role="dialog"
              aria-label="Everyone's balance"
              initial={{ y: '100%' }}
              animate={{ y: 0 }}
              exit={{ y: '100%' }}
              transition={{ type: 'spring', damping: 32, stiffness: 340 }}
              onClick={(e) => e.stopPropagation()}
            >
              <div className="sheet-handle" />
              <div className="sheet-header">
                <span className="sheet-title">Everyone's balance</span>
                <button className="sheet-close" onClick={() => setShowEveryone(false)} aria-label="Close">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden>
                    <path d="M18 6L6 18M6 6L18 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                  </svg>
                </button>
              </div>
              <div className="sheet-body">{everyone}</div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Why a suggested payment exists */}
      <AnimatePresence>
        {explaining && (
          <TransferExplainer groupId={group.id} transfer={explaining} onClose={() => setExplaining(null)} />
        )}
      </AnimatePresence>

      {/* Mark a payment complete */}
      <AnimatePresence>
        {settling && (
          <SettleModal
            fromUserId={settling.from}
            toUserId={settling.to}
            amount={settling.amount}
            currency={cur}
            groupLabel={group.name}
            onClose={() => setSettling(null)}
            onConfirm={handleSettle}
          />
        )}
      </AnimatePresence>
    </div>
  );
}
