/**
 * Turning model output back into plain receipt lines, so the app's existing
 * text parser (parseReceiptText) can read it. That keeps the comparison fair:
 * for the OCR-style models, only the reading step changes.
 *
 * The box helpers used by Florence-2 live in the app (it ships as Better scan).
 */

export { boxesToLines, dedupeOverlap, quadToBox, type Box } from '../lib/receiptLines';

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
