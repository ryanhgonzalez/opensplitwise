import { useEffect, useMemo, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Link } from 'react-router-dom';
import Avatar from './Avatar';
import { useStore, selectCurrentUser } from '../store';
import { formatCurrency } from '../utils';
import { buildReminder, payLinks, reminderItems, smsLink, type Tone } from '../lib/reminder';
import { contactPicker } from '../lib/contacts';
import type { ReminderSentActivity } from '../types';
import './SettleModal.css';
import './RemindSheet.css';

interface RemindSheetProps {
  /** Who owes you. */
  personId: string;
  amount: number;
  currency: string;
  /** The groups the debt sits in; the message names them and their expenses. */
  groupIds: string[];
  onClose: () => void;
}

const canShare = () => typeof navigator !== 'undefined' && typeof navigator.share === 'function';

export default function RemindSheet({ personId, amount, currency, groupIds, onClose }: RemindSheetProps) {
  const currentUser = useStore(selectCurrentUser)!;
  const users = useStore((s) => s.users);
  const groups = useStore((s) => s.groups);
  const expenses = useStore((s) => s.expenses);
  const settlements = useStore((s) => s.settlements);
  const updateUser = useStore((s) => s.updateUser);
  const logReminder = useStore((s) => s.logReminder);

  const person = users.find((u) => u.id === personId);
  const firstName = person?.name.split(' ')[0] ?? '';
  const groupNames = groupIds.map((id) => groups.find((g) => g.id === id)?.name).filter((n): n is string => !!n);

  const [tone, setTone] = useState<Tone>('friendly');
  const items = useMemo(
    () => reminderItems(expenses, settlements, personId, currentUser.id, groupIds),
    [expenses, settlements, personId, currentUser.id, groupIds],
  );
  const links = payLinks(currentUser.payHandles, amount, currency, groupNames.join(', '));
  const draft = (t: Tone) => buildReminder({ name: firstName, amount, currency, groupNames, items, tone: t, links });
  const [message, setMessage] = useState(() => draft('friendly'));

  const [addingPhone, setAddingPhone] = useState(false);
  const [phoneInput, setPhoneInput] = useState('');
  const [done, setDone] = useState<ReminderSentActivity['via'] | null>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => () => clearTimeout(closeTimer.current), []);

  if (!person) return null;

  const hasHandles = !!(currentUser.payHandles?.venmo || currentUser.payHandles?.cashapp || currentUser.payHandles?.paypal);
  const phone = person.phone?.trim();

  const pickTone = (t: Tone) => {
    setTone(t);
    setMessage(draft(t));
  };

  const finish = (via: ReminderSentActivity['via']) => {
    logReminder({ toUserId: personId, amount, currency, groupId: groupIds.length === 1 ? groupIds[0] : undefined, via });
    setDone(via);
    closeTimer.current = setTimeout(onClose, 2200);
  };

  const share = async () => {
    try {
      await navigator.share({ text: message });
      finish('share');
    } catch (e) {
      // Closing the share sheet without picking anything isn't a reminder.
      if ((e as Error).name !== 'AbortError') copy();
    }
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(message);
      finish('copy');
    } catch {
      // Clipboard blocked: leave the sheet open so the text can be selected by hand.
    }
  };

  const savePhone = (value: string) => {
    const clean = value.trim();
    if (!clean) return;
    updateUser(personId, { phone: clean });
    setAddingPhone(false);
    setPhoneInput('');
  };

  const pickContact = async () => {
    try {
      const [contact] = await contactPicker()!.select(['tel'], { multiple: false });
      const tel = contact?.tel?.[0];
      if (tel) savePhone(tel);
      else setAddingPhone(true);
    } catch {
      // Cancelled or refused: type it instead.
      setAddingPhone(true);
    }
  };

  const doneText = {
    text: { title: 'Messages is open', detail: `Check the message and tap send to remind ${firstName}.` },
    share: { title: 'Reminder shared', detail: `Noted in Activity: you reminded ${firstName} today.` },
    copy: { title: 'Message copied', detail: `Paste it wherever you talk to ${firstName}.` },
  };

  return (
    <motion.div className="modal-overlay" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={onClose}>
      <motion.div
        className="settle-modal"
        role="dialog"
        aria-label={`Remind ${firstName}`}
        initial={{ y: '100%', opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        exit={{ y: '100%', opacity: 0 }}
        transition={{ type: 'spring', damping: 28, stiffness: 300 }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-handle" />

        <AnimatePresence mode="wait">
          {done ? (
            <motion.div
              key="done"
              className="settle-success"
              initial={{ scale: 0.8, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              transition={{ type: 'spring', damping: 20 }}
            >
              <div className="success-checkmark">
                <svg width="32" height="32" viewBox="0 0 24 24" fill="none" aria-hidden>
                  <path d="M20 6L9 17L4 12" stroke="white" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </div>
              <h3>{doneText[done].title}</h3>
              <p className="text-secondary text-sm">{doneText[done].detail}</p>
            </motion.div>
          ) : (
            <motion.div key="form" initial={{ opacity: 1 }} exit={{ opacity: 0 }}>
              <div className="modal-header">
                <div className="modal-avatars">
                  <Avatar user={person} size="lg" />
                </div>
                <h2 className="modal-title">Remind {firstName}</h2>
                <p className="text-secondary text-sm">
                  {firstName} owes you {formatCurrency(amount, currency)}
                </p>
                {groupNames.length > 0 && <span className="modal-group-chip">{groupNames.join(' · ')}</span>}
              </div>

              <div className="remind-tone" role="radiogroup" aria-label="Tone">
                {(['friendly', 'firm'] as Tone[]).map((t) => (
                  <button
                    key={t}
                    role="radio"
                    aria-checked={tone === t}
                    className={`remind-tone-opt ${tone === t ? 'active' : ''}`}
                    onClick={() => pickTone(t)}
                  >
                    {t === 'friendly' ? 'Friendly' : 'Firm'}
                  </button>
                ))}
              </div>

              <label className="remind-label" htmlFor="remind-message">Message</label>
              <textarea
                id="remind-message"
                className="field-input remind-message"
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                rows={7}
              />
              {!hasHandles && (
                <p className="remind-hint">
                  Add your Venmo, Cash App or PayPal in <Link to="/settings">Settings</Link> to put a pay link in the message.
                </p>
              )}

              {!phone && (
                <div className="remind-phone">
                  {addingPhone ? (
                    <form
                      className="remind-phone-form"
                      onSubmit={(e) => {
                        e.preventDefault();
                        savePhone(phoneInput);
                      }}
                    >
                      <input
                        className="field-input"
                        type="tel"
                        inputMode="tel"
                        autoComplete="tel"
                        placeholder={`${firstName}'s number`}
                        aria-label={`${firstName}'s phone number`}
                        value={phoneInput}
                        onChange={(e) => setPhoneInput(e.target.value)}
                        autoFocus
                      />
                      <button className="btn btn-secondary" type="submit" disabled={!phoneInput.trim()}>
                        Save
                      </button>
                    </form>
                  ) : (
                    <button className="remind-link" onClick={() => (contactPicker() ? pickContact() : setAddingPhone(true))}>
                      Add {firstName}'s number to text them directly
                    </button>
                  )}
                </div>
              )}

              <div className="remind-actions">
                {phone && (
                  <a className="modal-confirm remind-primary" href={smsLink(phone, message)} onClick={() => finish('text')}>
                    Text {firstName}
                  </a>
                )}
                {canShare() && (
                  <button className={phone ? 'btn btn-secondary remind-secondary' : 'modal-confirm'} onClick={share}>
                    {phone ? 'Share another way…' : 'Share…'}
                  </button>
                )}
                <button
                  className={phone || canShare() ? 'btn btn-secondary remind-secondary' : 'modal-confirm'}
                  onClick={copy}
                >
                  Copy message
                </button>
                <button className="modal-cancel" onClick={onClose}>Cancel</button>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </motion.div>
    </motion.div>
  );
}
