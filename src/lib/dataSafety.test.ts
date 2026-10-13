import { describe, expect, it } from 'vitest';
import { backupStatus, isBackupReminderDue } from './dataSafety';

const NOW = new Date(2026, 9, 12, 12);
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000);
const expense = (created: number, updated = created) => ({ createdAt: daysAgo(created), updatedAt: daysAgo(updated) });

describe('backupStatus', () => {
  it('counts everything when there has never been a backup', () => {
    const records = { expenses: [expense(10), expense(3)], settlements: [{ createdAt: daysAgo(2) }], groups: [{ createdAt: daysAgo(12) }] };
    expect(backupStatus(records, undefined)).toEqual({ unsavedChanges: 4, oldestUnsaved: daysAgo(12) });
  });

  it('counts only what changed after the last backup, edits included', () => {
    const records = { expenses: [expense(10), expense(10, 1), expense(2)], settlements: [], groups: [{ createdAt: daysAgo(12) }] };
    expect(backupStatus(records, daysAgo(5))).toEqual({ unsavedChanges: 2, oldestUnsaved: daysAgo(2) });
  });

  it('reports nothing unsaved right after a backup', () => {
    expect(backupStatus({ expenses: [expense(3)], settlements: [], groups: [] }, daysAgo(1))).toEqual({ unsavedChanges: 0 });
  });
});

describe('isBackupReminderDue', () => {
  const records = { expenses: [expense(8)], settlements: [], groups: [] };

  it('is due once a change has gone unsaved for a week', () => {
    expect(isBackupReminderDue(records, backupStatus(records, undefined), undefined, NOW)).toBe(true);
  });

  it('waits until the oldest unsaved change is a week old', () => {
    const fresh = { expenses: [expense(6)], settlements: [], groups: [] };
    expect(isBackupReminderDue(fresh, backupStatus(fresh, undefined), undefined, NOW)).toBe(false);
  });

  it('respects "Later" until the snooze ends', () => {
    const status = backupStatus(records, undefined);
    expect(isBackupReminderDue(records, status, daysAgo(-3), NOW)).toBe(false);
    expect(isBackupReminderDue(records, status, daysAgo(1), NOW)).toBe(true);
  });

  it('never nags without expenses, or when nothing is unsaved', () => {
    const groupsOnly = { expenses: [], settlements: [], groups: [{ createdAt: daysAgo(30) }] };
    expect(isBackupReminderDue(groupsOnly, backupStatus(groupsOnly, undefined), undefined, NOW)).toBe(false);
    expect(isBackupReminderDue(records, backupStatus(records, daysAgo(1)), undefined, NOW)).toBe(false);
  });
});
