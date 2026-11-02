import type { Group, User } from '../types';

// ─────────────────────────────────────────────────────────────────────────────
// Expenses with one person, outside any named group.
//
// They're kept in a hidden two-person group (`direct`), so balances, settling
// up, sharing by QR, currencies and repeats all work as they do in any group.
// The group is made when its first expense is saved; until then the expense
// form holds a placeholder id, `with:<their id>`.
// ─────────────────────────────────────────────────────────────────────────────

const PENDING = 'with:';

/** The placeholder group id for "just with this person", before the group exists. */
export const pendingDirectId = (userId: string) => `${PENDING}${userId}`;

/** Who a placeholder id is for; undefined for a real group id. */
export const pendingDirectUser = (groupId: string) => (groupId.startsWith(PENDING) ? groupId.slice(PENDING.length) : undefined);

/** Listed under Groups and offered in pickers: a named group that isn't archived. */
export const isListed = (g: Pick<Group, 'direct' | 'archivedAt'>) => !g.direct && !g.archivedAt;

/** The other person in a two-person group, from where you stand. */
export const directOther = (g: Pick<Group, 'members'>, me: string) => g.members.find((m) => m.userId !== me)?.userId;

/** Your existing group with just this person, if there is one. */
export const directGroupWith = (groups: Group[], me: string, them: string): Group | undefined =>
  groups.find(
    (g) =>
      g.direct &&
      g.members.length === 2 &&
      g.members.some((m) => m.userId === me) &&
      g.members.some((m) => m.userId === them),
  );

/** A new two-person group: named for both, so it reads the same on either phone. */
export function directGroupDraft(me: User, them: User, currency: string): Omit<Group, 'id' | 'createdAt' | 'lastActivity'> {
  const joinedAt = new Date();
  return {
    name: `${me.name.split(' ')[0]} & ${them.name.split(' ')[0]}`,
    emoji: '🤝',
    color: them.avatarColor,
    type: 'friends',
    currency,
    direct: true,
    members: [
      { userId: me.id, role: 'owner', joinedAt },
      { userId: them.id, role: 'member', joinedAt },
    ],
  };
}
