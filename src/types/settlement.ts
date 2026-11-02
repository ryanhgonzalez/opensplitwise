export type PaymentMethod = 'venmo' | 'cashapp' | 'zelle' | 'cash' | 'other';

export const PAYMENT_METHOD_LABELS: Record<PaymentMethod, string> = {
  venmo: 'Venmo',
  cashapp: 'Cash App',
  zelle: 'Zelle',
  cash: 'Cash',
  other: 'Other',
};

export interface Settlement {
  id: string;
  fromUserId: string;
  toUserId: string;
  amount: number;
  currency: string;
  groupId?: string;
  date: Date;
  paymentMethod?: PaymentMethod;
  note?: string;
  createdAt: Date;
}
