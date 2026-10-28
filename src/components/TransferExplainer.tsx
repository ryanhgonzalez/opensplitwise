import { useMemo } from 'react';
import { motion } from 'framer-motion';
import Avatar from './Avatar';
import { useStore, selectCurrentUser } from '../store';
import { directDebts, groupTransfers, simplifies, type SettlementTransaction } from '../lib/calculations';
import { groupCurrency } from '../lib/currency';
import { formatCurrency } from '../utils';
import './SettleModal.css';
import './TransferExplainer.css';

interface TransferExplainerProps {
  /** The group the payment is suggested in. */
  groupId: string;
  /** The suggested payment being explained. */
  transfer: SettlementTransaction;
  /** Shows the group's name, for screens that list payments from several groups. */
  showGroup?: boolean;
  onClose: () => void;
}

/** "A", "A and B", "A, B and C". */
const listNames = (names: string[]) =>
  names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;

/**
 * Shows why a suggested payment exists: the payer's direct debts in the group,
 * expense by expense, and how simplifying turned them into this payment.
 */
export default function TransferExplainer({ groupId, transfer, showGroup = false, onClose }: TransferExplainerProps) {
  const users = useStore((s) => s.users);
  const group = useStore((s) => s.groups.find((g) => g.id === groupId));
  const allExpenses = useStore((s) => s.expenses);
  const allSettlements = useStore((s) => s.settlements);
  const me = useStore(selectCurrentUser)?.id ?? '';

  // The group's suggested payments and who owes whom directly, as on its screen.
  const { transfers, direct } = useMemo(() => {
    const snapshot = {
      expenses: allExpenses.filter((e) => e.groupId === groupId),
      settlements: allSettlements.filter((s) => s.groupId === groupId),
      memberIds: group?.members.map((m) => m.userId) ?? [],
    };
    return { transfers: groupTransfers(snapshot, simplifies(group)), direct: directDebts(snapshot) };
  }, [allExpenses, allSettlements, groupId, group]);

  const payer = users.find((u) => u.id === transfer.from);
  const recipient = users.find((u) => u.id === transfer.to);
  if (!payer || !recipient || !group) return null;

  const currency = groupCurrency(group);
  // First names, unless two members share one ("Frank" and "Frank Jr").
  const firsts = group.members.map((m) => users.find((u) => u.id === m.userId)?.name.split(' ')[0]);
  const nameOf = (uid: string, lower = false) => {
    if (uid === me) return lower ? 'you' : 'You';
    const name = users.find((u) => u.id === uid)?.name;
    if (!name) return 'Unknown';
    const first = name.split(' ')[0];
    return firsts.filter((f) => f === first).length > 1 ? name : first;
  };

  const verb = (uid: string, you: string, other: string) => (uid === me ? you : other);
  const fmt = (n: number) => formatCurrency(n, currency);

  const payerName = nameOf(transfer.from);
  const recipientName = nameOf(transfer.to, true);

  // The payer's own direct debts: what they owe first, then what they're owed.
  const owes = direct.filter((d) => d.from === transfer.from);
  const owed = direct.filter((d) => d.to === transfer.from);
  const directToRecipient = owes.find((d) => d.to === transfer.to)?.amount ?? 0;
  const isDirect = Math.abs(directToRecipient - transfer.amount) < 0.005;

  // People the payer owes but won't be paying, because the money goes elsewhere.
  const paidByPayer = transfers.filter((t) => t.from === transfer.from);
  const rerouted = owes.filter((d) => !paidByPayer.some((t) => t.to === d.to)).map((d) => nameOf(d.to));
  const otherLegs = paidByPayer.filter((t) => t.to !== transfer.to);

  const title = `Why ${payerName} ${verb(transfer.from, 'pay', 'pays')} ${recipientName} ${fmt(transfer.amount)}`;

  let summary: string;
  if (isDirect) {
    summary = `${payerName} ${verb(transfer.from, 'owe', 'owes')} ${recipientName} this directly, from the expenses below.`;
  } else if (directToRecipient > 0) {
    summary =
      `${payerName} ${verb(transfer.from, 'owe', 'owes')} ${recipientName} ${fmt(directToRecipient)} directly. ` +
      'The rest is money owed to other people, sent this way to keep the number of payments down.';
  } else {
    summary =
      `${payerName} ${verb(transfer.from, "don't", "doesn't")} owe ${recipientName} anything directly. ` +
      'This is money owed to other people, sent this way to keep the number of payments down.';
  }

  const renderDebt = (d: (typeof direct)[number]) => (
    <div key={`${d.from}-${d.to}`} className="tx-debt">
      <div className="tx-debt-head">
        <span>
          {nameOf(d.from)} {verb(d.from, 'owe', 'owes')} {nameOf(d.to, true)}
        </span>
        <span className="num tx-debt-amount">{fmt(d.amount)}</span>
      </div>
      <ul className="tx-items">
        {d.items.map((item, i) => (
          <li key={`${item.id}-${i}`} className="tx-item">
            <span className="tx-item-name">{item.kind === 'payment' ? 'Payment made' : item.description}</span>
            <span className="num tx-item-amount">{item.amount < 0 ? `−${fmt(-item.amount)}` : fmt(item.amount)}</span>
          </li>
        ))}
      </ul>
    </div>
  );

  return (
    <motion.div
      className="modal-overlay"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      onClick={onClose}
    >
      <motion.div
        className="settle-modal"
        role="dialog"
        aria-label={title}
        initial={{ y: '100%', opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        exit={{ y: '100%', opacity: 0 }}
        transition={{ type: 'spring', damping: 28, stiffness: 300 }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-handle" />

        <div className="modal-header">
          <div className="modal-avatars">
            <Avatar user={payer} size="lg" showRing={transfer.from === me} />
            <div className="modal-arrow">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden>
                <path d="M5 12H19M14 7L19 12L14 17" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </div>
            <Avatar user={recipient} size="lg" showRing={transfer.to === me} />
          </div>
          <h2 className="modal-title">{title}</h2>
          <p className="text-secondary text-sm">{summary}</p>
          {showGroup && <span className="modal-group-chip">{group.name}</span>}
        </div>

        <div className="tx-debts">
          {owes.map(renderDebt)}
          {owed.map(renderDebt)}
        </div>

        {!isDirect && (
          <div className="tx-explain text-sm">
            <p>
              Overall, {nameOf(transfer.from, true)}{' '}
              {verb(transfer.from, 'owe', 'owes')} {fmt(paidByPayer.reduce((s, t) => s + t.amount, 0))} in this group.
              {rerouted.length > 0 && (
                <>
                  {' '}Instead of paying {listNames(rerouted)}, {nameOf(transfer.from, true)}{' '}
                  {verb(transfer.from, 'pay', 'pays')} {recipientName}
                  {otherLegs.length > 0 &&
                    ` (and ${listNames(otherLegs.map((t) => `${fmt(t.amount)} to ${nameOf(t.to, true)}`))})`}
                  .
                </>
              )}
            </p>
            <p className="text-secondary">
              The rest of the group's payments shift to match. Nobody pays or receives more in total. The money
              just takes fewer steps.
            </p>
          </div>
        )}

        <button className="btn btn-secondary tx-close" onClick={onClose}>
          Got it
        </button>
      </motion.div>
    </motion.div>
  );
}
