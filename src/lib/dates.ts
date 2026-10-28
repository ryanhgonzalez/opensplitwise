// ─────────────────────────────────────────────────────────────────────────────
// Dates in saved data, backups and shared groups.
//
// JSON has no dates, so they're written as ISO text ("2026-10-12T10:00:00.000Z")
// and turned back into Dates on reading. Only the fields that hold dates are:
// reviving any text that looked like one also turned a description such as
// "2026-10-12T10:00:00 dinner" into an Invalid Date, which can't be shown.
// ─────────────────────────────────────────────────────────────────────────────

/** Every field the app keeps a Date in, across all its records. */
const DATE_FIELDS = new Set([
  'date', // expenses, payments, activity
  'createdAt',
  'updatedAt',
  'joinedAt', // group members
  'lastActivity', // groups
  'startDate', // repeating expenses
  'deletedAt', // deletion markers
  'sentAt', // shared groups
]);

/** groupId → Date: a map whose values are dates, under keys that aren't. */
const DATE_MAPS = new Set(['groupSyncedAt']);

const ISO_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

const toDate = (value: unknown) =>
  typeof value === 'string' && ISO_DATE_TIME.test(value) ? new Date(value) : value;

/** A `JSON.parse` reviver that gives the app's date fields back as Dates. */
export function reviveDates(key: string, value: unknown): unknown {
  if (DATE_FIELDS.has(key)) return toDate(value);
  if (DATE_MAPS.has(key) && value !== null && typeof value === 'object' && !Array.isArray(value)) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, toDate(v)]));
  }
  return value;
}
