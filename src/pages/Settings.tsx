import { useEffect, useMemo, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useStore, selectCurrentUser, type ThemeMode } from '../store';
import Avatar from '../components/Avatar';
import GroupTile from '../components/GroupTile';
import ExportImportSheet from '../components/ExportImportSheet';
import IdentityPicker from '../components/IdentityPicker';
import { downloadFullBackup } from '../lib/backupNow';
import { backupStatus, lastBackupAt } from '../lib/dataSafety';
import { formatBytes } from '../lib/receiptPhotos';
import { isOcrDownloaded, RECEIPT_OCR } from '../lib/receiptOcr';
import { shouldOfferInstall, showInstallGuide } from '../lib/pwa';
import { formatRelativeDay } from '../utils/format';
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

export default function Settings() {
  const currentUser = useStore(selectCurrentUser)!;
  const users = useStore((s) => s.users);
  const groups = useStore((s) => s.groups);
  const expenses = useStore((s) => s.expenses);
  const settlements = useStore((s) => s.settlements);
  const theme = useStore((s) => s.theme);
  const setTheme = useStore((s) => s.setTheme);
  const wipeAllData = useStore((s) => s.wipeAllData);

  const [showDataSheet, setShowDataSheet] = useState(false);
  const [showIdentityPicker, setShowIdentityPicker] = useState(false);
  const [pdfLoadingId, setPdfLoadingId] = useState<string | null>(null);
  const [showWipeConfirm, setShowWipeConfirm] = useState(false);
  const [wipeNameInput, setWipeNameInput] = useState('');
  // Backup times live in localStorage, not the store; bump this to re-read them.
  const [, setTick] = useState(0);
  const [persisted, setPersisted] = useState<boolean | null>(null);
  const [ocrReady, setOcrReady] = useState<boolean | null>(null);

  useEffect(() => {
    navigator.storage?.persisted?.().then(setPersisted, () => setPersisted(false));
    void isOcrDownloaded().then(setOcrReady);
  }, []);

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

  const photos = expenses.filter((e) => e.receipt);
  const photoBytes = photos.reduce((n, e) => n + (e.receipt?.bytes ?? 0), 0);
  const offlineReady = typeof navigator !== 'undefined' && !!navigator.serviceWorker?.controller;
  const myGroups = groups.filter((g) => g.members.some((m) => m.userId === currentUser.id));

  const backUp = async () => {
    await downloadFullBackup();
    setTick((t) => t + 1);
  };

  const generatePdf = async (groupId: string) => {
    if (pdfLoadingId) return;
    setPdfLoadingId(groupId);
    try {
      const group = groups.find((g) => g.id === groupId)!;
      const groupExpenses = expenses.filter((e) => e.groupId === groupId);
      // Completed payments change who still owes what; the report must apply them.
      const payments = settlements.filter((s) => s.groupId === groupId);
      const { generateGroupReport } = await import('../lib/groupReport');
      await generateGroupReport(group, groupExpenses, users, payments);
    } finally {
      setPdfLoadingId(null);
    }
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
          <Avatar user={currentUser} size="lg" />
          <span className="settings-profile-info">
            <span className="settings-profile-name">{currentUser.name}</span>
            <span className="text-sm text-secondary">You, on this device</span>
          </span>
          <button className="btn btn-secondary settings-small-btn" onClick={() => setShowIdentityPicker(true)}>
            Switch person
          </button>
        </div>

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
            <div className="settings-row">
              <span className="settings-row-text">
                <span className="settings-row-label">Storage on this device</span>
                <span className="settings-row-sub">
                  {persisted === null ? '' : persisted ? 'Protected · ' : 'Not protected yet · '}
                  {expenses.length} {expenses.length === 1 ? 'expense' : 'expenses'}
                  {photos.length > 0 && ` · ${photos.length} ${photos.length === 1 ? 'photo' : 'photos'} (${formatBytes(photoBytes)})`}
                </span>
              </span>
            </div>
            <div className="settings-row">
              <span className="settings-row-text">
                <span className="settings-row-label">Receipt reader</span>
                <span className="settings-row-sub">
                  {ocrReady === null
                    ? ''
                    : ocrReady
                      ? `Downloaded · ${Math.round(RECEIPT_OCR.approxBytes / 1e6)} MB`
                      : 'Downloads the first time you scan a receipt'}
                </span>
              </span>
            </div>
          </div>
        </section>

        <section className="settings-section" aria-labelledby="settings-reports">
          <h2 id="settings-reports" className="settings-section-title">Group reports (PDF)</h2>
          <div className="settings-rows">
            {myGroups.length === 0 ? (
              <p className="settings-row settings-row-sub">No groups yet.</p>
            ) : (
              myGroups.map((g) => {
                const hasExpenses = expenses.some((e) => e.groupId === g.id);
                return (
                  <button
                    key={g.id}
                    className="settings-row"
                    onClick={() => generatePdf(g.id)}
                    disabled={!hasExpenses || !!pdfLoadingId}
                  >
                    <GroupTile group={g} size={28} />
                    <span className="settings-row-text">
                      <span className="settings-row-label">{g.name}</span>
                      {!hasExpenses && <span className="settings-row-sub">No expenses yet</span>}
                    </span>
                    <span className="settings-row-action">
                      {pdfLoadingId === g.id ? 'Making…' : hasExpenses ? 'Download' : ''}
                    </span>
                  </button>
                );
              })
            )}
          </div>
        </section>

        <section className="settings-section" aria-labelledby="settings-app">
          <h2 id="settings-app" className="settings-section-title">App</h2>
          <div className="settings-rows">
            {shouldOfferInstall() && (
              <button className="settings-row" onClick={showInstallGuide}>
                <span className="settings-row-text">
                  <span className="settings-row-label">Install on your home screen</span>
                </span>
                <Chevron />
              </button>
            )}
            <div className="settings-row">
              <span className="settings-row-text">
                <span className="settings-row-label">Works offline</span>
              </span>
              <span className="settings-row-sub">{offlineReady ? 'Ready' : 'After the next visit'}</span>
            </div>
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
                autoFocus
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
