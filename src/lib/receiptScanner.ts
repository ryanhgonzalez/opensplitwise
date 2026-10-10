import type { ExpenseCategory } from '../types';
import type { BetterScanProgress } from './betterScan';

// ─────────────────────────────────────────────────────────────────────────────
// Client-side receipt scanner: image → OCR (Tesseract.js, or Florence-2 for
// Better scan; see betterScan.ts) → best-effort fields.
//
// Accuracy note: generic OCR on real-world receipts is imperfect, so everything
// here is best-effort and MUST land in an editable draft the user reviews before
// saving — never auto-commit. `parseReceiptText` is kept pure (no DOM/OCR deps)
// so it can be unit-tested against sample receipt text.
// ─────────────────────────────────────────────────────────────────────────────

export interface LineItem {
  description: string;
  amount: number;
}

export interface ParsedReceipt {
  amount?: number;
  description?: string;
  category?: ExpenseCategory;
  date?: Date;
  lineItems?: LineItem[];
  rawText: string;
}

export type ScanProgress = (progress: number) => void;

/** Scan a receipt image file and return best-effort expense fields. */
export async function scanReceipt(file: File, onProgress?: ScanProgress): Promise<ParsedReceipt> {
  const canvas = await preprocessImage(file);

  // Lazy-load Tesseract so it never bloats the main bundle — only fetched on first scan.
  const [{ createWorker }, { simd }] = await Promise.all([import('tesseract.js'), import('wasm-feature-detect')]);

  // Tesseract's own defaults fetch these from a CDN. Copies are served from
  // /tesseract (see vite.config.ts) and precached, so scanning works offline.
  // Absolute URLs: the worker runs from a blob URL, which has no base to
  // resolve a path against.
  const base = new URL('/tesseract/', location.href).href;
  const core = (await simd()) ? 'tesseract-core-simd-lstm.wasm.js' : 'tesseract-core-lstm.wasm.js';
  const worker = await createWorker('eng', 1, {
    workerPath: base + 'worker.min.js',
    corePath: base + core,
    langPath: base,
    logger: (m: { status: string; progress: number }) => {
      if (m.status === 'recognizing text') onProgress?.(m.progress);
    },
  });

  try {
    const { data } = await worker.recognize(canvas);
    const text = data.text ?? '';
    return { ...parseReceiptText(text, { dayFirst: localePrefersDayFirst() }), rawText: text };
  } finally {
    await worker.terminate();
  }
}

/**
 * Better scan: the same fields, read by the on-device Florence-2 model instead
 * of Tesseract (see betterScan.ts). Throws if the model can't load or run, so
 * the caller can fall back to `scanReceipt`.
 */
export async function scanReceiptBetter(file: File, onProgress?: BetterScanProgress): Promise<ParsedReceipt> {
  const { readReceiptText } = await import('./betterScan');
  const text = await readReceiptText(file, onProgress);
  return { ...parseReceiptText(text, { dayFirst: localePrefersDayFirst() }), rawText: text };
}

/** Most of the world writes 05/09 as 5 September; the US and a few others mean May 9. */
function localePrefersDayFirst(): boolean {
  const lang = typeof navigator === 'undefined' ? '' : navigator.language;
  return !!lang && !/^(en-US|es-US|en-PH|fil)\b/i.test(lang);
}

// ─── Image preprocessing (downscale + grayscale + mild contrast) ──────────────

async function preprocessImage(file: File): Promise<HTMLCanvasElement> {
  const url = URL.createObjectURL(file);
  try {
    const img = await loadImage(url);
    const maxDim = 1800; // enough detail for OCR without excessive memory/time
    const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
    const width = Math.max(1, Math.round(img.width * scale));
    const height = Math.max(1, Math.round(img.height * scale));

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return canvas;

    ctx.drawImage(img, 0, 0, width, height);

    // Grayscale + mild contrast boost — helps OCR on faded thermal receipts.
    const imageData = ctx.getImageData(0, 0, width, height);
    const d = imageData.data;
    const contrast = 1.35;
    const intercept = 128 * (1 - contrast);
    for (let i = 0; i < d.length; i += 4) {
      const gray = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
      const v = clamp(contrast * gray + intercept, 0, 255);
      d[i] = d[i + 1] = d[i + 2] = v;
    }
    ctx.putImageData(imageData, 0, 0);
    return canvas;
  } finally {
    URL.revokeObjectURL(url);
  }
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Could not load image'));
    img.src = src;
  });
}

const clamp = (n: number, lo: number, hi: number) => (n < lo ? lo : n > hi ? hi : n);

