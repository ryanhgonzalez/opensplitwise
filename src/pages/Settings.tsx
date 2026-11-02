import { useMemo, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Link } from 'react-router-dom';
import { useStore, selectCurrentUser, type ThemeMode } from '../store';
import Avatar from '../components/Avatar';
import ExportImportSheet from '../components/ExportImportSheet';
import IdentityPicker from '../components/IdentityPicker';
import PersonSheet from '../components/PersonSheet';
import { downloadFullBackup } from '../lib/backupNow';
import { backupStatus, lastBackupAt } from '../lib/dataSafety';
import { shouldOfferInstall, showInstallGuide } from '../lib/pwa';
import { formatRelativeDay } from '../utils/format';
import { cleanHandle } from '../lib/reminder';
import type { PayHandles } from '../types';
import '../styles/sheet.css';
import './Settings.css';

const THEMES: { value: ThemeMode; label: string }[] = [
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
  { value: 'system', label: 'System' },
];

function Chevron() {
  return (
    <svg className="settings-chevron" width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="M9 18L15 12L9 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

const PAY_APPS: { key: keyof PayHandles; label: string; prefix: string; placeholder: string }[] = [
  { key: 'venmo', label: 'Venmo', prefix: '@', placeholder: 'username' },
  { key: 'cashapp', label: 'Cash App', prefix: '$', placeholder: 'cashtag' },
  { key: 'paypal', label: 'PayPal', prefix: 'paypal.me/', placeholder: 'name' },
];

/** "Venmo @ana-r · Cash App and PayPal not set". */
function payLinksSummary(handles: PayHandles | undefined): string {
  const set = PAY_APPS.filter(({ key }) => handles?.[key]);
  const unset = PAY_APPS.filter(({ key }) => !handles?.[key]).map((a) => a.label);
  if (set.length === 0) return 'Not set up';
  const named = set.map(({ key, label, prefix }) => `${label} ${prefix === 'paypal.me/' ? '' : prefix}${handles![key]}`.trim());
  if (unset.length === 0) return named.join(' · ');
  const missing = unset.length === 1 ? `${unset[0]} not set` : `${unset.join(' and ')} not set`;
  return `${named.join(' · ')} · ${missing}`;
}

/** Your names on payment apps, so reminders can carry a link that pays you. */
function PaymentLinksSheet({ onClose }: { onClose: () => void }) {
  const currentUser = useStore(selectCurrentUser)!;
  const updateUser = useStore((s) => s.updateUser);
  const [draft, setDraft] = useState<PayHandles>(currentUser.payHandles ?? {});

  const saveAll = () => {
    const next: PayHandles = {};
    for (const { key } of PAY_APPS) {
      const value = cleanHandle(draft[key] ?? '');
      if (value) next[key] = value;
    }
    updateUser(currentUser.id, { payHandles: next });
  };
  const done = () => {
    saveAll();
    onClose();
  };

  return (
    <motion.div className="sheet-overlay" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={done}>
      <motion.div
        className="sheet-panel"
        role="dialog"
        aria-label="Payment links"
        initial={{ y: '100%' }}
        animate={{ y: 0 }}
        exit={{ y: '100%' }}
        transition={{ type: 'spring', damping: 32, stiffness: 340 }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sheet-handle" />
        <div className="sheet-header">
          <span className="sheet-title">Payment links</span>
        </div>
        <form className="sheet-body" id="pay-links-form" onSubmit={(e) => { e.preventDefault(); done(); }}>
          <p className="settings-section-intro">
            Reminders link here so people can pay you, amount filled in. Venmo and Cash App are dollars only. Stays on
            this device.
          </p>
          <div className="settings-rows">
            {PAY_APPS.map(({ key, label, prefix, placeholder }) => (
              <label key={key} className="settings-row settings-pay-row">
                <span className="settings-row-label">{label}</span>
                <span className="settings-pay-field">
                  <span className="settings-pay-prefix" aria-hidden>{prefix}</span>
                  <input
                    className="settings-pay-input"
                    value={draft[key] ?? ''}
                    onChange={(e) => setDraft((d) => ({ ...d, [key]: e.target.value }))}
                    placeholder={placeholder}
                    aria-label={`Your ${label} ${placeholder}`}
                    autoCapitalize="none"
                    autoCorrect="off"
                    spellCheck={false}
                  />
                </span>
              </label>
            ))}
          </div>
        </form>
        <div className="sheet-footer">
          <button className="sheet-cta" type="submit" form="pay-links-form">Done</button>
        </div>
      </motion.div>
    </motion.div>
  );
}

export default function Settings() {
  const currentUser = useStore(selectCurrentUser)!;
  const groups = useStore((s) => s.groups);
  const expenses = useStore((s) => s.expenses);
  const settlements = useStore((s) => s.settlements);
  const theme = useStore((s) => s.theme);
  const setTheme = useStore((s) => s.setTheme);
  const wipeAllData = useStore((s) => s.wipeAllData);

  const [showDataSheet, setShowDataSheet] = useState(false);
  const [showIdentityPicker, setShowIdentityPicker] = useState(false);
  const [editingSelf, setEditingSelf] = useState(false);
  const [showPayLinks, setShowPayLinks] = useState(false);
  const [showWipeConfirm, setShowWipeConfirm] = useState(false);
  const [wipeNameInput, setWipeNameInput] = useState('');
  // Backup times live in localStorage, not the store; bump this to re-read them.
  const [, setTick] = useState(0);

  const last = lastBackupAt();
  const status = useMemo(
    () => backupStatus({ expenses, settlements, groups }, last),
    [expenses, settlements, groups, last?.getTime()], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const changes = `${status.unsavedChanges} ${status.unsavedChanges === 1 ? 'change' : 'changes'}`;
  const backupLine = !last
    ? 'No backup yet'
    : status.unsavedChanges === 0
      ? `Up to date · last backup ${formatRelativeDay(last)}`
      : `Last backup ${formatRelativeDay(last)} · ${changes} since`;


  const backUp = async () => {
    await downloadFullBackup();
    setTick((t) => t + 1);
  };

  const wipeNameMatches =
    currentUser.name.trim().length > 0 &&
    wipeNameInput.trim().toLowerCase() === currentUser.name.trim().toLowerCase();
  const closeWipeConfirm = () => {
    setShowWipeConfirm(false);
    setWipeNameInput('');
  };
  const handleWipe = () => {
    // Resets hasOnboarded → the app returns to the onboarding screen.
    if (wipeNameMatches) wipeAllData();
  };

  return (
    <div className="page-content">
      <div className="settings-page">
        <h1 className="page-hero-title">Settings</h1>

        <div className="settings-profile">
          <button className="settings-profile-edit" onClick={() => setEditingSelf(true)} aria-label="Edit your name and details">
            <Avatar user={currentUser} size="lg" />
            <span className="settings-profile-info">
              <span className="settings-profile-name">{currentUser.name}</span>
              <span className="text-sm text-secondary">
                You, on this device · <span className="settings-profile-edit-word">Edit</span>
              </span>
            </span>
          </button>
          <button className="btn btn-secondary settings-small-btn" onClick={() => setShowIdentityPicker(true)}>
            Switch person
          </button>
        </div>

        <section className="settings-section" aria-labelledby="settings-paid">
          <h2 id="settings-paid" className="settings-section-title">Getting paid</h2>
          <div className="settings-rows">
            <button className="settings-row" onClick={() => setShowPayLinks(true)}>
              <span className="settings-row-text">
                <span className="settings-row-label">Payment links</span>
                <span className="settings-row-sub">{payLinksSummary(currentUser.payHandles)}</span>
              </span>
              <Chevron />
            </button>
          </div>
        </section>

        <section className="settings-section" aria-labelledby="settings-appearance">
          <h2 id="settings-appearance" className="settings-section-title">Appearance</h2>
          <div className="settings-theme" role="radiogroup" aria-label="Theme">
            {THEMES.map(({ value, label }) => (
              <button
                key={value}
                role="radio"
                aria-checked={theme === value}
                className={`settings-theme-opt ${theme === value ? 'active' : ''}`}
                onClick={() => setTheme(value)}
              >
                {label}
              </button>
            ))}
          </div>
        </section>

        <section className="settings-section" aria-labelledby="settings-data">
          <h2 id="settings-data" className="settings-section-title">Your data</h2>
          <div className="settings-rows">
            <div className="settings-row">
              <span className="settings-row-text">
                <span className="settings-row-label">Backup</span>
                <span className={`settings-row-sub ${status.unsavedChanges > 0 && expenses.length > 0 ? 'warn' : ''}`}>
                  {backupLine}
                </span>
              </span>
              <button className="btn btn-primary settings-small-btn" onClick={backUp}>
                Back up
              </button>
            </div>
            <button className="settings-row" onClick={() => setShowDataSheet(true)}>
              <span className="settings-row-text">
                <span className="settings-row-label">Restore, import or export</span>
                <span className="settings-row-sub">Open a backup file, or save one group</span>
              </span>
              <Chevron />
            </button>
            {shouldOfferInstall() && (
              <button className="settings-row" onClick={showInstallGuide}>
                <span className="settings-row-text">
                  <span className="settings-row-label">Install on your home screen</span>
                </span>
                <Chevron />
              </button>
            )}
            <Link className="settings-row settings-link-row" to="/settings/about">
              <span className="settings-row-text">
                <span className="settings-row-label">About OpenSplitwise</span>
                <span className="settings-row-sub">Version, storage, offline, privacy</span>
              </span>
              <Chevron />
            </Link>
          </div>
        </section>

        <div className="settings-erase">
          <button className="btn settings-erase-btn" onClick={() => setShowWipeConfirm(true)}>
            Erase all data on this device
          </button>
        </div>
      </div>

      <AnimatePresence>
        {showIdentityPicker && (
          <IdentityPicker variant="switch" onClose={() => setShowIdentityPicker(false)} />
        )}
        {editingSelf && (
          <PersonSheet open={editingSelf} onClose={() => setEditingSelf(false)} userId={currentUser.id} />
        )}
        {showPayLinks && <PaymentLinksSheet key={currentUser.id} onClose={() => setShowPayLinks(false)} />}
      </AnimatePresence>

      <AnimatePresence>
        {showDataSheet && (
          <ExportImportSheet
            open={showDataSheet}
            onClose={() => {
              setShowDataSheet(false);
              setTick((t) => t + 1);
            }}
          />
        )}
      </AnimatePresence>

      <AnimatePresence>
        {showWipeConfirm && (
          <motion.div
            className="settings-wipe-overlay"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            onClick={closeWipeConfirm}
          >
            <motion.div
              className="settings-wipe-modal"
              role="dialog"
              aria-modal="true"
              aria-labelledby="settings-wipe-title"
              initial={{ opacity: 0, scale: 0.94, y: 12 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.96, y: 8 }}
              transition={{ type: 'spring', damping: 30, stiffness: 340 }}
              onClick={(e) => e.stopPropagation()}
            >
              <h3 id="settings-wipe-title" className="settings-wipe-title">Erase all data</h3>
              <p className="settings-wipe-text">
                This permanently deletes <strong>all</strong> of your groups, expenses, people and activity on this
                device, and starts OpenSplitwise over. It can't be undone.
              </p>
              <label className="settings-wipe-label" htmlFor="settings-wipe-input">
                Type <strong>{currentUser.name}</strong> to confirm
              </label>
              <input
                id="settings-wipe-input"
                className="settings-wipe-input"
                type="text"
                placeholder="Your name…"
                value={wipeNameInput}
                onChange={(e) => setWipeNameInput(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleWipe()}
                autoComplete="off"
              />
              <div className="settings-wipe-actions">
                <button className="btn btn-secondary" onClick={closeWipeConfirm}>
                  Cancel
                </button>
                <button className="btn settings-wipe-delete" onClick={handleWipe} disabled={!wipeNameMatches}>
                  Erase everything
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
