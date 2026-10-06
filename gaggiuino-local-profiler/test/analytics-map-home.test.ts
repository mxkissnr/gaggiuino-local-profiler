import { describe, it, expect, beforeAll } from 'vitest';

// analytics.js pulls in state.js/i18n.js (localStorage/navigator at module
// load) — same minimal stub other analytics test files use (see
// world-map-antimeridian.test.js, world-map-theme-colors.test.js).
let homeCountryFromLocale: (typeof import('../public-src/views/analytics.js'))['homeCountryFromLocale'];
let featureLabelPoint: (typeof import('../public-src/views/analytics.js'))['featureLabelPoint'];
let greatCircleKm: (typeof import('../public-src/views/analytics.js'))['greatCircleKm'];

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
