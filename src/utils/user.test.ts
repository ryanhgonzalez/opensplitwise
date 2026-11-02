import { describe, expect, it } from 'vitest';
import { shortName } from './user';

describe('shortName', () => {
  const names = ['Ana Ruiz', 'Frank Gonzalez', 'Frank Gonzalez Jr', 'Ben'];

  it('uses the first name when nobody else on the list shares it', () => {
    expect(shortName('Ana Ruiz', names)).toBe('Ana');
    expect(shortName('Ben', names)).toBe('Ben');
  });

  it('uses the full name when two people share a first name', () => {
    expect(shortName('Frank Gonzalez', names)).toBe('Frank Gonzalez');
    expect(shortName('Frank Gonzalez Jr', names)).toBe('Frank Gonzalez Jr');
  });

  it('ignores people it couldn’t find', () => {
    expect(shortName('Frank Gonzalez', ['Frank Gonzalez', undefined])).toBe('Frank');
  });
});
