import { useMemo, useState, useEffect } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { useStore, selectCurrentUser, selectTotalsForGroup } from '../store';
import { calculateBalances, calculateSettlements, round } from '../lib/calculations';
import { EMPTY_FILTER, categoryOptions, filterExpenses, isFilterActive, type ExpenseFilter } from '../lib/expenseFilter';
import { formatCurrency, formatDate, formatLedgerDate, formatSigned, getNetAmountForUser } from '../utils';
import { categoryLabel } from '../lib/categories';
import type { Expense, PaymentMethod } from '../types';
import Avatar from '../components/Avatar';
import GroupTile from '../components/GroupTile';
import AddExpenseSheet from '../components/AddExpenseSheet';
import EditGroupSheet from '../components/EditGroupSheet';
import ShareGroupSheet from '../components/ShareGroupSheet';
import ReceiptViewer from '../components/ReceiptViewer';
import { showToast } from '../lib/toast';
import { FREQUENCY_LABELS, nextOccurrence, ruleIdOf } from '../lib/recurring';
import PersonSheet from '../components/PersonSheet';
import ExpenseFilterBar from '../components/ExpenseFilterBar';
import SettleModal from '../components/SettleModal';
import { expenseAmountLabel, groupCurrency } from '../lib/currency';
import './GroupDetail.css';

const PAYMENT_METHOD_LABELS: Record<PaymentMethod, string> = {
  venmo: 'Venmo',
  cashapp: 'Cash App',
  zelle: 'Zelle',
  cash: 'Cash',
  other: 'Other',
};

const signClass = (n: number) => (Math.abs(n) < 0.005 ? 'zero' : n > 0 ? 'pos' : 'neg');

const RECEIPT_ICON = (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden>
    <path d="M6 3h12v18l-3-2-3 2-3-2-3 2V3z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
    <path d="M9 8h6M9 12h6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
  </svg>
);

const SHARE_ICON = (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden>
    <path d="M12 3v12M7 8l5-5 5 5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    <path d="M5 13v6a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
  </svg>
);

