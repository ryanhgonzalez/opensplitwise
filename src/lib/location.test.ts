import { describe, it, expect } from 'vitest';
import { formatAccuracy, formatCoords, mapsUrl } from './location';

const shell = { lat: 40.71283, lng: -74.00602, accuracy: 12 };

describe('location', () => {
  it('shows coordinates and how close they are', () => {
    expect(formatCoords({ lat: 40.7, lng: -74 })).toBe('40.70000, -74.00000');
    expect(formatAccuracy(12)).toBe('within 12 m');
    expect(formatAccuracy(1500)).toBe('within 1.5 km');
    expect(formatAccuracy(undefined)).toBe('');
  });

  it('opens Apple Maps on Apple devices and Google Maps elsewhere', () => {
    const iphone = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)';
    const android = 'Mozilla/5.0 (Linux; Android 15; Pixel 9)';
    expect(mapsUrl(shell, 'Gas fill-up', iphone)).toBe('https://maps.apple.com/?ll=40.71283,-74.00602&q=Gas%20fill-up');
    expect(mapsUrl(shell, 'Gas fill-up', android)).toBe('https://www.google.com/maps/search/?api=1&query=40.71283,-74.00602');
  });
});
