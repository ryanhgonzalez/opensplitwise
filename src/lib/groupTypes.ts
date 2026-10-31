import type { ExpenseCategory, GroupType } from '../types';
import { CATEGORY_LABELS } from '../types';

// ─────────────────────────────────────────────────────────────────────────────
// Group types: what each is called, and which categories it puts first.
//
// A type only changes the order of the category list and the category a new
// expense starts on. Every category stays available in every group.
// ─────────────────────────────────────────────────────────────────────────────

interface GroupTypeInfo {
  value: GroupType;
  label: string;
  /** How the hint under the picker names it: "a trip". */
  phrase: string;
  /** Shown first when picking a category, best first. Empty means no suggested row. */
  suggested: ExpenseCategory[];
}

/** In the order the pickers show them. */
export const GROUP_TYPES: GroupTypeInfo[] = [
  { value: 'home',    label: 'Home',    phrase: 'a home',             suggested: ['groceries', 'rent', 'utilities', 'household', 'subscriptions', 'food'] },
  { value: 'trip',    label: 'Trip',    phrase: 'a trip',             suggested: ['food', 'accommodation', 'transport', 'gas', 'entertainment', 'groceries'] },
  { value: 'couple',  label: 'Couple',  phrase: 'a couple',           suggested: ['food', 'groceries', 'rent', 'utilities', 'entertainment', 'gifts'] },
  { value: 'family',  label: 'Family',  phrase: 'a family',           suggested: ['groceries', 'kids', 'food', 'healthcare', 'utilities', 'gifts'] },
  { value: 'friends', label: 'Friends', phrase: 'a group of friends', suggested: ['food', 'entertainment', 'gifts', 'transport', 'shopping', 'gas'] },
  { value: 'work',    label: 'Work',    phrase: 'a work group',       suggested: ['food', 'travel', 'transport', 'accommodation', 'gas', 'other'] },
  { value: 'event',   label: 'Event',   phrase: 'an event',           suggested: ['food', 'entertainment', 'gifts', 'shopping', 'transport', 'accommodation'] },
  { value: 'other',   label: 'Other',   phrase: 'a group',            suggested: [] },
];

const byValue = new Map(GROUP_TYPES.map((t) => [t.value, t]));

export function groupTypeLabel(type: GroupType | undefined): string {
  return (type && byValue.get(type)?.label) || 'Other';
}

/** The categories this type puts first; empty for Other or an unknown type. */
export function suggestedCategories(type: GroupType | undefined): ExpenseCategory[] {
  return (type && byValue.get(type)?.suggested) || [];
}

/** What a new expense in a group of this type starts on. */
export function defaultCategory(type: GroupType | undefined): ExpenseCategory {
  return suggestedCategories(type)[0] ?? 'food';
}

/** The line under the type picker, e.g. "Puts what a trip usually needs first: Food & Drink, Accommodation, Transport." */
export function groupTypeHint(type: GroupType): string {
  const top = suggestedCategories(type).slice(0, 3).map((c) => CATEGORY_LABELS[c]);
  if (!top.length) return 'Every category in the usual order.';
  return `Puts what ${groupTypePhrase(type)} usually needs first: ${top.join(', ')}.`;
}

/** "a trip", "a group of friends": for "Suggested for a trip". */
export function groupTypePhrase(type: GroupType | undefined): string {
  return (type && byValue.get(type)?.phrase) || 'a group';
}
