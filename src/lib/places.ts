// ─────────────────────────────────────────────────────────────────────────────
// Naming where an expense was paid: the places near a saved location.
//
// The one time the app sends anything to an outside service on its own: only
// when "Name this place" is tapped, it asks for the named shops, restaurants
// and the like around the pin. That request carries the location (and, like
// any request, the internet address); nothing else.
//
// Photon (komoot's search over OpenStreetMap data) answers first: it's quick
// and allows requests from web pages. The public Overpass servers are the
// fallback; they're often too busy to answer.
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

const PHOTON = 'https://photon.komoot.io/reverse';
const OVERPASS = 'https://overpass-api.de/api/interpreter';

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
  books: 'Bookstore',
  hardware: 'Hardware store',
  electronics: 'Electronics',
  car_repair: 'Car repair',
  laundry: 'Laundry',
  dry_cleaning: 'Dry cleaner',
  motel: 'Motel',
  hostel: 'Hostel',
};

/** Places with no money changing hands, or that are rarely what you mean. */
const SKIP = new Set([
  // Outdoors, landmarks and public offices: named, but not where you pay.
  'park', 'garden', 'playground', 'pitch', 'track', 'common', 'nature_reserve', 'dog_park', 'picnic_site',
  'artwork', 'memorial', 'viewpoint', 'information', 'government', 'townhall', 'courthouse', 'grave_yard',
  'place_of_worship', 'police', 'fire_station', 'post_box', 'clock',
  'fountain', 'bicycle_rental', 'bench', 'waste_basket', 'parking_space', 'bicycle_parking', 'toilets', 'drinking_water', 'post_box', 'vending_machine', 'shelter', 'telephone', 'recycling', 'atm']);

/** Straight-line distance in metres. */
export function distanceMetres(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * 6_371_000 * Math.asin(Math.sqrt(h)));
}

const humanize = (v: string) => (v.charAt(0).toUpperCase() + v.slice(1)).replace(/_/g, ' ');

/** One place from any source, or nothing when it isn't one worth listing. */
function toPlace(
  id: string,
  tags: { name?: string; key?: string; value?: string; housenumber?: string; street?: string },
  lat: number,
  lng: number,
  origin: { lat: number; lng: number },
): NearbyPlace | null {
  const name = tags.name?.trim();
  if (!name || !tags.key || !KEYS.includes(tags.key) || SKIP.has(tags.value ?? '')) return null;
  const street = [tags.housenumber, tags.street].filter(Boolean).join(' ');
  return {
    id,
    name,
    kind: KIND_LABELS[tags.value ?? ''] ?? humanize(tags.value || 'Place'),
    address: street || undefined,
    lat: Math.round(lat * 1e5) / 1e5,
    lng: Math.round(lng * 1e5) / 1e5,
    distance: distanceMetres(origin, { lat, lng }),
  };
}

/** Nearest first, one per name and spot (a shop mapped as a point and a building). */
function tidy(places: (NearbyPlace | null)[], limit: number): NearbyPlace[] {
  const seen = new Set<string>();
  return places
    .filter((p): p is NearbyPlace => !!p)
    .sort((a, b) => a.distance - b.distance)
    .filter((p) => {
      const key = `${p.name.toLowerCase()}@${Math.round(p.distance / 25)}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, limit);
}

// ── Photon ───────────────────────────────────────────────────────────────────

interface PhotonFeature {
  geometry?: { coordinates?: [number, number] };
  properties?: { osm_type?: string; osm_id?: number; osm_key?: string; osm_value?: string; name?: string; housenumber?: string; street?: string };
}

export function photonUrl(lat: number, lng: number, radiusKm: number): string {
  const q = new URLSearchParams({ lat: String(lat), lon: String(lng), radius: String(radiusKm), limit: '30', lang: 'en' });
  for (const k of KEYS) q.append('osm_tag', k);
  return `${PHOTON}?${q}`;
}

export function parsePhoton(json: { features?: PhotonFeature[] }, origin: { lat: number; lng: number }, limit = 15): NearbyPlace[] {
  return tidy(
    (json.features ?? []).map((f) => {
      const [lng, lat] = f.geometry?.coordinates ?? [];
      const p = f.properties ?? {};
      if (lat === undefined || lng === undefined) return null;
      return toPlace(`${p.osm_type}/${p.osm_id}`, { name: p.name, key: p.osm_key, value: p.osm_value, housenumber: p.housenumber, street: p.street }, lat, lng, origin);
    }),
    limit,
  );
}

// ── Overpass ─────────────────────────────────────────────────────────────────

interface OverpassElement {
  type: string;
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string | undefined>;
}

/** The query: named places within `radius` metres of the pin. */
export function overpassQuery(lat: number, lng: number, radius: number): string {
  const around = `(around:${radius},${lat},${lng})`;
  return `[out:json][timeout:8];(${KEYS.map((k) => `nwr${around}["name"]["${k}"];`).join('')});out center tags 60;`;
}

export function parsePlaces(json: { elements?: OverpassElement[] }, origin: { lat: number; lng: number }, limit = 15): NearbyPlace[] {
  return tidy(
    (json.elements ?? []).map((el) => {
      const tags = el.tags ?? {};
      const lat = el.lat ?? el.center?.lat;
      const lng = el.lon ?? el.center?.lon;
      if (lat === undefined || lng === undefined) return null;
      const key = KEYS.find((k) => tags[k]);
      return toPlace(`${el.type}/${el.id}`, { name: tags.name, key, value: key && tags[key], housenumber: tags['addr:housenumber'], street: tags['addr:street'] }, lat, lng, origin);
    }),
    limit,
  );
}

// ── Looking up ───────────────────────────────────────────────────────────────

async function getJson<T>(url: string, init: RequestInit, ms: number): Promise<T> {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(ms) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json() as Promise<T>;
}

/**
 * Places around the pin, nearest first. Looks close first (wider when the
 * phone wasn't sure where it was), then further out if there's nothing.
 * Rejects with a message to show.
 */
export async function nearbyPlaces(loc: ExpenseLocation): Promise<NearbyPlace[]> {
  const near = Math.min(Math.max(loc.accuracy ?? 0, 150), 400);
  try {
    for (const radius of [near, 1000]) {
      const places = parsePhoton(await getJson(photonUrl(loc.lat, loc.lng, radius / 1000), {}, 10_000), loc);
      if (places.length) return places;
    }
    return [];
  } catch {
    // Photon is down or unreachable: one try on Overpass.
  }
  try {
    const body = new URLSearchParams({ data: overpassQuery(loc.lat, loc.lng, near) });
    return parsePlaces(await getJson(OVERPASS, { method: 'POST', body }, 10_000), loc);
  } catch {
    throw new Error(
      typeof navigator !== 'undefined' && navigator.onLine === false
        ? 'You’re offline. Nearby places need a connection.'
        : 'Couldn’t reach OpenStreetMap. Try again in a moment.',
    );
  }
}

/** "40 m", "1.2 km" */
export const formatDistance = (m: number) => (m < 1000 ? `${m} m` : `${(m / 1000).toFixed(1)} km`);
