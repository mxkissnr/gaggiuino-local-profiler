import { describe, it, expect } from 'vitest';

// #1625: dates must be built from local time, not UTC — between midnight and
// the local UTC offset (01:00/02:00 in Europe), a UTC-derived date is one day
// off. Force a zone east of UTC so a timestamp shortly after local midnight
// falls on the previous UTC day, the exact case the old code got wrong.
process.env.TZ = 'Europe/Berlin';

const { localIsoDate, todayIsoDate, localMidnightMs } = await import('../public-src/utils.js');

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

describe('localMidnightMs', () => {
    it('parses a YYYY-MM-DD value as local midnight', () => {
        expect(localMidnightMs('2026-10-12')).toBe(new Date(2026, 9, 12).getTime());
    });
});
