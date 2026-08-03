// #610: in-app "What's New" changelog data (lib/whats-new.js). Pure data +
// getter, no Node/DOM deps, so it's tested directly the same way
// lib/machines/theme-presets.js is (see test/validation.test.js).
import { describe, it, expect } from 'vitest';
import { WHATS_NEW_ENTRIES, MAX_ENTRIES, getWhatsNewEntries } from '../lib/whats-new.js';

const SEMVER_RE = /^\d+\.\d+\.\d+$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

describe('WHATS_NEW_ENTRIES', () => {
    it('every entry is well-formed: version, date, non-empty highlights', () => {
        for (const entry of WHATS_NEW_ENTRIES) {
            expect(entry.version).toMatch(SEMVER_RE);
            expect(entry.date).toMatch(DATE_RE);
            expect(Array.isArray(entry.highlights)).toBe(true);
            expect(entry.highlights.length).toBeGreaterThan(0);
            entry.highlights.forEach(h => {
                expect(typeof h).toBe('string');
                expect(h.length).toBeGreaterThan(0);
            });
        }
    });

    it('has at most MAX_ENTRIES entries', () => {
        expect(WHATS_NEW_ENTRIES.length).toBeLessThanOrEqual(MAX_ENTRIES);
    });
});

describe('getWhatsNewEntries', () => {
    it('returns entries sorted newest-first by version', () => {
        const versions = getWhatsNewEntries().map(e => e.version);
        const sorted = [...versions].sort((a, b) => {
            const pa = a.split('.').map(Number);
            const pb = b.split('.').map(Number);
            for (let i = 0; i < 3; i++) {
                if (pb[i] !== pa[i]) return pb[i] - pa[i];
            }
            return 0;
        });
        expect(versions).toEqual(sorted);
    });

    it('caps the result at MAX_ENTRIES even if the source list were longer', () => {
        expect(getWhatsNewEntries().length).toBeLessThanOrEqual(MAX_ENTRIES);
    });

    it('does not mutate the underlying WHATS_NEW_ENTRIES array', () => {
        const before = WHATS_NEW_ENTRIES.map(e => e.version);
        getWhatsNewEntries();
        expect(WHATS_NEW_ENTRIES.map(e => e.version)).toEqual(before);
    });
});
