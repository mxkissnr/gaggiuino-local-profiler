import { describe, it, expect } from 'vitest';
import { roastAgeDays, freshnessState, shouldShowFreshBadge } from '../public-src/utils.js';

const DAY = 86400000;
const now = new Date(2026, 6, 5, 12).getTime(); // 2026-07-05 noon, local time

describe('roastAgeDays', () => {
    it('parses the DD.MM.YYYY form format', () => {
        expect(roastAgeDays('25.06.2026', now)).toBe(10);
        expect(roastAgeDays('25.06.26', now)).toBe(10);
    });

    it('parses the ISO format used by bags and imports', () => {
        expect(roastAgeDays('2026-06-25', now)).toBe(10);
        expect(roastAgeDays('2026-07-05', now)).toBe(0);
    });

    it('rejects future dates, ancient dates and garbage', () => {
        expect(roastAgeDays('2026-08-01', now)).toBeNull();
        expect(roastAgeDays('2020-01-01', now)).toBeNull();
        expect(roastAgeDays('soon', now)).toBeNull();
        expect(roastAgeDays('', now)).toBeNull();
        expect(roastAgeDays(null, now)).toBeNull();
    });
});

describe('freshnessState', () => {
    it('mirrors the degassing tracker windows', () => {
        expect(freshnessState(0)).toBe('degassing');
        expect(freshnessState(3)).toBe('degassing');
        expect(freshnessState(4)).toBe('almost');
        expect(freshnessState(7)).toBe('peak');
        expect(freshnessState(21)).toBe('peak');
        expect(freshnessState(22)).toBe('fading');
        expect(freshnessState(35)).toBe('fading');
        expect(freshnessState(36)).toBe('old');
        expect(freshnessState(null)).toBeNull();
    });
});

describe('shouldShowFreshBadge', () => {
    it('keeps showing the badge for beans with no stock tracking at all', () => {
        expect(shouldShowFreshBadge(0, null)).toBe(true);
        expect(shouldShowFreshBadge(null, null)).toBe(true);
    });

    it('keeps showing the badge for a stock-tracked bean that still has stock', () => {
        expect(shouldShowFreshBadge(250, 50)).toBe(true);
        expect(shouldShowFreshBadge(250, 1)).toBe(true);
    });

    it('hides the badge for a stock-tracked bean that is depleted or over-consumed', () => {
        expect(shouldShowFreshBadge(250, 0)).toBe(false);
        expect(shouldShowFreshBadge(250, -20)).toBe(false);
    });
});
