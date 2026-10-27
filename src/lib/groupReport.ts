import jsPDF from 'jspdf';
import { autoTable, type CellDef, type RowInput, type UserOptions } from 'jspdf-autotable';

type ColumnStyles = NonNullable<UserOptions['columnStyles']>;
import type { Group, Expense, User, Settlement, PaymentMethod } from '../types';
import { categoryLabel } from './categories';
import { groupCurrency } from './currency';
import { formatCurrency } from '../utils/format';
import { calculateBalances, calculateSettlements, signedAmount } from './calculations';
import { getShareForUser } from '../utils/expense';
import plexSansRegularUrl from '../assets/fonts/IBMPlexSans-Regular.ttf?url';
import plexSansSemiBoldUrl from '../assets/fonts/IBMPlexSans-SemiBold.ttf?url';
import plexMonoRegularUrl from '../assets/fonts/IBMPlexMono-Regular.ttf?url';
import plexMonoSemiBoldUrl from '../assets/fonts/IBMPlexMono-SemiBold.ttf?url';

/*
 * Group expense report, styled to match the app's Ledger design: ink on white,
 * a heavy rule opening each section, hairlines between rows, every amount in
 * mono, blue for "is owed" and orange for "owes".
 *
 * Contents, in order: summary, balances, payments still to make, payments
 * already made, then the expense list.
 */

// ─── Palette (mirrors src/styles/variables.css, light theme) ─────────────────

type RGB = [number, number, number];

const C = {
  ink:   [21, 23, 28] as RGB,
  soft:  [74, 79, 88] as RGB,
  muted: [91, 96, 106] as RGB,
  rule:  [228, 228, 223] as RGB,
  owed:  [29, 71, 201] as RGB,
  owe:   [180, 65, 15] as RGB,
};

// ─── Fonts ────────────────────────────────────────────────────────────────────

interface Fonts {
  sans: string;
  mono: string;
  /** Plex has these glyphs; the PDF built-in fonts do not. */
  minus: string;
  arrow: string;
  dot: string;
}

const PLEX: Fonts = { sans: 'IBMPlexSans', mono: 'IBMPlexMono', minus: '−', arrow: '→', dot: '·' };
const BUILTIN: Fonts = { sans: 'helvetica', mono: 'courier', minus: '-', arrow: '->', dot: '-' };

const FONT_FILES: [url: string, file: string, family: string, style: string][] = [
  [plexSansRegularUrl, 'IBMPlexSans-Regular.ttf', 'IBMPlexSans', 'normal'],
  [plexSansSemiBoldUrl, 'IBMPlexSans-SemiBold.ttf', 'IBMPlexSans', 'bold'],
  [plexMonoRegularUrl, 'IBMPlexMono-Regular.ttf', 'IBMPlexMono', 'normal'],
  [plexMonoSemiBoldUrl, 'IBMPlexMono-SemiBold.ttf', 'IBMPlexMono', 'bold'],
];

/** Base64 of each font file, fetched once per session. */
let fontData: Promise<string[]> | null = null;

function toBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

/**
 * Registers IBM Plex with the document. Falls back to the PDF built-in fonts
 * when the files cannot be fetched (offline, say), so export never fails on it.
 */
async function loadFonts(doc: jsPDF): Promise<Fonts> {
  try {
    fontData ??= Promise.all(
      FONT_FILES.map(async ([url]) => {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`font ${url}: ${res.status}`);
        return toBase64(await res.arrayBuffer());
      }),
    );
    const data = await fontData;
    FONT_FILES.forEach(([, file, family, style], i) => {
      doc.addFileToVFS(file, data[i]);
      doc.addFont(file, family, style);
    });
    return PLEX;
  } catch {
    fontData = null;
    return BUILTIN;
  }
}

// ─── Formatting ───────────────────────────────────────────────────────────────

const PAYMENT_METHOD_LABELS: Record<PaymentMethod, string> = {
  venmo: 'Venmo',
  cashapp: 'Cash App',
  zelle: 'Zelle',
  cash: 'Cash',
  other: 'Other',
};

