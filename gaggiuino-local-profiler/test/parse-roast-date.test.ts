import { describe, it, expect } from 'vitest';
import { parseRoastDate, roastAgeDays } from '../public-src/utils.js';

describe('parseRoastDate', () => {
    it('parses the typed DMY forms, all separators and a two-digit year', () => {
        expect(parseRoastDate('12.10.2026')).toEqual(new Date(2026, 9, 12));
        expect(parseRoastDate('1.2.26')).toEqual(new Date(2026, 1, 1));
        expect(parseRoastDate('12/10/2026')).toEqual(new Date(2026, 9, 12));
        expect(parseRoastDate('12-10-2026')).toEqual(new Date(2026, 9, 12));
    });

    it('parses the ISO form used by bags and imports', () => {
        expect(parseRoastDate('2026-10-12')).toEqual(new Date(2026, 9, 12));
        expect(parseRoastDate('2026-10-12T08:00:00Z')).toEqual(new Date(2026, 9, 12));
    });

    it('returns null for empty, missing or unparseable input', () => {
        expect(parseRoastDate('')).toBeNull();
        expect(parseRoastDate(null)).toBeNull();
        expect(parseRoastDate(undefined)).toBeNull();
        expect(parseRoastDate('abc')).toBeNull();
        expect(parseRoastDate('12.10')).toBeNull();
    });
});

describe('roastAgeDays (results unchanged)', () => {
    const now = new Date(2026, 9, 22).getTime(); // 2026-10-22 local midnight

    it('parses one case per format', () => {
        expect(roastAgeDays('12.10.2026', now)).toBe(10);
        expect(roastAgeDays('12.10.26', now)).toBe(10);
        expect(roastAgeDays('12/10/2026', now)).toBe(10);
        expect(roastAgeDays('12-10-2026', now)).toBe(10);
        expect(roastAgeDays('2026-10-12', now)).toBe(10);
    });
});
