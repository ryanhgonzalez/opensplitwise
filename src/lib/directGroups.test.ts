import { describe, it, expect } from 'vitest';
import { directGroupWith, directOther, isListed, pendingDirectId, pendingDirectUser } from './directGroups';
import type { Group } from '../types';

const group = (id: string, members: string[], extra: Partial<Group> = {}): Group => ({
  id,
  name: id,
  emoji: '🤝',
  color: '#000',
  type: 'friends',
  members: members.map((userId) => ({ userId, role: 'member', joinedAt: new Date(0) })),
  lastActivity: new Date(0),
  createdAt: new Date(0),
  ...extra,
});

describe('direct groups', () => {
  it('round-trips the placeholder id', () => {
    expect(pendingDirectUser(pendingDirectId('u2'))).toBe('u2');
    expect(pendingDirectUser('g1')).toBeUndefined();
  });

  it('finds only the two-person group with exactly you two', () => {
    const groups = [
      group('trip', ['me', 'ana']),
      group('three', ['me', 'ana', 'ben'], { direct: true }),
      group('d', ['me', 'ana'], { direct: true }),
    ];
    expect(directGroupWith(groups, 'me', 'ana')?.id).toBe('d');
    expect(directGroupWith(groups, 'me', 'ben')).toBeUndefined();
    expect(directOther(groups[2], 'me')).toBe('ana');
  });

  it('lists named groups that are not archived', () => {
    expect(isListed(group('a', []))).toBe(true);
    expect(isListed(group('b', [], { direct: true }))).toBe(false);
    expect(isListed(group('c', [], { archivedAt: new Date() }))).toBe(false);
  });
});