/**
 * The group's currency, unsigned. The embedded fonts cover Latin-1 plus €, so
 * "$12.50", "€12.50", "£" and "¥" print as symbols; anything else ("₹", "₩")
 * prints as its code, "INR 1,250.00", rather than as a missing glyph.
 */
function fmtMoney(n: number, currency: string): string {
  const symbol = formatCurrency(n, currency);
  if (!/[^\u0020-\u00ff€]/.test(symbol)) return symbol;
  return new Intl.NumberFormat('en-US', { style: 'currency', currency, currencyDisplay: 'code' }).format(Math.abs(n));
}

const isZero = (n: number) => Math.abs(n) < 0.005;

function signed(n: number, f: Fonts, currency: string): string {
  if (isZero(n)) return fmtMoney(0, currency);
  return `${n > 0 ? '+' : f.minus}${fmtMoney(n, currency)}`;
}

function longDate(d: Date): string {
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

/** "SEP 12", the date down the left edge of ledger rows. */
function ledgerDate(d: Date): string {
  return d.toLocaleDateString('en-US', { month: 'short', day: '2-digit' }).toUpperCase();
}

function stripEmoji(str: string): string {
  // Neither Plex nor the built-in fonts carry emoji.
  return str
    .replace(/\p{Extended_Pictographic}|\p{Regional_Indicator}|[\u{FE00}-\u{FE0F}\u{200D}]/gu, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

// ─── Main export ──────────────────────────────────────────────────────────────

export async function generateGroupReport(
  group: Group,
  expenses: Expense[],
  users: User[],
  /** Payments already marked complete in this group. */
  payments: Settlement[] = [],
): Promise<void> {
  const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
  const f = await loadFonts(doc);
  const cur = groupCurrency(group);

  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  const margin = 16;
  const cw = pageW - margin * 2;
  const bottomLimit = pageH - 14;

  const nameOf = (id: string) => stripEmoji(users.find((u) => u.id === id)?.name ?? 'Unknown');

  // ── People: a short code and colour each, like the app's avatars ───────────
  //
  // The expense rows show these instead of names, with a legend up top. Codes
  // must be unique on paper, where colour may not survive printing: the usual
  // initials, else first + last word ("FJ" for Frank Gonzalez Jr), else the
  // first two letters of the first name ("Er", "El"), else a number.
  const involved = new Set<string>(group.members.map((m) => m.userId));
  for (const e of expenses) {
    involved.add(e.paidBy);
    for (const en of e.split.entries) involved.add(en.userId);
  }
  const people = [...involved].map((id) => users.find((u) => u.id === id)).filter((u): u is User => !!u);
  const codeOf = new Map<string, string>();
  {
    const words = (u: User) => stripEmoji(u.name).trim().split(/\s+/).filter(Boolean);
    const candidates = (u: User): string[] => {
      const w = words(u);
      const first = w[0] ?? '?';
      return [
        (u.initials || first[0]).toUpperCase().slice(0, 2),
        (first[0] + (w.length > 1 ? w[w.length - 1][0] : '')).toUpperCase(),
        first.slice(0, 1).toUpperCase() + first.slice(1, 2).toLowerCase(),
      ];
    };
    let pending = people;
    for (let level = 0; level < 3 && pending.length; level++) {
      const counts = new Map<string, number>();
      const taken = new Set(codeOf.values());
      for (const u of pending) {
        const c = candidates(u)[level];
        counts.set(c, (counts.get(c) ?? 0) + 1);
      }
      const still: User[] = [];
      for (const u of pending) {
        const c = candidates(u)[level];
        if (counts.get(c) === 1 && !taken.has(c)) codeOf.set(u.id, c);
        else still.push(u);
      }
      pending = still;
    }
    pending.forEach((u, i) => codeOf.set(u.id, `${candidates(u)[0][0]}${i + 1}`));
  }

  /** The avatar colour, softened the way the app does (22% over white). */
  const tintOf = (id: string): RGB => {
    const hex = users.find((u) => u.id === id)?.avatarColor ?? '#94a3b8';
    const m = /^#?([0-9a-f]{6})$/i.exec(hex);
    const n = m ? parseInt(m[1], 16) : 0x94a3b8;
    const mix = (c: number) => Math.round(c * 0.22 + 255 * 0.78);
    return [mix((n >> 16) & 255), mix((n >> 8) & 255), mix(n & 255)];
  };

  const CHIP_R = 2.3;
  /** A person's chip, centred on (cx, cy). */
  const chip = (id: string, cx: number, cy: number) => {
    doc.setFillColor(...tintOf(id));
    doc.circle(cx, cy, CHIP_R, 'F');
    doc.setFont(f.sans, 'bold');
    doc.setFontSize(5.4);
    doc.setTextColor(...C.ink);
    doc.text(codeOf.get(id) ?? '?', cx, cy, { align: 'center', baseline: 'middle' });
  };
  const memberIds = group.members.map((m) => m.userId);
  const sortedExpenses = [...expenses].sort((a, b) => a.date.getTime() - b.date.getTime());
  const sortedPayments = [...payments].sort((a, b) => a.date.getTime() - b.date.getTime());

  // Completed payments count, so balances and transfers show what is still owed.
  const balances = calculateBalances({ expenses, memberIds, settlements: payments });
  const transfers = calculateSettlements({ expenses, memberIds, settlements: payments });

  // Refunds come off what was spent.
  const totalSpent = expenses.reduce((s, e) => s + signedAmount(e), 0);
  const outstanding = transfers.reduce((s, t) => s + t.amount, 0);
  const times = expenses.map((e) => e.date.getTime());
  const first = times.length ? new Date(Math.min(...times)) : null;
  const last = times.length ? new Date(Math.max(...times)) : null;
  const dateRange = !first
    ? 'No expenses'
    : first.toDateString() === last!.toDateString()
      ? longDate(first)
      : `${longDate(first)} ${'–'} ${longDate(last!)}`;

  const groupName = stripEmoji(group.name) || 'Group';

  // ── Drawing helpers ─────────────────────────────────────────────────────────

  const text = (
    str: string | string[],
    x: number,
    y: number,
    opts: { font?: 'sans' | 'mono'; bold?: boolean; size: number; color?: RGB; align?: 'left' | 'right' },
  ) => {
    doc.setFont(opts.font === 'mono' ? f.mono : f.sans, opts.bold ? 'bold' : 'normal');
    doc.setFontSize(opts.size);
    doc.setTextColor(...(opts.color ?? C.ink));
    doc.text(str, x, y, { align: opts.align ?? 'left' });
  };

  const hline = (y: number, weight: number, color: RGB) => {
    doc.setDrawColor(...color);
    doc.setLineWidth(weight);
    doc.line(margin, y, pageW - margin, y);
  };

  /** Section heading; starts a new page if the section would begin too low. */
  const section = (title: string, y: number, needed = 40): number => {
    if (y + needed > bottomLimit) {
      doc.addPage();
      y = 24;
    }
    text(title, margin, y, { bold: true, size: 11.5 });
    return y + 3.5;
  };

  const lastY = () => (doc as unknown as { lastAutoTable?: { finalY: number } }).lastAutoTable?.finalY ?? 0;

  /** Ledger table: caps header over an ink line, hairlines between rows, no fills. */
  const table = (
    startY: number,
    head: string[],
    body: RowInput[],
    columnStyles: ColumnStyles,
    foot?: RowInput[],
    hooks: Pick<UserOptions, 'willDrawCell' | 'didDrawCell' | 'rowPageBreak'> = {},
  ) => {
    autoTable(doc, {
      startY,
      head: [head],
      body,
      foot,
      theme: 'plain',
      margin: { left: margin, right: margin, top: 24, bottom: 14 },
      showFoot: 'lastPage',
      styles: {
        font: f.sans,
        fontSize: 8.5,
        textColor: C.ink,
        cellPadding: { top: 2.1, bottom: 2.1, left: 0, right: 2 },
        lineColor: C.rule,
        lineWidth: { bottom: 0.2 },
        valign: 'middle',
      },
      headStyles: {
        font: f.sans,
        fontStyle: 'normal',
        fontSize: 6.8,
        textColor: C.muted,
        lineColor: C.ink,
        lineWidth: { bottom: 0.35 },
        cellPadding: { top: 1.5, bottom: 2, left: 0, right: 2 },
      },
      footStyles: {
        font: f.sans,
        fontStyle: 'bold',
        lineColor: C.ink,
        lineWidth: { top: 0.35 },
      },
      columnStyles,
      ...hooks,
      // Right-aligned header labels over right-aligned money columns.
      didParseCell: (data) => {
        const col = columnStyles[data.column.index];
        if (data.section === 'head' && col?.halign === 'right') data.cell.styles.halign = 'right';
        if (data.section === 'head') data.cell.text = data.cell.text.map((t) => t.toUpperCase());
      },
    });
    return lastY();
  };

  const money = (n: number, opts: { color?: RGB; bold?: boolean } = {}): CellDef => ({
    content: fmtMoney(n, cur),
    styles: { font: f.mono, halign: 'right', textColor: opts.color ?? C.ink, fontStyle: opts.bold ? 'bold' : 'normal' },
  });

  const signedMoney = (n: number): CellDef => ({
    content: isZero(n) ? 'Settled' : signed(n, f, cur),
    styles: {
      font: isZero(n) ? f.sans : f.mono,
      halign: 'right',
      fontStyle: 'bold',
      textColor: isZero(n) ? C.muted : n > 0 ? C.owed : C.owe,
    },
  });

  // ── Masthead ────────────────────────────────────────────────────────────────

  let y = 18;
  text('OpenSplitwise', margin, y, { bold: true, size: 10 });
  text(`Generated ${longDate(new Date())}`, pageW - margin, y, { size: 8, color: C.muted, align: 'right' });
  y += 4;
  hline(y, 0.2, C.rule);

  y += 12;
  text(groupName, margin, y, { bold: true, size: 22 });
  y += 7;
  text('Expense report', margin, y, { size: 9, color: C.muted });
  y += 5;

  // Legend: each person's chip and full name, owner first, wrapping as needed.
  {
    const ordered = [...people].sort((a, b) => {
      const owner = (u: User) => group.members.find((m) => m.userId === u.id)?.role === 'owner';
      return Number(owner(b)) - Number(owner(a));
    });
    const ROW = 6.5;
    let x = margin;
    let cy = y + CHIP_R;
    doc.setFont(f.sans, 'normal');
    doc.setFontSize(8.5);
    for (const u of ordered) {
      const isOwner = group.members.find((m) => m.userId === u.id)?.role === 'owner';
      const label = `${stripEmoji(u.name)}${isOwner ? ' (owner)' : ''}`;
      doc.setFont(f.sans, 'normal');
      doc.setFontSize(8.5);
      const w = CHIP_R * 2 + 1.8 + doc.getTextWidth(label);
      if (x > margin && x + w > pageW - margin) {
        x = margin;
        cy += ROW;
      }
      chip(u.id, x + CHIP_R, cy);
      text(label, x + CHIP_R * 2 + 1.8, cy + 1.1, { size: 8.5, color: C.soft });
      x += w + 6;
    }
    y = cy + CHIP_R + 7;
  }

  // ── Summary strip ──────────────────────────────────────────────────────────

  const stats: { label: string; value: string; color?: RGB }[] = [
    { label: 'TOTAL SPENT', value: fmtMoney(totalSpent, cur) },
    { label: 'DATES', value: dateRange },
    { label: 'EXPENSES', value: String(expenses.length) },
    {
      label: 'STILL TO SETTLE',
      value: isZero(outstanding) ? 'Nothing' : fmtMoney(outstanding, cur),
      color: isZero(outstanding) ? C.muted : C.ink,
    },
  ];
  const stripH = 19;
  hline(y, 0.8, C.ink);
  const colW = cw / stats.length;
  stats.forEach((s, i) => {
    const x = margin + i * colW + (i === 0 ? 0 : 4);
    if (i > 0) {
      doc.setDrawColor(...C.rule);
      doc.setLineWidth(0.2);
      doc.line(margin + i * colW, y, margin + i * colW, y + stripH);
    }
    text(s.label, x, y + 6.5, { size: 6.8, color: C.muted });
    // Shrink long values (a wide date range) to fit their column.
    const isMoneyish = /^[$\d]/.test(s.value);
    let size = 13;
    doc.setFont(isMoneyish ? f.mono : f.sans, 'normal');
    doc.setFontSize(size);
    while (doc.getTextWidth(s.value) > colW - 8 && size > 7) {
      size -= 0.5;
      doc.setFontSize(size);
    }
    text(s.value, x, y + 14.5, { font: isMoneyish ? 'mono' : 'sans', size, color: s.color });
  });
  y += stripH;
  hline(y, 0.2, C.rule);
  y += 10;

  // ── Balances ────────────────────────────────────────────────────────────────

  y = section('Balances', y);
  const rows = group.members.map((m) => {
    const id = m.userId;
    // A refund received counts against what someone paid; their part of it against their share.
    const paid = expenses.filter((e) => e.paidBy === id).reduce((s, e) => s + signedAmount(e), 0);
    const share = expenses.reduce((s, e) => s + getShareForUser(e, id), 0);
    // Money handed over already: sending moves you up, receiving moves you down.
    const settled = payments.reduce(
      (s, p) => s + (p.fromUserId === id ? p.amount : 0) - (p.toUserId === id ? p.amount : 0),
      0,
    );
    return { id, paid, share, settled, net: balances[id] ?? 0 };
  });
  const anyPayments = payments.length > 0;

  y = table(
    y,
    ['Member', 'Paid', 'Share', ...(anyPayments ? ['Payments'] : []), 'Balance'],
    rows.map((r) => [
      { content: nameOf(r.id), styles: { fontStyle: 'bold' } },
      money(r.paid),
      money(r.share),
      ...(anyPayments
        ? [{
            content: isZero(r.settled) ? f.minus === '-' ? '-' : '—' : signed(r.settled, f, cur),
            styles: { font: f.mono, halign: 'right' as const, textColor: isZero(r.settled) ? C.muted : C.soft },
          }]
        : []),
      signedMoney(r.net),
    ]),
    anyPayments
      ? { 0: { cellWidth: 'auto' }, 1: { cellWidth: 30, halign: 'right' }, 2: { cellWidth: 30, halign: 'right' }, 3: { cellWidth: 30, halign: 'right' }, 4: { cellWidth: 32, halign: 'right' } }
      : { 0: { cellWidth: 'auto' }, 1: { cellWidth: 34, halign: 'right' }, 2: { cellWidth: 34, halign: 'right' }, 3: { cellWidth: 36, halign: 'right' } },
  );
  y += 5;
  const note = anyPayments
    ? `Balance = paid ${f.minus} share + payments sent ${f.minus} payments received. Positive: is owed money. Negative: owes money.`
    : `Balance = paid ${f.minus} share. Positive: is owed money. Negative: owes money.`;
  doc.setFont(f.sans, 'normal');
  doc.setFontSize(7.5);
  const noteLines = doc.splitTextToSize(note, cw) as string[];
  text(noteLines, margin, y, { size: 7.5, color: C.muted });
  y += noteLines.length * 3.4 + 9;

  // ── Still to settle ─────────────────────────────────────────────────────────

  y = section('Still to settle', y, 30);
  if (transfers.length === 0) {
    hline(y + 1, 0.35, C.ink);
    text('All settled up. Nobody owes anybody in this group.', margin, y + 8, { size: 9, color: C.muted });
    y += 20;
  } else {
    y = table(
      y,
      ['Payment', 'Amount'],
      transfers.map((t) => [
        `${nameOf(t.from)}  ${f.arrow}  ${nameOf(t.to)}`,
        money(t.amount, { bold: true }),
      ]),
      { 0: { cellWidth: 'auto' }, 1: { cellWidth: 36, halign: 'right' } },
      transfers.length > 1
        ? [[
            { content: `${transfers.length} payments settle the group`, styles: { fontStyle: 'normal', textColor: C.muted } },
            money(outstanding, { bold: true }),
          ]]
        : undefined,
    );
    y += 11;
  }

  // ── Completed payments ──────────────────────────────────────────────────────

  if (sortedPayments.length > 0) {
    y = section('Completed payments', y, 30);
    y = table(
      y,
      ['Date', 'Payment', 'Method', 'Amount'],
      sortedPayments.map((p) => [
        { content: ledgerDate(p.date), styles: { font: f.mono, textColor: C.muted, fontSize: 7.5 } },
        `${nameOf(p.fromUserId)}  ${f.arrow}  ${nameOf(p.toUserId)}`,
        { content: p.paymentMethod ? PAYMENT_METHOD_LABELS[p.paymentMethod] : f.minus === '-' ? '-' : '—', styles: { textColor: C.soft } },
        money(p.amount),
      ]),
      { 0: { cellWidth: 20 }, 1: { cellWidth: 'auto' }, 2: { cellWidth: 30 }, 3: { cellWidth: 32, halign: 'right' } },
    );
    y += 11;
  }

  // ── Expenses ────────────────────────────────────────────────────────────────

  y = section('Expenses', y, 26);
  if (sortedExpenses.length === 0) {
    hline(y + 1, 0.35, C.ink);
    text('No expenses yet.', margin, y + 8, { size: 9, color: C.muted });
  } else {
    // Paid by shows the payer's chip; Split shows everyone with a share as
    // chips under a short label. Equal splits give the amount once ("$14.17
    // each"); other splits pair each chip with its amount. Drawn by hand, so
    // each cell's height is worked out first and reserved with minCellHeight.
    const PAID_COL = 3;
    const SPLIT_COL = 4;
    const SPLIT_W = 64;
    const PAD_TOP = 2.1;
    const LABEL_H = 3.6;
    const CHIP_ROW = 5.6;
    const AMOUNT_SIZE = 7;
    const SPLIT_LABELS: Record<Expense['split']['type'], string> = {
      equal: 'Equally',
      exact: 'By amount',
      percentage: 'By percent',
      shares: 'By shares',
    };

    interface Placed { id: string; amount?: string; x: number; row: number }
    const layoutSplit = (e: Expense) => {
      const shares = e.split.entries.filter((en) => en.amount > 0.005);
      const inner = SPLIT_W - 4;
      const equal = e.split.type === 'equal' && !e.items?.length && shares.length > 1;
      let label: string | undefined;
      if (shares.length > 1) {
        const how = e.items?.length ? 'By item' : SPLIT_LABELS[e.split.type];
        if (equal) {
          const lo = Math.min(...shares.map((x) => x.amount));
          const hi = Math.max(...shares.map((x) => x.amount));
          const each = hi - lo < 0.005 ? fmtMoney(hi, cur) : `${fmtMoney(lo, cur)}–${fmtMoney(hi, cur)}`;
          label = `${how} ${f.dot} ${each} each`;
        } else {
          label = how;
        }
      }
      doc.setFont(f.mono, 'normal');
      doc.setFontSize(AMOUNT_SIZE);
      const placed: Placed[] = [];
      let x = 0;
      let row = 0;
      for (const sh of shares) {
        const amount = equal ? undefined : fmtMoney(sh.amount, cur);
        const w = CHIP_R * 2 + (amount ? 1.2 + doc.getTextWidth(amount) : 0);
        if (x > 0 && x + w > inner) {
          x = 0;
          row++;
        }
        placed.push({ id: sh.userId, amount, x, row });
        x += w + (amount ? 3.5 : 1.2);
      }
      const rows = placed.length ? row + 1 : 0;
      const height = PAD_TOP * 2 + (label ? LABEL_H : 0) + rows * CHIP_ROW;
      return { label, placed, height };
    };
    const layouts = sortedExpenses.map(layoutSplit);

    const rows: RowInput[] = sortedExpenses.map((e, i) => [
        { content: ledgerDate(e.date), styles: { font: f.mono, textColor: C.muted, fontSize: 7.5 } },
        {
          // Paid in another currency: show what was actually paid next to the name.
          content: `${e.refund ? 'Refund: ' : ''}${stripEmoji(e.description) || 'Expense'}${e.original && e.original.currency !== cur ? ` (${fmtMoney(e.original.amount, e.original.currency)})` : ''}`,
          styles: { fontStyle: 'bold' },
        },
        { content: stripEmoji(categoryLabel(e.category, group)) || 'Other', styles: { textColor: C.soft, fontSize: 7.5 } },
        // Drawn by hand: the payer's chip, and "got back" for a refund they received.
        { content: '', styles: { minCellHeight: e.refund ? 11 : 0 } },
        { content: '', styles: { minCellHeight: layouts[i].height } },
        // A refund reads as money coming off: "−€60.00".
        e.refund ? { ...money(e.amount), content: `−${fmtMoney(e.amount, cur)}` } : money(e.amount),
      ]);
    const rowIndex = new Map(rows.map((r, i) => [r, i]));

    table(
      y,
      ['Date', 'Description', 'Category', 'Paid by', 'Split', 'Amount'],
      rows,
      {
        // Top-aligned: chip rows make some rows taller, and the rest should line up with their first line.
        0: { cellWidth: 15, valign: 'top' },
        1: { cellWidth: 'auto', valign: 'top' },
        2: { cellWidth: 22, valign: 'top' },
        3: { cellWidth: 14, valign: 'top' },
        4: { cellWidth: SPLIT_W, valign: 'top' },
        5: { cellWidth: 24, halign: 'right', valign: 'top' },
      },
      [[
        { content: 'Total', colSpan: 5 },
        money(totalSpent, { bold: true }),
      ]],
      {
        // A row moves to the next page whole, so its chips are never cut in half.
        rowPageBreak: 'avoid',
        didDrawCell: (data) => {
          if (data.section !== 'body') return;
          const cell = data.cell;
          const top = cell.y + PAD_TOP;
          // By the row's own data, not its position: a row being moved to the
          // next page is drawn from a copy whose index is -1.
          const i = rowIndex.get(data.row.raw as RowInput);
          if (i === undefined) return;
          const e = sortedExpenses[i];

          if (data.column.index === PAID_COL) {
            chip(e.paidBy, cell.x + CHIP_R, top + CHIP_R + 0.3);
            if (e.refund) text('got back', cell.x, top + CHIP_R * 2 + 3.6, { size: 6.2, color: C.muted });
            return;
          }
          if (data.column.index !== SPLIT_COL) return;

          const { label, placed } = layouts[i];
          let rowsTop = top;
          if (label) {
            text(label, cell.x, top + 2.4, { size: 6.8, color: C.muted });
            rowsTop += LABEL_H;
          }
          for (const p of placed) {
            const cy = rowsTop + p.row * CHIP_ROW + CHIP_R + 0.3;
            chip(p.id, cell.x + p.x + CHIP_R, cy);
            if (p.amount) {
              text(p.amount, cell.x + p.x + CHIP_R * 2 + 1.2, cy + 1, { font: 'mono', size: AMOUNT_SIZE, color: C.soft });
            }
          }
        },
      },
    );
  }

  // ── Running header and footer ───────────────────────────────────────────────

  const pages = doc.getNumberOfPages();
  for (let p = 1; p <= pages; p++) {
    doc.setPage(p);
    if (p > 1) {
      text(groupName, margin, 13, { bold: true, size: 8.5 });
      text('Expense report', pageW - margin, 13, { size: 8, color: C.muted, align: 'right' });
      hline(16, 0.2, C.rule);
    }
    hline(pageH - 10, 0.2, C.rule);
    text('OpenSplitwise', margin, pageH - 6, { size: 7.5, color: C.muted });
    text(`Page ${p} of ${pages}`, pageW - margin, pageH - 6, { font: 'mono', size: 7.5, color: C.muted, align: 'right' });
  }

  const filename = `${groupName.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase() || 'group'}-report.pdf`;
  doc.save(filename);
}
