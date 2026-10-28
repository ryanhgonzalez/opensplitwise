import { useState, useRef, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { dataSnapshot, useStore, selectFriendBalances } from '../store';
import {
  buildFullExport,
  buildGroupExport,
  downloadExport,
  parseAndValidate,
  remapForNewGroup,
} from '../lib/dataExport';
import type { AppExport, ParseResult, ImportStats, ImportMode } from '../lib/dataExport';
import { downloadSplitwiseCsv, looksLikeSplitwiseCsv, parseSplitwiseCsv } from '../lib/splitwiseCsv';
import { lastBackupAt, markBackedUp } from '../lib/dataSafety';
import { formatBytes, photosFor, savePhotos } from '../lib/receiptPhotos';
import { formatRelativeDay } from '../utils/format';
import './ExportImportSheet.css';

// ─── Animation variants ───────────────────────────────────────────────────────

const overlayVariants = {
  hidden: { opacity: 0 },
  visible: { opacity: 1, transition: { duration: 0.2 } },
  exit:   { opacity: 0, transition: { duration: 0.18 } },
};

const panelVariants = {
  hidden:  { y: '100%', opacity: 0.6 },
  visible: { y: 0, opacity: 1, transition: { type: 'spring' as const, damping: 32, stiffness: 320 } },
  exit:    { y: '100%', opacity: 0, transition: { duration: 0.22, ease: [0.4, 0, 1, 1] as [number, number, number, number] } },
};

/** Sentinel for "I am none of the people in this file". */
const NOT_IN_FILE = '__not-in-file__';

// ─── Sub-components ───────────────────────────────────────────────────────────

function StatusBanner({ type, children }: { type: 'success' | 'warning' | 'error'; children: React.ReactNode }) {
  const icons = {
    success: (
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none">
        <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2" />
        <path d="M7 12.5L10.5 16L17 9" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    ),
    warning: (
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none">
        <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        <line x1="12" y1="9" x2="12" y2="13" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        <circle cx="12" cy="17" r="1" fill="currentColor" />
      </svg>
    ),
    error: (
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none">
        <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2" />
        <line x1="15" y1="9" x2="9" y2="15" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        <line x1="9" y1="9" x2="15" y2="15" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      </svg>
    ),
  };
  return (
    <div className={`eis-banner eis-banner-${type}`}>
      <span className="eis-banner-icon">{icons[type]}</span>
      <span>{children}</span>
    </div>
  );
}

function ImportModeCard({
  selected,
  onSelect,
  title,
  description,
  danger,
}: {
  selected: boolean;
  onSelect: () => void;
  title: string;
  description: string;
  danger?: boolean;
}) {
  return (
    <button
      className={`eis-mode-card${selected ? ' selected' : ''}${danger ? ' danger' : ''}`}
      onClick={onSelect}
    >
      <div className="eis-mode-radio">{selected && <div className="eis-mode-radio-dot" />}</div>
      <div className="eis-mode-text">
        <span className="eis-mode-title">{title}</span>
        <span className="eis-mode-desc">{description}</span>
      </div>
    </button>
  );
}

// ─── Main sheet ───────────────────────────────────────────────────────────────

interface ExportImportSheetProps {
  open: boolean;
  onClose: () => void;
  defaultTab?: 'export' | 'import';
  defaultGroupId?: string;
}

export default function ExportImportSheet({
  open,
  onClose,
  defaultTab = 'export',
  defaultGroupId,
}: ExportImportSheetProps) {
  const groups      = useStore((s) => s.groups);
  const users       = useStore((s) => s.users);
  const expenses    = useStore((s) => s.expenses);
  const settlements = useStore((s) => s.settlements);
  const currentUserId   = useStore((s) => s.currentUserId);
  const restoreAllData  = useStore((s) => s.restoreAllData);
  const mergeImportData = useStore((s) => s.mergeImportData);

  const [tab, setTab] = useState<'export' | 'import'>(defaultTab);

  // ── Export state ──
  const [exportTarget, setExportTarget]   = useState<'full' | 'group'>(defaultGroupId ? 'group' : 'full');
  const [exportGroupId, setExportGroupId] = useState(defaultGroupId ?? groups[0]?.id ?? '');
  const [exportDone, setExportDone]       = useState(false);
  /** A single group can also go out as Splitwise's spreadsheet. */
  const [exportFormat, setExportFormat]   = useState<'json' | 'splitwise'>('json');
  // Receipt photos go into full backups unless left out (they can make the file much larger).
  const [includePhotos, setIncludePhotos] = useState(true);
  const withPhotos  = expenses.filter((e) => e.receipt);
  const photoBytes  = withPhotos.reduce((n, e) => n + (e.receipt?.bytes ?? 0), 0);

  // ── Import state ──
  const fileRef = useRef<HTMLInputElement>(null);
  const [dragOver,       setDragOver]       = useState(false);
  const [parseResult,    setParseResult]    = useState<ParseResult | null>(null);
  const [importMode,     setImportMode]     = useState<ImportMode>('merge');
  const [replaceAck,     setReplaceAck]     = useState(false);
  /** Which person in the file the importer is. '' = not answered yet, NOT_IN_FILE = none of them. */
  const [selfIdInFile,   setSelfIdInFile]   = useState('');
  const [importStatus,   setImportStatus]   = useState<'idle' | 'done' | 'error'>('idle');
  const [importStats,    setImportStats]    = useState<ImportStats | null>(null);
  const [importError,    setImportError]    = useState<string | null>(null);

  // Everything, as it is at the moment of exporting. `friendBalances` is
  // still written into the file: the format carries it so older app versions
  // can read these backups. On import it is ignored and recomputed.
  const statePayload = () => {
    const s = useStore.getState();
    return { ...dataSnapshot(s), friendBalances: selectFriendBalances(s) };
  };
  // Re-read on every render; exporting re-renders (exportDone), so it stays current.
  const lastBackup = lastBackupAt();

  // ── Export handlers ──────────────────────────────────────────────────────────

  async function handleExport() {
    if (exportTarget === 'group' && exportFormat === 'splitwise') {
      const group = groups.find((g) => g.id === exportGroupId);
      if (!group) return;
      downloadSplitwiseCsv({ group, users, expenses, settlements });
      setExportDone(true);
      setTimeout(() => setExportDone(false), 3000);
      return;
    }
    const receipts =
      exportTarget === 'full' && includePhotos && withPhotos.length
        ? await photosFor(withPhotos.map((e) => e.id))
        : undefined;
    const data =
      exportTarget === 'full'
        ? buildFullExport({ ...statePayload(), receipts })
        : buildGroupExport(statePayload(), exportGroupId);
    if (!data) return;
    downloadExport(data);
    // Only a full export can restore everything; a single group's file can't.
    if (data.exportType === 'full') markBackedUp();
    setExportDone(true);
    setTimeout(() => setExportDone(false), 3000);
  }

  // ── Import handlers ──────────────────────────────────────────────────────────

  const handleFile = useCallback((file: File) => {
    const isJson = /\.json$/i.test(file.name) || file.type === 'application/json';
    const isCsv = /\.csv$/i.test(file.name) || file.type === 'text/csv';
    if (!isJson && !isCsv) {
      setParseResult({ ok: false, errors: ['Please upload an OpenSplitwise .json backup or a Splitwise .csv export.'], warnings: [] });
      return;
    }
    const reader = new FileReader();
    reader.onload = (e) => {
      const text = e.target?.result as string;
      const result = isCsv || looksLikeSplitwiseCsv(text)
        ? parseSplitwiseCsv(text, file.name)
        : parseAndValidate(text);
      setParseResult(result);
      setImportStatus('idle');
      setImportStats(null);
      setReplaceAck(false);
      setSelfIdInFile('');
      if (result.ok && result.data) {
        setImportMode(result.data.exportType === 'group' ? 'new-group' : 'merge');
      }
    };
    reader.readAsText(file);
  }, []);

  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files[0];
    if (file) handleFile(file);
  }

  function handleFileInput(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file) handleFile(file);
    e.target.value = '';
  }

  function handleImport() {
    if (!parseResult?.ok || !parseResult.data) return;
    const exported: AppExport = parseResult.data;

    try {
      if (importMode === 'replace') {
        restoreAllData(exported.data);
        void savePhotos(exported.data.receipts);
        // The data on hand is now exactly what's in that file.
        markBackedUp();
        setImportStats({
          usersAdded:       exported.data.users.length,
          groupsAdded:      exported.data.groups.length,
          expensesAdded:    exported.data.expenses.length,
          settlementsAdded: exported.data.settlements.length,
        });
      } else if (importMode === 'merge') {
        const stats = mergeImportData(exported.data);
        void savePhotos(exported.data.receipts);
        setImportStats(stats);
      } else {
        // new-group: fold whoever the importer said they are into their own
        // account, remap the rest to fresh IDs, then merge.
        const payload = remapForNewGroup(
          exported,
          users,
          currentUserId,
          selfIdInFile === NOT_IN_FILE ? null : selfIdInFile,
        );
        const stats = mergeImportData(payload);
        setImportStats(stats);
      }
      setImportStatus('done');
    } catch (err) {
      setImportError(err instanceof Error ? err.message : 'An unexpected error occurred.');
      setImportStatus('error');
    }
  }

  function resetImport() {
    setParseResult(null);
    setImportStatus('idle');
    setImportStats(null);
    setImportError(null);
    setReplaceAck(false);
    setSelfIdInFile('');
  }

  // ── Derived ──────────────────────────────────────────────────────────────────

  const canImport = parseResult?.ok &&
    (importMode !== 'replace' || replaceAck) &&
    (importMode !== 'new-group' || selfIdInFile !== '') &&
    importStatus === 'idle';

  const exportedData = parseResult?.ok ? parseResult.data! : null;
  const isGroupExport = exportedData?.exportType === 'group';
  const isFullExport  = exportedData?.exportType === 'full';
  // Its people get fresh ids, so there is nothing for a merge to line up with.
  const isSplitwise   = exportedData?.meta.source === 'splitwise';

  // ── Render ───────────────────────────────────────────────────────────────────

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="eis-overlay"
          variants={overlayVariants}
          initial="hidden"
          animate="visible"
          exit="exit"
          onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
        >
          <motion.div
            className="eis-panel"
            variants={panelVariants}
            initial="hidden"
            animate="visible"
            exit="exit"
          >
            {/* Handle */}
            <div className="sheet-handle" />

            {/* Header */}
            <div className="sheet-header">
              <span className="sheet-title">Data &amp; Backups</span>
              <button className="sheet-close" onClick={onClose} aria-label="Close">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
                  <path d="M18 6L6 18M6 6L18 18" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
                </svg>
              </button>
            </div>

            {/* Tabs */}
            <div className="eis-tabs">
              <button className={`eis-tab${tab === 'export' ? ' active' : ''}`} onClick={() => setTab('export')}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
                  <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M7 10l5 5 5-5M12 15V3" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                Export
              </button>
              <button className={`eis-tab${tab === 'import' ? ' active' : ''}`} onClick={() => { setTab('import'); resetImport(); }}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
                  <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M17 8l-5-5-5 5M12 3v12" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                Import
              </button>
            </div>

            {/* Body */}
            <div className="sheet-body">

              {/* ── EXPORT TAB ───────────────────────────────────────────────── */}
              {tab === 'export' && (
                <div className="eis-section">
                  <p className="eis-section-desc">
                    Download a backup of your data as a JSON file. You can restore or transfer it at any time.
                  </p>
                  <p className="eis-last-backup text-xs text-secondary">
                    {lastBackup ? `Last full backup: ${formatRelativeDay(lastBackup)}` : 'No full backup yet'}
                  </p>

                  {/* Option cards */}
                  <div className="eis-option-row">
                    <button
                      className={`eis-option-card${exportTarget === 'full' ? ' selected' : ''}`}
                      onClick={() => setExportTarget('full')}
                    >
                      <div className="eis-option-icon">
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
                          <ellipse cx="12" cy="5" rx="9" ry="3" stroke="currentColor" strokeWidth="1.8" />
                          <path d="M3 5v14c0 1.66 4.03 3 9 3s9-1.34 9-3V5" stroke="currentColor" strokeWidth="1.8" />
                          <path d="M3 12c0 1.66 4.03 3 9 3s9-1.34 9-3" stroke="currentColor" strokeWidth="1.8" />
                        </svg>
                      </div>
                      <span className="eis-option-label">All Data</span>
                      <span className="eis-option-sub">{groups.length} groups · {expenses.length} expenses</span>
                    </button>

                    <button
                      className={`eis-option-card${exportTarget === 'group' ? ' selected' : ''}`}
                      onClick={() => setExportTarget('group')}
                    >
                      <div className="eis-option-icon">
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
                          <path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                          <circle cx="9" cy="7" r="4" stroke="currentColor" strokeWidth="1.8" />
                          <path d="M23 21v-2a4 4 0 00-3-3.87M16 3.13a4 4 0 010 7.75" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                        </svg>
                      </div>
                      <span className="eis-option-label">Single Group</span>
                      <span className="eis-option-sub">Members, expenses &amp; settlements</span>
                    </button>
                  </div>

                  {exportTarget === 'full' && withPhotos.length > 0 && (
                    <label className="eis-photos">
                      <input type="checkbox" checked={includePhotos} onChange={(e) => setIncludePhotos(e.target.checked)} />
                      <span>
                        Include receipt photos ({withPhotos.length} · {formatBytes(photoBytes)}).
                        Without them, photos can't be restored from this backup.
                      </span>
                    </label>
                  )}

                  {/* Group selector */}
                  {exportTarget === 'group' && (
                    <div className="field-group" style={{ marginTop: 16 }}>
                      <label className="field-label">Select group</label>
                      <select
                        className="field-input eis-select"
                        value={exportGroupId}
                        onChange={(e) => setExportGroupId(e.target.value)}
                      >
                        {groups.map((g) => (
                          <option key={g.id} value={g.id}>{g.emoji} {g.name}</option>
                        ))}
                      </select>
                      {exportGroupId && (() => {
                        const g = groups.find((gr) => gr.id === exportGroupId);
                        const count = expenses.filter((e) => e.groupId === exportGroupId).length;
                        return g ? (
                          <p className="eis-hint">
                            {g.members.length} members · {count} expenses · {settlements.filter((s) => s.groupId === exportGroupId).length} settlements
                          </p>
                        ) : null;
                      })()}
                      <label className="field-label" style={{ marginTop: 14 }}>Format</label>
                      <select
                        className="field-input eis-select"
                        value={exportFormat}
                        onChange={(e) => setExportFormat(e.target.value as 'json' | 'splitwise')}
                      >
                        <option value="json">OpenSplitwise backup (.json)</option>
                        <option value="splitwise">Splitwise spreadsheet (.csv)</option>
                      </select>
                      {exportFormat === 'splitwise' && (
                        <p className="eis-hint">
                          Same layout as Splitwise&apos;s &ldquo;Export as spreadsheet&rdquo;. It keeps each
                          person&apos;s balance but not receipts, notes or item splits, so use the .json to restore here.
                        </p>
                      )}
                    </div>
                  )}

                  {exportDone && (
                    <StatusBanner type="success">File downloaded — check your Downloads folder.</StatusBanner>
                  )}
                </div>
              )}

              {/* ── IMPORT TAB ───────────────────────────────────────────────── */}
              {tab === 'import' && (
                <div className="eis-section">
                  {importStatus === 'done' && importStats ? (
                    /* Success state */
                    <div className="eis-import-done">
                      <div className="eis-done-icon">
                        <svg width="28" height="28" viewBox="0 0 24 24" fill="none">
                          <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="1.8" />
                          <path d="M7 12.5L10.5 16L17 9" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                      </div>
                      <h3 className="eis-done-title">Import complete</h3>
                      <div className="eis-done-stats">
                        {[
                          { label: 'Groups added',       value: importStats.groupsAdded },
                          { label: 'Expenses added',     value: importStats.expensesAdded },
                          { label: 'Settlements added',  value: importStats.settlementsAdded },
                          { label: 'Members added',      value: importStats.usersAdded },
                        ].filter((r) => r.value > 0).map((r) => (
                          <div key={r.label} className="eis-done-row">
                            <span className="eis-done-label">{r.label}</span>
                            <span className="eis-done-val">{r.value}</span>
                          </div>
                        ))}
                        {importMode === 'replace' && <p className="eis-done-note">All previous data was replaced.</p>}
                      </div>
                      <button className="eis-text-btn" onClick={resetImport}>Import another file</button>
                    </div>
                  ) : importStatus === 'error' ? (
                    /* Error state */
                    <div className="eis-import-done">
                      <div className="eis-done-icon error">
                        <svg width="28" height="28" viewBox="0 0 24 24" fill="none">
                          <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="1.8" />
                          <line x1="15" y1="9" x2="9" y2="15" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
                          <line x1="9" y1="9" x2="15" y2="15" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
                        </svg>
                      </div>
                      <h3 className="eis-done-title">Import failed</h3>
                      <p className="eis-done-note" style={{ color: 'var(--text-secondary)' }}>{importError}</p>
                      <button className="eis-text-btn" onClick={resetImport}>Try again</button>
                    </div>
                  ) : (
                    <>
                      <p className="eis-section-desc">
                        Upload a previously exported OpenSplitwise JSON file to restore or merge your data.
                      </p>

                      {/* Drop zone */}
                      {!parseResult && (
                        <div
                          className={`eis-dropzone${dragOver ? ' drag-over' : ''}`}
                          onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
                          onDragLeave={() => setDragOver(false)}
                          onDrop={handleDrop}
                          onClick={() => fileRef.current?.click()}
                          role="button"
                          tabIndex={0}
                          onKeyDown={(e) => e.key === 'Enter' && fileRef.current?.click()}
                        >
                          <svg width="32" height="32" viewBox="0 0 24 24" fill="none" className="eis-dropzone-icon">
                            <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M17 8l-5-5-5 5M12 3v12" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                          </svg>
                          <p className="eis-dropzone-text">Drop a .json backup or Splitwise .csv here</p>
                          <p className="eis-dropzone-sub">or click to browse</p>
                        </div>
                      )}
                      <input
                        ref={fileRef}
                        type="file"
                        accept=".json,.csv,application/json,text/csv"
                        style={{ display: 'none' }}
                        onChange={handleFileInput}
                      />

                      {/* Parse errors */}
                      {parseResult && !parseResult.ok && (
                        <>
                          {parseResult.errors.map((e, i) => (
                            <StatusBanner key={i} type="error">{e}</StatusBanner>
                          ))}
                          <button className="eis-text-btn" style={{ marginTop: 12 }} onClick={resetImport}>
                            Try a different file
                          </button>
                        </>
                      )}

                      {/* File preview + mode selector */}
                      {parseResult?.ok && exportedData && (
                        <>
                          {/* Preview card */}
                          <div className="eis-preview">
                            <div className="eis-preview-header">
                              <div className="eis-preview-badge">
                                {isSplitwise
                                  ? `Splitwise: ${exportedData.meta.groupName}`
                                  : isGroupExport ? `Group: ${exportedData.meta.groupName}` : 'Full Backup'}
                              </div>
                              <button className="eis-text-btn-sm" onClick={resetImport}>Change file</button>
                            </div>
                            <div className="eis-preview-stats">
                              {[
                                { label: 'Groups',      v: exportedData.meta.groupCount },
                                { label: 'Members',     v: exportedData.meta.userCount },
                                { label: 'Expenses',    v: exportedData.meta.expenseCount },
                                { label: 'Settlements', v: exportedData.meta.settlementCount },
                              ].map((s) => (
                                <div key={s.label} className="eis-preview-stat">
                                  <span className="eis-preview-stat-val">{s.v}</span>
                                  <span className="eis-preview-stat-label">{s.label}</span>
                                </div>
                              ))}
                            </div>
                            <p className="eis-preview-date">
                              {isSplitwise
                                ? 'From a Splitwise group export. You can rename the group after importing.'
                                : <>Exported {new Date(exportedData.exportedAt).toLocaleString()} · v{exportedData.version}</>}
                            </p>
                          </div>

                          {/* Warnings */}
                          {parseResult.warnings.map((w, i) => (
                            <StatusBanner key={i} type="warning">{w}</StatusBanner>
                          ))}

                          {/* Mode selector */}
                          <div className="eis-modes">
                            <p className="field-label" style={{ marginBottom: 10 }}>Import mode</p>

                            {isGroupExport && (
                              <ImportModeCard
                                selected={importMode === 'new-group'}
                                onSelect={() => setImportMode('new-group')}
                                title="Import as new group"
                                description="Creates fresh copies with new IDs. Safe to use — nothing existing is changed."
                              />
                            )}

                            {/* The file was written from its author's point of view. Without
                                this the importer silently inherits the author's identity. */}
                            {importMode === 'new-group' && (
                              <div className="field-group" style={{ margin: '4px 0 12px' }}>
                                <label className="field-label" htmlFor="eis-self">
                                  Which of these people are you?
                                </label>
                                <select
                                  id="eis-self"
                                  className="field-input eis-select"
                                  value={selfIdInFile}
                                  onChange={(e) => setSelfIdInFile(e.target.value)}
                                >
                                  <option value="" disabled>Select yourself…</option>
                                  {exportedData.data.users.map((u) => (
                                    <option key={u.id} value={u.id}>
                                      {u.name}
                                      {u.id === exportedData.data.currentUserId ? ' — shared this file' : ''}
                                    </option>
                                  ))}
                                  <option value={NOT_IN_FILE}>None of them — I&apos;m not in this group</option>
                                </select>
                                <p className="eis-hint">
                                  {selfIdInFile === NOT_IN_FILE
                                    ? 'Everyone in the file is added as a separate person, and none of their expenses count as yours.'
                                    : 'What this person paid and owes becomes yours — balances are shown from their side.'}
                                </p>
                              </div>
                            )}

                            {!isSplitwise && <ImportModeCard
                              selected={importMode === 'merge'}
                              onSelect={() => setImportMode('merge')}
                              title="Merge with existing data"
                              description="Adds new items from the file, skipping anything that already exists."
                            />}

                            {isFullExport && (
                              <>
                                <ImportModeCard
                                  selected={importMode === 'replace'}
                                  onSelect={() => { setImportMode('replace'); setReplaceAck(false); }}
                                  title="Replace all data"
                                  description="Removes all current data and restores exactly what is in this file."
                                  danger
                                />
                                {importMode === 'replace' && (
                                  <label className="eis-ack">
                                    <input
                                      type="checkbox"
                                      checked={replaceAck}
                                      onChange={(e) => setReplaceAck(e.target.checked)}
                                    />
                                    <span>I understand this will permanently delete all current data</span>
                                  </label>
                                )}
                              </>
                            )}
                          </div>
                        </>
                      )}
                    </>
                  )}
                </div>
              )}
            </div>

            {/* Footer */}
            <div className="sheet-footer">
              {tab === 'export' ? (
                <button
                  className="sheet-cta"
                  onClick={handleExport}
                  disabled={exportTarget === 'group' && !exportGroupId}
                >
                  {exportDone ? 'Downloaded!' : (
                    <>
                      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" style={{ marginRight: 7, verticalAlign: 'middle' }}>
                        <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M7 10l5 5 5-5M12 15V3" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                      {exportTarget === 'group' && exportFormat === 'splitwise'
                        ? 'Download Splitwise CSV'
                        : `Download ${exportTarget === 'group' ? 'Group' : 'Full'} Backup`}
                    </>
                  )}
                </button>
              ) : importStatus === 'idle' && parseResult?.ok ? (
                <button
                  className="sheet-cta"
                  onClick={handleImport}
                  disabled={!canImport}
                >
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" style={{ marginRight: 7, verticalAlign: 'middle' }}>
                    <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M17 8l-5-5-5 5M12 3v12" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                  {importMode === 'replace' ? 'Replace & Restore' : importMode === 'merge' ? 'Merge Data' : 'Import as New Group'}
                </button>
              ) : importStatus === 'done' ? (
                <button className="sheet-cta" onClick={onClose}>Done</button>
              ) : null}
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
