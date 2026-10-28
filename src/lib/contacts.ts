// ─────────────────────────────────────────────────────────────────────────────
// Adding people from the phone's contacts.
//
// Two ways in: Android Chrome's contact picker (tick several people), and a
// contacts file (.vcf), which any phone's Contacts app can export. Either way
// the app only sees the contacts you chose, never the whole address book.
// ─────────────────────────────────────────────────────────────────────────────

import type { User } from '../types';

export interface Contact {
  name: string;
  phone?: string;
  email?: string;
}

/** Android Chrome's contact picker. Safari keeps it behind a developer setting. */
interface ContactsManager {
  select: (
    props: ('name' | 'tel' | 'email')[],
    opts?: { multiple?: boolean },
  ) => Promise<{ name?: string[]; tel?: string[]; email?: string[] }[]>;
}

export const contactPicker = (): ContactsManager | undefined =>
  typeof navigator === 'undefined' ? undefined : (navigator as Navigator & { contacts?: ContactsManager }).contacts;

/** Opens the picker for several people. Empty if cancelled. */
export async function pickContacts(): Promise<Contact[]> {
  const picker = contactPicker();
  if (!picker) return [];
  const picked = await picker.select(['name', 'tel', 'email'], { multiple: true });
  return picked
    .map((c) => ({ name: c.name?.[0]?.trim() ?? '', phone: c.tel?.[0]?.trim() || undefined, email: c.email?.[0]?.trim() || undefined }))
    .filter((c) => c.name);
}

/** vCard text values escape commas, semicolons and newlines with a backslash. */
const unescape = (v: string) => v.replace(/\\n/gi, ' ').replace(/\\([,;\\])/g, '$1').trim();

/**
 * Reads a contacts file: one or many vCards (versions 2.1, 3 and 4). Takes the
 * display name (or builds one from the name parts, or the company), the mobile
 * number when one is marked, and the first email.
 */
export function parseVcf(text: string): Contact[] {
  // A line starting with a space or tab continues the one before it.
  const lines = text.replace(/\r\n?/g, '\n').replace(/\n[ \t]/g, '').split('\n');
  const contacts: Contact[] = [];
  let card: { fn?: string; n?: string; org?: string; tels: { value: string; mobile: boolean; pref: boolean }[]; emails: string[] } | null = null;

  for (const line of lines) {
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    // "item1.TEL;TYPE=CELL" → name "TEL", params "type=cell"
    const [rawName, ...params] = line.slice(0, colon).split(';');
    const name = rawName.replace(/^[^.]*\./, '').toUpperCase();
    const paramText = params.join(';').toLowerCase();
    const value = line.slice(colon + 1);

    if (name === 'BEGIN' && value.trim().toUpperCase() === 'VCARD') {
      card = { tels: [], emails: [] };
    } else if (!card) {
      continue;
    } else if (name === 'END') {
      // N is Family;Given;Middle;Prefix;Suffix → "Given Middle Family"
      const parts = card.n?.split(';').map(unescape) ?? [];
      const built = [parts[1], parts[2], parts[0]].filter(Boolean).join(' ');
      const display = card.fn || built || card.org || '';
      const tel = card.tels.find((t) => t.mobile) ?? card.tels.find((t) => t.pref) ?? card.tels[0];
      if (display) contacts.push({ name: display, phone: tel?.value, email: card.emails[0] });
      card = null;
    } else if (name === 'FN') {
      card.fn = unescape(value);
    } else if (name === 'N') {
      card.n = value;
    } else if (name === 'ORG') {
      card.org = unescape(value.split(';')[0]);
    } else if (name === 'TEL') {
      const tel = unescape(value.replace(/^tel:/i, ''));
      if (tel) card.tels.push({ value: tel, mobile: /cell|mobile|iphone/.test(paramText), pref: /pref/.test(paramText) });
    } else if (name === 'EMAIL') {
      const email = unescape(value);
      if (email) card.emails.push(email);
    }
  }
  return contacts;
}

/** The last ten digits, so "+1 (555) 010-2030" and "555-010-2030" match. */
const phoneKey = (phone?: string) => (phone ?? '').replace(/\D/g, '').slice(-10);
const nameKey = (name: string) => name.trim().toLowerCase().replace(/\s+/g, ' ');

export interface ImportRow extends Contact {
  /**
   * `new`: adds them. `phone`: someone here by that name, with no number yet,
   * gets this one. `skip`: already here.
   */
  action: 'new' | 'phone' | 'skip';
  /** Who's already here, for `phone` and `skip`. */
  userId?: string;
}

/** What importing these contacts would do, given the people already here. */
export function planImport(contacts: Contact[], users: User[]): ImportRow[] {
  const seen = new Set<string>();
  const rows: ImportRow[] = [];
  for (const c of contacts) {
    const key = nameKey(c.name);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const byPhone = phoneKey(c.phone) && users.find((u) => phoneKey(u.phone) === phoneKey(c.phone));
    const byName = users.find((u) => nameKey(u.name) === key);
    if (byPhone) rows.push({ ...c, action: 'skip', userId: byPhone.id });
    else if (byName && c.phone && !byName.phone) rows.push({ ...c, action: 'phone', userId: byName.id });
    else if (byName) rows.push({ ...c, action: 'skip', userId: byName.id });
    else rows.push({ ...c, action: 'new' });
  }
  // New people first, alphabetically; those already here last.
  const order = { new: 0, phone: 1, skip: 2 };
  return rows.sort((a, b) => order[a.action] - order[b.action] || a.name.localeCompare(b.name));
}
