import type {
  Activity, CategoryId, CustomCategory, Expense, Group, Settlement, SplitEntry, User,
} from '../types';
import { round } from './calculations';
import { categoryLabel, cleanCategoryName, findCategoryByName } from './categories';
import { EXPORT_SCHEMA, EXPORT_VERSION, type AppExport, type ParseResult } from './dataExport';

// ─────────────────────────────────────────────────────────────────────────────
// Splitwise's group spreadsheet ("Export as spreadsheet"), both ways.
//
// The file is a CSV:
//
//   Date,Description,Category,Cost,Currency,Alice,Bob
//   2024-05-01,Dinner,Dining out,60.00,USD,30.00,-30.00
//   2024-05-02,Bob paid Alice,Payment,30.00,USD,-30.00,30.00
//
//   2024-05-03,Total balance, , ,USD,0.00,0.00
//
// Each person's column is what they paid minus what they owe, so it says how
// the row moved their balance but not who paid. Payments use the category
// "Payment". The last row(s) total each person's column, one per currency.
// ─────────────────────────────────────────────────────────────────────────────

const FIXED_COLUMNS = ['Date', 'Description', 'Category', 'Cost', 'Currency'] as const;
const PAYMENT = 'Payment';
const TOTAL_BALANCE = 'Total balance';
const EPSILON = 0.005;

// ─── CSV text ─────────────────────────────────────────────────────────────────

/** RFC 4180: commas, quotes and line breaks inside quoted fields. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  const src = text.replace(/^\uFEFF/, '');

  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"' && src[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') {
      quoted = true;
    } else if (c === ',') {
      row.push(field); field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      row.push(field); rows.push(row);
      row = []; field = '';
    } else {
      field += c;
    }
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

function csvField(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

const csvLine = (fields: string[]) => fields.map(csvField).join(',');

/** True when the text starts with Splitwise's header row. */
export function looksLikeSplitwiseCsv(text: string): boolean {
  const header = parseCsv(text.slice(0, 2000))[0]?.map((h) => h.trim().toLowerCase()) ?? [];
  return FIXED_COLUMNS.every((col, i) => header[i] === col.toLowerCase());
}

// ─── Categories ───────────────────────────────────────────────────────────────

/** Splitwise's category names, lower case, that have a built-in match here. */
const FROM_SPLITWISE: Record<string, CategoryId> = {
  'general': 'other',
  'uncategorized': 'other',
  'other': 'other',
  'dining out': 'food',
  'food and drink': 'food',
  'food and drink - other': 'food',
  'liquor': 'food',
  'groceries': 'groceries',
  'bus/train': 'transport',
  'car': 'transport',
  'gas/fuel': 'transport',
  'parking': 'transport',
  'taxi': 'transport',
  'bicycle': 'transport',
  'transportation': 'transport',
  'transportation - other': 'transport',
  'plane': 'travel',
  'hotel': 'accommodation',
  'entertainment': 'entertainment',
  'entertainment - other': 'entertainment',
  'games': 'entertainment',
  'movies': 'entertainment',
  'music': 'entertainment',
  'sports': 'entertainment',
  'utilities': 'utilities',
  'utilities - other': 'utilities',
  'electricity': 'utilities',
  'heat/gas': 'utilities',
  'water': 'utilities',
  'trash': 'utilities',
  'cleaning': 'utilities',
  'tv/phone/internet': 'utilities',
  'rent': 'rent',
  'mortgage': 'rent',
  'medical expenses': 'healthcare',
  'gifts': 'gifts',
  'education': 'education',
  'clothing': 'shopping',
  'electronics': 'shopping',
  'furniture': 'shopping',
  'household supplies': 'shopping',
};

/** What a built-in category is called on export: Splitwise's name where there is an obvious one. */
const TO_SPLITWISE: Partial<Record<CategoryId, string>> = {
  other: 'General',
  food: 'Dining out',
  healthcare: 'Medical expenses',
};

// ─── Import ───────────────────────────────────────────────────────────────────

