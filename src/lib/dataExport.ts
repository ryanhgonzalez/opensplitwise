import type { User, Group, Expense, ExpenseSnapshot, Settlement, Activity, Tombstone, RecurringExpense } from '../types';
import { deriveTotals } from './calculations';
import { reviveDates } from './dates';

// ─── Schema constants ─────────────────────────────────────────────────────────

// Predates the rename to OpenSplitwise. Every file already exported carries this
// value, so changing it would make all existing backups fail to import.
export const EXPORT_SCHEMA = 'opensplit-export' as const;
export const EXPORT_VERSION = 1 as const;

// ─── Public types ─────────────────────────────────────────────────────────────

export interface ExportMeta {
  userCount: number;
  groupCount: number;
  expenseCount: number;
  settlementCount: number;
  activityCount: number;
  /** Present only on group exports. */
  groupId?: string;
  groupName?: string;
  /** Set when the file was read from another app's export rather than written by this one. */
  source?: 'splitwise';
}

export interface ExportPayload {
  currentUserId: string;
  users: User[];
  groups: Group[];
  expenses: Expense[];
  settlements: Settlement[];
  activities: Activity[];
  friendBalances: Record<string, number>;
  /** Sharing state (groupSync.ts). Absent in files from before sharing; full backups carry it. */
  tombstones?: Tombstone[];
  userAliases?: Record<string, string>;
  groupSyncedAt?: Record<string, Date>;
  /** Repeating expenses. Absent in files from before them. */
  recurring?: RecurringExpense[];
  /** Receipt photos, expense id → data: URL. Full backups carry them unless left out. */
  receipts?: Record<string, string>;
}

export interface AppExport {
  schema: typeof EXPORT_SCHEMA;
  version: number;
  exportType: 'full' | 'group';
  exportedAt: string;
  meta: ExportMeta;
  data: ExportPayload;
}

export interface ParseResult {
  ok: boolean;
  data?: AppExport;
  errors: string[];
  warnings: string[];
}

export interface ImportStats {
  usersAdded: number;
  groupsAdded: number;
  expensesAdded: number;
  settlementsAdded: number;
}

export type ImportMode = 'new-group' | 'merge' | 'replace';

// ─── Legacy fields ────────────────────────────────────────────────────────────

/**
 * Drops the balance and total that older versions stored on each group.
 * They're worked out from the expenses now, and a stored copy goes stale:
 * files from before still carry them, and restoring one brought them back.
 */
export function withoutLegacyTotals(group: Group): Group {
  if (!('yourBalance' in group) && !('totalSpent' in group)) return group;
  const cleaned = { ...group } as Group & { yourBalance?: unknown; totalSpent?: unknown };
  delete cleaned.yourBalance;
  delete cleaned.totalSpent;
  return cleaned;
}

// ─── Export builders ──────────────────────────────────────────────────────────

export function buildFullExport(state: ExportPayload): AppExport {
  return {
    schema: EXPORT_SCHEMA,
    version: EXPORT_VERSION,
    exportType: 'full',
    exportedAt: new Date().toISOString(),
    meta: {
      userCount: state.users.length,
      groupCount: state.groups.length,
      expenseCount: state.expenses.length,
      settlementCount: state.settlements.length,
      activityCount: state.activities.length,
    },
    data: { ...state, groups: state.groups.map(withoutLegacyTotals) },
  };
}

export function buildGroupExport(state: ExportPayload, groupId: string): AppExport | null {
  const group = state.groups.find((g) => g.id === groupId);
  if (!group) return null;

  // Collect every user ID referenced in this group's data.
  const memberIds = new Set(group.members.map((m) => m.userId));
  memberIds.add(state.currentUserId);

  const groupExpenses = state.expenses.filter((e) => e.groupId === groupId);
  const groupSettlements = state.settlements.filter((s) => s.groupId === groupId);
  const groupActivities = state.activities.filter((a) => a.groupId === groupId);

  for (const e of groupExpenses) {
    memberIds.add(e.paidBy);
    for (const en of e.split.entries) memberIds.add(en.userId);
  }
  for (const s of groupSettlements) {
    memberIds.add(s.fromUserId);
    memberIds.add(s.toUserId);
  }

  const users = state.users.filter((u) => memberIds.has(u.id));

  // What each person owes you in this group alone: the app-wide balances
  // would mix in every other group you share with them.
  const { friendBalances } = deriveTotals(groupExpenses, groupSettlements, state.currentUserId, [group]);

  return {
    schema: EXPORT_SCHEMA,
    version: EXPORT_VERSION,
    exportType: 'group',
    exportedAt: new Date().toISOString(),
    meta: {
      groupId,
      groupName: group.name,
      userCount: users.length,
      groupCount: 1,
      expenseCount: groupExpenses.length,
      settlementCount: groupSettlements.length,
      activityCount: groupActivities.length,
    },
    data: {
      currentUserId: state.currentUserId,
      users,
      groups: [withoutLegacyTotals(group)],
      expenses: groupExpenses,
      settlements: groupSettlements,
      activities: groupActivities,
      friendBalances,
    },
  };
}

