import { useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useStore } from '../store';
import { parseAndValidate } from '../lib/dataExport';
import type { GroupType } from '../types';
import { localeCurrency } from '../lib/currency';
import CurrencySelect from '../components/CurrencySelect';
import './Onboarding.css';

const features = [
  { title: 'Track shared expenses', body: 'Log any expense and split it any way you like — equally, by amount, or by percentage.' },
  { title: 'Settle up with friends', body: 'See exactly who owes what at a glance and record payments when debts are cleared.' },
  { title: 'Understand your spending', body: 'Charts and breakdowns show where your money goes across all your groups.' },
];

const GROUP_EMOJIS = ['🏠', '✈️', '🍽️', '🎉', '💼', '🏖️', '🎓', '⚽'];
const PRESET_COLORS = ['#7c3aed', '#0ea5e9', '#10b981', '#f59e0b', '#ec4899', '#ef4444'];
const GROUP_TYPES: { value: GroupType; label: string }[] = [
  { value: 'home', label: 'Home' },
  { value: 'trip', label: 'Trip' },
  { value: 'work', label: 'Work' },
  { value: 'event', label: 'Event' },
  { value: 'other', label: 'Other' },
];

const container = {
  hidden: { opacity: 0 },
  show: { opacity: 1, transition: { staggerChildren: 0.1, delayChildren: 0.2 } },
};

const item = {
  hidden: { opacity: 0, y: 20 },
  show: { opacity: 1, y: 0, transition: { duration: 0.5, ease: [0.4, 0, 0.2, 1] as [number, number, number, number] } },
};

