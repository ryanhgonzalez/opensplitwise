import { useState, useRef, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useStore, selectCurrentUser } from '../store';
import { firstGrapheme } from '../lib/emoji';
import type { GroupType } from '../types';
import Avatar from './Avatar';
import '../styles/sheet.css';
import './CreateGroupSheet.css';

const PRESET_COLORS = ['#7c3aed', '#0ea5e9', '#10b981', '#f59e0b', '#ec4899', '#ef4444'];
const GROUP_TYPES: { value: GroupType; label: string }[] = [
  { value: 'home',    label: 'Home' },
  { value: 'trip',    label: 'Trip' },
  { value: 'work',    label: 'Work' },
  { value: 'event',   label: 'Event' },
  { value: 'other',   label: 'Other' },
];

interface CreateGroupSheetProps {
  open: boolean;
  onClose: () => void;
  onCreated: (groupId: string) => void;
}

export default function CreateGroupSheet({ open, onClose, onCreated }: CreateGroupSheetProps) {
  const currentUser = useStore(selectCurrentUser)!;
  const users = useStore(s => s.users);
  const createGroup = useStore(s => s.createGroup);
  const addUser = useStore(s => s.addUser);

  const [name, setName] = useState('');
  const [emoji, setEmoji] = useState('🏠');
  const [color, setColor] = useState('#7c3aed');
  const [type, setType] = useState<GroupType>('other');
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [newPersonName, setNewPersonName] = useState('');
  const [showNewPerson, setShowNewPerson] = useState(false);
  const [showEmojiInput, setShowEmojiInput] = useState(false);
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

  const toggleMember = (id: string) =>
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const handleAddNewPerson = () => {
    if (!newPersonName.trim()) return;
    const user = addUser({ name: newPersonName.trim() });
    setSelectedIds(prev => new Set(prev).add(user.id));
    setNewPersonName('');
    setShowNewPerson(false);
  };

  const handleCreate = () => {
    if (!name.trim()) return;
    const members = [
      { userId: currentUser.id, role: 'owner' as const, joinedAt: new Date() },
      ...Array.from(selectedIds).map(id => ({
        userId: id,
        role: 'member' as const,
        joinedAt: new Date(),
      })),
    ];
    const group = createGroup({ name: name.trim(), emoji, color, type, members });
    handleClose();
    onCreated(group.id);
  };

  const handleClose = () => {
    setName('');
    setEmoji('🏠');
    setColor('#7c3aed');
    setType('other');
    setSelectedIds(new Set());
    setNewPersonName('');
    setShowNewPerson(false);
    setShowEmojiInput(false);
    onClose();
  };

  const canCreate = name.trim().length > 0;

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="sheet-overlay"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          onClick={handleClose}
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
              <span className="sheet-title">New Group</span>
              <button className="sheet-close" onClick={handleClose} aria-label="Close">
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
                    placeholder="Apartment, Road Trip, …"
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

                {/* Current user always included */}
                <div className="cgs-member-row cgs-member-you">
                  <Avatar user={currentUser} size="sm" showRing />
                  <span className="cgs-member-name">You</span>
                  <span className="cgs-member-badge">Owner</span>
                </div>

                {users.filter(u => u.id !== currentUser.id).map(u => (
                  <button
                    key={u.id}
                    className={`cgs-member-row ${selectedIds.has(u.id) ? 'selected' : ''}`}
                    onClick={() => toggleMember(u.id)}
                  >
                    <Avatar user={u} size="sm" />
                    <span className="cgs-member-name">{u.name}</span>
                    <div className={`cgs-checkbox ${selectedIds.has(u.id) ? 'checked' : ''}`}>
                      {selectedIds.has(u.id) && (
                        <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
                          <path d="M2 5L4 7L8 3" stroke="white" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                      )}
                    </div>
                  </button>
                ))}

                {/* Add new person */}
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
                      <button
                        className="cgs-add-confirm"
                        onClick={handleAddNewPerson}
                        disabled={!newPersonName.trim()}
                      >
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
            </div>

            <div className="sheet-footer">
              <button className="sheet-cta" onClick={handleCreate} disabled={!canCreate}>
                Create Group {selectedIds.size > 0 ? `with ${selectedIds.size + 1} people` : ''}
              </button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
