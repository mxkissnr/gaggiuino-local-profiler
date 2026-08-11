// Audit finding (2026-08-11): public-src/bean-math.js's header comment
// claims it "mirrors" lib/services/LibraryService.js's computeBeanRemaining
// "exactly", but no test ever ran the same fixtures through both
// implementations to check that claim — only through the frontend copy
// (test/bean-math.test.js) or only through the backend copy
// (test/bean-id-migration.test.js). This file closes that gap: every
// fixture below is run through BOTH implementations and the results
// compared, so a future edit to one side that silently drifts from the
// other fails here instead of shipping (this is exactly the class of bug
// this same audit found already-happened in the Lovelace cards).
import { describe, it, expect, beforeEach } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

// In-memory DB swap (same pattern as bean-id-migration.test.js /
// db-routes.test.js) — computeBeanRemaining itself is pure and never
// touches the DB, but LibraryService.js pulls in repositories that lazily
// call getDb(), so this keeps the require safe/consistent with the rest of
// the suite regardless of what those modules do at load time.
const Database = require('better-sqlite3');
const dbPath   = require.resolve('../lib/db');
const realDb   = require(dbPath);
const memDb    = new Database(':memory:');
realDb.initSchema(memDb);
require.cache[dbPath].exports = { getDb: () => memDb, initSchema: realDb.initSchema };

const libraryService = require('../lib/services/LibraryService');

import { computeBeanRemaining as computeBeanRemainingFrontend } from '../public-src/bean-math.js';

beforeEach(() => memDb.exec('DELETE FROM shots; DELETE FROM annotations; DELETE FROM library;'));

// Runs the same fixture through both implementations. Each side gets its own
// deep copy rather than the same object instances: neither implementation
// mutates its inputs today, but that is precisely one of the properties this
// test exists to protect, so it must not be assumed. Sharing instances would
// let a future mutation in the first-called side (backend) silently feed the
// second, keeping the two in agreement here while real callers -- which never
// share state this way -- diverge.
function runBoth(bean, doseRows, allBeans) {
    return {
        backend:  libraryService.computeBeanRemaining(
            structuredClone(bean), structuredClone(doseRows), structuredClone(allBeans)),
        frontend: computeBeanRemainingFrontend(
            structuredClone(bean), structuredClone(doseRows), structuredClone(allBeans)),
    };
}

