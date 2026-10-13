export interface FriendBalance {
  userId: string;
  amount: number;
  groupId?: string;
}

export interface GroupBalance {
  groupId: string;
  yourBalance: number;
  totalSpent: number;
  memberBalances: FriendBalance[];
}

export interface OverallBalance {
  /** Every amount below is in this currency; balances in different currencies are never added. */
  currency: string;
  net: number;
  totalOwed: number;
  totalOwe: number;
  owedByFriend: FriendBalance[];
  oweToFriend: FriendBalance[];
}
