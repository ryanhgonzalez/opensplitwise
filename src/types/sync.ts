/** What a deletion marker removes when a group is shared. */
export type TombstoneKind = 'expense' | 'settlement' | 'category' | 'member';

/**
 * Left behind when an expense, payment or custom category is deleted from a
 * group, or a member removed, so the deletion travels with the next share:
 * the other phone drops its copy unless it was edited (or the member added
 * again) after `deletedAt`.
 */
export interface Tombstone {
  /** The record's id; for a member, the person's id on the phone that holds the marker. */
  id: string;
  kind: TombstoneKind;
  groupId: string;
  deletedAt: Date;
}
