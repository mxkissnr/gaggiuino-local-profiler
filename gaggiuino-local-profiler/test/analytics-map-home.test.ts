import { describe, it, expect, beforeAll } from 'vitest';

// analytics.js pulls in state.js/i18n.js (localStorage/navigator at module
// load) — same minimal stub other analytics test files use (see
// world-map-antimeridian.test.js, world-map-theme-colors.test.js).
let homeCountryFromLocale: (typeof import('../public-src/views/analytics.js'))['homeCountryFromLocale'];
let featureLabelPoint: (typeof import('../public-src/views/analytics.js'))['featureLabelPoint'];
let greatCircleKm: (typeof import('../public-src/views/analytics.js'))['greatCircleKm'];
let computeMapBoundingCoords: (typeof import('../public-src/views/analytics.js'))['computeMapBoundingCoords'];
let originFrameCoords: (typeof import('../public-src/views/analytics.js'))['originFrameCoords'];
let featureBounds: (typeof import('../public-src/views/analytics.js'))['featureBounds'];

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
  originFrameCoords = mod.originFrameCoords;
  featureBounds = mod.featureBounds;
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

// #1543: the frame must cover each origin country's full extent, not just its
// centroid, or a country wider than the padding (India) is cut off at the edge.
describe('originFrameCoords / featureBounds (#1543)', () => {
  it('emits both diagonal corners of an origin country, not just its centre', () => {
    const india: [number, number, number, number] = [68.1, 8.0, 97.4, 35.5];
    const coords = originFrameCoords(['IN'], new Map([['IN', india]]));
    expect(coords).toEqual([[68.1, 8.0], [97.4, 35.5]]);
  });

  it('keeps India fully inside the computed frame (before: only its centre)', () => {
    const india: [number, number, number, number] = [68.1, 8.0, 97.4, 35.5];
    const box = computeMapBoundingCoords(originFrameCoords(['IN'], new Map([['IN', india]])))!;
    expect(box).toBeDefined();
    const [[west, north], [east, south]] = box;
    // India's whole extent, not only its centre [78.96, 20.59], is inside.
    expect(west).toBeLessThanOrEqual(68.1);
    expect(east).toBeGreaterThanOrEqual(97.4);
    expect(south).toBeLessThanOrEqual(8.0);
    expect(north).toBeGreaterThanOrEqual(35.5);
  });

  it('skips a country whose bounds are unknown', () => {
    expect(originFrameCoords(['IN', 'ZZ'], new Map([['IN', [68.1, 8.0, 97.4, 35.5]]])))
      .toEqual([[68.1, 8.0], [97.4, 35.5]]);
  });

  it('featureBounds spans a MultiPolygon and tolerates an empty geometry', () => {
    type GeometryArg = Parameters<typeof featureBounds>[0];
    const emptyPolygon = { type: 'Polygon', coordinates: [] } as unknown as GeometryArg;
    const multi = {
      type: 'MultiPolygon',
      coordinates: [
        [[[0, 0], [2, 0], [2, 2], [0, 2], [0, 0]]],
        [[[10, 10], [14, 10], [14, 12], [10, 12], [10, 10]]],
      ],
    } as unknown as GeometryArg;
    expect(featureBounds(null)).toBeNull();
    expect(featureBounds(emptyPolygon)).toBeNull();
    expect(featureBounds(multi)).toEqual([0, 0, 14, 12]);
  });
});
