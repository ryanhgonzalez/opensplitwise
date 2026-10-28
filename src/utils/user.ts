import type { User } from '../types';

/** A person as sent to someone else: their phone number and pay names stay here. */
export function shareableUser(user: User): User {
  const copy = { ...user };
  delete copy.phone;
  delete copy.payHandles;
  return copy;
}
