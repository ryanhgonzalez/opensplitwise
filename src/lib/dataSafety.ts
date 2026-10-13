import type { Expense, Group, Settlement } from '../types';

// ─────────────────────────────────────────────────────────────────────────────
// Keeping data from being lost.
//
// Everything lives in this browser's storage, and browsers may clear a site's
// storage: under storage pressure, or Safari after weeks without a visit. Two
// defences: ask the browser to keep it (persistent storage), and remind people
// to download a backup when changes have gone unsaved for a while.
// ─────────────────────────────────────────────────────────────────────────────

// ─── Persistent storage ──────────────────────────────────────────────────────

export type PersistResult = 'persisted' | 'not-granted' | 'unsupported';

let request: Promise<PersistResult> | null = null;

/**
 * Asks the browser not to clear the app's storage. Chrome and Safari decide on
 * their own (engagement, installed to the home screen); Firefox asks the
 * person once. Asked at most once per page load.
 */
export function requestPersistentStorage(): Promise<PersistResult> {
  request ??= (async () => {
    try {
      if (!navigator.storage?.persist) return 'unsupported';
      if (await navigator.storage.persisted()) return 'persisted';
      return (await navigator.storage.persist()) ? 'persisted' : 'not-granted';
    } catch {
      return 'unsupported';
    }
  })();
  return request;
}

// ─── Backups ─────────────────────────────────────────────────────────────────

const LAST_BACKUP_KEY = 'opensplitwise-last-backup';
const SNOOZE_KEY = 'opensplitwise-backup-snoozed-until';

/** How long changes can go unsaved before the reminder, and how long "Later" hides it. */
export const BACKUP_REMINDER_DAYS = 7;
const DAY = 24 * 60 * 60 * 1000;

function readDate(key: string): Date | undefined {
  try {
    const raw = localStorage.getItem(key);
    const date = raw ? new Date(raw) : undefined;
    return date && !Number.isNaN(date.getTime()) ? date : undefined;
  } catch {
    return undefined;
  }
}

function writeDate(key: string, date: Date): void {
  try {
    localStorage.setItem(key, date.toISOString());
  } catch {
    // Storage blocked: the reminder may show again sooner than it should.
  }
}

export const lastBackupAt = () => readDate(LAST_BACKUP_KEY);

/** Call after a full export or a restore from a file: the data on hand is now in a file. */
export function markBackedUp(now = new Date()): void {
  writeDate(LAST_BACKUP_KEY, now);
}

/** "Later" on the reminder. */
export function snoozeBackupReminder(now = new Date()): void {
  writeDate(SNOOZE_KEY, new Date(now.getTime() + BACKUP_REMINDER_DAYS * DAY));
}

export const backupSnoozedUntil = () => readDate(SNOOZE_KEY);

export interface BackupStatus {
  /** Expenses, payments and groups created or edited since the last backup. */
  unsavedChanges: number;
  /** When the earliest of those happened. */
  oldestUnsaved?: Date;
}

interface Records {
  expenses: Pick<Expense, 'createdAt' | 'updatedAt'>[];
  settlements: Pick<Settlement, 'createdAt'>[];
  groups: Pick<Group, 'createdAt'>[];
}

/** What a backup made now would add, compared with the last one. */
export function backupStatus(records: Records, lastBackup: Date | undefined): BackupStatus {
  const changed = [
    ...records.expenses.map((e) => (e.updatedAt > e.createdAt ? e.updatedAt : e.createdAt)),
    ...records.settlements.map((s) => s.createdAt),
    ...records.groups.map((g) => g.createdAt),
  ].filter((when) => !lastBackup || when.getTime() > lastBackup.getTime());

  if (changed.length === 0) return { unsavedChanges: 0 };
  return {
    unsavedChanges: changed.length,
    oldestUnsaved: new Date(Math.min(...changed.map((d) => d.getTime()))),
  };
}

/**
 * Remind when there are expenses, some change has gone unsaved for at least
 * BACKUP_REMINDER_DAYS, and the person hasn't asked to be reminded later.
 */
export function isBackupReminderDue(
  records: Records,
  status: BackupStatus,
  snoozedUntil: Date | undefined,
  now = new Date(),
): boolean {
  if (records.expenses.length === 0 || !status.oldestUnsaved) return false;
  if (snoozedUntil && snoozedUntil.getTime() > now.getTime()) return false;
  return now.getTime() - status.oldestUnsaved.getTime() >= BACKUP_REMINDER_DAYS * DAY;
}