const PALETTE = ['#7c3aed', '#0ea5e9', '#10b981', '#f59e0b', '#ec4899', '#ef4444', '#8b5cf6', '#06b6d4'];

function makeUser(name: string, index: number, now: Date): User {
  const initials = name.split(/\s+/).map((p) => p[0]).join('').toUpperCase().slice(0, 2);
  return { id: crypto.randomUUID(), name, initials, avatarColor: PALETTE[index % PALETTE.length], createdAt: now };
}

/** "1,234.50" or "-12" → number; NaN when it isn't one. */
function parseAmount(raw: string): number {
  const s = raw.trim().replace(/,/g, '');
  return s === '' ? 0 : Number(s);
}

/** "2024-05-01" as midday local time, so no time zone moves it to another day. */
function parseDate(raw: string): Date | null {
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(raw.trim());
  if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12);
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** "trip-to-paris_2024-05-01_export.csv" → "Trip To Paris". */
export function groupNameFromFilename(filename: string): string {
  const base = filename
    .replace(/\.csv$/i, '')
    .replace(/_?\d{4}-\d{2}-\d{2}_export$/i, '')
    .replace(/[-_]+/g, ' ')
    .trim();
  return base ? base.replace(/\b\p{L}/gu, (c) => c.toUpperCase()) : 'Splitwise import';
}

/** Moves the cents lost to rounding onto the last entry, so the split adds up to `total`. */
function fixRounding(entries: SplitEntry[], total: number): SplitEntry[] {
  const drift = round(total - entries.reduce((s, e) => s + e.amount, 0));
  if (Math.abs(drift) < EPSILON || !entries.length) return entries;
  const last = entries[entries.length - 1];
  return [...entries.slice(0, -1), { ...last, amount: round(last.amount + drift) }];
}

interface RowExpense {
  paidBy: string;
  amount: number;
  entries: SplitEntry[];
  note?: string;
}

/**
 * Turns one row's per-person effects into expenses with a single payer each.
 *
 * With one person ahead (the usual case) that person paid the whole cost and
 * everyone behind owes what they're behind by. When several people are
 * ahead, the file can't say what each paid, so the row becomes one expense
 * per person ahead, sized by how far ahead they are. Balances come out the
 * same either way.
 */
function rowToExpenses(cost: number, nets: Map<string, number>): RowExpense[] {
  const ahead = [...nets].filter(([, n]) => n > EPSILON);
  const behind = [...nets].filter(([, n]) => n < -EPSILON);
  const totalAhead = ahead.reduce((s, [, n]) => s + n, 0);
  if (!ahead.length) return [];

  return ahead.map(([payer, net]) => {
    const portion = net / totalAhead;
    const amount = round(cost * portion);
    const own = round(amount - net);
    const entries: SplitEntry[] = [
      ...(own > EPSILON ? [{ userId: payer, amount: own }] : []),
      ...behind.map(([userId, n]) => ({ userId, amount: round(-n * portion) })),
    ];
    return {
      paidBy: payer,
      amount,
      entries: fixRounding(entries, amount),
      note: ahead.length > 1
        ? 'Imported from Splitwise: several people paid, so this is split into one expense per payer.'
        : undefined,
    };
  });
}

