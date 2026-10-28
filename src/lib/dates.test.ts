import { describe, it, expect } from 'vitest';
import { reviveDates } from './dates';

describe('reviveDates', () => {
  const when = new Date('2026-10-12T10:00:00.000Z');

  it('gives the date fields back as Dates', () => {
    const back = JSON.parse(JSON.stringify({ date: when, createdAt: when, joinedAt: when, deletedAt: when }), reviveDates);
    for (const v of Object.values(back)) expect(v).toEqual(when);
  });

  it('gives the values of a groupId → date map back as Dates', () => {
    const back = JSON.parse(JSON.stringify({ groupSyncedAt: { g1: when } }), reviveDates);
    expect(back.groupSyncedAt.g1).toEqual(when);
  });

  it('leaves text that only looks like a date as text', () => {
    // Reviving these turned a description into an Invalid Date, which can't be shown.
    const text = { description: '2026-10-12T10:00:00 dinner', name: '2026-10-12T10:00:00.000Z', notes: '2026-10-12T10:00' };
    expect(JSON.parse(JSON.stringify(text), reviveDates)).toEqual(text);
  });
});
