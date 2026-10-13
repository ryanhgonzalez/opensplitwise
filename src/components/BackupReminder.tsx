import { useMemo, useState } from 'react';
import { useStore } from '../store';
import { selectFriendBalances } from '../store/selectors';
import { buildFullExport, downloadExport } from '../lib/dataExport';
import {
  backupSnoozedUntil,
  backupStatus,
  isBackupReminderDue,
  lastBackupAt,
  markBackedUp,
  snoozeBackupReminder,
} from '../lib/dataSafety';
import { formatRelativeDay } from '../utils/format';
import { photosFor } from '../lib/receiptPhotos';
import './BackupReminder.css';

/**
 * Dashboard banner: changes have gone unsaved for a week, so offer a one-tap
 * backup (the same full export as the Export sheet), or "Later" for a week.
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
    const s = useStore.getState();
    const withPhotos = s.expenses.filter((e) => e.receipt).map((e) => e.id);
    const receipts = withPhotos.length ? await photosFor(withPhotos) : undefined;
    downloadExport(
      buildFullExport({
        currentUserId: s.currentUserId,
        users: s.users,
        groups: s.groups,
        expenses: s.expenses,
        settlements: s.settlements,
        activities: s.activities,
        friendBalances: selectFriendBalances(s),
        tombstones: s.tombstones,
        userAliases: s.userAliases,
        groupSyncedAt: s.groupSyncedAt,
        recurring: s.recurring,
        receipts,
      }),
    );
    markBackedUp();
    setTick((t) => t + 1);
  };

  const later = () => {
    snoozeBackupReminder();
    setTick((t) => t + 1);
  };

  const changes = `${status.unsavedChanges} ${status.unsavedChanges === 1 ? 'change' : 'changes'}`;
  return (
    <section className="backup-reminder" aria-label="Backup reminder">
      <div className="backup-reminder-text">
        <span className="backup-reminder-title">Back up your data</span>
        <span className="text-sm text-secondary">
          {last
            ? `${changes} since your last backup ${formatRelativeDay(last)}.`
            : 'You haven’t made a backup yet.'}{' '}
          Everything is stored only on this device, so a backup file is the way to get it back if the browser clears
          it.
        </span>
      </div>
      <div className="backup-reminder-actions">
        <button type="button" className="btn btn-primary" onClick={backUpNow}>
          Back up now
        </button>
        <button type="button" className="btn btn-secondary" onClick={later}>
          Later
        </button>
      </div>
    </section>
  );
}
