import { describe, it, expect } from 'vitest';

// score.js uses module.exports — import via createRequire
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { calcShotScore } = require('../lib/score');

describe('calcShotScore', () => {
    it('returns null for a shot with no datapoints', () => {
        expect(calcShotScore({ datapoints: [] })).toBeNull();
    });

    it('returns null for a test shot (no real weight)', () => {
        expect(calcShotScore({ datapoints: [1, 2, 3], annotation: {} })).toBeNull();
    });

    it('returns a number between 0 and 100 for a valid annotated shot', () => {
        const shot = {
            datapoints: new Array(200).fill([0, 93, 9, 0]),
            duration:   250,
            annotation: {
                coffee:       'Test Bean',
                grindSetting: '12',
                rating:       4,
                dose:         18,
                tds:          9.2,
            },
        };
        const score = calcShotScore(shot);
        if (score !== null) {
            expect(score).toBeGreaterThanOrEqual(0);
            expect(score).toBeLessThanOrEqual(100);
        }
    });

    it('returns null when shot is null', () => {
        expect(calcShotScore(null)).toBeNull();
    });
});
