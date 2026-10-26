/** The four destinations, shared by the desktop sidebar and the mobile tab bar. */
export interface NavItem {
  to: string;
  label: string;
  /** One stroke path on a 24 × 24 grid. */
  path: string;
}

export const NAV_ITEMS: NavItem[] = [
  {
    to: '/',
    label: 'Home',
    path: 'M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z',
  },
  {
    to: '/groups',
    label: 'Groups',
    path: 'M9 11.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM2.5 20c.8-3.6 3.4-5.5 6.5-5.5s5.7 1.9 6.5 5.5M16 4.6a3.5 3.5 0 0 1 0 6.8M18 14.8c1.9.7 3.1 2.4 3.5 5.2',
  },
  {
    to: '/people',
    label: 'People',
    path: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21c1-4 4-6 8-6s7 2 8 6',
  },
  {
    to: '/activity',
    label: 'Activity',
    path: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7v5l3.5 2',
  },
];

export function NavIcon({ path, size = 20 }: { path: string; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d={path} />
    </svg>
  );
}
