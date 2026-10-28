/** Your own names on payment apps, used to put a pay link in reminders. */
export interface PayHandles {
  venmo?: string;
  cashapp?: string;
  paypal?: string;
}

export interface User {
  id: string;
  name: string;
  initials: string;
  email?: string;
  /** For texting a reminder straight to them. Stays on this device: never shared. */
  phone?: string;
  /** Only set on you. Stays on this device: never shared. */
  payHandles?: PayHandles;
  avatarColor: string;
  createdAt: Date;
}
