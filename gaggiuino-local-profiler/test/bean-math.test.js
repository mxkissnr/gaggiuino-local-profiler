// #551: frontend bean-math port of the backend's LibraryService
// computeBeanRemaining tests (test/bean-id-migration.test.js's "beanId-first
// matching (#456 regression)" describe block) — same scenarios, inline dose
// rows instead of a DB round trip, since public-src/bean-math.js is a pure
// ESM module with no DB dependency.
import { describe, it, expect } from 'vitest';
import { matchesBean, sumConsumedDoses, computeBeanRemaining } from '../public-src/bean-math.js';

describe('computeBeanRemaining (#551, ported from #456 regression)', () => {
    it('a bean deleted and reimported under the same name recovers the old shots\' consumption via name fallback', () => {
        const newBean = { id: 2000, name: 'Kiraz', stock_g: 250, bags: [{ id: 2, openedAt: 0 }] };
        const doseRows = [
            { coffee: 'Kiraz', beanId: 1000, dose: '18', timestamp: 1000 },
            { coffee: 'Kiraz', beanId: 1000, dose: '19', timestamp: 1001 },
        ];
        // Library now only contains the new bean — beanId 1000 no longer resolves.
        expect(computeBeanRemaining(newBean, doseRows, [newBean])).toBe(250 - 18 - 19);
    });

    it('does NOT rescue by name when beanId resolves to a different, still-existing bean', () => {
        const bean1000 = { id: 1000, name: 'House Espresso', stock_g: 250, bags: [{ id: 1, openedAt: 0 }] };
        const bean2000 = { id: 2000, name: 'House Espresso', stock_g: 500, bags: [{ id: 2, openedAt: 0 }] };
        const allBeans = [bean1000, bean2000];
        const doseRows = [{ coffee: 'House Espresso', beanId: 2000, dose: '18', timestamp: 1000 }];

        expect(computeBeanRemaining(bean1000, doseRows, allBeans)).toBe(250);
        expect(computeBeanRemaining(bean2000, doseRows, allBeans)).toBe(500 - 18);
    });

    it('consumption still tracks correctly across a rename when beanId matches', () => {
        const bean = { id: 1000, name: 'Kiraz Reserve', stock_g: 250, bags: [{ id: 1, openedAt: 0 }] };
        const doseRows = [{ coffee: 'Kiraz', beanId: 1000, dose: '18', timestamp: 1000 }];
        expect(computeBeanRemaining(bean, doseRows, [bean])).toBe(250 - 18);
    });

    it('multi-bag openedAt cutoff excludes doses before the active bag was opened', () => {
        const bean = { id: 1, name: 'Dolce', stock_g: 250, bags: [{ id: 1, openedAt: 0 }, { id: 2, openedAt: 5000 * 1000 }] };
        const doseRows = [
            { coffee: 'Dolce', dose: 18, timestamp: 1000 }, // old bag, before cutoff
            { coffee: 'Dolce', dose: 18, timestamp: 6000 }, // active bag, after cutoff
        ];
        expect(computeBeanRemaining(bean, doseRows, [bean])).toBe(250 - 18);
    });

    it('returns null for beans without stock tracking', () => {
        const bean = { id: 1, name: 'Untracked' };
        expect(computeBeanRemaining(bean, [], [bean])).toBeNull();
    });

    it('matchesBean: beanId beats a coincidentally-matching name', () => {
        const bean = { id: 1, name: 'Kiraz' };
        const idExists = new Set([1, 2]);
        expect(matchesBean({ coffee: 'Kiraz', beanId: 2 }, bean, idExists)).toBe(false);
        expect(matchesBean({ coffee: 'Different Name', beanId: 1 }, bean, idExists)).toBe(true);
    });

    it('sumConsumedDoses ignores non-numeric/zero doses', () => {
        const bean = { id: 1, name: 'Kiraz' };
        const doseRows = [
            { coffee: 'Kiraz', dose: 'x', timestamp: 1 },
            { coffee: 'Kiraz', dose: '0', timestamp: 1 },
            { coffee: 'Kiraz', dose: '18', timestamp: 1 },
        ];
        expect(sumConsumedDoses(bean, doseRows, [bean])).toBe(18);
    });
});
