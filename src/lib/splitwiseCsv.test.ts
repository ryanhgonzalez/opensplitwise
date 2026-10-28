import { describe, it, expect } from 'vitest';
import { buildSplitwiseCsv, groupNameFromFilename, looksLikeSplitwiseCsv, parseCsv, parseSplitwiseCsv } from './splitwiseCsv';
import type { AppExport } from './dataExport';

/** Each person's net balance by name: paid minus owed, plus payments made minus received. */
function balances(file: AppExport, currency = 'USD'): Record<string, number> {
  const { users, expenses, settlements } = file.data;
  const net = new Map(users.map((u) => [u.id, 0]));
  for (const e of expenses.filter((x) => x.currency === currency)) {
    const sign = e.refund ? -1 : 1;
    net.set(e.paidBy, net.get(e.paidBy)! + sign * e.amount);
    for (const en of e.split.entries) net.set(en.userId, net.get(en.userId)! - sign * en.amount);
  }
  for (const s of settlements.filter((x) => x.currency === currency)) {
    net.set(s.fromUserId, net.get(s.fromUserId)! + s.amount);
    net.set(s.toUserId, net.get(s.toUserId)! - s.amount);
  }
  return Object.fromEntries(users.map((u) => [u.name, Math.round(net.get(u.id)! * 100) / 100]));
}

const SAMPLE = [
  'Date,Description,Category,Cost,Currency,Alice Smith,Bob Jones,Cara Lee',
  '2024-05-01,Dinner,Dining out,90.00,USD,60.00,-30.00,-30.00',
  '2024-05-02,"Groceries, snacks",Groceries,30.00,USD,-10.00,20.00,-10.00',
  '2024-05-03,Bob Jones paid Alice Smith,Payment,10.00,USD,-10.00,10.00,0.00',
  '2024-05-04,Ferry,Pets,12.00,USD,-4.00,-4.00,8.00',
  '',
  '2024-05-05,Total balance, , ,USD,36.00,-4.00,-32.00',
].join('\n');

describe('parseCsv', () => {
  it('handles quotes, commas and line breaks inside fields', () => {
    expect(parseCsv('a,"b, c","say ""hi""\nthere"\r\n1,2,3')).toEqual([
      ['a', 'b, c', 'say "hi"\nthere'],
      ['1', '2', '3'],
    ]);
  });
});