// ─── Text parsing (pure — unit-testable) ──────────────────────────────────────

export interface ParseOptions {
  /**
   * How to read an ambiguous numeric date like 05/09/2026 when nothing on the
   * receipt settles it: true = 5 September, false (default) = May 9.
   */
  dayFirst?: boolean;
}

export function parseReceiptText(text: string, options: ParseOptions = {}): Omit<ParsedReceipt, 'rawText'> {
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  return {
    amount: extractTotal(lines),
    description: extractMerchant(lines),
    category: guessCategory(text),
    date: extractDate(text, options.dayFirst ?? false),
    lineItems: extractLineItems(lines),
  };
}

/**
 * Turns one matched amount into a number, working out which separator is the
 * decimal point: "1,234.56", "1.234,56", "196,93" and "12.00" all parse.
 */
function parseAmount(raw: string): number {
  const lastDot = raw.lastIndexOf('.');
  const lastComma = raw.lastIndexOf(',');
  const decimalAt = Math.max(lastDot, lastComma);
  // A separator followed by exactly two digits at the end is the decimal point.
  const hasDecimal = decimalAt >= 0 && raw.length - decimalAt - 1 === 2;
  const whole = (hasDecimal ? raw.slice(0, decimalAt) : raw).replace(/[.,]/g, '');
  const cents = hasDecimal ? raw.slice(decimalAt + 1) : '';
  return parseFloat(cents ? `${whole}.${cents}` : whole);
}

/** Pull currency-looking numbers ($1,234.56 / 1.234,56 / 196,93 / 12.00) from a single line. */
function moneyOnLine(line: string): number[] {
  // With thousands groups and cents, plain cents (either separator), or comma thousands alone.
  const re = /(\d{1,3}(?:[.,]\d{3})+[.,]\d{2}|\d+[.,]\d{2}|\d{1,3}(?:,\d{3})+)(?!\d)/g;
  const out: number[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(line))) {
    const n = parseAmount(m[1]);
    if (!Number.isNaN(n)) out.push(n);
  }
  return out;
}

/**
 * Find the receipt total. Priority:
 *   1) strong keywords (grand total / balance due / amount due), scanned bottom-up
 *   2) a line that is just "Total" plus an amount, scanned bottom-up
 *   3) any other "total" line that isn't a subtotal, savings, tender or payment line
 *   4) fallback: the largest currency value on the receipt
 * Label and value are sometimes on separate lines, so we also peek at the next line.
 *
 * Taking the last "total" line, as this used to, picks up the payment block
 * that often follows ("Total savings", "Tendered total", "Total purchase").
 */
function extractTotal(lines: string[]): number | undefined {
  const strong = /(grand\s*total|total\s*due|balance\s*due|amount\s*due)/i;
  const total = /\btotals?\b/i;
  const notTheTotal =
    /(sub\s*-?\s*total|savings?|saved|tender(?:ed)?|purchase|discount|\bitems?\b|change|payment|paid|before\s*tax|\btip\b|gratuity|points|\bqty\b)/i;
  // "TOTAL USD $43.84", "Total: £4.50", or OCR's "E4.50" for "£4.50" still count as a bare total.
  const strip = (line: string) =>
    line.replace(/\b(usd|eur|gbp|cad|aud|nzd|chf|mxn)\b/gi, '').replace(/[$£€¥]|(?<=\s)E(?=\d)/g, '');
  const bareTotal = /^\W*totals?\b[^a-z]*$/i;

  const numbersFor = (i: number): number[] => {
    const here = moneyOnLine(lines[i]);
    if (here.length) return here;
    return i + 1 < lines.length ? moneyOnLine(lines[i + 1]) : [];
  };
  const lastNumberFor = (match: (line: string) => boolean): number | undefined => {
    for (let i = lines.length - 1; i >= 0; i--) {
      if (match(lines[i])) {
        const nums = numbersFor(i);
        if (nums.length) return nums[nums.length - 1];
      }
    }
    return undefined;
  };

  const found =
    lastNumberFor((l) => strong.test(l)) ??
    lastNumberFor((l) => bareTotal.test(strip(l))) ??
    lastNumberFor((l) => total.test(l) && !notTheTotal.test(l));
  if (found !== undefined) return found;

  let max: number | undefined;
  for (const line of lines) {
    for (const n of moneyOnLine(line)) {
      if (max === undefined || n > max) max = n;
    }
  }
  return max;
}

