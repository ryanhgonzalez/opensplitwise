import { describe, it, expect } from 'vitest';
import { buildReminder, cleanHandle, lastReminder, payLinks, reminderItems, smsLink } from './reminder';
import type { Activity, Expense, Settlement } from '../types';

const day = (n: number) => new Date(2026, 9, n, 12);

function expense(id: string, description: string, paidBy: string, shares: Record<string, number>, date = day(10), extra: Partial<Expense> = {}): Expense {
  const entries = Object.entries(shares).map(([userId, amount]) => ({ userId, amount }));
  return {
    id, description, paidBy, date, groupId: 'g1', currency: 'USD', category: 'food',
    amount: entries.reduce((s, e) => s + e.amount, 0),
    split: { type: 'exact', entries },
    createdAt: date, updatedAt: date,
    ...extra,
  };
}

const paid = (from: string, to: string, date: Date, groupId = 'g1'): Settlement => ({
  id: `p-${date.getTime()}`, fromUserId: from, toUserId: to, amount: 10, currency: 'USD', groupId, date, createdAt: date,
});

describe('cleanHandle', () => {
  it('takes a name however it was typed', () => {
    expect(cleanHandle('@ana-g')).toBe('ana-g');
    expect(cleanHandle(' $AnaG ')).toBe('AnaG');
    expect(cleanHandle('https://paypal.me/anag/20')).toBe('anag');
    expect(cleanHandle('venmo.com/u/ana-g')).toBe('ana-g');
    expect(cleanHandle('cash.app/$anag')).toBe('anag');
  });
});

describe('payLinks', () => {
  const handles = { venmo: '@ana', cashapp: '$ana', paypal: 'anapp' };

  it('fills in the amount for each app', () => {
    const links = payLinks(handles, 85.8, 'USD', 'Lisbon trip');
    expect(links.map((l) => l.app)).toEqual(['Venmo', 'Cash App', 'PayPal']);
    expect(links[0].url).toBe('https://venmo.com/ana?txn=pay&amount=85.80&note=Lisbon+trip');
    expect(links[1].url).toBe('https://cash.app/$ana/85.80');
    expect(links[2].url).toBe('https://paypal.me/anapp/85.80USD');
  });

  it('leaves out the dollar-only apps for other currencies', () => {
    expect(payLinks(handles, 12, 'EUR').map((l) => l.url)).toEqual(['https://paypal.me/anapp/12.00EUR']);
  });

  it('is empty with no names saved', () => {
    expect(payLinks(undefined, 12, 'USD')).toEqual([]);
    expect(payLinks({ venmo: '  ' }, 12, 'USD')).toEqual([]);
  });
});

describe('reminderItems', () => {
  const expenses = [
    expense('a', 'Dinner', 'me', { me: 30, ben: 30 }, day(2)),
    expense('b', 'Taxi', 'me', { me: 10, ben: 10 }, day(8)),
    expense('c', 'Tickets', 'me', { me: 50, ben: 50 }, day(9)),
    expense('d', 'Their lunch', 'ben', { me: 20 }, day(9)), // they paid: not what they owe
    expense('e', 'Coffee', 'me', { me: 4 }, day(9)), // they weren't in it
    expense('f', 'Other group', 'me', { ben: 99 }, day(9), { groupId: 'g2' }),
    expense('r', 'Refund', 'me', { ben: 5 }, day(9), { refund: {} }),
  ];

  it('names what you paid that they were in, biggest share first, in the groups given', () => {
    expect(reminderItems(expenses, [], 'ben', 'me', ['g1'])).toEqual(['Tickets', 'Dinner', 'Taxi']);
  });

  it('skips what came before their last payment to you', () => {
    expect(reminderItems(expenses, [paid('ben', 'me', day(5))], 'ben', 'me', ['g1'])).toEqual(['Tickets', 'Taxi']);
  });

  it('falls back to everything when it all predates the payment', () => {
    expect(reminderItems(expenses, [paid('ben', 'me', day(20))], 'ben', 'me', ['g1'])).toEqual(['Tickets', 'Dinner', 'Taxi']);
  });

  it('covers every group when none are given', () => {
    expect(reminderItems(expenses, [], 'ben', 'me', [])[0]).toBe('Other group');
  });
});

describe('buildReminder', () => {
  const base = { name: 'Ben', amount: 85.83, currency: 'USD', groupNames: ['Lisbon trip'], items: ['Tickets', 'Dinner'], links: [] };

  it('writes a friendly message with what it is for', () => {
    expect(buildReminder({ ...base, tone: 'friendly' })).toBe(
      'Hey Ben! Just a friendly reminder that you owe me $85.83 from Lisbon trip (Tickets and Dinner).\n\nThanks! 🙂',
    );
  });

  it('writes a firm one that asks for a date', () => {
    const text = buildReminder({ ...base, tone: 'firm' });
    expect(text).toContain('Hi Ben, you still owe me $85.83 from Lisbon trip (Tickets and Dinner).');
    expect(text).toContain('this week');
  });

  it('names three expenses, then counts the rest', () => {
    const text = buildReminder({ ...base, items: ['A', 'B', 'C', 'D', 'E'], tone: 'friendly' });
    expect(text).toContain('(A, B, C and 2 more)');
  });

  it('adds pay links, one or several', () => {
    const one = buildReminder({ ...base, tone: 'friendly', links: [{ app: 'PayPal', url: 'https://paypal.me/a/1.00USD' }] });
    expect(one).toContain('You can pay me on PayPal: https://paypal.me/a/1.00USD');
    const two = buildReminder({
      ...base, tone: 'friendly',
      links: [{ app: 'Venmo', url: 'v' }, { app: 'PayPal', url: 'p' }],
    });
    expect(two).toContain('You can pay me here:\nVenmo: v\nPayPal: p');
  });

  it('reads well with no groups or expenses', () => {
    expect(buildReminder({ ...base, groupNames: [], items: [], tone: 'friendly' })).toMatch(/^Hey Ben! Just a friendly reminder that you owe me \$85\.83\./);
  });
});

describe('smsLink', () => {
  it('addresses Messages to the number, with the text typed in', () => {
    expect(smsLink('+1 (555) 010-2030', 'Hi & thanks')).toBe('sms:+15550102030?&body=Hi%20%26%20thanks');
    expect(smsLink(undefined, 'Hi')).toBe('sms:?&body=Hi');
  });
});

describe('lastReminder', () => {
  it('finds the newest reminder to that person', () => {
    const r = (id: string, to: string, d: number): Activity => ({
      id, type: 'reminder_sent', date: day(d), actorId: 'me', toUserId: to, amount: 1, currency: 'USD', via: 'share',
    });
    expect(lastReminder([r('1', 'ben', 3), r('2', 'ben', 7), r('3', 'eve', 9)], 'ben')?.id).toBe('2');
    expect(lastReminder([], 'ben')).toBeUndefined();
  });
});
