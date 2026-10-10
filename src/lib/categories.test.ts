import { describe, expect, it } from 'vitest';
import type { Expense, Group } from '../types';
import { categoryLabel, cleanCategoryName, findCategoryByName } from './categories';
import { getCategoryBreakdown } from './analytics';
import { matchesQuery } from './expenseFilter';

const trip = { categories: [{ id: 'custom:ski' as const, name: 'Ski passes' }] };

describe('categoryLabel', () => {
  it('names built-in and group categories', () => {
    expect(categoryLabel('food')).toBe('Food & Drink');
    expect(categoryLabel('custom:ski', trip)).toBe('Ski passes');
  });

  it('reads a custom category it cannot find as Other', () => {
    expect(categoryLabel('custom:ski')).toBe('Other');
    expect(categoryLabel('custom:gone', trip)).toBe('Other');
  });
});

describe('category names', () => {
  it('tidies spaces and caps the length', () => {
    expect(cleanCategoryName('  Ski   passes ')).toBe('Ski passes');
    expect(cleanCategoryName('x'.repeat(50))).toHaveLength(30);
  });

  it('finds built-in and group categories by name, ignoring case', () => {
    expect(findCategoryByName('food & drink', trip)).toBe('food');
    expect(findCategoryByName('SKI PASSES', trip)).toBe('custom:ski');
    expect(findCategoryByName('Ferry', trip)).toBeUndefined();
  });
});

const expense = (id: string, groupId: string, category: Expense['category'], amount: number): Expense => ({
  id,
  description: 'Thing',
  amount,
  currency: 'USD',
  paidBy: 'me',
  groupId,
  date: new Date(),
  category,
  split: { type: 'equal', entries: [{ userId: 'me', amount }] },
  createdAt: new Date(),
  updatedAt: new Date(),
});

const group = (id: string, categories: Group['categories']): Group => ({
  id,
  name: id,
  emoji: '✈️',
  color: '#000',
  type: 'trip',
  members: [],
  categories,
  lastActivity: new Date(),
  createdAt: new Date(),
});

describe('getCategoryBreakdown with custom categories', () => {
  it('combines same-named categories from different groups, and counts lost ones as Other', () => {
    const groups = [
      group('a', [{ id: 'custom:a-gas', name: 'Gas' }]),
      group('b', [{ id: 'custom:b-gas', name: 'gas' }]),
    ];
    const rows = getCategoryBreakdown(
      [
        expense('1', 'a', 'custom:a-gas', 30),
        expense('2', 'b', 'custom:b-gas', 20),
        expense('3', 'a', 'custom:removed', 5),
        expense('4', 'a', 'other', 5),
      ],
      'me',
      'total',
      groups,
    );
    expect(rows.map((r) => [r.label, r.amount])).toEqual([
      ['Gas', 50],
      ['Other', 10],
    ]);
  });
});

describe('search with custom categories', () => {
  it('matches the custom name when given the group', () => {
    const e = expense('1', 'a', 'custom:ski', 30);
    expect(matchesQuery(e, 'ski', () => '', (c) => categoryLabel(c, trip))).toBe(true);
    expect(matchesQuery(e, 'ski', () => '')).toBe(false);
  });
});
