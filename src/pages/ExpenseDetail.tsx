import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { AnimatePresence } from 'framer-motion';
import { useStore, selectCurrentUser } from '../store';
import Avatar from '../components/Avatar';
import AddExpenseSheet from '../components/AddExpenseSheet';
import ReceiptViewer from '../components/ReceiptViewer';
import { categoryLabel } from '../lib/categories';
import { recordCurrency } from '../lib/currency';
import { FREQUENCY_LABELS, nextOccurrence, ruleIdOf } from '../lib/recurring';
import { loadPhoto } from '../lib/receiptPhotos';
import { showToast } from '../lib/toast';
import { round } from '../lib/calculations';
import { formatCurrency, formatSigned, getNetAmountForUser } from '../utils';
import type { Expense } from '../types';
import './ExpenseDetail.css';

/** Items listed before "Show all". */
const ITEMS_SHOWN = 6;

const SPLIT_WORDS: Record<Expense['split']['type'], string> = {
  equal: 'split equally',
  exact: 'split by amounts',
  percentage: 'split by percent',
  shares: 'split by shares',
};

const thisYear = (d: Date) => d.getFullYear() === new Date().getFullYear();
const longDate = (d: Date) =>
  d.toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: thisYear(d) ? undefined : 'numeric',
  });
const shortDate = (d: Date) =>
  d.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: thisYear(d) ? undefined : 'numeric',
  });