/** Merchant name is almost always at the very top of the receipt. */
function extractMerchant(lines: string[]): string | undefined {
  // Note: \btel[.:] (not bare "tel") so merchant names like "HOTEL"/"MOTEL" aren't
  // mistaken for a "Tel:" phone line.
  const noise = /(receipt|invoice|order\s*#|\btel[.:]|phone|fax|www\.|https?:|\.com|street|\bst\b|\bave\b|\brd\b|suite|\bste\b|survey|thank you|welcome|cashier|register|\d{2,}[/-]\d{2,})/i;
  for (const line of lines.slice(0, 6)) {
    const letters = (line.match(/[a-z]/gi) ?? []).length;
    const digits = (line.match(/\d/g) ?? []).length;
    if (letters >= 3 && letters > digits && line.length <= 40 && !noise.test(line)) {
      return toTitleCase(line.replace(/[*_|]+/g, '').trim());
    }
  }
  return undefined;
}

function toTitleCase(s: string): string {
  return s
    .toLowerCase()
    .replace(/\b([a-z])/g, (_, c: string) => c.toUpperCase())
    .replace(/\s+/g, ' ')
    .trim();
}

// ─── Date extraction ──────────────────────────────────────────────────────────

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

function makeDate(year: number, month: number, day: number): Date | undefined {
  if (year < 2000 || year > 2099 || month < 1 || month > 12 || day < 1 || day > 31) return undefined;
  return new Date(year, month - 1, day); // local midnight (no timezone shift)
}

/**
 * Whether an ambiguous numeric date (both parts 12 or under) puts the day first.
 * Dots are the European style; £ or € without $ means a day-first country, $
 * without them a month-first one; otherwise the caller's preference decides.
 */
function ambiguousIsDayFirst(text: string, separator: string, fallback: boolean): boolean {
  if (separator === '.') return true;
  const euro = /[£€]|\b(eur|gbp)\b/i.test(text);
  const dollar = /\$/.test(text);
  if (euro && !dollar) return true;
  if (dollar && !euro) return false;
  return fallback;
}

/**
 * Best-effort receipt date. Numeric dates are read day-first when the first
 * part can't be a month (30/09/2025), month-first when the second can't
 * (01/26/2018), and otherwise by ambiguousIsDayFirst.
 */
function extractDate(text: string, dayFirst: boolean): Date | undefined {
  // ISO: 2026-08-01
  let m = text.match(/\b(20\d{2})[-/.](\d{1,2})[-/.](\d{1,2})\b/);
  if (m) { const d = makeDate(+m[1], +m[2], +m[3]); if (d) return d; }

  // Numeric: DD/MM/YYYY or MM/DD/YYYY (2- or 4-digit year), same separator twice.
  for (const n of text.matchAll(/\b(\d{1,2})([-/.])(\d{1,2})\2(\d{2,4})\b/g)) {
    const a = +n[1];
    const b = +n[3];
    const year = +n[4] < 100 ? 2000 + +n[4] : +n[4];
    const dayFirstHere = a > 12 ? true : b > 12 ? false : ambiguousIsDayFirst(text, n[2], dayFirst);
    const d = dayFirstHere ? makeDate(year, b, a) : makeDate(year, a, b);
    if (d) return d;
  }

  // Month name: "Aug 1, 2026" / "August 01 2026"
  const monthAlt = MONTHS.join('[a-z]*|') + '[a-z]*';
  m = text.match(new RegExp(`\\b(${monthAlt})\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(20\\d{2})\\b`, 'i'));
  if (m) {
    const mon = MONTHS.indexOf(m[1].slice(0, 3).toLowerCase()) + 1;
    const d = makeDate(+m[3], mon, +m[2]);
    if (d) return d;
  }
  // "1 Aug 2026"
  m = text.match(new RegExp(`\\b(\\d{1,2})\\s+(${monthAlt})\\s+(20\\d{2})\\b`, 'i'));
  if (m) {
    const mon = MONTHS.indexOf(m[2].slice(0, 3).toLowerCase()) + 1;
    const d = makeDate(+m[3], mon, +m[1]);
    if (d) return d;
  }
  return undefined;
}

// ─── Line-item extraction ─────────────────────────────────────────────────────

// Lines whose "name" is really a summary/payment row — never a purchasable item.
const NON_ITEM = /(sub\s*-?\s*total|subtotal|\btotals?\b|\btax\b|\btip\b|gratuity|balance|amount due|\bdue\b|change|\bcash\b|credit|debit|visa|master|amex|discover|\bcard\b|tender|payment|rounding|service charge|savings|\bqty\b)/i;

// The line where items end: everything below is totals, tax and payment. It
// must carry an amount, so a header like "Total BusinessWare Inc." doesn't count.
const ITEMS_END = /^\W*(sub\s*-?\s*total|totals?\b)/i;
const endsItems = (line: string) => ITEMS_END.test(line) && moneyOnLine(line).length > 0;

// "name … price", where the price may carry a currency sign (or OCR's "E" for
// "£"), use either decimal separator, and be followed by a one- or two-character
// tax flag ("2.88 N", "1.98 X").
const ITEM_LINE =
  /^(.*?\S)\s+(-?)\s*(?:[$£€]|E(?=\d))?\s*(\d{1,3}(?:[.,]\d{3})*[.,]\d{2}|\d+[.,]\d{2})(?:\s+[A-Z0-9]{1,2})?\s*$/;

/** Removes what isn't the product name: barcodes, PLU and quantity columns, tax flags. */
function cleanItemName(raw: string): string {
  return raw
    .replace(/\b\d{6,}\b/g, ' ')           // barcodes / SKUs
    .replace(/^\s*\d+\s*[xX]?\s+/, '')    // leading quantity or PLU code ("2X", "3115")
    .replace(/(\s+\d{1,3})+\s*$/, '')     // trailing quantity column ("Peaches  3")
    .replace(/\s+[A-Z]\s*$/, '')          // trailing tax flag ("BREAD  F")
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/**
 * Extract "name … price" rows as line items (best-effort).
 *
 * Collection stops at the first subtotal/total line: what follows is tax,
 * tenders, savings and card slips, which would otherwise read as items.
 */
function extractLineItems(lines: string[]): LineItem[] {
  const items: LineItem[] = [];
  for (const line of lines) {
    if (endsItems(line)) break;

    const m = line.match(ITEM_LINE);
    if (!m || m[2] === '-') continue;          // no price, or a discount line
    const price = parseAmount(m[3]);
    if (!(price > 0)) continue;

    if (NON_ITEM.test(m[1])) continue;         // tax/payment rows above the totals
    const name = cleanItemName(m[1]);
    if ((name.match(/[a-z]/gi) ?? []).length < 2) continue; // needs real letters

    items.push({ description: toTitleCase(name).slice(0, 40), amount: price });
  }
  return items;
}

// Keyword → category. Ordered by specificity; first confident hit wins.
const CATEGORY_KEYWORDS: [ExpenseCategory, RegExp][] = [
  ['subscriptions', /\b(netflix|spotify|hulu|disney\+?|prime video|subscription|patreon|youtube premium)\b/i],
  ['accommodation', /\b(hotel|motel|inn|resort|airbnb|lodging|hostel)\b/i],
  ['transport',     /\b(uber|lyft|taxi|cab|fuel|gas station|shell|chevron|exxon|mobil|\bbp\b|parking|transit|metro|toll|fare)\b/i],
  ['travel',        /\b(airline|airways|airport|flight|delta|united airlines|jetblue|southwest|amtrak|rental car|hertz|avis)\b/i],
  ['healthcare',    /\b(pharmacy|cvs|walgreens|clinic|hospital|medical|dental|dentist|doctor|urgent care|\brx\b)\b/i],
  ['groceries',     /\b(grocery|supermarket|market|foods|safeway|kroger|costco|trader joe|whole foods|aldi|publix|wegmans|produce)\b/i],
  ['entertainment', /\b(cinema|theatre|theater|movie|amc|regal|concert|arcade|bowling|museum)\b/i],
  ['utilities',     /\b(electric|water bill|utility|energy|comcast|xfinity|at&t|verizon|t-?mobile|internet|power company)\b/i],
  ['personal-care', /\b(salon|spa|barber|nails?|beauty|haircut|massage)\b/i],
  ['food',          /\b(restaurant|cafe|coffee|grill|pizza|burger|sushi|\bbar\b|diner|kitchen|bistro|bakery|starbucks|mcdonald|chipotle|taco|deli|eatery|brewery|pub)\b/i],
  ['shopping',      /\b(target|walmart|amazon|best buy|boutique|apparel|clothing|mall|\bstore\b|outlet|ikea)\b/i],
  ['education',     /\b(tuition|university|college|bookstore|course|textbook)\b/i],
];

function guessCategory(text: string): ExpenseCategory | undefined {
  for (const [category, re] of CATEGORY_KEYWORDS) {
    if (re.test(text)) return category;
  }
  return undefined; // leave the form's current selection untouched when unsure
}
