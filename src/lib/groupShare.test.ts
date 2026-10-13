import { describe, expect, it } from 'vitest';
import type { GroupBundle } from './groupSync';
import { FRAME_BYTES, FrameCollector, compressBundle, decompressBundle, parseBundle, toFrames } from './groupShare';

const bundle = (expenses = 3): GroupBundle => ({
  kind: 'opensplitwise-group',
  v: 1,
  sentAt: new Date('2026-10-01T12:00:00Z'),
  senderId: 'a1',
  group: {
    id: 'trip', name: 'Lisbon', emoji: '✈️', color: '#000', type: 'trip', currency: 'EUR',
    members: [{ userId: 'a1', role: 'member', joinedAt: new Date('2026-10-01T10:00:00Z') }],
    lastActivity: new Date('2026-10-01T11:00:00Z'), createdAt: new Date('2026-10-01T10:00:00Z'),
  },
  users: [{ id: 'a1', name: 'Ana', initials: 'A', avatarColor: '#000', createdAt: new Date('2026-10-01T10:00:00Z') }],
  expenses: Array.from({ length: expenses }, (_, i) => ({
    id: `e${i}-${crypto.randomUUID()}`, description: `Expense ${i}`, amount: 10 + i, currency: 'EUR', paidBy: 'a1', groupId: 'trip',
    date: new Date('2026-10-01T11:00:00Z'), split: { type: 'equal', entries: [{ userId: 'a1', amount: 10 + i }] },
    category: 'food', createdAt: new Date('2026-10-01T11:00:00Z'), updatedAt: new Date('2026-10-01T11:00:00Z'),
  })),
  settlements: [],
  tombstones: [],
});

describe('bundle text', () => {
  it('round-trips with dates intact', () => {
    const b = bundle();
    const back = parseBundle(JSON.stringify(b));
    expect(back).toEqual(b);
    expect(back.expenses[0].updatedAt).toBeInstanceOf(Date);
  });

  it('rejects other files with a clear reason', () => {
    expect(() => parseBundle('not json')).toThrow(/not valid JSON/);
    expect(() => parseBundle('{"schema":"opensplit-export"}')).toThrow(/isn’t a shared group/);
    expect(() => parseBundle(JSON.stringify({ ...bundle(), v: 2 }))).toThrow(/newer version/);
  });
});

describe('code frames', () => {
  it('compress, split, arrive in any order with repeats, and reassemble', async () => {
    const b = bundle(150);
    const payload = await compressBundle(b);
    const frames = toFrames(payload, 0x1234);
    expect(frames.length).toBe(Math.ceil(payload.length / FRAME_BYTES));
    expect(frames.length).toBeGreaterThan(3);

    const c = new FrameCollector();
    const shuffled = [...frames].reverse();
    for (const f of [...shuffled.slice(0, 2), ...shuffled]) c.add(f); // repeats
    expect(c.complete).toBe(true);
    expect(await decompressBundle(c.payload())).toEqual(b);
  });

  it('says which parts have arrived, for the progress bar', async () => {
    const frames = toFrames(await compressBundle(bundle(150)), 7);
    const c = new FrameCollector();
    c.add(frames[2]);
    c.add(frames[0]);
    expect(c.arrived).toEqual(frames.map((_, i) => i === 0 || i === 2));
  });

  it('ignores stray QR codes and starts over when another share appears', async () => {
    const c = new FrameCollector();
    expect(c.add(new TextEncoder().encode('https://example.com'))).toBe(false);

    const first = toFrames(await compressBundle(bundle(150)), 1);
    const second = toFrames(await compressBundle(bundle(1)), 2);
    c.add(first[0]);
    c.add(second[0]);
    expect([c.received, c.total]).toEqual([1, second.length]);
    expect(c.complete).toBe(second.length === 1);
  });
});
