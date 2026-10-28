import { useEffect, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import Avatar from './Avatar';
import { useStore, selectCurrentUser } from '../store';
import { round } from '../lib/calculations';
import { formatCurrency } from '../utils';
import { currencySymbol } from '../lib/currency';
import type { PaymentMethod } from '../types';
import './SettleModal.css';

const paymentMethods: { id: PaymentMethod; label: string }[] = [
  { id: 'venmo', label: 'Venmo' },
  { id: 'cashapp', label: 'Cash App' },
  { id: 'zelle', label: 'Zelle' },
  { id: 'cash', label: 'Cash' },
];

interface SettleModalProps {
  /** Who owes the money / is making the payment. */
  fromUserId: string;
  /** Who is owed the money / receives the payment. */
  toUserId: string;
  /** Outstanding balance between them — the default and maximum amount. */
  amount: number;
  /** What `amount` and the payment are in. */
  currency: string;
  /** Shown as context when settling inside a group. */
  groupLabel?: string;
  onClose: () => void;
  onConfirm: (amount: number, method: PaymentMethod) => void;
}

export default function SettleModal({
  fromUserId,
  toUserId,
  amount,
  currency,
  groupLabel,
  onClose,
  onConfirm,
}: SettleModalProps) {
  const [method, setMethod] = useState<PaymentMethod>('venmo');
  const [rawAmount, setRawAmount] = useState(amount.toFixed(2));
  const [confirmed, setConfirmed] = useState(false);
  const [paidAmount, setPaidAmount] = useState(amount);
  const closeTimer = useRef<ReturnType<typeof setTimeout>>();

  const users = useStore((s) => s.users);
  const currentUser = useStore(selectCurrentUser)!;
  const payer = users.find((u) => u.id === fromUserId);
  const recipient = users.find((u) => u.id === toUserId);

  useEffect(() => () => clearTimeout(closeTimer.current), []);

  if (!payer || !recipient) return null;

  const iAmPayer = fromUserId === currentUser.id;
  const iAmRecipient = toUserId === currentUser.id;
  /** The person on the other side of the payment, from the current user's view. */
  const other = iAmPayer ? recipient : payer;
  const otherName = other.name.split(' ')[0];

  const parsed = Number.parseFloat(rawAmount);
  const overMax = Number.isFinite(parsed) && parsed > amount + 0.005;
  const validAmount = Number.isFinite(parsed) && parsed > 0.005 && !overMax;
  const remaining = validAmount ? round(amount - parsed) : amount;
  const settlesUp = validAmount && remaining <= 0.005;

  const handleConfirm = () => {
    if (!validAmount) return;
    const settledAmount = round(parsed);
    setPaidAmount(settledAmount);
    onConfirm(settledAmount, method);
    setConfirmed(true);
    closeTimer.current = setTimeout(onClose, 1800);
  };

  const title =
    iAmPayer ? `Pay ${otherName}`
    : iAmRecipient ? `${otherName} paid you`
    : `${payer.name.split(' ')[0]} paid ${recipient.name.split(' ')[0]}`;

  const subtitle =
    iAmPayer
      ? `You owe ${otherName} ${formatCurrency(amount, currency)}`
      : iAmRecipient
        ? `${otherName} owes you ${formatCurrency(amount, currency)}`
        : `${payer.name.split(' ')[0]} owes ${recipient.name.split(' ')[0]} ${formatCurrency(amount, currency)}`;

  // With an unusable amount the button is disabled, so it drops the figure rather
  // than advertising a $0.00 payment.
  const sum = validAmount ? ` ${formatCurrency(parsed, currency)}` : '';
  const confirmLabel =
    iAmPayer ? `Pay${sum}`
    : iAmRecipient ? `Mark${sum} received`
    : `Record${sum} payment`;

  const successTitle =
    iAmRecipient ? 'Payment received'
    : 'Payment recorded';

  const settledWith = iAmPayer || iAmRecipient
    ? `you're all square with ${otherName}`
    : `${payer.name.split(' ')[0]} and ${recipient.name.split(' ')[0]} are square`;

  const successDetail = settlesUp
    ? `${formatCurrency(paidAmount, currency)} settled — ${settledWith}`
    : `${formatCurrency(paidAmount, currency)} recorded · ${formatCurrency(remaining, currency)} still outstanding`;

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
        initial={{ y: '100%', opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        exit={{ y: '100%', opacity: 0 }}
        transition={{ type: 'spring', damping: 28, stiffness: 300 }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-handle" />

        <AnimatePresence mode="wait">
          {confirmed ? (
            <motion.div
              key="success"
              className="settle-success"
              initial={{ scale: 0.8, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              transition={{ type: 'spring', damping: 20 }}
            >
              <motion.div
                className="success-checkmark"
                initial={{ scale: 0 }}
                animate={{ scale: 1 }}
                transition={{ delay: 0.1, type: 'spring', damping: 15 }}
              >
                <svg width="32" height="32" viewBox="0 0 24 24" fill="none">
                  <path d="M20 6L9 17L4 12" stroke="white" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </motion.div>
              <h3>{successTitle}</h3>
              <p className="text-secondary text-sm">{successDetail}</p>
            </motion.div>
          ) : (
            <motion.div key="form" initial={{ opacity: 1 }} exit={{ opacity: 0 }}>
              <div className="modal-header">
                <div className="modal-avatars">
                  <Avatar user={payer} size="lg" showRing={iAmPayer} />
                  <div className="modal-arrow">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
                      <path d="M5 12H19M14 7L19 12L14 17" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  </div>
                  <Avatar user={recipient} size="lg" showRing={iAmRecipient} />
                </div>
                <h2 className="modal-title">{title}</h2>
                <p className="text-secondary text-sm">{subtitle}</p>
                {groupLabel && <span className="modal-group-chip">{groupLabel}</span>}
              </div>

              <div className="modal-amount-field">
                <div className="modal-amount">
                  <span className="amount-currency">{currencySymbol(currency)}</span>
                  <input
                    className="amount-input"
                    value={rawAmount}
                    onChange={(e) => setRawAmount(e.target.value.replace(/[^\d.]/g, ''))}
                    onFocus={(e) => e.target.select()}
                    inputMode="decimal"
                    aria-label="Payment amount"
                    size={Math.max(rawAmount.length, 1)}
                  />
                </div>
                <div className="amount-hint">
                  {overMax ? (
                    <span className="text-red text-xs">
                      Only {formatCurrency(amount, currency)} is outstanding
                    </span>
                  ) : !validAmount ? (
                    <span className="text-red text-xs">Enter an amount</span>
                  ) : settlesUp ? (
                    <span className="text-green text-xs">Settles this balance in full</span>
                  ) : (
                    <>
                      <span className="text-xs text-secondary">
                        Partial · {formatCurrency(remaining, currency)} will remain
                      </span>
                      <button className="amount-full-btn" onClick={() => setRawAmount(amount.toFixed(2))}>
                        Full amount
                      </button>
                    </>
                  )}
                </div>
              </div>

              <div className="payment-methods">
                <p className="text-sm text-secondary" style={{ marginBottom: 10 }}>
                  {iAmPayer ? 'Pay via' : 'Paid via'}
                </p>
                <div className="payment-grid">
                  {paymentMethods.map((pm) => (
                    <button
                      key={pm.id}
                      className={`payment-method-btn ${method === pm.id ? 'active' : ''}`}
                      aria-pressed={method === pm.id}
                      onClick={() => setMethod(pm.id)}
                    >
                      {pm.label}
                    </button>
                  ))}
                </div>
              </div>


              <div className="modal-actions">
                <button className="modal-cancel" onClick={onClose}>Cancel</button>
                <motion.button
                  className="modal-confirm"
                  onClick={handleConfirm}
                  disabled={!validAmount}
                  whileTap={{ scale: 0.97 }}
                >
                  {confirmLabel}
                </motion.button>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </motion.div>
    </motion.div>
  );
}
