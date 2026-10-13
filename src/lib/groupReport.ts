import jsPDF from 'jspdf';
import { autoTable, type CellDef, type RowInput, type UserOptions } from 'jspdf-autotable';

type ColumnStyles = NonNullable<UserOptions['columnStyles']>;
import type { Group, Expense, User, Settlement, PaymentMethod } from '../types';
import { categoryLabel } from './categories';
import { groupCurrency } from './currency';
import { formatCurrency } from '../utils/format';
import { calculateBalances, calculateSettlements } from './calculations';
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
  const memberIds = group.members.map((m) => m.userId);
  const sortedExpenses = [...expenses].sort((a, b) => a.date.getTime() - b.date.getTime());
  const sortedPayments = [...payments].sort((a, b) => a.date.getTime() - b.date.getTime());

  // Completed payments count, so balances and transfers show what is still owed.
  const balances = calculateBalances({ expenses, memberIds, settlements: payments });
  const transfers = calculateSettlements({ expenses, memberIds, settlements: payments });

  const totalSpent = expenses.reduce((s, e) => s + e.amount, 0);
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
  const memberLine = group.members
    .map((m) => `${nameOf(m.userId)}${m.role === 'owner' ? ' (owner)' : ''}`)
    .join(', ');
  // Measure at the size it is drawn at, or it wraps far too early.
  doc.setFont(f.sans, 'normal');
  doc.setFontSize(9);
  const memberLines = doc.splitTextToSize(`Expense report ${f.dot} ${memberLine}`, cw) as string[];
  text(memberLines, margin, y, { size: 9, color: C.muted });
  y += memberLines.length * 4.2 + 5;

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
    const paid = expenses.filter((e) => e.paidBy === id).reduce((s, e) => s + e.amount, 0);
    const share = expenses.reduce((s, e) => s + (e.split.entries.find((en) => en.userId === id)?.amount ?? 0), 0);
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
    /** "Equal · 4 people" when everyone paid the same, otherwise each person's amount. */
    const splitLabel = (e: Expense) => {
      const amounts = e.split.entries.map((en) => en.amount);
      const even = amounts.every((a) => Math.abs(a - amounts[0]) <= 0.011);
      if (even) {
        const n = e.split.entries.length;
        return `Equal ${f.dot} ${n} ${n === 1 ? 'person' : 'people'}`;
      }
      return e.split.entries.map((en) => `${nameOf(en.userId)} ${fmtMoney(en.amount, cur)}`).join(', ');
    };

    table(
      y,
      ['Date', 'Description', 'Category', 'Paid by', 'Split', 'Amount'],
      sortedExpenses.map((e) => [
        { content: ledgerDate(e.date), styles: { font: f.mono, textColor: C.muted, fontSize: 7.5 } },
        {
          // Paid in another currency: show what was actually paid next to the name.
          content: `${stripEmoji(e.description) || 'Expense'}${e.original && e.original.currency !== cur ? ` (${fmtMoney(e.original.amount, e.original.currency)})` : ''}`,
          styles: { fontStyle: 'bold' },
        },
        { content: stripEmoji(categoryLabel(e.category, group)) || 'Other', styles: { textColor: C.soft, fontSize: 7.5 } },
        nameOf(e.paidBy),
        { content: splitLabel(e), styles: { textColor: C.soft, fontSize: 7.5 } },
        money(e.amount),
      ]),
      {
        0: { cellWidth: 16 },
        1: { cellWidth: 'auto' },
        2: { cellWidth: 26 },
        3: { cellWidth: 22 },
        4: { cellWidth: 40 },
        5: { cellWidth: 24, halign: 'right' },
      },
      [[
        { content: 'Total', colSpan: 5 },
        money(totalSpent, { bold: true }),
      ]],
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