describe('parseSplitwiseCsv', () => {
  it('reads expenses, payments and people, and matches the file\'s totals', () => {
    const r = parseSplitwiseCsv(SAMPLE, 'beach-trip_2024-05-06_export.csv');
    expect(r.ok).toBe(true);
    expect(r.warnings).toEqual([]);
    const file = r.data!;
    expect(file.meta.source).toBe('splitwise');
    expect(file.data.groups[0].name).toBe('Beach Trip');
    expect(file.data.users.map((u) => u.name)).toEqual(['Alice Smith', 'Bob Jones', 'Cara Lee']);
    expect(file.data.expenses).toHaveLength(3);
    expect(file.data.settlements).toHaveLength(1);
    expect(balances(file)).toEqual({ 'Alice Smith': 36, 'Bob Jones': -4, 'Cara Lee': -32 });

    const [dinner, groceries] = file.data.expenses;
    const alice = file.data.users[0].id;
    expect(dinner.paidBy).toBe(alice);
    expect(dinner.amount).toBe(90);
    expect(dinner.split.type).toBe('equal');
    expect(dinner.category).toBe('food');
    expect(groceries.description).toBe('Groceries, snacks');
    expect(dinner.date.getDate()).toBe(1);

    // Splitwise categories with no match here become the group's own.
    const ferry = file.data.expenses[2];
    expect(file.data.groups[0].categories).toEqual([{ id: ferry.category, name: 'Pets' }]);
  });

  it('splits a row several people paid into one expense per payer, keeping balances', () => {
    const csv = [
      'Date,Description,Category,Cost,Currency,A,B,C',
      '2024-01-01,Hotel,Hotel,300.00,USD,100.00,50.00,-150.00',
    ].join('\n');
    const file = parseSplitwiseCsv(csv).data!;
    expect(file.data.expenses).toHaveLength(2);
    expect(file.data.expenses.reduce((s, e) => s + e.amount, 0)).toBe(300);
    expect(balances(file)).toEqual({ A: 100, B: 50, C: -150 });
    for (const e of file.data.expenses) {
      expect(e.split.entries.reduce((s, en) => s + en.amount, 0)).toBeCloseTo(e.amount, 2);
    }
  });

  it('reads a negative cost as a refund', () => {
    const csv = [
      'Date,Description,Category,Cost,Currency,A,B',
      '2024-01-01,Returned tickets,Movies,-40.00,USD,-20.00,20.00',
    ].join('\n');
    const file = parseSplitwiseCsv(csv).data!;
    const [e] = file.data.expenses;
    expect(e.refund).toEqual({});
    expect(e.amount).toBe(40);
    expect(balances(file)).toEqual({ A: -20, B: 20 });
  });

  it('keeps an expense that moved nobody\'s balance, and says so', () => {
    const csv = 'Date,Description,Category,Cost,Currency,A,B\n2024-01-01,Coffee,General,5.00,USD,0.00,0.00';
    const r = parseSplitwiseCsv(csv);
    expect(r.data!.data.expenses).toHaveLength(1);
    expect(r.warnings[0]).toMatch(/doesn't say who paid/);
  });

  it('warns when the result disagrees with the Total balance row', () => {
    const csv = [
      'Date,Description,Category,Cost,Currency,A,B',
      '2024-01-01,Lunch,General,20.00,USD,10.00,-10.00',
      '',
      '2024-01-02,Total balance, , ,USD,99.00,-99.00',
    ].join('\n');
    expect(parseSplitwiseCsv(csv).warnings.some((w) => w.includes('Total balance'))).toBe(true);
  });

  it('makes one group per currency when the file mixes them', () => {
    const csv = [
      'Date,Description,Category,Cost,Currency,Alice,Bob',
      '2024-05-01,Dinner,Dining out,60.00,USD,30.00,-30.00',
      '2024-05-02,Tapas,Dining out,40.00,EUR,-20.00,20.00',
      '2024-05-03,Taxi,Taxi,20.00,USD,10.00,-10.00',
      '',
      '2024-05-04,Total balance, , ,USD,40.00,-40.00',
      '2024-05-04,Total balance, , ,EUR,-20.00,20.00',
    ].join('\n');
    const result = parseSplitwiseCsv(csv, 'beach-trip_2024-05-04_export.csv');
    expect(result.ok).toBe(true);
    const { groups, expenses } = result.data!.data;
    // A group here is in one currency, so euros aren't shown (or shared) as dollars.
    expect(groups.map((g) => [g.name, g.currency])).toEqual([['Beach Trip (USD)', 'USD'], ['Beach Trip (EUR)', 'EUR']]);
    for (const e of expenses) expect(groups.find((g) => g.id === e.groupId)!.currency).toBe(e.currency);
    expect(result.data!.meta.groupCount).toBe(2);
    expect(result.warnings.some((w) => w.includes('one group per currency'))).toBe(true);
    // Each still matches the file's own totals.
    expect(result.warnings.some((w) => w.includes('different'))).toBe(false);
    expect(balances(result.data!, 'EUR')).toEqual({ Alice: -20, Bob: 20 });
  });

  it('rejects CSVs that aren\'t a Splitwise export', () => {
    expect(looksLikeSplitwiseCsv('Name,Amount\nx,1')).toBe(false);
    expect(parseSplitwiseCsv('Name,Amount\nx,1').ok).toBe(false);
  });
});

describe('buildSplitwiseCsv', () => {
  it('round-trips through the importer with the same balances and categories', () => {
    const first = parseSplitwiseCsv(SAMPLE, 'beach.csv').data!;
    const { users, groups, expenses, settlements } = first.data;
    const csv = buildSplitwiseCsv({ group: groups[0], users, expenses, settlements });

    expect(csv.split('\n')[0]).toBe('Date,Description,Category,Cost,Currency,Alice Smith,Bob Jones,Cara Lee');
    expect(csv).toContain('2024-05-03,Bob Jones paid Alice Smith,Payment,10.00,USD,-10.00,10.00,0.00');
    expect(csv).toContain(',Total balance, , ,USD,36.00,-4.00,-32.00');

    const again = parseSplitwiseCsv(csv, 'beach.csv');
    expect(again.warnings).toEqual([]);
    expect(balances(again.data!)).toEqual(balances(first));
    expect(again.data!.data.expenses.map((e) => e.category.startsWith('custom:') ? 'custom' : e.category))
      .toEqual(['food', 'groceries', 'custom']);
  });
});

describe('groupNameFromFilename', () => {
  it('drops Splitwise\'s date and _export suffix', () => {
    expect(groupNameFromFilename('trip-to-paris_2024-05-01_export.csv')).toBe('Trip To Paris');
    expect(groupNameFromFilename('.csv')).toBe('Splitwise import');
  });
});
