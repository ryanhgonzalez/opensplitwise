import type { User } from '../types';

/** A person as sent to someone else: their phone number and pay names stay here. */
export function shareableUser(user: User): User {
  const copy = { ...user };
  delete copy.phone;
  delete copy.payHandles;
  return copy;
}

const firstNameOf = (name: string) => name.split(' ')[0];

/**
 * A name as lists show it: the first name, unless someone else among `names`
 * (everyone on the list, them included) has the same one, as with "Frank" and
 * "Frank Jr". Then the full name, so the two can be told apart.
 */
export function shortName(name: string, names: (string | undefined)[]): string {
  const first = firstNameOf(name);
  return names.filter((n) => n !== undefined && firstNameOf(n) === first).length > 1 ? name : first;
}
