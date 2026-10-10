import { useState, useRef, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useStore, selectCurrentUser } from '../store';
import { firstGrapheme } from '../lib/emoji';
import { MAX_CATEGORY_NAME, cleanCategoryName, findCategoryByName } from '../lib/categories';
import type { CustomCategoryId, Group, GroupType } from '../types';
import Avatar from './Avatar';
import '../styles/sheet.css';
import './CreateGroupSheet.css';
import './EditGroupSheet.css';

const PRESET_COLORS = ['#7c3aed', '#0ea5e9', '#10b981', '#f59e0b', '#ec4899', '#ef4444'];
const GROUP_TYPES: { value: GroupType; label: string }[] = [
  { value: 'home',    label: 'Home' },
  { value: 'trip',    label: 'Trip' },
  { value: 'work',    label: 'Work' },
  { value: 'event',   label: 'Event' },
  { value: 'other',   label: 'Other' },
];

interface EditGroupSheetProps {
  open: boolean;
  onClose: () => void;
  group: Group;
  onDeleted: () => void;
}

export default function EditGroupSheet({ open, onClose, group, onDeleted }: EditGroupSheetProps) {
  const currentUser = useStore(selectCurrentUser)!;
  const users = useStore(s => s.users);
  const updateGroup = useStore(s => s.updateGroup);
  const deleteGroup = useStore(s => s.deleteGroup);
  const addUser = useStore(s => s.addUser);
  const addGroupMember = useStore(s => s.addGroupMember);
  const removeGroupMember = useStore(s => s.removeGroupMember);
  const addGroupCategory = useStore(s => s.addGroupCategory);
  const removeGroupCategory = useStore(s => s.removeGroupCategory);
  const expenses = useStore(s => s.expenses);

  const [name, setName] = useState(group.name);
  const [emoji, setEmoji] = useState(group.emoji);
  const [color, setColor] = useState(group.color);
  const [type, setType] = useState<GroupType>(group.type);
  const [memberIds, setMemberIds] = useState<Set<string>>(
    new Set(group.members.map(m => m.userId))
  );
  const [newPersonName, setNewPersonName] = useState('');
  const [showNewPerson, setShowNewPerson] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [showEmojiInput, setShowEmojiInput] = useState(false);
  // Category changes, like member changes, apply on Save.
  const [removedCategories, setRemovedCategories] = useState<Set<CustomCategoryId>>(new Set());
  const [addedCategories, setAddedCategories] = useState<string[]>([]);
  const [newCategoryName, setNewCategoryName] = useState('');
  const newPersonRef = useRef<HTMLInputElement>(null);
  const emojiInputRef = useRef<HTMLInputElement>(null);
  const emojiBtnWrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!showEmojiInput) return;
    setTimeout(() => emojiInputRef.current?.focus(), 50);
    const handler = (e: MouseEvent) => {
      if (!emojiBtnWrapRef.current?.contains(e.target as Node)) setShowEmojiInput(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [showEmojiInput]);

  const friends = users.filter(u => u.id !== currentUser.id);

  const categoryUse = (id: CustomCategoryId) =>
    expenses.filter(e => e.groupId === group.id && e.category === id).length;

  const toggleRemoveCategory = (id: CustomCategoryId) =>
    setRemovedCategories(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const handleAddCategory = () => {
    const name = cleanCategoryName(newCategoryName);
    const taken =
      findCategoryByName(name, group) !== undefined ||
      addedCategories.some(n => n.toLowerCase() === name.toLowerCase());
    if (name && !taken) setAddedCategories(prev => [...prev, name]);
    setNewCategoryName('');
  };

  const toggleMember = (id: string) => {
    setMemberIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleAddNewPerson = () => {
    if (!newPersonName.trim()) return;
    const user = addUser({ name: newPersonName.trim() });
    setMemberIds(prev => new Set(prev).add(user.id));
    setNewPersonName('');
    setShowNewPerson(false);
  };

  const handleSave = () => {
    if (!name.trim()) return;

    updateGroup(group.id, { name: name.trim(), emoji, color, type });

    // Diff members: add newly selected, remove deselected.
    const origIds = new Set(group.members.map(m => m.userId));
    for (const id of memberIds) {
      if (!origIds.has(id)) addGroupMember(group.id, id);
    }
    for (const id of origIds) {
      if (!memberIds.has(id) && id !== currentUser.id) removeGroupMember(group.id, id);
    }

    for (const id of removedCategories) removeGroupCategory(group.id, id);
    for (const categoryName of addedCategories) addGroupCategory(group.id, categoryName);

    onClose();
  };

  const handleDelete = () => {
    onDeleted();
    deleteGroup(group.id);
  };

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
            className="sheet-panel"
            initial={{ y: '100%' }}
            animate={{ y: 0 }}
            exit={{ y: '100%' }}
            transition={{ type: 'spring', damping: 30, stiffness: 320 }}
            onClick={e => e.stopPropagation()}
          >
            <div className="sheet-handle" />
            <div className="sheet-header">
              <span className="sheet-title">Edit Group</span>
              <button className="sheet-close" onClick={onClose} aria-label="Close">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
                  <path d="M18 6L6 18M6 6L18 18" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
                </svg>
              </button>
            </div>

            <div className="sheet-body">
              {/* Name + emoji */}
              <div className="field-group">
                <div className="field-label">Group name</div>
                <div className="cgs-name-row">
                  <div className="cgs-emoji-btn-wrap" ref={emojiBtnWrapRef}>
                    <button
                      className="cgs-emoji-btn"
                      style={{ background: `color-mix(in srgb, ${color} 22%, var(--paper))` }}
                      aria-label="Choose emoji"
                      onClick={() => setShowEmojiInput(v => !v)}
                      title="Choose emoji"
                    >
                      {emoji}
                    </button>
                    {showEmojiInput && (
                      <div className="cgs-emoji-popover">
                        <input
                          ref={emojiInputRef}
                          className="cgs-emoji-input"
                          placeholder="Type any emoji…"
                          onChange={(e) => {
                            const first = firstGrapheme(e.target.value);
                            if (first) { setEmoji(first); setShowEmojiInput(false); }
                          }}
                          onKeyDown={(e) => e.key === 'Escape' && setShowEmojiInput(false)}
                        />
                        <p className="cgs-emoji-hint">Use your OS emoji keyboard or paste an emoji</p>
                      </div>
                    )}
                  </div>
                  <input
                    className="field-input"
                    style={{ flex: 1 }}
                    placeholder="Group name…"
                    value={name}
                    onChange={e => setName(e.target.value)}
                    autoFocus
                  />
                </div>
              </div>

              {/* Color */}
              <div className="field-group">
                <div className="field-label">Color</div>
                <div className="cgs-color-row">
                  {PRESET_COLORS.map(c => (
                    <button
                      key={c}
                      className={`cgs-color-dot ${color === c ? 'active' : ''}`}
                      style={{ background: `color-mix(in srgb, ${c} 22%, var(--paper))` }}
                      aria-pressed={color === c}
                      onClick={() => setColor(c)}
                      aria-label={`Color ${c}`}
                    />
                  ))}
                </div>
              </div>

              {/* Type */}
              <div className="field-group">
                <div className="field-label">Type</div>
                <div className="chip-row">
                  {GROUP_TYPES.map(t => (
                    <button
                      key={t.value}
                      className={`chip ${type === t.value ? 'active' : ''}`}
                      onClick={() => setType(t.value)}
                    >
                      {t.label}
                    </button>
                  ))}
                </div>
              </div>

              {/* Members */}
              <div className="field-group">
                <div className="field-label">Members</div>

                <div className="cgs-member-row cgs-member-you">
                  <Avatar user={currentUser} size="sm" showRing />
                  <span className="cgs-member-name">You</span>
                  <span className="cgs-member-badge">Owner</span>
                </div>

                {friends.map(u => (
                  <button
                    key={u.id}
                    className={`cgs-member-row ${memberIds.has(u.id) ? 'selected' : ''}`}
                    onClick={() => toggleMember(u.id)}
                  >
                    <Avatar user={u} size="sm" />
                    <span className="cgs-member-name">{u.name}</span>
                    <div className={`cgs-checkbox ${memberIds.has(u.id) ? 'checked' : ''}`}>
                      {memberIds.has(u.id) && (
                        <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
                          <path d="M2 5L4 7L8 3" stroke="white" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                      )}
                    </div>
                  </button>
                ))}

                <AnimatePresence>
                  {showNewPerson && (
                    <motion.div
                      initial={{ height: 0, opacity: 0 }}
                      animate={{ height: 'auto', opacity: 1 }}
                      exit={{ height: 0, opacity: 0 }}
                      transition={{ duration: 0.2 }}
                      className="cgs-new-person-row"
                    >
                      <input
                        ref={newPersonRef}
                        className="field-input"
                        style={{ flex: 1 }}
                        placeholder="Enter name…"
                        value={newPersonName}
                        onChange={e => setNewPersonName(e.target.value)}
                        onKeyDown={e => e.key === 'Enter' && handleAddNewPerson()}
                        autoFocus
                      />
                      <button className="cgs-add-confirm" onClick={handleAddNewPerson} disabled={!newPersonName.trim()}>
                        Add
                      </button>
                    </motion.div>
                  )}
                </AnimatePresence>

                <button
                  className="cgs-add-person-btn"
                  onClick={() => {
                    setShowNewPerson(true);
                    setTimeout(() => newPersonRef.current?.focus(), 50);
                  }}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
                    <path d="M12 5V19M5 12H19" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
                  </svg>
                  Add new person
                </button>
              </div>

              {/* Custom categories */}
              <div className="field-group">
                <div className="field-label">Categories</div>
                <p className="egs-cat-intro">
                  Made for this group, offered next to the built-in ones when adding an expense.
                </p>
                {(group.categories ?? []).map(c => {
                  const removed = removedCategories.has(c.id);
                  const used = categoryUse(c.id);
                  return (
                    <div key={c.id} className={`egs-cat-row ${removed ? 'removed' : ''}`}>
                      <div className="egs-cat-text">
                        <span className="egs-cat-name">{c.name}</span>
                        <span className="egs-cat-meta">
                          {removed
                            ? used > 0
                              ? `${used} ${used === 1 ? 'expense moves' : 'expenses move'} to Other when you save`
                              : 'Removed when you save'
                            : `${used} ${used === 1 ? 'expense' : 'expenses'}`}
                        </span>
                      </div>
                      <button
                        type="button"
                        className="egs-cat-action"
                        onClick={() => toggleRemoveCategory(c.id)}
                        aria-label={removed ? `Keep ${c.name}` : `Remove ${c.name}`}
                      >
                        {removed ? 'Undo' : 'Remove'}
                      </button>
                    </div>
                  );
                })}
                {addedCategories.map(n => (
                  <div key={n} className="egs-cat-row">
                    <div className="egs-cat-text">
                      <span className="egs-cat-name">{n}</span>
                      <span className="egs-cat-meta">Added when you save</span>
                    </div>
                    <button
                      type="button"
                      className="egs-cat-action"
                      onClick={() => setAddedCategories(prev => prev.filter(x => x !== n))}
                      aria-label={`Don't add ${n}`}
                    >
                      Undo
                    </button>
                  </div>
                ))}
                <form
                  className="cgs-new-person-row"
                  onSubmit={e => { e.preventDefault(); handleAddCategory(); }}
                >
                  <input
                    className="field-input"
                    style={{ flex: 1 }}
                    placeholder="New category…"
                    aria-label="New category name"
                    maxLength={MAX_CATEGORY_NAME}
                    value={newCategoryName}
                    onChange={e => setNewCategoryName(e.target.value)}
                  />
                  <button type="submit" className="cgs-add-confirm" disabled={!newCategoryName.trim()}>
                    Add
                  </button>
                </form>
              </div>

              {/* Danger zone */}
              <div className="egs-danger-zone">
                {!confirmDelete ? (
                  <button className="egs-delete-btn" onClick={() => setConfirmDelete(true)}>
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none">
                      <path d="M3 6H5H21M8 6V4C8 3.44772 8.44772 3 9 3H15C15.5523 3 16 3.44772 16 4V6M19 6L18.1671 19.1264C18.0723 20.6999 16.7622 22 15.1847 22H8.81535C7.23784 22 5.92769 20.6999 5.83286 19.1264L5 6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                    Delete Group
                  </button>
                ) : (
                  <motion.div
                    className="egs-confirm-row"
                    initial={{ opacity: 0, y: 4 }}
                    animate={{ opacity: 1, y: 0 }}
                  >
                    <p className="egs-confirm-text">Delete group and all its expenses?</p>
                    <div style={{ display: 'flex', gap: 8 }}>
                      <button className="egs-cancel-btn" onClick={() => setConfirmDelete(false)}>Cancel</button>
                      <button className="egs-confirm-delete-btn" onClick={handleDelete}>Delete</button>
                    </div>
                  </motion.div>
                )}
              </div>
            </div>

            <div className="sheet-footer">
              <button className="sheet-cta" onClick={handleSave} disabled={!name.trim()}>
                Save Changes
              </button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
