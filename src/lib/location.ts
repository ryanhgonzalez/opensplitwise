// ─────────────────────────────────────────────────────────────────────────────
// Where an expense was paid.
//
// The phone works out its own position (GPS, Wi-Fi); nothing is sent anywhere.
// The app keeps just the coordinates. "Open in Maps" hands them to the phone's
// maps app, which shows the place.
// ─────────────────────────────────────────────────────────────────────────────

import type { Expense } from '../types';

export type ExpenseLocation = NonNullable<Expense['location']>;

/** Five decimal places is about a metre: as precise as a phone gets. */
const round5 = (n: number) => Math.round(n * 1e5) / 1e5;

export const canLocate = () => typeof navigator !== 'undefined' && 'geolocation' in navigator;

/** Asks the phone where it is. Rejects with a message to show. */
export function currentLocation(): Promise<ExpenseLocation> {
  return new Promise((resolve, reject) => {
    if (!canLocate()) return reject(new Error('This browser can’t share its location.'));
    navigator.geolocation.getCurrentPosition(
      (pos) =>
        resolve({
          lat: round5(pos.coords.latitude),
          lng: round5(pos.coords.longitude),
          accuracy: Math.round(pos.coords.accuracy),
        }),
      (err) =>
        reject(
          new Error(
            err.code === err.PERMISSION_DENIED
              ? 'Location is turned off for this app. Allow it in your browser or phone settings.'
              : err.code === err.TIMEOUT
                ? 'Couldn’t find your location in time. Try again, ideally outdoors.'
                : 'Couldn’t find your location.',
          ),
        ),
      { enableHighAccuracy: true, timeout: 15_000, maximumAge: 60_000 },
    );
  });
}

/** "40.71283, -74.00602" */
export const formatCoords = (loc: ExpenseLocation) => `${loc.lat.toFixed(5)}, ${loc.lng.toFixed(5)}`;

/** "within 12 m", "within 1.2 km" */
export function formatAccuracy(metres?: number): string {
  if (metres === undefined) return '';
  return metres < 1000 ? `within ${metres} m` : `within ${(metres / 1000).toFixed(1)} km`;
}

/** Apple devices open Apple Maps; everything else, Google Maps. */
export function mapsUrl(loc: ExpenseLocation, label: string, userAgent = typeof navigator === 'undefined' ? '' : navigator.userAgent): string {
  const apple = /iPhone|iPad|iPod|Macintosh/.test(userAgent);
  return apple
    ? `https://maps.apple.com/?ll=${loc.lat},${loc.lng}&q=${encodeURIComponent(label || 'Expense')}`
    : `https://www.google.com/maps/search/?api=1&query=${loc.lat},${loc.lng}`;
}
