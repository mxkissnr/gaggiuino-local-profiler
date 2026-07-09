import { describe, it, expect, beforeAll } from 'vitest';

// analytics.js pulls in state.js (localStorage/navigator at module load)
// and i18n.js — neither is available in the plain Node test environment, so
// stub the minimum before importing, same approach as
// best-grind-combo.test.js / share-or-download.test.js.
let splitAntimeridianRing;

beforeAll(async () => {
  Object.defineProperty(globalThis, 'localStorage', {
    value: { getItem: () => null, setItem: () => {} },
    configurable: true, writable: true,
  });
  Object.defineProperty(globalThis, 'navigator', {
    value: { language: 'en' },
    configurable: true, writable: true,
  });
  ({ splitAntimeridianRing } = await import('../public-src/views/analytics.js'));
});

describe('splitAntimeridianRing', () => {
    it('passes a normal ring through unchanged', () => {
        const ring = [[10, 50], [12, 51], [12, 48], [10, 50]];
        const result = splitAntimeridianRing(ring);
        expect(result).toHaveLength(1);
        expect(result[0]).toEqual(ring);
    });

    it('splits a ring that jumps across the antimeridian into two rings, each within ±180°', () => {
        // Mimics the Russia Arctic archipelago ring: wraps from ~178.7E to ~-180/178.9W
        const ring = [
            [170, 71], [178.7, 71.6], [-179.9, 71.2], [-170, 70.8], [170, 71],
        ];
        const result = splitAntimeridianRing(ring);
        expect(result.length).toBeGreaterThan(1);
        for (const piece of result) {
            for (const [lon] of piece) {
                expect(Math.abs(lon)).toBeLessThanOrEqual(180);
            }
            // no consecutive points within a single piece should still jump >180°
            for (let i = 1; i < piece.length; i++) {
                expect(Math.abs(piece[i][0] - piece[i - 1][0])).toBeLessThanOrEqual(180);
            }
            // each resulting piece must be a closed ring
            expect(piece[0]).toEqual(piece[piece.length - 1]);
        }
    });

    it('splits a Fiji-like ring wrapping the full 360° span', () => {
        const ring = [
            [178.0, -17.0], [179.9, -16.5], [-179.8, -16.8], [-178.5, -17.0], [178.0, -17.0],
        ];
        const result = splitAntimeridianRing(ring);
        expect(result.length).toBeGreaterThan(1);
        for (const piece of result) {
            for (let i = 1; i < piece.length; i++) {
                expect(Math.abs(piece[i][0] - piece[i - 1][0])).toBeLessThanOrEqual(180);
            }
        }
    });

    it('returns the input unchanged for short/degenerate rings', () => {
        expect(splitAntimeridianRing([])).toEqual([[]]);
        expect(splitAntimeridianRing([[0, 0]])).toEqual([[[0, 0]]]);
    });

    it('routes a circumpolar ring\'s closing edge through the pole instead of straight across the map', () => {
        // Mimics Antarctica's 110m outline: a single ring that sweeps through
        // every longitude and is encoded starting/ending exactly at the
        // antimeridian, so the only ">180 jump" is its own closing edge
        // (last point deep-equal to the first) rather than an interior
        // crossing between two separate landmasses (unlike Russia/Fiji).
        const ring = [
            [-180, -84.7], [-100, -75], [0, -70], [100, -75], [180, -84.7], [-180, -84.7],
        ];
        const result = splitAntimeridianRing(ring);
        expect(result).toHaveLength(1);
        const piece = result[0];
        // The pole-hug detour has one intentional ±180 edge at the pole
        // itself (geographically a single point, rendered right at the map's
        // border) — that's fine. Any *other* consecutive pair must not jump
        // the seam, or the line would cut across the visible map body.
        for (let i = 1; i < piece.length; i++) {
            const jump = Math.abs(piece[i][0] - piece[i - 1][0]);
            if (jump > 180) {
                expect(Math.abs(piece[i][1])).toBe(90);
                expect(Math.abs(piece[i - 1][1])).toBe(90);
            }
        }
        // Still closed.
        expect(piece[0]).toEqual(piece[piece.length - 1]);
        // The detour actually dips toward the pole rather than just
        // re-appending the ±180 duplicate directly.
        expect(piece.some(([, lat]) => lat <= -89)).toBe(true);
    });

    it('closes each piece of a ring with multiple antimeridian crossings independently, not with a direct chord', () => {
        // A ring crossing the seam twice (out and back in) must not close a
        // piece by jumping straight from its end back to its own start when
        // those sit on opposite ±180 sides.
        const ring = [
            [170, 60], [179, 61], [-179, 62], [-170, 63], [-179, 64], [179, 65], [170, 60],
        ];
        const result = splitAntimeridianRing(ring);
        for (const piece of result) {
            for (let i = 1; i < piece.length; i++) {
                expect(Math.abs(piece[i][0] - piece[i - 1][0])).toBeLessThanOrEqual(180);
            }
        }
    });
});