export default function GroupDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();

  const [showAddExpense, setShowAddExpense] = useState(false);
  const [editingExpense, setEditingExpense] = useState<Expense | null>(null);
  const [duplicating, setDuplicating] = useState<Expense | null>(null);
  const [expenseMenuId, setExpenseMenuId] = useState<string | null>(null);
  const [showEditGroup, setShowEditGroup] = useState(false);
  const [showShare, setShowShare] = useState(false);
  const [viewingReceipt, setViewingReceipt] = useState<{ id: string; title: string } | null>(null);
  const [selectedMemberId, setSelectedMemberId] = useState<string | null>(null);
  const [settling, setSettling] = useState<{ from: string; to: string; amount: number } | null>(null);
  const [undoPaymentId, setUndoPaymentId] = useState<string | null>(null);
  const [expenseFilter, setExpenseFilter] = useState<ExpenseFilter>(EMPTY_FILTER);

  const users = useStore(s => s.users);
  const groups = useStore(s => s.groups);
  const allExpenses = useStore(s => s.expenses);
  const allSettlements = useStore(s => s.settlements);
  const deleteExpense = useStore(s => s.deleteExpense);
  const undoExpenseDelete = useStore(s => s.undoExpenseDelete);
  const allRecurring = useStore(s => s.recurring);
  const stopRecurring = useStore(s => s.stopRecurring);
  const [stoppingId, setStoppingId] = useState<string | null>(null);
  const groupRecurring = useMemo(() => allRecurring.filter(r => r.groupId === id), [allRecurring, id]);
  const addSettlement = useStore(s => s.addSettlement);
  const deleteSettlement = useStore(s => s.deleteSettlement);
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
  const nameOf = (uid: string, lower = false) =>
    uid === currentUser.id ? (lower ? 'you' : 'You') : getUserById(uid)?.name.split(' ')[0] ?? 'Unknown';

  // When the group is deleted from the store, navigate away instead of flashing a blank state.
  useEffect(() => {
    if (!group) navigate('/groups', { replace: true });
  }, [group, navigate]);

  if (!group) return null;

  const memberIds = group.members.map(m => m.userId);
  // Completed payments count against the expense totals, so balances and the
  // suggested transfers below both reflect what is actually still outstanding.
  const balances = calculateBalances({ expenses, memberIds, settlements: groupSettlements });
  const settlements = calculateSettlements({ expenses, memberIds, settlements: groupSettlements });
  const myBalance = balances[currentUser.id] ?? 0;
  const hasExpenses = expenses.length > 0;

  // What each member put in and what their split came to, for the balance rows.
  const paidBy: Record<string, number> = {};
  const shareOf: Record<string, number> = {};
  for (const e of expenses) {
    paidBy[e.paidBy] = (paidBy[e.paidBy] ?? 0) + e.amount;
    for (const en of e.split.entries) shareOf[en.userId] = (shareOf[en.userId] ?? 0) + en.amount;
  }

  const openAddExpense = () => { setEditingExpense(null); setDuplicating(null); setShowAddExpense(true); };
  const openDuplicate = (expense: Expense) => {
    setEditingExpense(null);
    setDuplicating(expense);
    setExpenseMenuId(null);
    setShowAddExpense(true);
  };

  const openEditExpense = (expense: Expense) => {
    setDuplicating(null);
    setEditingExpense(expense);
    setExpenseMenuId(null);
    setShowAddExpense(true);
  };

  const handleDeleteExpense = (expenseId: string) => {
    const deleted = deleteExpense(expenseId);
    setExpenseMenuId(null);
    if (deleted) {
      showToast({
        message: `Deleted “${deleted.expense.description}”`,
        action: { label: 'Undo', run: () => undoExpenseDelete(deleted) },
      });
    }
  };

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

  return (
    <div className="gd-shell">
      <div className="page-content">
        <div className="gd">
          {/* Header */}
          <header className="gd-header">
            <div className="gd-title-block">
              <Link to="/groups" className="gd-crumb">Groups /</Link>
              <div className="gd-title-row">
                <GroupTile group={group} size={40} />
                <h1 className="gd-title">{group.name}</h1>
                {/* Phones only: desktop has labelled buttons */}
                <button className="gd-icon-btn gd-settings-mobile gd-share-mobile" onClick={() => setShowShare(true)} aria-label="Share group">
                  {SHARE_ICON}
                </button>
                <button className="gd-icon-btn gd-settings-mobile" onClick={() => setShowEditGroup(true)} aria-label="Group settings">
                  {settingsIcon}
                </button>
              </div>
              <div className="gd-members">
                {group.members.map(m => {
                  const u = getUserById(m.userId);
                  if (!u) return null;
                  return (
                    <button
                      key={m.userId}
                      className="gd-member"
                      onClick={() => setSelectedMemberId(m.userId)}
                    >
                      <Avatar user={u} size="sm" />
                      <span>{nameOf(m.userId)}</span>
                    </button>
                  );
                })}
              </div>
            </div>
            <div className="gd-header-actions">
              <button className="btn btn-secondary" onClick={() => setShowShare(true)}>Share</button>
              <button className="btn btn-secondary" onClick={() => setShowEditGroup(true)}>Group settings</button>
              <button className="btn btn-primary" onClick={openAddExpense}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden>
                  <path d="M12 5V19M5 12H19" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                </svg>
                Add expense
              </button>
            </div>
          </header>

          {/* Statement */}
          <section className="statement gd-statement" aria-label="Group summary">
            <div>
              <span className="cap">Total spent</span>
              <span className="num gd-figure">{formatCurrency(totalSpent, cur)}</span>
            </div>
            <div>
              <span className="cap">
                {Math.abs(myBalance) < 0.005 ? 'Your balance' : myBalance > 0 ? 'You are owed' : 'You owe'}
              </span>
              <span className={`gd-figure gd-figure-strong ${Math.abs(myBalance) < 0.005 ? 'zero' : `num ${signClass(myBalance)}`}`}>
                {Math.abs(myBalance) < 0.005 ? 'Settled up' : formatSigned(myBalance, cur)}
              </span>
            </div>
            <div className="gd-statement-extra">
              <span className="cap">Still to settle</span>
              <span className="num gd-figure">
                {settlements.length} transfer{settlements.length === 1 ? '' : 's'}
              </span>
            </div>
          </section>

          <div className="gd-grid">
            {/* Outstanding transfers */}
            {settlements.length > 0 && (
              <section className="gd-area-settle">
                <h2 className="gd-h2">To settle</h2>
                <div className="ruled">
                  {settlements.map((s, i) => {
                    const isMyDebt = s.from === currentUser.id;
                    const isMyCredit = s.to === currentUser.id;
                    return (
                      <div key={i} className="gd-transfer">
                        <span className="gd-transfer-text">
                          <strong>{nameOf(s.from)}</strong>
                          <span className="text-secondary"> pays </span>
                          <strong>{nameOf(s.to, true)}</strong>
                        </span>
                        <span className="num gd-transfer-amount">{formatCurrency(s.amount, cur)}</span>
                        <button
                          className="btn btn-outline btn-sm"
                          onClick={() => setSettling({ from: s.from, to: s.to, amount: s.amount })}
                        >
                          {isMyDebt ? 'Pay' : isMyCredit ? 'Mark paid' : 'Settle'}
                        </button>
                      </div>
                    );
                  })}
                </div>
              </section>
            )}

            {/* Completed payments */}
            {sortedPayments.length > 0 && (
              <section className="gd-area-payments">
                <h2 className="gd-h2">Completed payments</h2>
                <div className="ruled">
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
                          <button
                            className="gd-undo"
                            onClick={() => setUndoPaymentId(p.id)}
                            aria-label="Undo this payment"
                          >
                            Undo
                          </button>
                        )}
                      </div>
                    );
                  })}
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
                  totalCount={expenses.length}
                  categories={expenseCategories}
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
                    <span role="columnheader"><span className="sr-only">Actions</span></span>
                  </div>
                  {visibleExpenses.map(expense => {
                    const net = round(getNetAmountForUser(expense, currentUser.id));
                    const menuOpen = expenseMenuId === expense.id;
                    return (
                      <div key={expense.id} className="gd-expense" role="rowgroup">
                        <div className="gd-row" role="row">
                          <span role="cell" className="num gd-date" title={formatDate(expense.date)}>
                            {formatLedgerDate(expense.date)}
                          </span>
                          <span role="cell" className="gd-desc-cell">
                            <span className="gd-desc">
                              {expense.description}
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
                            <span className="num gd-cat gd-col-wide-inline">{categoryLabel(expense.category, group)}</span>
                            <span className="text-xs text-secondary gd-meta-mobile">
                              {nameOf(expense.paidBy)} paid {expenseAmountLabel(expense)}
                            </span>
                          </span>
                          <span role="cell" className="gd-col-wide">{nameOf(expense.paidBy)}</span>
                          <span role="cell" className="num gd-col-wide gd-right gd-amount">{formatCurrency(expense.amount, cur)}</span>
                          <span role="cell" className="gd-right gd-share">
                            <span className={`num ${signClass(net)}`}>{formatSigned(net, cur)}</span>
                            <span className="gd-share-label">
                              {net > 0.005 ? 'you lent' : net < -0.005 ? 'you borrowed' : 'not involved'}
                            </span>
                          </span>
                          <span role="cell" className="gd-right">
                            <button
                              className={`gd-kebab ${menuOpen ? 'active' : ''}`}
                              onClick={() => setExpenseMenuId(menuOpen ? null : expense.id)}
                              aria-label={`Edit or delete ${expense.description}`}
                              aria-expanded={menuOpen}
                            >
                              <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                                <circle cx="5" cy="12" r="1.6" />
                                <circle cx="12" cy="12" r="1.6" />
                                <circle cx="19" cy="12" r="1.6" />
                              </svg>
                            </button>
                          </span>
                        </div>

                        <AnimatePresence>
                          {menuOpen && (
                            <motion.div
                              className="gd-actions"
                              initial={{ height: 0, opacity: 0 }}
                              animate={{ height: 'auto', opacity: 1 }}
                              exit={{ height: 0, opacity: 0 }}
                              transition={{ duration: 0.16 }}
                            >
                              <div className="gd-actions-inner">
                                <button className="btn btn-secondary btn-sm" onClick={() => openEditExpense(expense)}>
                                  Edit
                                </button>
                                <button className="btn btn-secondary btn-sm" onClick={() => openDuplicate(expense)}>
                                  Duplicate
                                </button>
                                {expense.receipt && (
                                  <button
                                    className="btn btn-secondary btn-sm"
                                    onClick={() => setViewingReceipt({ id: expense.id, title: expense.description })}
                                  >
                                    Receipt
                                  </button>
                                )}
                                <button className="btn btn-danger btn-sm" onClick={() => handleDeleteExpense(expense.id)}>
                                  Delete
                                </button>
                              </div>
                            </motion.div>
                          )}
                        </AnimatePresence>
                      </div>
                    );
                  })}
                </div>
              )}
            </section>

            {/* Repeating expenses */}
            {groupRecurring.length > 0 && (
              <section className="gd-area-repeating">
                <h2 className="gd-h2">Repeating</h2>
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
              </section>
            )}

            {/* Balances */}
            <section className="gd-area-balances" id="balances">
              <h2 className="gd-h2">Balances</h2>
              {!hasExpenses ? (
                <p className="text-sm text-secondary gd-balances-empty">Add an expense to see balances</p>
              ) : (
                <div className="ruled">
                  {group.members.map(m => {
                    const u = getUserById(m.userId);
                    if (!u) return null;
                    const bal = balances[m.userId] ?? 0;
                    const even = Math.abs(bal) < 0.005;
                    return (
                      <button key={m.userId} className="gd-balance" onClick={() => setSelectedMemberId(m.userId)}>
                        <Avatar user={u} size="sm" />
                        <span className="gd-balance-info">
                          <span className="gd-balance-name">{nameOf(m.userId)}</span>
                          <span className="num gd-balance-meta">
                            paid {formatCurrency(paidBy[m.userId] ?? 0, cur)} · share {formatCurrency(shareOf[m.userId] ?? 0, cur)}
                          </span>
                        </span>
                        <span className={`gd-balance-amount ${even ? 'zero' : `num ${signClass(bal)}`}`}>
                          {even ? 'settled up' : formatSigned(bal, cur)}
                        </span>
                      </button>
                    );
                  })}
                </div>
              )}
            </section>
          </div>
        </div>
      </div>

      {/* Add / Edit expense sheet */}
      <AnimatePresence>
        {showAddExpense && (
          <AddExpenseSheet
            key={editingExpense?.id ?? (duplicating ? `copy-${duplicating.id}` : 'new-expense')}
            open={showAddExpense}
            onClose={() => { setShowAddExpense(false); setEditingExpense(null); setDuplicating(null); }}
            defaultGroupId={id}
            editExpense={editingExpense ?? undefined}
            template={duplicating ?? undefined}
          />
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
        {showShare && <ShareGroupSheet open={showShare} onClose={() => setShowShare(false)} groupId={group.id} />}
        {showEditGroup && (
          <EditGroupSheet
            open={showEditGroup}
            onClose={() => setShowEditGroup(false)}
            group={group}
            onDeleted={() => navigate('/groups')}
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

      {/* Mark a payment complete */}
      <AnimatePresence>
        {settling && (
          <SettleModal
            fromUserId={settling.from}
            toUserId={settling.to}
            amount={settling.amount}
            currency={cur}
            mode="settle"
            groupLabel={group.name}
            onClose={() => setSettling(null)}
            onConfirm={handleSettle}
          />
        )}
      </AnimatePresence>
    </div>
  );
}
