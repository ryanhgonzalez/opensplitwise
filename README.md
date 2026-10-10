# OpenSplitwise

A mobile-first expense splitting PWA inspired by Splitwise, built with React and TypeScript. Features an Apple iOS-inspired design system with light/dark/system theming, fluid animations, and full offline support: data stays on the device, and a service worker caches the app itself.

## Features

- **Dashboard** — Net balance overview, recent expenses, and quick group access
- **Groups** — Create and manage expense groups with emoji, color coding, and member management
- **People** — Track individual balances across all shared groups
- **Activity** — Chronological feed of all expenses and payments
- **Settle Up** — Mark payments complete in either direction (money you paid or money you received), in full or partially, via Venmo, Cash App, Zelle, or cash. Balances, group totals, and the activity feed update immediately. Payments marked complete from Settle Up clear the overall balance with that person; to clear a specific group's balance, mark it complete from inside that group, where completed payments are also listed and can be undone.
- **Insights** — Spending breakdowns by category, monthly trends, and group contribution charts
- **Group PDF Reports** — Export a full expense report for any group as a PDF
- **Data Import / Export** — Back up and restore all app data as JSON
- **Theme Toggle** — Light, Dark, and System default modes with no flash on load
- **Receipt Scanning** — Fill an expense from a receipt photo, read on the device (Tesseract, or the opt-in Better scan model)
- **Works Offline** — After one online visit, everything above works with no connection (see below)

## Tech Stack

- **React 18** + **TypeScript**
- **Vite 5** for bundling
- **Zustand 5** with `persist` middleware for local state
- **Framer Motion** for animations
- **React Router v7** for navigation
- **jsPDF** + **jspdf-autotable** for PDF generation

## Getting Started

```bash
npm install
npm run dev
```

App runs at `http://localhost:5174`

## Build

```bash
npx vite build
```

Output goes to `dist/`.

## Offline

A service worker (vite-plugin-pwa, configured in `vite.config.ts`) precaches the whole app on the first visit, about 10 MB: every JS chunk, the self-hosted IBM Plex fonts, and Tesseract's worker, core and English data (served from `/tesseract`, copied out of `node_modules` at build time). After that the app, the PDF report and the standard receipt scan need no network.

Better scan's model (~390 MB) is not precached. The browser keeps it after its first use, and from then on Better scan works offline too.

New versions download in the background and take over when the app is next opened, or while it's in the background with no sheet open (`src/lib/serviceWorker.ts`), so an update never interrupts someone entering an expense.

## Deployment

Deployed via Cloudflare Pages connected to this repository.

- **Build command:** `npm run build`
- **Output directory:** `dist`
- **Node version:** `20`
