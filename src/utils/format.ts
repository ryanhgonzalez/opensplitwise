const formatters = new Map<string, Intl.NumberFormat>();

/**
 * "$12.50", "€12.50", "¥1,250": always unsigned. Each currency uses its own
 * number of decimals (yen has none). Defaults to US dollars, the currency of
 * data from before groups had one.
 */
export function formatCurrency(amount: number, currency = 'USD'): string {
  let fmt = formatters.get(currency);
  if (!fmt) {
    try {
      fmt = new Intl.NumberFormat('en-US', { style: 'currency', currency });
    } catch {
      // An unknown code in imported data: fall back to dollars rather than fail.
      fmt = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
    }
    formatters.set(currency, fmt);
  }
  return fmt.format(Math.abs(amount));
}

/**
 * Currency with an explicit direction: "+$12.50" or "−$12.50" (a true minus
 * sign, so figures line up in mono columns). Zero gets no sign.
 */
export function formatSigned(amount: number, currency = 'USD'): string {
  if (Math.abs(amount) < 0.005) return formatCurrency(0, currency);
  return `${amount > 0 ? '+' : '−'}${formatCurrency(amount, currency)}`;
}

/** "SEP 15" — the compact date used down the left edge of ledger rows. */
export function formatLedgerDate(date: Date): string {
  return date
    .toLocaleDateString('en-US', { month: 'short', day: '2-digit' })
    .toUpperCase();
}

export function formatDate(date: Date): string {
  const now = new Date();
  const diff = now.getTime() - date.getTime();
  const days = Math.floor(diff / (1000 * 60 * 60 * 24));

  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 7) return `${days} days ago`;

  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

export function formatTime(date: Date): string {
  return date.toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
}

/** "today", "yesterday", "5 days ago", or "on Oct 12" beyond a month, by calendar day. */
export function formatRelativeDay(date: Date, now: Date = new Date()): string {
  const day = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((day(now) - day(date)) / 86_400_000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days} days ago`;
  return `on ${date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: date.getFullYear() === now.getFullYear() ? undefined : 'numeric' })}`;
}