/** The receipt photo, shown in the page on desktop. */
function ReceiptImage({ expenseId, onOpen }: { expenseId: string; onOpen: () => void }) {
  const [url, setUrl] = useState<string | null>(null);
  const [missing, setMissing] = useState(false);
  useEffect(() => {
    let objectUrl: string | null = null;
    let live = true;
    loadPhoto(expenseId)
      .then((blob) => {
        if (!live) return;
        if (!blob) return setMissing(true);
        objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
      })
      .catch(() => live && setMissing(true));
    return () => {
      live = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [expenseId]);

  if (missing) return <p className="text-sm text-secondary">The photo isn't on this device.</p>;
  return (
    <button className="xd-photo" onClick={onOpen} aria-label="Open the receipt photo full size">
      {url && <img src={url} alt="Receipt" />}
    </button>
  );
}

export default function ExpenseDetail() {
  const { id: groupId = '', expenseId = '' } = useParams<{ id: string; expenseId: string }>();
  const navigate = useNavigate();

  const currentUser = useStore(selectCurrentUser)!;
  const users = useStore((s) => s.users);
  const group = useStore((s) => s.groups.find((g) => g.id === groupId));
  const expense = useStore((s) => s.expenses.find((e) => e.id === expenseId));
  const recurring = useStore((s) => s.recurring);
  const deleteExpense = useStore((s) => s.deleteExpense);
  const undoExpenseDelete = useStore((s) => s.undoExpenseDelete);

  const [sheet, setSheet] = useState<'edit' | 'duplicate' | null>(null);
  const [viewingPhoto, setViewingPhoto] = useState(false);
  const [showAllItems, setShowAllItems] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  // Deleted (here or by a merge) or never existed: back to the group.
  useEffect(() => {
    if (!expense) navigate(group ? `/groups/${groupId}` : '/groups', { replace: true });
  }, [expense, group, groupId, navigate]);

  if (!expense) return null;

  const me = currentUser.id;
  const cur = recordCurrency(expense);
  // Items are in the currency the expense was entered in.
  const itemCur = expense.original?.currency ?? cur;
  const firstName = (uid: string) =>
    uid === me ? 'You' : users.find((u) => u.id === uid)?.name.split(' ')[0] ?? 'Someone';
  const payer = firstName(expense.paidBy);
  const myShare = expense.split.entries.find((e) => e.userId === me)?.amount ?? 0;
  const net = round(getNetAmountForUser(expense, me));
  const position =
    expense.paidBy === me
      ? net > 0.005
        ? { text: 'You lent', amount: net, cls: 'pos' }
        : { text: 'Only you were in it', amount: 0, cls: 'zero' }
      : myShare > 0.005
        ? { text: `You owe ${payer}`, amount: -myShare, cls: 'neg' }
        : { text: 'You weren’t part of this', amount: 0, cls: 'zero' };

  const splitWords = expense.items?.length ? 'split by item' : SPLIT_WORDS[expense.split.type];
  const category = categoryLabel(expense.category, group);
  const edited = expense.updatedAt.getTime() - expense.createdAt.getTime() > 60_000;
  const rule = (() => {
    const rid = ruleIdOf(expense.id);
    return rid ? recurring.find((r) => r.id === rid) : undefined;
  })();

  const memberIds = group?.members.map((m) => m.userId) ?? expense.split.entries.map((e) => e.userId);
  const whoHad = (assigned: string[]) =>
    assigned.length >= memberIds.length && memberIds.every((m) => assigned.includes(m))
      ? 'Everyone'
      : assigned.map(firstName).join(', ');
  const items = expense.items ?? [];
  const shownItems = showAllItems ? items : items.slice(0, ITEMS_SHOWN);
  const itemsSum = round(items.reduce((s, it) => s + it.amount, 0));
  const entered = expense.original?.amount ?? expense.amount;
  const extra = round(entered - itemsSum);

  const remove = () => {
    const deleted = deleteExpense(expense.id);
    navigate(`/groups/${groupId}`, { replace: true });
    if (deleted) {
      showToast({
        message: `Deleted “${deleted.expense.description}”`,
        action: { label: 'Undo', run: () => undoExpenseDelete(deleted) },
      });
    }
  };

  const amountBlock = (
    <>
      <span className="num xd-amount">
        {expense.original && expense.original.currency !== cur
          ? formatCurrency(expense.original.amount, expense.original.currency)
          : formatCurrency(expense.amount, cur)}
      </span>
      {expense.original && expense.original.currency !== cur && (
        <span className="num text-sm text-secondary">= {formatCurrency(expense.amount, cur)} at the rate entered</span>
      )}
    </>
  );

  const actions = (
    <>
      <button className="btn btn-secondary" onClick={() => setSheet('duplicate')}>Duplicate</button>
      {confirmDelete ? (
        <span className="xd-confirm">
          <button className="btn btn-secondary" onClick={() => setConfirmDelete(false)}>Keep</button>
          <button className="btn btn-danger-solid" onClick={remove}>Delete</button>
        </span>
      ) : (
        <button className="btn xd-delete" onClick={() => setConfirmDelete(true)}>Delete</button>
      )}
    </>
  );

  return (
    <div className="page-content">
      <div className="xd">
        {/* Phones: back to the group, and Edit */}
        <div className="xd-topbar">
          <Link to={`/groups/${groupId}`} className="xd-back">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden>
              <path d="M15 18l-6-6 6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            {group?.name ?? 'Back'}
          </Link>
          <button className="btn btn-secondary xd-edit-small" onClick={() => setSheet('edit')}>Edit</button>
        </div>

        <header className="xd-header">
          <span className="xd-crumb">
            <Link to="/groups">Groups</Link> / <Link to={`/groups/${groupId}`}>{group?.name}</Link> /
          </span>
          <span className="xd-meta">
            {category} · {longDate(expense.date)}
          </span>
          <h1 className="xd-title">{expense.description}</h1>
          <span className="xd-hero-amount">{amountBlock}</span>
          <span className="xd-sub">
            {payer} paid · {splitWords}
          </span>
          <span className="xd-desk-sub">
            {category} · {longDate(expense.date)} · {payer} paid · {splitWords}
          </span>
          <span className="xd-header-actions">
            {actions}
            <button className="btn btn-primary" onClick={() => setSheet('edit')}>Edit</button>
          </span>
        </header>

        {/* Phones: one line saying where this leaves you. Desktop: a summary strip. */}
        <div className="xd-position">
          <span>{position.text}</span>
          {position.amount !== 0 && (
            <span className={`num xd-position-amount ${position.cls}`}>{formatCurrency(Math.abs(position.amount), cur)}</span>
          )}
        </div>
        <section className="statement xd-statement" aria-label="Summary">
          <div>
            <span className="cap">Total</span>
            <span className="num xd-figure">{formatCurrency(expense.amount, cur)}</span>
          </div>
          <div>
            <span className="cap">Your share</span>
            <span className="num xd-figure">{formatCurrency(myShare, cur)}</span>
          </div>
          <div>
            <span className="cap">{position.text}</span>
            <span className={`num xd-figure ${position.cls}`}>
              {position.amount === 0 ? '—' : formatSigned(position.amount, cur)}
            </span>
          </div>
        </section>

        <div className={`xd-columns ${expense.receipt ? 'with-photo' : ''}`}>
          <div className="xd-main">
            {items.length > 0 && (
              <section aria-labelledby="xd-items">
                <div className="xd-section-head">
                  <h2 id="xd-items" className="xd-h2">
                    {expense.receipt ? 'Receipt' : 'Items'} · {items.length} {items.length === 1 ? 'item' : 'items'}
                  </h2>
                  {expense.receipt && (
                    <button className="xd-link xd-narrow" onClick={() => setViewingPhoto(true)}>Photo</button>
                  )}
                </div>
                <div className="xd-items" role="table" aria-label="Items">
                  <div className="xd-item xd-item-head" role="row">
                    <span role="columnheader" className="cap">Item</span>
                    <span role="columnheader" className="cap">Who had it</span>
                    <span role="columnheader" className="cap xd-right">Price</span>
                  </div>
                  {shownItems.map((it, i) => (
                    <div key={i} className="xd-item" role="row">
                      <span role="cell" className="xd-item-name">{it.description || 'Item'}</span>
                      <span role="cell" className="xd-item-who">{whoHad(it.assigned)}</span>
                      <span role="cell" className="num xd-right">{formatCurrency(it.amount, itemCur)}</span>
                    </div>
                  ))}
                  {items.length > shownItems.length && (
                    <button className="xd-item xd-item-more" onClick={() => setShowAllItems(true)}>
                      <span>{items.length - shownItems.length} more items</span>
                      <span />
                      <span className="xd-link xd-right">Show all</span>
                    </button>
                  )}
                  {Math.abs(extra) >= 0.005 && (
                    <div className="xd-item xd-item-extra" role="row">
                      <span role="cell">{extra > 0 ? 'Tax & tip, shared in proportion' : 'Discount, shared in proportion'}</span>
                      <span role="cell" />
                      <span role="cell" className="num xd-right">
                        {extra < 0 ? '−' : ''}
                        {formatCurrency(Math.abs(extra), itemCur)}
                      </span>
                    </div>
                  )}
                </div>
              </section>
            )}

            <section aria-labelledby="xd-shares">
              <h2 id="xd-shares" className="xd-h2">Shares</h2>
              <div className="ruled">
                {expense.split.entries.map((en) => {
                  const u = users.find((x) => x.id === en.userId);
                  return (
                    <div key={en.userId} className="xd-share">
                      {u && <Avatar user={u} size="sm" />}
                      <span className="xd-share-name">
                        {firstName(en.userId)}
                        {en.userId === expense.paidBy && <span className="text-xs text-secondary"> · paid</span>}
                      </span>
                      <span className="num">{formatCurrency(en.amount, cur)}</span>
                    </div>
                  );
                })}
                {!expense.split.entries.some((en) => en.userId === expense.paidBy) && (
                  <div className="xd-share">
                    <span className="xd-share-name">
                      {payer} <span className="text-xs text-secondary">· paid, not in the split</span>
                    </span>
                    <span className="num">{formatCurrency(0, cur)}</span>
                  </div>
                )}
              </div>
            </section>

            {expense.receipt && items.length === 0 && (
              <button className="xd-photo-row xd-narrow" onClick={() => setViewingPhoto(true)}>
                <span>Receipt photo</span>
                <span className="xd-link">View</span>
              </button>
            )}

            {expense.notes && <p className="xd-notes">{expense.notes}</p>}

            <p className="xd-footnote">
              {rule && (
                <>
                  ↻ {FREQUENCY_LABELS[rule.frequency]} · next {shortDate(nextOccurrence(rule, new Date(Date.now() + 86_400_000)))}
                  <br />
                </>
              )}
              Added {shortDate(expense.createdAt)}
              {edited && ` · edited ${shortDate(expense.updatedAt)}`}
            </p>

            <div className="xd-bottom-actions">{actions}</div>
          </div>

          {expense.receipt && (
            <section className="xd-side" aria-labelledby="xd-photo-title">
              <h2 id="xd-photo-title" className="xd-h2">Receipt</h2>
              <ReceiptImage expenseId={expense.id} onOpen={() => setViewingPhoto(true)} />
              <span className="text-xs text-secondary">Click to open it full size</span>
            </section>
          )}
        </div>
      </div>

      <AnimatePresence>
        {sheet && (
          <AddExpenseSheet
            key={sheet}
            open
            onClose={() => setSheet(null)}
            defaultGroupId={groupId}
            editExpense={sheet === 'edit' ? expense : undefined}
            template={sheet === 'duplicate' ? expense : undefined}
          />
        )}
      </AnimatePresence>

      <AnimatePresence>
        {viewingPhoto && (
          <ReceiptViewer expenseId={expense.id} title={expense.description} onClose={() => setViewingPhoto(false)} />
        )}
      </AnimatePresence>
    </div>
  );
}
