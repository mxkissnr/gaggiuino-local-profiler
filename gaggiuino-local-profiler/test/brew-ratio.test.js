import { describe, it, expect } from 'vitest';
import { calcBrewRatio } from '../public-src/utils.js';

const shotWith = (dose) => ({ annotation: { dose } });
const dataWith = (finalWeight) => ({ weight: finalWeight == null ? [] : [{ x: 1, y: 10 }, { x: 25, y: finalWeight }] });

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
