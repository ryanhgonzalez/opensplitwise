import { describe, expect, it } from 'vitest';
import { firstGrapheme } from './emoji';

describe('firstGrapheme', () => {
  it('keeps multi-code-point emoji whole', () => {
    expect(firstGrapheme('🇺🇸')).toBe('🇺🇸');
    expect(firstGrapheme('👍🏽')).toBe('👍🏽');
    expect(firstGrapheme('👨‍👩‍👧')).toBe('👨‍👩‍👧');
    expect(firstGrapheme('🏳️‍🌈')).toBe('🏳️‍🌈');
    expect(firstGrapheme('✈️')).toBe('✈️');
    expect(firstGrapheme('1️⃣')).toBe('1️⃣');
  });

  it('takes only the first of several', () => {
    expect(firstGrapheme('🇯🇵🇺🇸')).toBe('🇯🇵');
    expect(firstGrapheme('🍕 pizza')).toBe('🍕');
  });

  it('returns an empty string for empty input', () => {
    expect(firstGrapheme('')).toBe('');
  });
});
