import { describe, it, expect } from 'vitest';
import { roastAgeDays, freshnessState, shouldShowFreshBadge, frozenOffsetDays, adjustedRoastAgeDays, toIsoDateInput, todayIsoDate, isoDateInputToMs } from '../public-src/utils.js';

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

describe('frozenOffsetDays', () => {
    it('returns 0 with no frozen portions', () => {
        expect(frozenOffsetDays([], now)).toBe(0);
        expect(frozenOffsetDays(undefined, now)).toBe(0);
        expect(frozenOffsetDays(null, now)).toBe(0);
    });

    it('counts a still-frozen portion up to now', () => {
        const frozenPortions = [{ id: 1, frozenAt: now - 5 * DAY, portionCount: 20, portionWeight_g: 18.5 }];
        expect(frozenOffsetDays(frozenPortions, now)).toBe(5);
    });

    it('stops counting a thawed portion at its own thawedAt', () => {
        const frozenPortions = [{ id: 1, frozenAt: now - 10 * DAY, thawedAt: now - 3 * DAY, portionCount: 20, portionWeight_g: 18.5 }];
        expect(frozenOffsetDays(frozenPortions, now)).toBe(7);
    });

    it('sums multiple portion batches', () => {
        const frozenPortions = [
            { id: 1, frozenAt: now - 10 * DAY, thawedAt: now - 8 * DAY, portionCount: 5, portionWeight_g: 18 },
            { id: 2, frozenAt: now - 4 * DAY, portionCount: 5, portionWeight_g: 18 },
        ];
        expect(frozenOffsetDays(frozenPortions, now)).toBe(6);
    });
});

describe('adjustedRoastAgeDays', () => {
    it('matches plain roastAgeDays when there is nothing frozen', () => {
        expect(adjustedRoastAgeDays('2026-06-25', [], now)).toBe(10);
        expect(adjustedRoastAgeDays('2026-06-25', undefined, now)).toBe(10);
    });

    it('subtracts frozen time from the calendar age', () => {
        const frozenPortions = [{ id: 1, frozenAt: now - 6 * DAY, portionCount: 20, portionWeight_g: 18.5 }];
        expect(adjustedRoastAgeDays('2026-06-25', frozenPortions, now)).toBe(4); // 10 - 6
    });

    it('never goes negative', () => {
        const frozenPortions = [{ id: 1, frozenAt: now - 30 * DAY, portionCount: 20, portionWeight_g: 18.5 }];
        expect(adjustedRoastAgeDays('2026-06-25', frozenPortions, now)).toBe(0);
    });

    it('stays null when the roast date itself is unparseable', () => {
        expect(adjustedRoastAgeDays('', [], now)).toBeNull();
        expect(adjustedRoastAgeDays(null, [], now)).toBeNull();
    });
});

describe('toIsoDateInput (#473)', () => {
    it('normalizes DD.MM.YYYY to YYYY-MM-DD', () => {
        expect(toIsoDateInput('25.06.2026')).toBe('2026-06-25');
        expect(toIsoDateInput('5.6.26')).toBe('2026-06-05');
    });

    it('passes ISO YYYY-MM-DD through unchanged', () => {
        expect(toIsoDateInput('2026-06-25')).toBe('2026-06-25');
        expect(toIsoDateInput('2026-06-25T10:00:00Z')).toBe('2026-06-25');
    });

    it('returns an empty string for unparseable or missing input', () => {
        expect(toIsoDateInput('')).toBe('');
        expect(toIsoDateInput(null)).toBe('');
        expect(toIsoDateInput(undefined)).toBe('');
        expect(toIsoDateInput('not a date')).toBe('');
    });
});

describe('todayIsoDate', () => {
    it('formats a given timestamp as local YYYY-MM-DD', () => {
        expect(todayIsoDate(now)).toBe('2026-07-05');
    });
});

describe('isoDateInputToMs', () => {
    it('parses a YYYY-MM-DD value into a local-noon epoch timestamp', () => {
        const ms = isoDateInputToMs('2026-06-25');
        const d = new Date(ms);
        expect(d.getFullYear()).toBe(2026);
        expect(d.getMonth()).toBe(5);
        expect(d.getDate()).toBe(25);
        expect(d.getHours()).toBe(12);
    });

    it('returns null for empty/invalid values', () => {
        expect(isoDateInputToMs('')).toBeNull();
        expect(isoDateInputToMs(undefined)).toBeNull();
        expect(isoDateInputToMs('25.06.2026')).toBeNull();
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
