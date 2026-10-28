// ─────────────────────────────────────────────────────────────────────────────
// Reminders: a ready-to-send message saying what someone owes you.
//
// There's no server, so the app can't message anyone itself. It writes the
// message and hands it to the phone: the share sheet, or Messages with it
// already typed. The person picks who it goes to (or it's addressed already)
// and taps send.
// ─────────────────────────────────────────────────────────────────────────────

import type { Activity, Expense, PayHandles, ReminderSentActivity, Settlement } from '../types';
import { formatCurrency } from '../utils/format';

export type Tone = 'friendly' | 'firm';

/** How many expenses the message names before "and 2 more". */
const NAMED = 3;

/** A name as typed in any form ("@ana", "$ana", "paypal.me/ana") → "ana". */
export function cleanHandle(raw: string): string {
  return raw
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/^(www\.)?(venmo\.com\/(u\/)?|cash\.app\/|paypal\.me\/|paypal\.com\/paypalme\/)/i, '')
    .replace(/^[@$]/, '')
    .replace(/[/?#].*$/, '')
    .trim();
}

export interface PayLink {
  app: 'Venmo' | 'Cash App' | 'PayPal';
  url: string;
}

/**
 * Links that open a payment to you, amount filled in. Venmo and Cash App only
 * take dollars, so they're left out for other currencies. Venmo's link isn't
 * documented by Venmo, so it may stop filling in the amount one day; it still
 * opens your profile.
 */
export function payLinks(handles: PayHandles | undefined, amount: number, currency: string, note = ''): PayLink[] {
  const a = amount.toFixed(2);
  const links: PayLink[] = [];
  const venmo = cleanHandle(handles?.venmo ?? '');
  const cashapp = cleanHandle(handles?.cashapp ?? '');
  const paypal = cleanHandle(handles?.paypal ?? '');
  if (venmo && currency === 'USD') {
    const q = new URLSearchParams({ txn: 'pay', amount: a, ...(note ? { note } : {}) });
    links.push({ app: 'Venmo', url: `https://venmo.com/${encodeURIComponent(venmo)}?${q}` });
  }
  if (cashapp && currency === 'USD') links.push({ app: 'Cash App', url: `https://cash.app/$${encodeURIComponent(cashapp)}/${a}` });
  if (paypal) links.push({ app: 'PayPal', url: `https://paypal.me/${encodeURIComponent(paypal)}/${a}${currency}` });
  return links;
}

/**
 * What the debt is for: the expenses you paid that they had a share in, since
 * they last paid you, biggest share first. Groups limit it to those groups.
 */
export function reminderItems(
  expenses: Expense[],
  settlements: Settlement[],
  them: string,
  me: string,
  groupIds: string[],
): string[] {
  const inScope = (groupId?: string) => groupIds.length === 0 || (!!groupId && groupIds.includes(groupId));
  const lastPaid = settlements
    .filter((s) => s.fromUserId === them && s.toUserId === me && inScope(s.groupId))
    .reduce<number>((max, s) => Math.max(max, s.date.getTime()), 0);
  const shareOf = (e: Expense) => e.split.entries.find((en) => en.userId === them)?.amount ?? 0;
  const owed = expenses.filter((e) => e.paidBy === me && !e.refund && inScope(e.groupId) && shareOf(e) > 0.005);
  // Everything predates their last payment: name what there is rather than nothing.
  const recent = owed.filter((e) => e.date.getTime() > lastPaid);
  return (recent.length ? recent : owed)
    .sort((a, b) => shareOf(b) - shareOf(a))
    .map((e) => e.description.trim())
    .filter((d, i, all) => d && all.indexOf(d) === i);
}

/** "A", "A and B", "A, B and C". */
function list(parts: string[]): string {
  if (parts.length <= 1) return parts.join('');
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

export interface ReminderInput {
  /** Their first name. */
  name: string;
  amount: number;
  currency: string;
  groupNames: string[];
  items: string[];
  tone: Tone;
  links: PayLink[];
}

export function buildReminder({ name, amount, currency, groupNames, items, tone, links }: ReminderInput): string {
  const money = formatCurrency(amount, currency);
  const from = groupNames.length ? ` from ${list(groupNames)}` : '';
  const named = items.slice(0, NAMED);
  const more = items.length - named.length;
  const what = named.length ? list(more > 0 ? [...named, `${more} more`] : named) : '';

  const opening =
    tone === 'friendly'
      ? `Hey ${name}! Just a friendly reminder that you owe me ${money}${from}${what ? ` (${what})` : ''}.`
      : `Hi ${name}, you still owe me ${money}${from}${what ? ` (${what})` : ''}. Could you pay it this week, please?`;

  const pay = links.length
    ? links.length === 1
      ? `\n\nYou can pay me on ${links[0].app}: ${links[0].url}`
      : `\n\nYou can pay me here:\n${links.map((l) => `${l.app}: ${l.url}`).join('\n')}`
    : '';

  return `${opening}${pay}\n\n${tone === 'friendly' ? 'Thanks! 🙂' : 'Thanks.'}`;
}

/**
 * Opens Messages with the text typed in, addressed to `phone` when given.
 * `?&body=` is the form both iOS and Android read.
 */
export function smsLink(phone: string | undefined, body: string): string {
  const to = (phone ?? '').replace(/[^\d+]/g, '');
  return `sms:${to}?&body=${encodeURIComponent(body)}`;
}

/** The most recent reminder you sent this person, if any. */
export function lastReminder(activities: Activity[], toUserId: string): ReminderSentActivity | undefined {
  let latest: ReminderSentActivity | undefined;
  for (const a of activities) {
    if (a.type === 'reminder_sent' && a.toUserId === toUserId && (!latest || a.date > latest.date)) latest = a;
  }
  return latest;
}