// ─── File download ────────────────────────────────────────────────────────────

export function downloadExport(data: AppExport): void {
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const slug = data.exportType === 'group'
    ? `group-${(data.meta.groupName ?? 'group').replace(/\s+/g, '_')}`
    : 'full';
  const filename = `opensplitwise-${slug}-${ts}.json`;

  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ─── Validation ───────────────────────────────────────────────────────────────

function isObj(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

export function parseAndValidate(json: string): ParseResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  let raw: unknown;
  try {
    // Dates come back as Dates (see dates.ts); everything checked below is unaffected.
    raw = JSON.parse(json, reviveDates);
  } catch {
    return { ok: false, errors: ['Invalid JSON — the file appears to be corrupted or was not an OpenSplitwise export.'], warnings };
  }

  if (!isObj(raw)) return { ok: false, errors: ['File does not contain a valid export object.'], warnings };

  // A group someone shared (groupShare.ts), not a backup: it merges through a different screen.
  if (raw.kind === 'opensplitwise-group') {
    return {
      ok: false,
      errors: ['This is a group someone shared with you, not a backup. Open it from Groups → Receive → Open file.'],
      warnings,
    };
  }

  if (raw.schema !== EXPORT_SCHEMA) {
    const got = raw.schema ? `"${String(raw.schema)}"` : 'missing';
    return {
      ok: false,
      errors: [`Unknown file format (schema: ${got}). This does not appear to be an OpenSplitwise export file.`],
      warnings,
    };
  }

  if (typeof raw.version !== 'number') {
    return { ok: false, errors: ['Export file is missing a version number.'], warnings };
  }

  if (raw.version > EXPORT_VERSION) {
    return {
      ok: false,
      errors: [`This file was created with a newer version of OpenSplitwise (v${raw.version}). Please update the app to import it.`],
      warnings,
    };
  }

  if (raw.version < EXPORT_VERSION) {
    warnings.push(`This file was created with an older version of OpenSplitwise (v${raw.version}). It will be migrated automatically.`);
  }

  if (!isObj(raw.data)) {
    return { ok: false, errors: ['Export file is missing its data payload.'], warnings };
  }

  const d = raw.data as Record<string, unknown>;

  for (const field of ['users', 'groups', 'expenses', 'settlements', 'activities'] as const) {
    if (!Array.isArray(d[field])) errors.push(`Missing or invalid "${field}" field.`);
  }
  if (typeof d.currentUserId !== 'string') errors.push('Missing "currentUserId" field.');
  if (errors.length) return { ok: false, errors, warnings };

  // Soft referential integrity checks — these produce warnings, not errors.
  const userIds = new Set((d.users as Record<string, unknown>[]).map((u) => u.id));
  const groupIds = new Set((d.groups as Record<string, unknown>[]).map((g) => g.id));
  let flagged = 0;

  for (const e of d.expenses as Record<string, unknown>[]) {
    if (flagged >= 4) { warnings.push('Additional integrity issues detected (not shown).'); break; }
    if (!userIds.has(e.paidBy)) { warnings.push(`Expense "${e.description ?? '?'}" has an unknown payer.`); flagged++; }
    if (e.groupId && !groupIds.has(e.groupId)) { warnings.push(`Expense "${e.description ?? '?'}" references an unknown group.`); flagged++; }
  }

  const revived = raw as unknown as AppExport;
  revived.data.groups = revived.data.groups.map(withoutLegacyTotals);
  return { ok: true, data: revived, warnings, errors: [] };
}

// ─── ID remapping — used for "Import as new group" ───────────────────────────

/**
 * @param selfIdInFile Which person *in the file* the importer is, folded into
 *   their own account. Defaults to the file's author — correct when you export
 *   and re-import your own data, but wrong when a friend shares theirs, so the
 *   import UI lets the importer pick. Pass `null` when they are in neither the
 *   file nor the group; everyone in the file then comes across as a new person.
 */
export function remapForNewGroup(
  exported: AppExport,
  existingUsers: User[],
  appCurrentUserId: string,
  selfIdInFile: string | null = exported.data.currentUserId,
): ExportPayload {
  const idMap = new Map<string, string>();

  // Whoever the importer identified as maps to the app's current user.
  if (selfIdInFile) idMap.set(selfIdInFile, appCurrentUserId);

  const byEmail = new Map(existingUsers.filter((u) => u.email).map((u) => [u.email!, u]));
  const byId = new Map(existingUsers.map((u) => [u.id, u]));
  const remapId = (id: string) => idMap.get(id) ?? id;

  // Remap users — match existing by email first, then by ID.
  const newUsers: User[] = [];
  for (const u of exported.data.users) {
    if (u.id === selfIdInFile) continue; // already handled
    const existing = (u.email && byEmail.get(u.email)) || byId.get(u.id);
    if (existing) {
      idMap.set(u.id, existing.id);
    } else {
      // Keep the original ID so re-importing the same group matches this
      // person by ID instead of creating a duplicate. We only reach here when
      // no existing user matched, so the ID can't collide.
      idMap.set(u.id, u.id);
      newUsers.push({ ...u });
    }
  }

  // Remap groups — always get fresh IDs.
  const remappedGroups: Group[] = exported.data.groups.map((g) => {
    const newId = crypto.randomUUID();
    idMap.set(g.id, newId);
    return {
      ...g,
      id: newId,
      members: g.members.map((m) => ({ ...m, userId: remapId(m.userId) })),
    };
  });

  // Remap expenses.
  const expIdMap = new Map<string, string>();
  const remappedExpenses: Expense[] = exported.data.expenses.map((e) => {
    const newId = crypto.randomUUID();
    expIdMap.set(e.id, newId);
    return {
      ...e,
      id: newId,
      paidBy: remapId(e.paidBy),
      groupId: e.groupId ? remapId(e.groupId) : undefined,
      split: { ...e.split, entries: e.split.entries.map((en) => ({ ...en, userId: remapId(en.userId) })) },
      // Who had each item of a receipt split by item.
      ...(e.items && { items: e.items.map((it) => ({ ...it, assigned: it.assigned.map(remapId) })) }),
    };
  });
  // A refund names the expense it refunds, which has a new id too.
  for (const e of remappedExpenses) {
    if (e.refund?.of) e.refund = { of: expIdMap.get(e.refund.of) };
  }

  // Remap settlements.
  const setIdMap = new Map<string, string>();
  const remappedSettlements: Settlement[] = exported.data.settlements.map((s) => {
    const newId = crypto.randomUUID();
    setIdMap.set(s.id, newId);
    return {
      ...s,
      id: newId,
      fromUserId: remapId(s.fromUserId),
      toUserId: remapId(s.toUserId),
      groupId: s.groupId ? remapId(s.groupId) : undefined,
    };
  });

  // Remap activities, preserving type-specific fields.
  const remappedActivities: Activity[] = exported.data.activities.map((a) => {
    const base: Record<string, unknown> = {
      ...a,
      id: crypto.randomUUID(),
      actorId: remapId(a.actorId),
      groupId: a.groupId ? remapId(a.groupId) : undefined,
    };
    if ('expenseId' in a && typeof a.expenseId === 'string') {
      base.expenseId = expIdMap.get(a.expenseId) ?? a.expenseId;
    }
    // A payment's entry names the payment, so undoing it can remove the entry.
    if ('settlementId' in a && typeof a.settlementId === 'string') {
      base.settlementId = setIdMap.get(a.settlementId) ?? a.settlementId;
    }
    // An edit's before/after copies name the payer and everyone in the split.
    for (const key of ['before', 'after'] as const) {
      const snap = (a as Partial<Record<typeof key, ExpenseSnapshot>>)[key];
      if (snap) {
        base[key] = {
          ...snap,
          paidBy: remapId(snap.paidBy),
          split: { ...snap.split, entries: snap.split.entries.map((en) => ({ ...en, userId: remapId(en.userId) })) },
        };
      }
    }
    if ('fromUserId' in a) base.fromUserId = remapId(a.fromUserId as string);
    if ('toUserId' in a) base.toUserId = remapId(a.toUserId as string);
    return base as unknown as Activity;
  });

  // Remap friendBalance keys.
  const remappedBalances: Record<string, number> = {};
  // Not checked by `parseAndValidate`, so a valid file may legitimately omit it.
  for (const [oldId, bal] of Object.entries(exported.data.friendBalances ?? {})) {
    remappedBalances[remapId(oldId)] = bal;
  }

  return {
    currentUserId: appCurrentUserId,
    users: newUsers,
    groups: remappedGroups,
    expenses: remappedExpenses,
    settlements: remappedSettlements,
    activities: remappedActivities,
    friendBalances: remappedBalances,
  };
}
