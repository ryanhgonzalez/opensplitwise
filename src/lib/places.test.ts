import { describe, it, expect } from 'vitest';
import { distanceMetres, formatDistance, overpassQuery, parsePlaces } from './places';

const here = { lat: 40.71283, lng: -74.00602 };
// About 11 m per 0.0001° of latitude.
const north = (m: number) => here.lat + m / 111_195;

describe('parsePlaces', () => {
  const answer = {
    elements: [
      { type: 'node', id: 1, lat: north(80), lon: here.lng, tags: { name: 'Starbucks', amenity: 'cafe' } },
      { type: 'way', id: 2, center: { lat: north(30), lon: here.lng }, tags: { name: 'Shell', amenity: 'fuel', 'addr:housenumber': '1200', 'addr:street': 'Main St' } },
      { type: 'node', id: 3, lat: north(31), lon: here.lng, tags: { name: 'Shell', shop: 'convenience' } }, // the same station, mapped twice
      { type: 'node', id: 4, lat: north(10), lon: here.lng, tags: { name: 'Park bench', amenity: 'bench' } },
      { type: 'node', id: 5, lat: north(20), lon: here.lng, tags: { amenity: 'restaurant' } }, // no name
      { type: 'node', id: 6, lat: north(50), lon: here.lng, tags: { name: 'Bob’s Bikes', shop: 'bicycle' } },
    ],
  };

  it('lists named places nearest first, in plain words, once each', () => {
    const places = parsePlaces(answer, here);
    expect(places.map((p) => [p.name, p.kind, p.distance])).toEqual([
      ['Shell', 'Gas station', 30],
      ['Bob’s Bikes', 'Bicycle', 50],
      ['Starbucks', 'Cafe', 80],
    ]);
    expect(places[0]).toMatchObject({ id: 'way/2', address: '1200 Main St' });
  });

  it('is empty when nothing is there', () => {
    expect(parsePlaces({}, here)).toEqual([]);
  });
});

describe('places helpers', () => {
  it('asks for named places of each kind around the pin', () => {
    const q = overpassQuery(40.7, -74, 150);
    expect(q).toContain('nwr(around:150,40.7,-74)["name"]["amenity"];');
    expect(q).toContain('["shop"]');
    expect(q).toMatch(/^\[out:json\]/);
  });

  it('measures and shows distance', () => {
    expect(distanceMetres(here, { lat: north(100), lng: here.lng })).toBe(100);
    expect(formatDistance(40)).toBe('40 m');
    expect(formatDistance(1234)).toBe('1.2 km');
  });
});
