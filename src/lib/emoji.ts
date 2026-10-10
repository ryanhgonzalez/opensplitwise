/**
 * The first user-visible character of `str`. Many emoji are several code
 * points long: flags (🇺🇸 is two regional-indicator letters), skin tones
 * (👍🏽), and joined sequences (👨‍👩‍👧, 🏳️‍🌈). Cutting at a code point instead
 * leaves half an emoji, which shows as a boxed letter or a "?" box.
 */
export function firstGrapheme(str: string): string {
  if (typeof Intl !== 'undefined' && 'Segmenter' in Intl) {
    const first = new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(str)[Symbol.iterator]().next();
    return first.done ? '' : first.value.segment;
  }
  return [...str][0] ?? ''; // pre-2023 Firefox: whole emoji only for single code points
}
