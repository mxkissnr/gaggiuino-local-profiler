import { describe, it, expect } from 'vitest';

// #1625: dates must be built from local time, not UTC — between midnight and
// the local UTC offset (01:00/02:00 in Europe), a UTC-derived date is one day
// off. Force a zone east of UTC so a timestamp shortly after local midnight
// falls on the previous UTC day, the exact case the old code got wrong.
process.env.TZ = 'Europe/Berlin';

const { localIsoDate, todayIsoDate, localMidnightMs, localDateKey, utcDateKey, localMonthKey } =
    await import('../public-src/utils.js');

describe('localIsoDate', () => {
    it('maps a timestamp just after local midnight to the local date', () => {
        // 2026-10-12 00:30 local (Berlin, UTC+2) is 2026-10-11T22:30Z.
        const justAfterMidnight = new Date(2026, 9, 12, 0, 30).getTime();
        expect(localIsoDate(justAfterMidnight)).toBe('2026-10-12');
    });

    it('is what todayIsoDate() reports', () => {
        const ts = new Date(2026, 9, 12, 0, 30).getTime();
        expect(todayIsoDate(ts)).toBe(localIsoDate(ts));
    });
});

// #1622: the shared day-key helpers. localDateKey must read local calendar
// fields and utcDateKey the UTC ones, so the same instant can land on
// different days in each (exactly the case the call sites rely on).
describe('localDateKey / utcDateKey', () => {
    it('splits the same instant across two days at local midnight', () => {
        // 2026-10-12 00:30 Berlin (UTC+2) is 2026-10-11T22:30Z.
        const justAfterLocalMidnight = new Date(2026, 9, 12, 0, 30);
        expect(localDateKey(justAfterLocalMidnight)).toBe('2026-10-12');
        expect(utcDateKey(justAfterLocalMidnight)).toBe('2026-10-11');
    });

    it('is stable across a month boundary', () => {
        // 2026-10-01 00:30 Berlin is 2026-09-30T22:30Z.
        const firstOfMonth = new Date(2026, 9, 1, 0, 30);
        expect(localDateKey(firstOfMonth)).toBe('2026-10-01');
        expect(utcDateKey(firstOfMonth)).toBe('2026-09-30');
    });

    it('builds the local month key', () => {
        expect(localMonthKey(new Date(2026, 9, 1, 0, 30))).toBe('2026-10');
        expect(localMonthKey(new Date(2026, 8, 30, 23, 0))).toBe('2026-09');
    });

    it('pads single-digit months and days', () => {
        expect(localDateKey(new Date(2026, 0, 5, 12, 0))).toBe('2026-01-05');
        expect(utcDateKey(new Date(Date.UTC(2026, 0, 5, 12, 0)))).toBe('2026-01-05');
    });

    it('agrees with localIsoDate for the same instant', () => {
        const ms = new Date(2026, 9, 12, 0, 30).getTime();
        expect(localDateKey(new Date(ms))).toBe(localIsoDate(ms));
    });
});

describe('localMidnightMs', () => {
    it('parses a YYYY-MM-DD value as local midnight', () => {
        expect(localMidnightMs('2026-10-12')).toBe(new Date(2026, 9, 12).getTime());
    });
});
