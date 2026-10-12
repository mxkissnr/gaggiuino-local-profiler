// #610: in-app "What's New" changelog data
// (public-src/shared/whats-new.js). Pure data + getter, no DOM deps, so
// it's tested directly.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { WHATS_NEW_ENTRIES, MAX_ENTRIES, getWhatsNewEntries } from '../public-src/shared/whats-new.js';

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
                const pbPart = pb[i] ?? 0;
                const paPart = pa[i] ?? 0;
                if (pbPart !== paPart) return pbPart - paPart;
            }
            return 0;
        });
        expect(versions).toEqual(sorted);
    });

    it('caps the result at MAX_ENTRIES even if the source list were longer', () => {
        // The shipped list is exactly MAX_ENTRIES long, so merely calling the
        // getter proves nothing about the cap. Push extra entries onto the
        // exported array to actually make the source longer than the cap, then
        // restore it so the sibling tests still see the original list.
        const originalLength = WHATS_NEW_ENTRIES.length;
        // Whatever version ships as newest; the cap keeps it on top, so
        // don't hard-code it (a new release would break the assertion).
        const newestVersion = getWhatsNewEntries()[0]?.version;
        for (let i = 0; i < MAX_ENTRIES; i++) {
            WHATS_NEW_ENTRIES.push({ version: `0.0.${i}`, date: '2000-01-01', highlights: ['older'] });
        }
        try {
            expect(WHATS_NEW_ENTRIES.length).toBeGreaterThan(MAX_ENTRIES);
            const result = getWhatsNewEntries();
            expect(result).toHaveLength(MAX_ENTRIES);
            // Newest-first survives the cap: the pushed oldest entries are the
            // ones dropped.
            expect(result[0]?.version).toBe(newestVersion);
            expect(result.map(e => e.version)).not.toContain('0.0.0');
        } finally {
            WHATS_NEW_ENTRIES.length = originalLength;
        }
    });

    it('does not mutate the underlying WHATS_NEW_ENTRIES array', () => {
        const before = WHATS_NEW_ENTRIES.map(e => e.version);
        getWhatsNewEntries();
        expect(WHATS_NEW_ENTRIES.map(e => e.version)).toEqual(before);
    });
});

describe('whats-new vs release version', () => {
    it('newest entry matches config.yaml version when CHANGELOG has a section for it', () => {
        const root = resolve(import.meta.dirname, '..');
        const version = readFileSync(join(root, 'config.yaml'), 'utf8').match(/^version:\s*"([^"]+)"/m)?.[1];
        const changelog = readFileSync(join(root, 'CHANGELOG.md'), 'utf8');
        expect(version).toBeDefined();
        if (changelog.includes(`## [${version}]`)) {
            expect(getWhatsNewEntries()[0]?.version).toBe(version);
        }
    });
});