export default function Onboarding() {
  const completeOnboarding = useStore((s) => s.completeOnboarding);
  const restoreAllData = useStore((s) => s.restoreAllData);

  const [step, setStep] = useState<'name' | 'group'>('name');
  const [name, setName] = useState('');
  const [importError, setImportError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  // First-group state
  const [groupName, setGroupName] = useState('');
  const [emoji, setEmoji] = useState('🏠');
  const [color, setColor] = useState('#7c3aed');
  const [type, setType] = useState<GroupType>('other');
  const [currency, setCurrency] = useState(localeCurrency);
  const [people, setPeople] = useState<string[]>([]);
  const [personDraft, setPersonDraft] = useState('');

  const handleContinue = () => {
    if (!name.trim()) return;
    setStep('group');
  };

  const finish = (withGroup: boolean) => {
    const trimmed = name.trim();
    if (!trimmed) return;

    // Establishes the current user synchronously so createGroup can reference it.
    completeOnboarding(trimmed);

    if (withGroup && groupName.trim()) {
      const { createGroup, addUser } = useStore.getState();
      const memberIds = people
        .map((p) => p.trim())
        .filter(Boolean)
        .map((p) => addUser({ name: p }).id);
      const currentUserId = useStore.getState().currentUserId;
      createGroup({
        name: groupName.trim(),
        emoji,
        color,
        type,
        currency,
        members: [
          { userId: currentUserId, role: 'owner', joinedAt: new Date() },
          ...memberIds.map((id) => ({ userId: id, role: 'member' as const, joinedAt: new Date() })),
        ],
      });
    }
  };

  const addPerson = () => {
    const t = personDraft.trim();
    if (!t) return;
    setPeople((prev) => [...prev, t]);
    setPersonDraft('');
  };

  const removePerson = (index: number) =>
    setPeople((prev) => prev.filter((_, i) => i !== index));

  const handleImportFile = (file: File) => {
    setImportError(null);
    if (!file.name.endsWith('.json') && file.type !== 'application/json') {
      setImportError('Please choose a .json backup file.');
      return;
    }
    const reader = new FileReader();
    reader.onload = (e) => {
      const result = parseAndValidate(e.target?.result as string);
      if (result.ok && result.data) {
        restoreAllData(result.data.data);
      } else {
        setImportError(result.errors[0] ?? 'That file could not be read as an OpenSplitwise backup.');
      }
    };
    reader.readAsText(file);
  };

  return (
    <div className="ob-root">

      <input
        ref={fileRef}
        type="file"
        accept="application/json,.json"
        style={{ display: 'none' }}
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) handleImportFile(file);
          e.target.value = '';
        }}
      />

      <AnimatePresence mode="wait">
        {step === 'name' ? (
          <motion.div
            key="name"
            className="ob-card"
            variants={container}
            initial="hidden"
            animate="show"
            exit={{ opacity: 0, y: -12, transition: { duration: 0.2 } }}
          >
            {/* Heading */}
            <motion.div className="ob-heading" variants={item}>
              <h1 className="ob-title">Welcome to OpenSplitwise</h1>
              <p className="ob-subtitle">Split expenses with anyone, settle up without the awkwardness.</p>
            </motion.div>

            {/* Feature highlights */}
            <motion.div className="ob-features" variants={item}>
              {features.map((f, i) => (
                <div className="ob-feature" key={f.title}>
                  <span className="ob-feature-icon">{String(i + 1).padStart(2, '0')}</span>
                  <div>
                    <p className="ob-feature-title">{f.title}</p>
                    <p className="ob-feature-body">{f.body}</p>
                  </div>
                </div>
              ))}
            </motion.div>

            {/* Name input */}
            <motion.div className="ob-form" variants={item}>
              <label className="ob-label" htmlFor="ob-name">What should we call you?</label>
              <input
                id="ob-name"
                className="ob-input"
                type="text"
                placeholder="Your name…"
                value={name}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleContinue()}
                autoFocus
                autoComplete="given-name"
                maxLength={40}
              />
              <motion.button
                className="ob-cta"
                onClick={handleContinue}
                disabled={!name.trim()}
                whileTap={{ scale: 0.97 }}
              >
                Continue
              </motion.button>

              {importError && <p className="ob-import-error">{importError}</p>}

              <div className="ob-divider"><span>or</span></div>

              <button className="ob-secondary" onClick={() => fileRef.current?.click()}>
                Open a shared or backed-up file
              </button>
              <p className="ob-secondary-hint">
                Switching devices, or has someone shared their expenses with you? Import their
                OpenSplitwise&nbsp;.json — you&apos;ll pick which person you are next.
              </p>
            </motion.div>
          </motion.div>
        ) : (
          <motion.div
            key="group"
            className="ob-card"
            variants={container}
            initial="hidden"
            animate="show"
            exit={{ opacity: 0, y: -12, transition: { duration: 0.2 } }}
          >
            <motion.div className="ob-heading" variants={item}>
              <div className="ob-group-preview" style={{ background: `color-mix(in srgb, ${color} 22%, var(--paper))` }}>
                {emoji}
              </div>
              <h1 className="ob-title">Create your first group</h1>
              <p className="ob-subtitle">Groups are where you track expenses with the same set of people.</p>
            </motion.div>

            <motion.div className="ob-form" variants={item}>
              {/* Group name */}
              <label className="ob-label" htmlFor="ob-group-name">Group name</label>
              <input
                id="ob-group-name"
                className="ob-input"
                type="text"
                placeholder="Apartment, Road Trip, …"
                value={groupName}
                onChange={(e) => setGroupName(e.target.value)}
                autoFocus
                maxLength={40}
              />

              {/* Emoji */}
              <span className="ob-label">Icon</span>
              <div className="ob-chip-row">
                {GROUP_EMOJIS.map((em) => (
                  <button
                    key={em}
                    className={`ob-emoji-dot ${emoji === em ? 'active' : ''}`}
                    onClick={() => setEmoji(em)}
                    aria-label={em}
                  >
                    {em}
                  </button>
                ))}
              </div>

              {/* Color */}
              <span className="ob-label">Color</span>
              <div className="ob-chip-row">
                {PRESET_COLORS.map((c) => (
                  <button
                    key={c}
                    className={`ob-color-dot ${color === c ? 'active' : ''}`}
                    style={{ background: `color-mix(in srgb, ${c} 22%, var(--paper))` }}
                    onClick={() => setColor(c)}
                    aria-label={`Color ${c}`}
                    aria-pressed={color === c}
                  />
                ))}
              </div>

              {/* Type */}
              <span className="ob-label">Type</span>
              <div className="ob-chip-row">
                {GROUP_TYPES.map((t) => (
                  <button
                    key={t.value}
                    className={`ob-type-chip ${type === t.value ? 'active' : ''}`}
                    aria-pressed={type === t.value}
                    onClick={() => setType(t.value)}
                  >
                    {t.label}
                  </button>
                ))}
              </div>

              {/* Currency */}
              <label className="ob-label" htmlFor="ob-currency">Currency</label>
              <CurrencySelect id="ob-currency" className="ob-input" value={currency} onChange={setCurrency} />

              {/* People */}
              <span className="ob-label">Add people (optional)</span>
              {people.length > 0 && (
                <div className="ob-people-chips">
                  {people.map((p, i) => (
                    <span className="ob-person-chip" key={`${p}-${i}`}>
                      {p}
                      <button onClick={() => removePerson(i)} aria-label={`Remove ${p}`}>
                        <svg width="10" height="10" viewBox="0 0 24 24" fill="none">
                          <path d="M18 6L6 18M6 6L18 18" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
                        </svg>
                      </button>
                    </span>
                  ))}
                </div>
              )}
              <div className="ob-person-add-row">
                <input
                  className="ob-input"
                  style={{ flex: 1 }}
                  placeholder="Their name…"
                  value={personDraft}
                  onChange={(e) => setPersonDraft(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && addPerson()}
                  maxLength={40}
                />
                <button className="ob-person-add-btn" onClick={addPerson} disabled={!personDraft.trim()}>
                  Add
                </button>
              </div>

              <motion.button
                className="ob-cta"
                onClick={() => finish(true)}
                disabled={!groupName.trim()}
                whileTap={{ scale: 0.97 }}
              >
                Create group &amp; finish
              </motion.button>
              <button className="ob-secondary" onClick={() => finish(false)}>
                Skip for now
              </button>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
