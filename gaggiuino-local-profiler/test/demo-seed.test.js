import { describe, it, expect } from 'vitest';

// demo-seed.js uses module.exports — import via createRequire
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { buildDemoDataset, DEMO_ID_BASE } = require('../lib/demo-seed');

describe('buildDemoDataset', () => {
    const { shots, beans, recipes } = buildDemoDataset();

    it('produces 8-12 shots with plausible curves and no duplicate IDs', () => {
        expect(shots.length).toBeGreaterThanOrEqual(8);
        expect(shots.length).toBeLessThanOrEqual(12);
        const ids = new Set(shots.map(s => s.id));
        expect(ids.size).toBe(shots.length);
        for (const shot of shots) {
            expect(shot.id).toBeGreaterThan(DEMO_ID_BASE);
            expect(Number.isInteger(shot.timestamp)).toBe(true); // Unix seconds
            expect(shot.duration).toBeGreaterThan(0);            // tenths of a second
            expect(shot.datapoints.pressure.length).toBeGreaterThan(0);
            expect(shot.datapoints.pressure.length).toBe(shot.datapoints.temperature.length);
        }
    });

    it('annotates shots with a bean name, dose and 1-5 rating', () => {
        for (const shot of shots) {
            expect(shot.annotation.coffee).toBeTruthy();
            expect(shot.annotation.dose).toBeGreaterThan(0);
            expect(shot.annotation.rating).toBeGreaterThanOrEqual(1);
            expect(shot.annotation.rating).toBeLessThanOrEqual(5);
        }
    });

    it('includes 2-3 beans, one of which is a blend using origins[]', () => {
        expect(beans.length).toBeGreaterThanOrEqual(2);
        expect(beans.length).toBeLessThanOrEqual(3);
        const blend = beans.find(b => b.origins.length > 1);
        expect(blend).toBeTruthy();
        expect(blend.origins[0]).toHaveProperty('code');
        expect(blend.origins[0]).toHaveProperty('percent');
        const sumPercent = blend.origins.reduce((s, o) => s + (o.percent || 0), 0);
        expect(sumPercent).toBeLessThanOrEqual(100);
    });

    it('includes at least one recipe referencing a demo bean', () => {
        expect(recipes.length).toBeGreaterThanOrEqual(1);
        const beanNames = new Set(beans.map(b => b.name));
        expect(beanNames.has(recipes[0].beanName)).toBe(true);
    });

    it('is deterministic in shape across calls (fresh timestamps each time)', () => {
        const second = buildDemoDataset();
        expect(second.shots.length).toBe(shots.length);
        expect(second.beans.map(b => b.name)).toEqual(beans.map(b => b.name));
    });
});
