import { describe, it, expect } from 'vitest';
import { roastAgeDays, freshnessState, shouldShowFreshBadge, frozenPortionAgeDays, toIsoDateInput, todayIsoDate, isoDateInputToMs } from '../public-src/utils.js';

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

// #477: a frozen portion's own effective age is tracked separately from the
// bag's plain roastAgeDays() badge — freezing part of a bag must never
// change how fresh the rest of the bag (still in normal use) reads.
describe('frozenPortionAgeDays', () => {
    it('holds flat at the age-at-freeze-time while still frozen (no thawedAt)', () => {
        const portion = { id: 1, frozenAt: now - 6 * DAY, portionCount: 20, portionWeight_g: 18.5 };
        // age at freeze time: roasted 2026-06-25, frozen 6 days later at now-6d
        expect(frozenPortionAgeDays('2026-06-25', portion, now)).toBe(4);
    });

    it('does not keep growing with `now` while still frozen', () => {
        const portion = { id: 1, frozenAt: now - 6 * DAY, portionCount: 20, portionWeight_g: 18.5 };
        const muchLater = now + 100 * DAY;
        expect(frozenPortionAgeDays('2026-06-25', portion, muchLater)).toBe(4);
    });

    it('resumes counting from thawedAt once thawed', () => {
        const portion = { id: 1, frozenAt: now - 10 * DAY, thawedAt: now - 3 * DAY, portionCount: 20, portionWeight_g: 18.5 };
        // age at freeze (2026-06-25 00:00 -> now-10d, i.e. 2026-06-25 12:00 = 0 whole days)
        // + 3 days since thawed
        expect(frozenPortionAgeDays('2026-06-25', portion, now)).toBe(0 + 3);
    });

    it('returns null for a missing/malformed portion or unparseable roast date', () => {
        expect(frozenPortionAgeDays('2026-06-25', null, now)).toBeNull();
        expect(frozenPortionAgeDays('2026-06-25', {}, now)).toBeNull();
        expect(frozenPortionAgeDays('', { frozenAt: now - DAY }, now)).toBeNull();
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
