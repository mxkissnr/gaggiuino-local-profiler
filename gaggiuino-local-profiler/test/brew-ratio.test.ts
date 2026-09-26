import { describe, it, expect } from 'vitest';
import { calcBrewRatio } from '../public-src/utils.js';

// calcBrewRatio's parameter still declares dose as string|null, but shot
// annotations carry numeric doses (api/types.ts) and the runtime parseFloats
// either — bridge the fixture to that older signature once here.
type BrewShot = NonNullable<Parameters<typeof calcBrewRatio>[0]>;
const shotWith = (dose: string | number | null | undefined): BrewShot => ({ annotation: { dose } } as BrewShot);
const dataWith = (finalWeight: number | null | undefined) => ({ weight: finalWeight == null ? [] : [{ x: 1, y: 10 }, { x: 25, y: finalWeight }] });

describe('calcBrewRatio', () => {
    it('computes final weight / dose', () => {
        expect(calcBrewRatio(shotWith('18'), dataWith(36))).toBeCloseTo(2.0);
        expect(calcBrewRatio(shotWith(20), dataWith(50))).toBeCloseTo(2.5);
    });

    it('returns null without dose or weight data', () => {
        expect(calcBrewRatio(shotWith(undefined), dataWith(36))).toBeNull();
        expect(calcBrewRatio(shotWith('18'), dataWith(null))).toBeNull();
        expect(calcBrewRatio({}, dataWith(36))).toBeNull();
    });

    it('rejects implausible doses and ratios', () => {
        expect(calcBrewRatio(shotWith('2'), dataWith(36))).toBeNull();   // dose too small
        expect(calcBrewRatio(shotWith('80'), dataWith(36))).toBeNull();  // dose too large
        expect(calcBrewRatio(shotWith('18'), dataWith(200))).toBeNull(); // ratio > 6
    });
});
