/**
 * Turning model output back into plain receipt lines, so the app's existing
 * text parser (parseReceiptText) can read it. That keeps the comparison fair:
 * for the OCR-style models, only the reading step changes.
 */

export interface Box {
  text: string;
  /** Bounding box in image pixels. */
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** Florence-2's quad box (8 numbers: 4 corners) to an axis-aligned box. */
export function quadToBox(text: string, quad: number[]): Box {
  const xs = [quad[0], quad[2], quad[4], quad[6]];
  const ys = [quad[1], quad[3], quad[5], quad[7]];
  return { text, x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
}

/**
 * Groups boxes into visual lines (similar vertical centre), left to right.
 * Receipts print the item on the left and its price on the right, often as
 * separate boxes; joining them restores "Coffee 3.50" for the parser.
 */
export function boxesToLines(boxes: Box[]): string[] {
  const sorted = boxes
    .filter((b) => b.text.trim())
    .map((b) => ({ ...b, cy: (b.y0 + b.y1) / 2, h: Math.max(1, b.y1 - b.y0) }))
    .sort((a, b) => a.cy - b.cy);

  const lines: (typeof sorted)[] = [];
  for (const b of sorted) {
    const line = lines[lines.length - 1];
    if (line) {
      const cy = line.reduce((s, x) => s + x.cy, 0) / line.length;
      const h = line.reduce((s, x) => s + x.h, 0) / line.length;
      if (Math.abs(b.cy - cy) < Math.min(h, b.h) * 0.6) {
        line.push(b);
        continue;
      }
    }
    lines.push([b]);
  }
  return lines.map((line) =>
    line
      .sort((a, b) => a.x0 - b.x0)
      .map((b) => b.text.trim())
      .join('  '),
  );
}

/**
 * Drops lines that appear twice because tiles overlap: same text, and the
 * second copy starts within the overlap band of the first.
 */
export function dedupeOverlap(boxes: Box[], overlapPx: number): Box[] {
  const kept: Box[] = [];
  for (const b of boxes) {
    const dup = kept.some(
      (k) => k.text.trim() === b.text.trim() && Math.abs(k.y0 - b.y0) <= overlapPx && Math.abs(k.x0 - b.x0) <= overlapPx,
    );
    if (!dup) kept.push(b);
  }
  return kept;
}

const CELL_TAGS = /<(fcel|ecel|lcel|ucel|xcel|ched|rhed|srow|nl)>/g;

/**
 * Granite-Docling's DocTags to plain lines. Tables (OTSL) become one line per
 * row with cells separated by two spaces; every other element is one line.
 */
export function docTagsToLines(doctags: string): string[] {
  const text = doctags
    .replace(/<loc_\d+>/g, '')
    .replace(CELL_TAGS, (_, tag: string) => (tag === 'nl' ? '\n' : '  '))
    .replace(/<\/[a-z_0-9]+>/gi, '\n')
    .replace(/<[^>]+>/g, '');
  return text
    .split('\n')
    .map((l) => l.replace(/\s{3,}/g, '  ').trim())
    .filter(Boolean);
}

/**
 * Pulls the first JSON object out of a model's reply (which may wrap it in
 * prose or a code fence). Returns null when nothing parses.
 */
export function extractJson(reply: string): unknown {
  const start = reply.indexOf('{');
  if (start < 0) return null;
  for (let end = reply.lastIndexOf('}'); end > start; end = reply.lastIndexOf('}', end - 1)) {
    try {
      return JSON.parse(reply.slice(start, end + 1));
    } catch {
      // try a shorter span
    }
  }
  return null;
}
