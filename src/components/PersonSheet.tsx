import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useStore, selectCurrentUser, selectFriendBalancesByCurrency } from '../store';
import { groupCurrency } from '../lib/currency';
import Avatar from './Avatar';
import { formatCurrency } from '../utils';
import { calculateBalances } from '../lib/calculations';
import '../styles/sheet.css';
import './PersonSheet.css';

const AVATAR_COLORS = ['#7c3aed', '#0ea5e9', '#10b981', '#f59e0b', '#ec4899', '#ef4444', '#8b5cf6', '#06b6d4'];

interface PersonSheetProps {
  open: boolean;
  onClose: () => void;
  userId: string;
  groupId?: string;
}

export default function PersonSheet({ open, onClose, userId, groupId }: PersonSheetProps) {
  const currentUser = useStore(selectCurrentUser)!;
  const users = useStore(s => s.users);
  const groups = useStore(s => s.groups);
  const allExpenses = useStore(s => s.expenses);
  const allSettlements = useStore(s => s.settlements);
  const byCurrency = useStore(selectFriendBalancesByCurrency);
  const updateUser = useStore(s => s.updateUser);
  const deleteUser = useStore(s => s.deleteUser);
  const removeGroupMember = useStore(s => s.removeGroupMember);

  const person = users.find(u => u.id === userId);
  const group = groupId ? groups.find(g => g.id === groupId) : undefined;
  const isSelf = userId === currentUser.id;

  const [name, setName] = useState(person?.name ?? '');
  const [avatarColor, setAvatarColor] = useState(person?.avatarColor ?? '#7c3aed');
  const [confirmAction, setConfirmAction] = useState<'remove' | 'delete' | null>(null);

  if (!person) return null;
  if (groupId && !group) return null;

  // When in a specific group context, use per-group balance (in its currency).
  // Otherwise the overall balance, one per currency.
  const balances: { currency: string; amount: number }[] = group
    ? [{ currency: groupCurrency(group), amount: (() => {
        const groupExpenses = allExpenses.filter(e => e.groupId === groupId);
        const groupSettlements = allSettlements.filter(s => s.groupId === groupId);
        const memberIds = group.members.map(m => m.userId);
        const balances = calculateBalances({
          expenses: groupExpenses,
          memberIds,
          settlements: groupSettlements,
        });
        return balances[userId] ?? 0;
      })() }]
    : Object.entries(byCurrency).map(([currency, b]) => ({ currency, amount: b[userId] ?? 0 }));
  const unsettled = balances.filter(b => Math.abs(b.amount) >= 0.005);

  // Groups this person shares with the current user (for global view).
  const sharedGroups = group
    ? []
    : groups.filter(g =>
        g.members.some(m => m.userId === userId) &&
        g.members.some(m => m.userId === currentUser.id),
      );

  const handleSave = () => {
    const initials = name.trim().split(/\s+/).map(p => p[0]).join('').toUpperCase().slice(0, 2);
    updateUser(userId, { name: name.trim(), avatarColor, initials });
    onClose();
  };

  const handleRemoveFromGroup = () => {
    removeGroupMember(groupId!, userId);
    onClose();
  };

  const handleDeletePerson = () => {
    deleteUser(userId);
    onClose();
  };

  const expenseCount = allExpenses.filter(
    e => e.paidBy === userId || e.split.entries.some(en => en.userId === userId)
  ).length;

  const previewUser = { ...person, name: name || person.name, avatarColor };
  const settled = unsettled.length === 0;
  // The colour follows the larger balance when there are several currencies.
  const lead = [...unsettled].sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount))[0];
  const firstName = person.name.split(' ')[0];

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="sheet-overlay"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          onClick={onClose}
        >
          <motion.div
            className="sheet-panel ps-panel"
            role="dialog"
            aria-label={isSelf ? 'Your profile' : person.name}
            initial={{ y: '100%' }}
            animate={{ y: 0 }}
            exit={{ y: '100%' }}
            transition={{ type: 'spring', damping: 32, stiffness: 340 }}
            onClick={e => e.stopPropagation()}
          >
            <div className="sheet-handle" />
            <div className="sheet-header">
              <span className="sheet-title">{isSelf ? 'Your profile' : 'Person'}</span>
              <button className="sheet-close" onClick={onClose} aria-label="Close">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden>
                  <path d="M18 6L6 18M6 6L18 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                </svg>
              </button>
            </div>

            <div className="sheet-body">
              {/* Identity */}
              <div className="ps-identity">
                <Avatar user={previewUser} size="xl" />
                <div className="ps-identity-text">
                  <span className="ps-name">{name || person.name}</span>
                  {!isSelf && (
                    <span className={`ps-balance ${settled ? 'zero' : `num ${lead.amount > 0 ? 'pos' : 'neg'}`}`}>
                      {settled
                        ? `Settled up${group ? ` in ${group.name}` : ''}`
                        : `${unsettled
                            .map(b => `${b.amount > 0 ? 'owes you' : 'you owe'} ${formatCurrency(b.amount, b.currency)}`)
                            .join(' · ')}${group ? ` in ${group.name}` : ' overall'}`}
                    </span>
                  )}
                </div>
              </div>

              {/* Name */}
              <div className="field-group">
                <label className="field-label" htmlFor="ps-name">Name</label>
                <input
                  id="ps-name"
                  className="field-input"
                  value={name}
                  onChange={e => setName(e.target.value)}
                  placeholder="Full name"
                />
              </div>

              {/* Avatar colour */}
              <fieldset className="field-group ps-fieldset">
                <legend className="field-label">Color</legend>
                <div className="ps-color-row">
                  {AVATAR_COLORS.map(c => (
                    <button
                      key={c}
                      type="button"
                      className={`ps-color-dot ${avatarColor === c ? 'active' : ''}`}
                      style={{ background: `color-mix(in srgb, ${c} 22%, var(--paper))` }}
                      onClick={() => setAvatarColor(c)}
                      aria-label={`Color ${c}`}
                      aria-pressed={avatarColor === c}
                    />
                  ))}
                </div>
              </fieldset>

              {/* Shared groups (global view only) */}
              {sharedGroups.length > 0 && (
                <div className="field-group">
                  <div className="field-label">Shared groups</div>
                  <div className="ruled">
                    {sharedGroups.map(g => (
                      <div key={g.id} className="ps-group-row">
                        <span aria-hidden>{g.emoji}</span>
                        <span>{g.name}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Actions (non-self only) */}
              {!isSelf && (
                <div className="ps-actions">
                  {confirmAction === null && (
                    <>
                      {group && (
                        <button className="btn btn-secondary" onClick={() => setConfirmAction('remove')}>
                          Remove from {group.name}
                        </button>
                      )}
                      <button className="btn btn-danger" onClick={() => setConfirmAction('delete')}>
                        Delete {firstName} everywhere
                      </button>
                    </>
                  )}

                  <AnimatePresence>
                    {confirmAction === 'remove' && group && (
                      <motion.div
                        className="ps-confirm-box"
                        role="alertdialog"
                        initial={{ opacity: 0, y: 6 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, y: 6 }}
                      >
                        <p className="ps-confirm-text">
                          Remove <strong>{firstName}</strong> from {group.name}?
                          Their expenses in this group will remain.
                        </p>
                        <div className="ps-confirm-btns">
                          <button className="btn btn-secondary" onClick={() => setConfirmAction(null)}>Cancel</button>
                          <button className="btn btn-danger-solid" onClick={handleRemoveFromGroup}>Remove</button>
                        </div>
                      </motion.div>
                    )}
                    {confirmAction === 'delete' && (
                      <motion.div
                        className="ps-confirm-box"
                        role="alertdialog"
                        initial={{ opacity: 0, y: 6 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, y: 6 }}
                      >
                        <p className="ps-confirm-text">
                          Permanently delete <strong>{person.name}</strong>?{' '}
                          This will also delete {expenseCount} expense{expenseCount !== 1 ? 's' : ''} involving them and cannot be undone.
                        </p>
                        <div className="ps-confirm-btns">
                          <button className="btn btn-secondary" onClick={() => setConfirmAction(null)}>Cancel</button>
                          <button className="btn btn-danger-solid" onClick={handleDeletePerson}>Delete</button>
                        </div>
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>
              )}
            </div>

            <div className="sheet-footer">
              <button className="sheet-cta" onClick={handleSave} disabled={!name.trim()}>
                Save changes
              </button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
