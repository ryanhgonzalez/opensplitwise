import { useMemo, useState } from 'react';
import { useStore } from '../store';
import { downloadFullBackup } from '../lib/backupNow';
import {
  backupSnoozedUntil,
  backupStatus,
  isBackupReminderDue,
  lastBackupAt,
  snoozeBackupReminder,
} from '../lib/dataSafety';
import { formatRelativeDay } from '../utils/format';
import './BackupReminder.css';

/**
 * One line on Home: changes have gone unsaved for a week, so offer a one-tap
 * backup (the same full export as the Export sheet), or × to ask again in a week.
 */
export default function BackupReminder() {
  const expenses = useStore((s) => s.expenses);
  const settlements = useStore((s) => s.settlements);
  const groups = useStore((s) => s.groups);
  // Backup times live in localStorage, not the store; bump this to re-read them.
  const [, setTick] = useState(0);

  const last = lastBackupAt();
  const status = useMemo(
    () => backupStatus({ expenses, settlements, groups }, last),
    [expenses, settlements, groups, last?.getTime()], // eslint-disable-line react-hooks/exhaustive-deps
  );
  if (!isBackupReminderDue({ expenses, settlements, groups }, status, backupSnoozedUntil())) return null;

  const backUpNow = async () => {
    await downloadFullBackup();
    setTick((t) => t + 1);
  };

  const later = () => {
    snoozeBackupReminder();
    setTick((t) => t + 1);
  };

  const changes = `${status.unsavedChanges} ${status.unsavedChanges === 1 ? 'change' : 'changes'}`;
  return (
    <section className="backup-reminder" aria-label="Backup reminder">
      <span className="backup-reminder-text">
        {last
          ? `${changes} since your backup ${formatRelativeDay(last)}`
          : 'Not backed up yet'}
      </span>
      <button type="button" className="backup-reminder-go" onClick={backUpNow}>
        Back up
      </button>
      <button type="button" className="backup-reminder-later" onClick={later} aria-label="Remind me later">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden>
          <path d="M18 6L6 18M6 6L18 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        </svg>
      </button>
    </section>
  );
}