describe('bean-math parity: backend LibraryService.computeBeanRemaining vs. frontend bean-math.js', () => {
    it('beanId match wins over a coincidentally-matching name on a DIFFERENT existing bean', () => {
        const bean1000 = { id: 1000, name: 'House Espresso', stock_g: 250, bags: [{ id: 1, openedAt: 0 }] };
        const bean2000 = { id: 2000, name: 'House Espresso', stock_g: 500, bags: [{ id: 2, openedAt: 0 }] };
        const allBeans = [bean1000, bean2000];
        const doseRows = [{ coffee: 'House Espresso', beanId: 2000, dose: '18', timestamp: 1000 }];

        const r1000 = runBoth(bean1000, doseRows, allBeans);
        const r2000 = runBoth(bean2000, doseRows, allBeans);

        expect(r1000.backend).toBe(r1000.frontend);
        expect(r1000.backend).toBe(250); // untouched — the dose belongs to bean2000 by id
        expect(r2000.backend).toBe(r2000.frontend);
        expect(r2000.backend).toBe(500 - 18);
    });

    it('a bean deleted and reimported under the same name recovers old consumption via name fallback', () => {
        const newBean  = { id: 2000, name: 'Kiraz', stock_g: 250, bags: [{ id: 2, openedAt: 0 }] };
        const doseRows = [
            { coffee: 'Kiraz', beanId: 1000, dose: '18', timestamp: 1000 }, // 1000 no longer resolves
            { coffee: 'Kiraz', beanId: 1000, dose: '19', timestamp: 1001 },
        ];
        const { backend, frontend } = runBoth(newBean, doseRows, [newBean]);

        expect(backend).toBe(frontend);
        expect(backend).toBe(250 - 18 - 19);
    });

    it('name collision between two existing beans (no beanId on the dose row) matches both, ambiguously — same on both sides', () => {
        const beanA = { id: 1, name: 'Dolce', stock_g: 250, bags: [{ id: 1, openedAt: 0 }] };
        const beanB = { id: 2, name: 'Dolce', stock_g: 300, bags: [{ id: 2, openedAt: 0 }] };
        const allBeans = [beanA, beanB];
        // No beanId at all (pre-migration annotation) — legacy name-only
        // matching, which is genuinely ambiguous between two same-named
        // beans. Parity is what matters here, not resolving the ambiguity.
        const doseRows = [{ coffee: 'Dolce', dose: '18', timestamp: 1000 }];

        const rA = runBoth(beanA, doseRows, allBeans);
        const rB = runBoth(beanB, doseRows, allBeans);

        expect(rA.backend).toBe(rA.frontend);
        expect(rA.backend).toBe(250 - 18);
        expect(rB.backend).toBe(rB.frontend);
        expect(rB.backend).toBe(300 - 18);
    });

    it('bag-scoped: multi-bag openedAt cutoff excludes doses before the active bag was opened', () => {
        const bean = {
            id: 1, name: 'Dolce', stock_g: 250,
            bags: [{ id: 1, openedAt: 0 }, { id: 2, openedAt: 5000 * 1000 }],
        };
        const doseRows = [
            { coffee: 'Dolce', dose: 18, timestamp: 1000 }, // old bag, before cutoff
            { coffee: 'Dolce', dose: 18, timestamp: 6000 }, // active bag, after cutoff
        ];
        const { backend, frontend } = runBoth(bean, doseRows, [bean]);

        expect(backend).toBe(frontend);
        expect(backend).toBe(250 - 18);
    });

    it('bag-scoped: a dose predating the only recorded bag still counts against it', () => {
        const bean = { id: 1, name: 'Lasso Lassi', stock_g: 250, bags: [{ id: 1, openedAt: 5000 * 1000 }] };
        const doseRows = [{ coffee: 'Lasso Lassi', beanId: 1, dose: '18', timestamp: 1000 }];
        const { backend, frontend } = runBoth(bean, doseRows, [bean]);

        expect(backend).toBe(frontend);
        expect(backend).toBe(250 - 18);
    });

    it('lifetime (no bags at all): every matching dose counts regardless of timestamp', () => {
        const bean = { id: 1, name: 'No Bags', stock_g: 250 }; // bags omitted entirely
        const doseRows = [
            { coffee: 'No Bags', dose: 18, timestamp: 1 },
            { coffee: 'No Bags', dose: 19, timestamp: 999999999 },
        ];
        const { backend, frontend } = runBoth(bean, doseRows, [bean]);

        expect(backend).toBe(frontend);
        expect(backend).toBe(250 - 18 - 19);
    });

    it('lifetime (empty bags array): treated the same as no bags at all', () => {
        const bean = { id: 1, name: 'Empty Bags', stock_g: 250, bags: [] };
        const doseRows = [{ coffee: 'Empty Bags', dose: 18, timestamp: 1 }];
        const { backend, frontend } = runBoth(bean, doseRows, [bean]);

        expect(backend).toBe(frontend);
        expect(backend).toBe(250 - 18);
    });

    it('empty doseRows: full stock remains, on both sides', () => {
        const bean = { id: 1, name: 'Fresh', stock_g: 250, bags: [{ id: 1, openedAt: 0 }] };
        const { backend, frontend } = runBoth(bean, [], [bean]);

        expect(backend).toBe(frontend);
        expect(backend).toBe(250);
    });

    it('empty allBeans: doseRows still match by name fallback (beanId can never resolve into an empty set)', () => {
        const bean = { id: 1, name: 'Solo', stock_g: 250, bags: [{ id: 1, openedAt: 0 }] };
        const doseRows = [{ coffee: 'Solo', beanId: 1, dose: '18', timestamp: 1 }];
        const { backend, frontend } = runBoth(bean, doseRows, []);

        expect(backend).toBe(frontend);
        expect(backend).toBe(250 - 18);
    });

    it('untracked bean (no stock_g) returns null on both sides', () => {
        const bean = { id: 1, name: 'Untracked' };
        const { backend, frontend } = runBoth(bean, [], [bean]);

        expect(backend).toBeNull();
        expect(frontend).toBeNull();
    });

    it('nullish doseRows: both sides now treat it as zero consumption (found+fixed divergence — see below)', () => {
        const bean = { id: 1, name: 'Guarded', stock_g: 250, bags: [{ id: 1, openedAt: 0 }] };

        const undefResult = runBoth(bean, undefined, [bean]);
        expect(undefResult.backend).toBe(undefResult.frontend);
        expect(undefResult.backend).toBe(250);

        const nullResult = runBoth(bean, null, [bean]);
        expect(nullResult.backend).toBe(nullResult.frontend);
        expect(nullResult.backend).toBe(250);
    });

    it('non-numeric and zero doses are ignored identically on both sides', () => {
        const bean = { id: 1, name: 'Zeroes', stock_g: 250, bags: [{ id: 1, openedAt: 0 }] };
        const doseRows = [
            { coffee: 'Zeroes', dose: 'not-a-number', timestamp: 1 },
            { coffee: 'Zeroes', dose: '0', timestamp: 1 },
            { coffee: 'Zeroes', dose: null, timestamp: 1 },
            { coffee: 'Zeroes', dose: '18', timestamp: 1 },
        ];
        const { backend, frontend } = runBoth(bean, doseRows, [bean]);

        expect(backend).toBe(frontend);
        expect(backend).toBe(250 - 18);
    });

    it('rounding: fractional doses and a fractional stock_g run through the double-round pattern identically', () => {
        // consumed = 10.3 + 10.4 = 20.7 -> round -> 21; stock 100.6 - 21 =
        // 79.6 -> round -> 80. Picked so the "round consumed, then round the
        // subtraction" order actually matters vs. a naive single round
        // (round(100.6 - 20.7) = round(79.9) = 80 — same here, but the point
        // is both implementations apply literally the same two-step formula,
        // not that this particular fixture would expose a mismatch).
        const bean = { id: 1, name: 'Fractional', stock_g: 100.6, bags: [{ id: 1, openedAt: 0 }] };
        const doseRows = [
            { coffee: 'Fractional', dose: '10.3', timestamp: 1 },
            { coffee: 'Fractional', dose: '10.4', timestamp: 2 },
        ];
        const { backend, frontend } = runBoth(bean, doseRows, [bean]);

        expect(backend).toBe(frontend);
        expect(backend).toBe(80);
    });

    it('rounding: half-up boundary on the consumed sum matches on both sides', () => {
        // consumed = 10.5 + 10.0 = 20.5 -> Math.round rounds .5 up -> 21.
        const bean = { id: 1, name: 'HalfUp', stock_g: 250, bags: [{ id: 1, openedAt: 0 }] };
        const doseRows = [
            { coffee: 'HalfUp', dose: '10.5', timestamp: 1 },
            { coffee: 'HalfUp', dose: '10.0', timestamp: 2 },
        ];
        const { backend, frontend } = runBoth(bean, doseRows, [bean]);

        expect(backend).toBe(frontend);
        expect(backend).toBe(250 - 21);
    });
});