/** Parses a Splitwise group spreadsheet into a group backup that imports as a new group. */
export function parseSplitwiseCsv(text: string, filename = ''): ParseResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const rows = parseCsv(text);
  const header = rows[0]?.map((h) => h.trim()) ?? [];

  if (!looksLikeSplitwiseCsv(text)) {
    return { ok: false, errors: ['This CSV isn\'t a Splitwise group export (expected columns Date, Description, Category, Cost, Currency, then one per person).'], warnings };
  }
  const names = header.slice(FIXED_COLUMNS.length);
  if (!names.length) {
    return { ok: false, errors: ['The file has no columns for people.'], warnings };
  }

  const now = new Date();
  const users = names.map((name, i) => makeUser(name || `Person ${i + 1}`, i, now));
  // A group here is in one currency, so a file that mixes them becomes one
  // group per currency, each with its own balances (as Splitwise keeps them).
  const groupIds = new Map<string, string>();
  const groupIdFor = (currency: string) => {
    let id = groupIds.get(currency);
    if (!id) {
      id = crypto.randomUUID();
      groupIds.set(currency, id);
    }
    return id;
  };
  const expenses: Expense[] = [];
  const settlements: Settlement[] = [];
  const activities: Activity[] = [];
  const customCategories: CustomCategory[] = [];
  const currencyCount = new Map<string, number>();
  /** currency → each person's total, from the file's own Total balance rows. */
  const fileTotals = new Map<string, number[]>();
  let unknownPayer = 0;
  let badRows = 0;

  const categoryFor = (name: string): CategoryId => {
    const clean = cleanCategoryName(name);
    if (!clean) return 'other';
    const known = FROM_SPLITWISE[clean.toLowerCase()] ?? findCategoryByName(clean, { categories: customCategories });
    if (known) return known;
    const made: CustomCategory = { id: `custom:${crypto.randomUUID()}`, name: clean };
    customCategories.push(made);
    return made.id;
  };

  for (const row of rows.slice(1)) {
    if (row.every((f) => f.trim() === '')) continue;
    const [rawDate, rawDescription, rawCategory, rawCost, rawCurrency] = row;
    const description = (rawDescription ?? '').trim();
    const currency = (rawCurrency ?? '').trim().toUpperCase() || 'USD';
    const nets = names.map((_, i) => parseAmount(row[FIXED_COLUMNS.length + i] ?? ''));

    if (description === TOTAL_BALANCE) {
      fileTotals.set(currency, nets);
      continue;
    }

    const date = parseDate(rawDate ?? '');
    let cost = parseAmount(rawCost ?? '');
    if (!date || Number.isNaN(cost) || nets.some(Number.isNaN)) { badRows++; continue; }

    currencyCount.set(currency, (currencyCount.get(currency) ?? 0) + 1);
    const groupId = groupIdFor(currency);
    const byUser = new Map(users.map((u, i) => [u.id, nets[i]]));

    if ((rawCategory ?? '').trim() === PAYMENT) {
      // Whoever handed over the money is ahead; whoever got it is behind.
      const givers = [...byUser].filter(([, n]) => n > EPSILON).map(([id, n]) => ({ id, left: n }));
      const takers = [...byUser].filter(([, n]) => n < -EPSILON).map(([id, n]) => ({ id, left: -n }));
      for (const g of givers) {
        for (const t of takers) {
          const amount = round(Math.min(g.left, t.left));
          if (amount < EPSILON) continue;
          g.left -= amount; t.left -= amount;
          const s: Settlement = { id: crypto.randomUUID(), fromUserId: g.id, toUserId: t.id, amount, currency, groupId, date, createdAt: now };
          settlements.push(s);
          activities.push({ id: crypto.randomUUID(), type: 'payment', date, actorId: g.id, groupId, settlementId: s.id, fromUserId: g.id, toUserId: t.id, amount });
        }
      }
      continue;
    }

    // Money coming back is a negative cost; flip it and mark it a refund.
    const refund = cost < 0;
    if (refund) {
      cost = -cost;
      for (const [id, n] of byUser) byUser.set(id, -n);
    }

    let parts = rowToExpenses(cost, byUser);
    if (!parts.length) {
      // Nobody's balance moved (one person's own expense), so the file doesn't say whose it was.
      unknownPayer++;
      const someone = users[0].id;
      parts = [{
        paidBy: someone,
        amount: round(cost),
        entries: [{ userId: someone, amount: round(cost) }],
        note: 'Imported from Splitwise: this didn\'t change anyone\'s balance, so the file doesn\'t say who paid.',
      }];
    }

    const category = categoryFor(rawCategory ?? '');
    for (const part of parts) {
      const shares = part.entries.map((e) => e.amount);
      const equal = shares.every((a) => Math.abs(a - shares[0]) <= 0.01);
      const e: Expense = {
        id: crypto.randomUUID(),
        description: description || 'Expense',
        amount: part.amount,
        currency,
        paidBy: part.paidBy,
        groupId,
        date,
        split: { type: equal ? 'equal' : 'exact', entries: part.entries },
        category,
        ...(part.note ? { notes: part.note } : {}),
        ...(refund ? { refund: {} } : {}),
        createdAt: now,
        updatedAt: now,
      };
      expenses.push(e);
      activities.push({ id: crypto.randomUUID(), type: 'expense_added', date, actorId: e.paidBy, groupId, expenseId: e.id });
    }
  }

  if (!expenses.length && !settlements.length) {
    errors.push(badRows ? 'No rows in the file could be read.' : 'The file has no expenses or payments.');
    return { ok: false, errors, warnings };
  }

  if (badRows) warnings.push(`${badRows} row${badRows === 1 ? '' : 's'} couldn't be read and ${badRows === 1 ? 'was' : 'were'} skipped.`);
  if (unknownPayer) {
    warnings.push(`${unknownPayer} expense${unknownPayer === 1 ? '' : 's'} didn't change anyone's balance, so the file doesn't say who paid. ${unknownPayer === 1 ? 'It\'s' : 'They\'re'} listed as paid by ${users[0].name}.`);
  }
  const baseName = groupNameFromFilename(filename);
  // Most-used currency first; only those with something in them.
  const currencies = [...currencyCount]
    .sort((x, y) => y[1] - x[1])
    .map(([c]) => c)
    .filter((c) => expenses.some((e) => e.currency === c) || settlements.some((x) => x.currency === c));
  const nameFor = (currency: string) => (currencies.length > 1 ? `${baseName} (${currency})` : baseName);
  if (currencies.length > 1) {
    warnings.push(
      `The file mixes currencies (${currencies.join(', ')}), so it becomes one group per currency: ${currencies.map(nameFor).join(', ')}.`,
    );
  }

  // Check the result against the file's own totals.
  for (const [currency, totals] of fileTotals) {
    const ours = new Map(users.map((u) => [u.id, 0]));
    for (const e of expenses.filter((x) => x.currency === currency)) {
      const sign = e.refund ? -1 : 1;
      ours.set(e.paidBy, ours.get(e.paidBy)! + sign * e.amount);
      for (const en of e.split.entries) ours.set(en.userId, ours.get(en.userId)! - sign * en.amount);
    }
    for (const s of settlements.filter((x) => x.currency === currency)) {
      ours.set(s.fromUserId, ours.get(s.fromUserId)! + s.amount);
      ours.set(s.toUserId, ours.get(s.toUserId)! - s.amount);
    }
    const off = users.filter((u, i) => Math.abs(ours.get(u.id)! - totals[i]) > 0.02);
    if (off.length) {
      warnings.push(`After import, ${off.map((u) => u.name).join(', ')} ${off.length === 1 ? 'has' : 'have'} a different ${currency} balance than the file's "Total balance" row. Check the group after importing.`);
    }
  }

  const groups: Group[] = currencies.map((currency) => {
    const id = groupIdFor(currency);
    const dates = [
      ...expenses.filter((e) => e.groupId === id).map((e) => e.date),
      ...settlements.filter((x) => x.groupId === id).map((x) => x.date),
    ];
    const first = new Date(Math.min(...dates.map((d) => d.getTime())));
    const last = new Date(Math.max(...dates.map((d) => d.getTime())));
    return {
      id,
      name: nameFor(currency),
      emoji: '🧾',
      color: PALETTE[0],
      type: 'other',
      members: users.map((u, i) => ({ userId: u.id, role: i === 0 ? 'owner' : 'member', joinedAt: first })),
      currency,
      ...(customCategories.length ? { categories: customCategories } : {}),
      lastActivity: last,
      createdAt: first,
      updatedAt: now,
    };
  });

  const data: AppExport = {
    schema: EXPORT_SCHEMA,
    version: EXPORT_VERSION,
    exportType: 'group',
    exportedAt: now.toISOString(),
    meta: {
      source: 'splitwise',
      groupId: groups[0].id,
      groupName: baseName,
      userCount: users.length,
      groupCount: groups.length,
      expenseCount: expenses.length,
      settlementCount: settlements.length,
      activityCount: activities.length,
    },
    data: {
      // Nobody in the file is marked as its author; the importer picks who they are.
      currentUserId: '',
      users,
      groups,
      expenses,
      settlements,
      activities,
      friendBalances: {},
    },
  };
  return { ok: true, data, errors: [], warnings };
}

