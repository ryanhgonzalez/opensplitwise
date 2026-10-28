import { describe, it, expect } from 'vitest';
import { parseVcf, planImport } from './contacts';
import type { User } from '../types';

// What iPhone's Contacts app exports, folded lines and all.
const IOS = [
  'BEGIN:VCARD',
  'VERSION:3.0',
  'PRODID:-//Apple Inc.//iPhone OS 18.0//EN',
  'N:Lopes;Ben;;;',
  'FN:Ben Lopes',
  'item1.TEL;type=pref:+351 912 000 111',
  'TEL;type=CELL;type=VOICE:+1 (555) 010-2030',
  'EMAIL;type=INTERNET;type=HOME:ben@example.com',
  'PHOTO;ENCODING=b;TYPE=JPEG:/9j/4AAQSkZJRgABAQAAAQABAAD',
  ' /2wBDAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoHBwYIDAoMDAsKCwsNDhIQ',
  'END:VCARD',
  'BEGIN:VCARD',
  'VERSION:3.0',
  'N:Silva;Carla;Maria;;',
  'TEL;type=HOME:555 777 8888',
  'END:VCARD',
  'BEGIN:VCARD',
  'VERSION:3.0',
  'ORG:Pizza\\, Lda;',
  'END:VCARD',
  'BEGIN:VCARD',
  'VERSION:3.0',
  'NOTE:no name at all',
  'END:VCARD',
].join('\r\n');

describe('parseVcf', () => {
  it('reads names, the mobile number and the email', () => {
    expect(parseVcf(IOS)).toEqual([
      { name: 'Ben Lopes', phone: '+1 (555) 010-2030', email: 'ben@example.com' },
      { name: 'Carla Maria Silva', phone: '555 777 8888', email: undefined },
      { name: 'Pizza, Lda', phone: undefined, email: undefined },
    ]);
  });

  it('reads version 4 and lowercase, with tel: values', () => {
    const v4 = 'begin:vcard\nversion:4.0\nfn:Dana Reis\ntel;value=uri;type=cell:tel:+15551234567\nend:vcard\n';
    expect(parseVcf(v4)).toEqual([{ name: 'Dana Reis', phone: '+15551234567', email: undefined }]);
  });

  it('is empty for a file that is not contacts', () => {
    expect(parseVcf('hello, world')).toEqual([]);
  });
});

describe('planImport', () => {
  const user = (id: string, name: string, phone?: string): User => ({
    id, name, initials: name[0], avatarColor: '#000', createdAt: new Date(), ...(phone ? { phone } : {}),
  });
  const here = [user('u1', 'Ben Lopes'), user('u2', 'Carla', '555-777-8888'), user('u3', 'Dana Reis', '+1 555 999 0000')];

  it('adds new people, gives a number to a namesake without one, and skips the rest', () => {
    const rows = planImport(
      [
        { name: 'Eddie Costa', phone: '555 111 2222' },
        { name: 'ben lopes', phone: '+1 (555) 010-2030' },
        { name: 'Carla Maria Silva', phone: '+1 555 777 8888' }, // same number as Carla
        { name: 'Dana Reis', phone: '555 444 3333' }, // has a number already
        { name: 'Eddie Costa' }, // twice in the file
      ],
      here,
    );
    expect(rows.map((r) => [r.name, r.action, r.userId])).toEqual([
      ['Eddie Costa', 'new', undefined],
      ['ben lopes', 'phone', 'u1'],
      ['Carla Maria Silva', 'skip', 'u2'],
      ['Dana Reis', 'skip', 'u3'],
    ]);
  });
});
