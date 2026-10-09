import { describe, it, expect, beforeAll } from 'vitest';

// analytics.js pulls in state.js/i18n.js (localStorage/navigator at module
// load) — same minimal stub other analytics test files use (see
// world-map-antimeridian.test.js, world-map-theme-colors.test.js).
let homeCountryFromLocale: (typeof import('../public-src/views/analytics.js'))['homeCountryFromLocale'];
let featureLabelPoint: (typeof import('../public-src/views/analytics.js'))['featureLabelPoint'];
let greatCircleKm: (typeof import('../public-src/views/analytics.js'))['greatCircleKm'];
let computeMapBoundingCoords: (typeof import('../public-src/views/analytics.js'))['computeMapBoundingCoords'];
let originsNeedingMarkers: (typeof import('../public-src/views/analytics.js'))['originsNeedingMarkers'];

beforeAll(async () => {
  Object.defineProperty(globalThis, 'localStorage', {
    value: { getItem: () => null, setItem: () => {} },
    configurable: true, writable: true,
  });
  Object.defineProperty(globalThis, 'navigator', {
    value: { language: 'en' },
    configurable: true, writable: true,
  });
  const mod = await import('../public-src/views/analytics.js');
  homeCountryFromLocale = mod.homeCountryFromLocale;
  featureLabelPoint = mod.featureLabelPoint;
  greatCircleKm = mod.greatCircleKm;
  computeMapBoundingCoords = mod.computeMapBoundingCoords;
  originsNeedingMarkers = mod.originsNeedingMarkers;
});

describe('homeCountryFromLocale (#1467)', () => {
  it('resolves a full locale tag', () => {
    expect(homeCountryFromLocale('de-DE')).toBe('DE');
  });

  it('maximizes a bare language tag to its likely region', () => {
    expect(homeCountryFromLocale('de')).toBe('DE');
    expect(homeCountryFromLocale('nl')).toBe('NL');
  });

  it('resolves a non-German locale too', () => {
    expect(homeCountryFromLocale('en-US')).toBe('US');
  });

  it('returns null for an empty or missing tag', () => {
    expect(homeCountryFromLocale('')).toBeNull();
    expect(homeCountryFromLocale(undefined)).toBeNull();
  });

  it('returns null when no region can be inferred', () => {
    expect(homeCountryFromLocale('xx')).toBeNull();
  });
});

describe('featureLabelPoint (#1467)', () => {
  it('returns the bounding-box centre of a simple polygon', () => {
    const square = [[[0, 0], [0, 2], [2, 2], [2, 0], [0, 0]]];
    expect(featureLabelPoint({ type: 'Polygon', coordinates: square })).toEqual([1, 1]);
  });

  it('picks the largest part of a multipolygon, not its smaller territories', () => {
    const small = [[[0, 0], [0, 1], [1, 1], [1, 0], [0, 0]]];
    const large = [[[10, 10], [10, 14], [14, 14], [14, 10], [10, 10]]];
    expect(featureLabelPoint({ type: 'MultiPolygon', coordinates: [small, large] })).toEqual([12, 12]);
  });

  it('returns null without usable coordinates', () => {
    expect(featureLabelPoint(null)).toBeNull();
    expect(featureLabelPoint({ type: 'Polygon', coordinates: [] })).toBeNull();
  });
});

describe('greatCircleKm (#1467)', () => {
  it('is zero for the same point', () => {
    expect(greatCircleKm([13.405, 52.52], [13.405, 52.52])).toBe(0);
  });

  // Berlin (52.52 N, 13.405 E) to Addis Ababa (9.02 N, 38.75 E) is ~5,351 km
  // along a great circle — the plan's "roughly 5,000 km", rounded.
  it('measures Berlin to Addis Ababa at about 5,350 km', () => {
    const d = greatCircleKm([13.405, 52.52], [38.7525, 9.0192]);
    expect(d).toBeGreaterThan(5250);
    expect(d).toBeLessThan(5450);
  });
});

describe('computeMapBoundingCoords (#1467)', () => {
  it('frames a single origin with a symmetric minimum span', () => {
    expect(computeMapBoundingCoords([[0, 0]])).toEqual([[-15, 10], [15, -10]]);
  });

  it('frames two far-apart origins without falling back to the whole globe', () => {
    // Central America and Ethiopia: wide in longitude, but the box stays tight
    // in latitude (widened only to the 20 degree minimum).
    expect(computeMapBoundingCoords([[-90, 15], [40, 9]])).toEqual([[-98, 22], [48, 2]]);
  });

  it('clamps the box to valid longitude and latitude', () => {
    expect(computeMapBoundingCoords([[175, 0]])).toEqual([[160, 10], [180, -10]]);
  });

  it('returns undefined when there are no usable coordinates', () => {
    expect(computeMapBoundingCoords(null)).toBeUndefined();
    expect(computeMapBoundingCoords([[NaN, 5], null])).toBeUndefined();
  });
});

// #1543: an origin that only appears as a blend's secondary country has a chip
// but no bean scatter point of its own, so it drew nothing on the map. These
// are the codes that need an extra marker; the acceptance report named India.
describe('originsNeedingMarkers (#1543)', () => {
  it('adds a secondary origin that has shots but no bean point of its own', () => {
    expect(originsNeedingMarkers(['BR', 'ET'], ['BR', 'ET', 'IN'])).toEqual(['IN']);
  });

  it('adds nothing when every origin already has a bean point', () => {
    expect(originsNeedingMarkers(['BR', 'ET', 'IN'], ['BR', 'ET', 'IN'])).toEqual([]);
  });

  it('emits a repeated code only once', () => {
    expect(originsNeedingMarkers([], ['IN', 'IN'])).toEqual(['IN']);
  });

  it('frames the added origin inside the initial view', () => {
    // The home point (Berlin) plus a bean in Ethiopia; India is the origin the
    // frame would otherwise be missing on screen.
    const centroids: Record<string, [number, number]> = { IN: [78.96, 20.59] };
    const added = originsNeedingMarkers(['ET'], ['ET', 'IN']).map(code => centroids[code]);
    const box = computeMapBoundingCoords([[40.49, 9.15], ...added, [13.405, 52.52]]);
    expect(box).toBeDefined();
    const [[west, north], [east, south]] = box!;
    expect(78.96).toBeGreaterThanOrEqual(west);
    expect(78.96).toBeLessThanOrEqual(east);
    expect(20.59).toBeGreaterThanOrEqual(south);
    expect(20.59).toBeLessThanOrEqual(north);
  });
});