// ─── Export ───────────────────────────────────────────────────────────────────

const ymd = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

const money = (n: number) => (Math.abs(n) < EPSILON ? 0 : n).toFixed(2);

export interface SplitwiseCsvInput {
  group: Group;
  users: User[];
  expenses: Expense[];
  settlements: Settlement[];
}

/** Writes one group in Splitwise's spreadsheet layout. */
export function buildSplitwiseCsv({ group, users, expenses, settlements }: SplitwiseCsvInput): string {
  const groupExpenses = expenses.filter((e) => e.groupId === group.id);
  const groupSettlements = settlements.filter((s) => s.groupId === group.id);

  // Members first, then anyone a record names who has since left the group.
  const ids = group.members.map((m) => m.userId);
  const seen = new Set(ids);
  const include = (id: string) => { if (!seen.has(id)) { seen.add(id); ids.push(id); } };
  for (const e of groupExpenses) { include(e.paidBy); e.split.entries.forEach((en) => include(en.userId)); }
  for (const s of groupSettlements) { include(s.fromUserId); include(s.toUserId); }
  const nameOf = (id: string) => users.find((u) => u.id === id)?.name ?? 'Unknown';
  const col = new Map(ids.map((id, i) => [id, i]));

  type Row = { date: Date; fields: string[]; currency: string; nets: number[] };
  const rows: Row[] = [];

  for (const e of groupExpenses) {
    const sign = e.refund ? -1 : 1;
    const nets = ids.map(() => 0);
    nets[col.get(e.paidBy)!] += sign * e.amount;
    for (const en of e.split.entries) nets[col.get(en.userId)!] -= sign * en.amount;
    const category = TO_SPLITWISE[e.category] ?? categoryLabel(e.category, group);
    rows.push({ date: e.date, currency: e.currency, nets, fields: [e.description, category, money(sign * e.amount), e.currency] });
  }
  for (const s of groupSettlements) {
    const nets = ids.map(() => 0);
    nets[col.get(s.fromUserId)!] += s.amount;
    nets[col.get(s.toUserId)!] -= s.amount;
    const description = `${nameOf(s.fromUserId)} paid ${nameOf(s.toUserId)}`;
    rows.push({ date: s.date, currency: s.currency, nets, fields: [description, PAYMENT, money(s.amount), s.currency] });
  }
  rows.sort((a, b) => a.date.getTime() - b.date.getTime());

  const lines = [csvLine([...FIXED_COLUMNS, ...ids.map(nameOf)])];
  const totals = new Map<string, number[]>();
  for (const r of rows) {
    lines.push(csvLine([ymd(r.date), ...r.fields, ...r.nets.map(money)]));
    const t = totals.get(r.currency) ?? ids.map(() => 0);
    r.nets.forEach((n, i) => { t[i] += n; });
    totals.set(r.currency, t);
  }

  lines.push('');
  const today = ymd(new Date());
  if (!totals.size) totals.set(group.currency ?? 'USD', ids.map(() => 0));
  for (const [currency, t] of totals) {
    lines.push(csvLine([today, TOTAL_BALANCE, ' ', ' ', currency, ...t.map(money)]));
  }
  return lines.join('\n') + '\n';
}

/** Splitwise names its files like "trip-to-paris_2024-05-01_export.csv". */
export function splitwiseFilename(groupName: string): string {
  const slug = groupName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'group';
  return `${slug}_${ymd(new Date())}_export.csv`;
}

export function downloadSplitwiseCsv(input: SplitwiseCsvInput): void {
  const blob = new Blob([buildSplitwiseCsv(input)], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = splitwiseFilename(input.group.name);
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
