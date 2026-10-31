import { describe, expect, it } from 'vitest';
import type { GroupType } from '../types';
import { BUILT_IN_CATEGORIES } from './categories';
import { GROUP_TYPES, defaultCategory, groupTypeHint, groupTypeLabel, suggestedCategories } from './groupTypes';

const ALL_TYPES: GroupType[] = ['trip', 'home', 'couple', 'family', 'friends', 'work', 'event', 'other'];

describe('group types', () => {
  it('offers every type, once each', () => {
    expect(GROUP_TYPES.map((t) => t.value).sort()).toEqual([...ALL_TYPES].sort());
  });

  it('only suggests built-in categories, without repeats', () => {
    for (const t of GROUP_TYPES) {
      expect(new Set(t.suggested).size).toBe(t.suggested.length);
      for (const c of t.suggested) expect(BUILT_IN_CATEGORIES).toContain(c);
    }
  });

  it('starts a new expense on the type\'s first suggestion', () => {
    expect(defaultCategory('home')).toBe('groceries');
    expect(defaultCategory('trip')).toBe('food');
    expect(defaultCategory('other')).toBe('food');
    expect(defaultCategory(undefined)).toBe('food');
  });

  it('copes with a type it does not know, from older or edited files', () => {
    const odd = 'boat' as GroupType;
    expect(groupTypeLabel(odd)).toBe('Other');
    expect(suggestedCategories(odd)).toEqual([]);
    expect(defaultCategory(odd)).toBe('food');
  });

  it('says what the type changes', () => {
    expect(groupTypeHint('trip')).toBe('Puts what a trip usually needs first: Food & Drink, Accommodation, Transport.');
    expect(groupTypeHint('friends')).toMatch(/^Puts what a group of friends usually needs first/);
    expect(groupTypeHint('other')).toBe('Every category in the usual order.');
  });
});
