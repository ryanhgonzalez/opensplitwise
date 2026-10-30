// ─────────────────────────────────────────────────────────────────────────────
// Naming where an expense was paid: the places near a saved location.
//
// The one time the app sends anything to an outside service on its own: only
// when "Name this place" is tapped, it asks OpenStreetMap's Overpass API for
// named shops, restaurants and the like around the pin. That request carries
// the location (and, like any request, the internet address); nothing else.
// ─────────────────────────────────────────────────────────────────────────────

import type { ExpenseLocation } from './location';

export interface NearbyPlace {
  id: string;
  name: string;
  /** "Gas station", "Cafe" */
  kind: string;
  address?: string;
  lat: number;
  lng: number;
  /** Metres from the saved location. */
  distance: number;
}

/** Public Overpass servers, tried in turn when one is busy. */
const SERVERS = ['https://overpass-api.de/api/interpreter', 'https://overpass.private.coffee/api/interpreter'];

/** The kinds of things people pay at. */
const KEYS = ['amenity', 'shop', 'tourism', 'leisure', 'craft', 'office', 'healthcare'];

/** OpenStreetMap's words for common places, in everyday English. */
const KIND_LABELS: Record<string, string> = {
  fuel: 'Gas station',
  restaurant: 'Restaurant',
  fast_food: 'Fast food',
  cafe: 'Cafe',
  bar: 'Bar',
  pub: 'Pub',
  supermarket: 'Supermarket',
  convenience: 'Convenience store',
  pharmacy: 'Pharmacy',
  chemist: 'Pharmacy',
  hotel: 'Hotel',
  parking: 'Parking',
  cinema: 'Cinema',
  bakery: 'Bakery',
  clothes: 'Clothing',
  department_store: 'Department store',
  mall: 'Shopping mall',
  ice_cream: 'Ice cream',
  car_wash: 'Car wash',
  charging_station: 'EV charging',
  hairdresser: 'Hairdresser',
  doctors: 'Doctor',
  dentist: 'Dentist',
  hospital: 'Hospital',
  museum: 'Museum',
  attraction: 'Attraction',
  fitness_centre: 'Gym',
};

/** Places with no money changing hands, or that are rarely what you mean. */
const SKIP = new Set(['bench', 'waste_basket', 'parking_space', 'bicycle_parking', 'toilets', 'drinking_water', 'post_box', 'vending_machine', 'shelter', 'telephone', 'recycling', 'atm']);

/** The query: named places within `radius` metres of the pin. */
export function overpassQuery(lat: number, lng: number, radius: number): string {
  const around = `(around:${radius},${lat},${lng})`;
  return `[out:json][timeout:10];(${KEYS.map((k) => `nwr${around}["name"]["${k}"];`).join('')});out center tags 60;`;
}

/** Straight-line distance in metres. */
export function distanceMetres(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * 6_371_000 * Math.asin(Math.sqrt(h)));
}

const humanize = (v: string) => (v.charAt(0).toUpperCase() + v.slice(1)).replace(/_/g, ' ');

interface OverpassElement {
  type: string;
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string | undefined>;
}

/** Overpass's answer → the places, nearest first, one per name and spot. */
export function parsePlaces(json: { elements?: OverpassElement[] }, origin: { lat: number; lng: number }, limit = 15): NearbyPlace[] {
  const places: NearbyPlace[] = [];
  const seen = new Set<string>();
  for (const el of json.elements ?? []) {
    const tags = el.tags ?? {};
    const lat = el.lat ?? el.center?.lat;
    const lng = el.lon ?? el.center?.lon;
    const name = tags.name?.trim();
    if (!name || lat === undefined || lng === undefined) continue;
    const key = KEYS.find((k) => tags[k]);
    const value = (key && tags[key]) || '';
    if (SKIP.has(value)) continue;
    const distance = distanceMetres(origin, { lat, lng });
    // A shop mapped as both a point and a building: keep one.
    const dedupe = `${name.toLowerCase()}@${Math.round(distance / 25)}`;
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);
    const street = [tags['addr:housenumber'], tags['addr:street']].filter(Boolean).join(' ');
    places.push({
      id: `${el.type}/${el.id}`,
      name,
      kind: KIND_LABELS[value] ?? humanize(value || 'Place'),
      address: street || undefined,
      lat: Math.round(lat * 1e5) / 1e5,
      lng: Math.round(lng * 1e5) / 1e5,
      distance,
    });
  }
  return places.sort((a, b) => a.distance - b.distance).slice(0, limit);
}

/**
 * Places around the pin. Looks close first (wider when the phone wasn't sure
 * where it was), then further out if there's nothing. Rejects with a message
 * to show.
 */
export async function nearbyPlaces(loc: ExpenseLocation, signal?: AbortSignal): Promise<NearbyPlace[]> {
  const near = Math.min(Math.max(loc.accuracy ?? 0, 100), 300);
  for (const radius of [near, 600]) {
    const places = parsePlaces(await query(overpassQuery(loc.lat, loc.lng, radius), signal), loc);
    if (places.length) return places;
  }
  return [];
}

async function query(data: string, signal?: AbortSignal): Promise<{ elements?: OverpassElement[] }> {
  let lastError: unknown;
  for (const server of SERVERS) {
    try {
      const res = await fetch(server, {
        method: 'POST',
        body: new URLSearchParams({ data }),
        signal: signal ?? AbortSignal.timeout(15_000),
      });
      // Busy or rate-limited: try the next server.
      if (res.status === 429 || res.status >= 500) {
        lastError = new Error(`busy (${res.status})`);
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      if ((e as Error).name === 'AbortError' && signal?.aborted) throw e;
      lastError = e;
    }
  }
  throw new Error(
    typeof navigator !== 'undefined' && navigator.onLine === false
      ? 'You’re offline. Nearby places need a connection.'
      : `OpenStreetMap didn’t answer${lastError instanceof Error && lastError.message.startsWith('busy') ? ' (it’s busy)' : ''}. Try again in a moment.`,
  );
}

/** "40 m", "1.2 km" */
export const formatDistance = (m: number) => (m < 1000 ? `${m} m` : `${(m / 1000).toFixed(1)} km`);
