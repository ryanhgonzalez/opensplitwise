import type { CategoryId, CustomCategoryId, ExpenseCategory, Group } from '../types';
import { CATEGORY_ICONS, CATEGORY_LABELS } from '../types';

// ─────────────────────────────────────────────────────────────────────────────
// Categories: the built-in set plus each group's custom ones.
//
// A custom category belongs to one group (Group.categories), and an expense
// refers to it by id. Anything that shows a category goes through
// `categoryInfo` with the expense's group, so a custom id that can't be found
// (removed, or its group isn't on hand) reads as Other instead of an id.
// ─────────────────────────────────────────────────────────────────────────────

export const BUILT_IN_CATEGORIES = Object.keys(CATEGORY_LABELS) as ExpenseCategory[];

/** Custom categories have no icon of their own; this stands in where one is needed. */
export const CUSTOM_CATEGORY_ICON = '🏷️';

export const MAX_CATEGORY_NAME = 30;

type GroupCategories = Pick<Group, 'categories'> | undefined;

export function isCustomCategory(id: CategoryId): id is CustomCategoryId {
  return id.startsWith('custom:');
}

export function categoryInfo(id: CategoryId, group?: GroupCategories): { label: string; icon: string } {
  if (isCustomCategory(id)) {
    const custom = group?.categories?.find((c) => c.id === id);
    if (custom) return { label: custom.name, icon: CUSTOM_CATEGORY_ICON };
    return { label: CATEGORY_LABELS.other, icon: CATEGORY_ICONS.other };
  }
  return {
    label: CATEGORY_LABELS[id] ?? CATEGORY_LABELS.other,
    icon: CATEGORY_ICONS[id] ?? CATEGORY_ICONS.other,
  };
}

export const categoryLabel = (id: CategoryId, group?: GroupCategories) => categoryInfo(id, group).label;

/** Trims and collapses spaces; an empty result means the name can't be used. */
export function cleanCategoryName(name: string): string {
  return name.trim().replace(/\s+/g, ' ').slice(0, MAX_CATEGORY_NAME);
}

/** The built-in or group category already called `name` (ignoring case), if any. */
export function findCategoryByName(name: string, group?: GroupCategories): CategoryId | undefined {
  const wanted = cleanCategoryName(name).toLowerCase();
  if (!wanted) return undefined;
  const builtIn = BUILT_IN_CATEGORIES.find((c) => CATEGORY_LABELS[c].toLowerCase() === wanted);
  if (builtIn) return builtIn;
  return group?.categories?.find((c) => c.name.toLowerCase() === wanted)?.id;
}
