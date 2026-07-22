import { describe, it, expect } from 'vitest';

// score.js uses module.exports — import via createRequire
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { calcShotScore, calcShotScoreDetail } = require('../lib/score');

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

// #450: bean's own brewTempC/brewRatio recommendation becomes the scoring
// target instead of the generic fixed bands, when set — but must never
// change scoring for a shot whose bean has neither field.
describe('calcShotScore — bean-aware target (#450)', () => {
    // 30 points, steady 8.5 bar (in-band), temp fixed at 90.5°C (in the
    // generic 90-96°C band -> acc=100 pre-#450), weight ramping to 39.6g on
    // an 18g dose (r=2.2, in the generic 1.8-2.5 band -> also 100 pre-#450).
    const N = 30;
    const shot = {
        datapoints: {
            pressure:          new Array(N).fill(85),
            temperature:       new Array(N).fill(905),
            targetTemperature: new Array(N).fill(0), // none recorded -> falls through to band/bean target
            timeInShot:        Array.from({ length: N }, (_, i) => i * 10),
            shotWeight:        Array.from({ length: N }, (_, i) => Math.round((i / (N - 1)) * 396)),
        },
        duration: 300, // 30s -> in the 25-35s "100" band
        annotation: { coffee: 'Test Bean', dose: 18 },
    };

    it('is unaffected when bean is absent or has no brewTempC/brewRatio (regression safety)', () => {
        const baseline = calcShotScore(shot);
        expect(calcShotScore(shot, null)).toBe(baseline);
        expect(calcShotScore(shot, {})).toBe(baseline);
        expect(calcShotScore(shot, { name: 'Test Bean' })).toBe(baseline);
    });

    it('scores temperature against bean.brewTempC instead of the generic band when set', () => {
        const baseline = calcShotScore(shot); // avgT=90.5°C, in-band -> full marks pre-#450
        const withBeanTarget = calcShotScore(shot, { brewTempC: 93 }); // 2.5°C off the bean's own target
        expect(withBeanTarget).toBeLessThan(baseline);
    });

    it('scores dose:yield ratio against bean.brewRatio instead of the generic band when set', () => {
        const baseline = calcShotScore(shot); // r=2.2, in-band -> full marks pre-#450
        const withBeanTarget = calcShotScore(shot, { brewRatio: '1:1.8' }); // 0.4 off the bean's own target
        expect(withBeanTarget).toBeLessThan(baseline);
    });

    it('ignores an unparsable brewRatio string rather than throwing', () => {
        expect(() => calcShotScore(shot, { brewRatio: 'whatever the roaster wrote' })).not.toThrow();
        expect(calcShotScore(shot, { brewRatio: 'whatever the roaster wrote' })).toBe(calcShotScore(shot));
    });
});

// #457: calcShotScoreDetail surfaces whether the bean's own target was
// actually used, for the verdict header's "scored against this bean's
// target" hint. calcShotScore stays the thin score-only wrapper.
describe('calcShotScoreDetail — usedBeanTarget flag (#457)', () => {
    const N = 30;
    const baseShot = {
        datapoints: {
            pressure:          new Array(N).fill(85),
            temperature:       new Array(N).fill(905),
            targetTemperature: new Array(N).fill(0), // none recorded
            timeInShot:        Array.from({ length: N }, (_, i) => i * 10),
            shotWeight:        Array.from({ length: N }, (_, i) => Math.round((i / (N - 1)) * 396)),
        },
        duration: 300,
        annotation: { coffee: 'Test Bean', dose: 18 },
    };
    // Same shot, but WITH its own recorded target-temperature curve — this
    // must stay the highest-priority temperature source, unaffected by a
    // bean recommendation being present too.
    const shotWithOwnCurve = {
        ...baseShot,
        datapoints: { ...baseShot.datapoints, targetTemperature: new Array(N).fill(905) },
    };

    it('is false when neither the shot nor the bean has a target (generic band used)', () => {
        expect(calcShotScoreDetail(baseShot, null).usedBeanTarget).toBe(false);
        expect(calcShotScoreDetail(baseShot, {}).usedBeanTarget).toBe(false);
    });

    it('is true when the bean\'s brewTempC was actually used for the temperature factor', () => {
        expect(calcShotScoreDetail(baseShot, { brewTempC: 93 }).usedBeanTarget).toBe(true);
    });

    it('is true when the bean\'s brewRatio was actually used for the ratio factor', () => {
        expect(calcShotScoreDetail(baseShot, { brewRatio: '1:1.8' }).usedBeanTarget).toBe(true);
    });

    it('is false when the shot has its own target-temperature curve, even if the bean has brewTempC (shot curve wins)', () => {
        expect(calcShotScoreDetail(shotWithOwnCurve, { brewTempC: 93 }).usedBeanTarget).toBe(false);
    });

    it('is false for a shot that scores null', () => {
        expect(calcShotScoreDetail({ datapoints: [] }, { brewTempC: 93 })).toEqual({ score: null, usedBeanTarget: false });
        expect(calcShotScoreDetail(null, { brewTempC: 93 })).toEqual({ score: null, usedBeanTarget: false });
    });

    it('calcShotScore stays a thin wrapper returning exactly calcShotScoreDetail(...).score', () => {
        expect(calcShotScore(baseShot, { brewTempC: 93 })).toBe(calcShotScoreDetail(baseShot, { brewTempC: 93 }).score);
        expect(calcShotScore(baseShot, null)).toBe(calcShotScoreDetail(baseShot, null).score);
    });
});
