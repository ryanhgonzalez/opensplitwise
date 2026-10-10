import type { Extraction, Label, ReceiptItem } from './types';

/**
 * Scores one extraction against its label, field by field.
 *
 * A field the label leaves out is not scored (null), so a partly labelled
 * receipt still counts for the fields it does have.
 */
export interface FieldScores {
  total: boolean | null;
  date: boolean | null;
  merchant: boolean | null;
  /** F1 over line items; null when the label lists no items. */
  itemsF1: number | null;
}

const tokens = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);

/** Token overlap (Jaccard) between two strings, 0–1. */
export function textSimilarity(a: string, b: string): number {
  const ta = new Set(tokens(a));
  const tb = new Set(tokens(b));
  if (ta.size === 0 && tb.size === 0) return 1;
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared++;
  return shared / (ta.size + tb.size - shared);
}

/** "Pingo Doce Lisboa" matches "PINGO DOCE": either contains the other, or most words overlap. */
export function merchantMatches(predicted: string, truth: string): boolean {
  const p = tokens(predicted).join(' ');
  const t = tokens(truth).join(' ');
  if (!p || !t) return false;
  return p.includes(t) || t.includes(p) || textSimilarity(p, t) >= 0.5;
}

const sameMoney = (a: number, b: number) => Math.abs(a - b) < 0.005;

/**
 * Item-level F1. An item counts as found when the amount matches to the cent
 * and the description shares at least a word or so with the label's.
 */
export function itemsF1(predicted: ReceiptItem[], truth: ReceiptItem[]): number {
  if (truth.length === 0) return predicted.length === 0 ? 1 : 0;
  if (predicted.length === 0) return 0;
  const unused = [...truth];
  let hits = 0;
  for (const p of predicted) {
    const i = unused.findIndex(
      (t) => sameMoney(t.amount, p.amount) && textSimilarity(t.description, p.description) >= 0.25,
    );
    if (i >= 0) {
      hits++;
      unused.splice(i, 1);
    }
  }
  const precision = hits / predicted.length;
  const recall = hits / truth.length;
  return precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
}

export function scoreExtraction(got: Extraction, label: Label): FieldScores {
  return {
    total: label.total === undefined ? null : got.total !== undefined && sameMoney(got.total, label.total),
    date: label.date === undefined ? null : got.date === label.date,
    merchant: label.merchant === undefined ? null : !!got.merchant && merchantMatches(got.merchant, label.merchant),
    itemsF1: label.items === undefined || label.items.length === 0 ? null : itemsF1(got.items ?? [], label.items),
  };
}

export interface EngineSummary {
  /** Share correct among receipts whose label has the field, or null if none do. */
  total: number | null;
  date: number | null;
  merchant: number | null;
  itemsF1: number | null;
  medianMs: number | null;
  receipts: number;
  failures: number;
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null);

function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export function summarize(rows: { scores: FieldScores | null; ms: number | null }[]): EngineSummary {
  const ok = rows.filter((r) => r.scores !== null) as { scores: FieldScores; ms: number | null }[];
  const rate = (k: 'total' | 'date' | 'merchant') => {
    const scored = ok.map((r) => r.scores[k]).filter((v): v is boolean => v !== null);
    return scored.length ? scored.filter(Boolean).length / scored.length : null;
  };
  return {
    total: rate('total'),
    date: rate('date'),
    merchant: rate('merchant'),
    itemsF1: mean(ok.map((r) => r.scores.itemsF1).filter((v): v is number => v !== null)),
    medianMs: median(ok.map((r) => r.ms).filter((v): v is number => v !== null)),
    receipts: rows.length,
    failures: rows.length - ok.length,
  };
}
