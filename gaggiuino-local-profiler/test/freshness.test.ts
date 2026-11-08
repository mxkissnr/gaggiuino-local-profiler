import { describe, it, expect, afterEach, vi } from 'vitest';
import { roastAgeDays, freshnessState, shouldShowFreshBadge, frozenPortionAgeDays, toIsoDateInput, todayIsoDate, isoDateInputToMs } from '../public-src/utils.js';

// The frozen-shot tests below import the shot annotation panel and the bean
// card, whose module graph reads localStorage/navigator at load time — stub
// the minimum browser globals first (same approach as
// test/frozen-portion-shot-tracking.test.ts).
const g = globalThis as unknown as Record<string, unknown>;
g.localStorage ??= { getItem: () => null, setItem: () => {} };
g.navigator    ??= { language: 'en-US' };
g.window       ??= { calcShotScore: () => null, getShotData: () => ({}) };

const { S } = await import('../public-src/state/index.js');
const { calcBeanAgeAtShot, shotBeanAge, beanAgeForSave } = await import('../public-src/views/shots/utils.js');
const { _frozenShotAge, _renderFrozenPortionPills, updateDegassing } = await import('../public-src/views/shots/annotation.js');
const { beanFreshBadge } = await import('../public-src/views/library/bean-card.js');

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

    it('keeps counting while frozen, but at the fixed FROZEN_AGE_FACTOR rate', () => {
        const portion = { id: 1, frozenAt: now - 6 * DAY, portionCount: 20, portionWeight_g: 18.5 };
        const muchLater = now + 100 * DAY;
        // 4 whole days at the freeze + floor(106 frozen days x 0.05) = 4 + 5
        expect(frozenPortionAgeDays('2026-06-25', portion, muchLater)).toBe(9);
    });

    it('resumes counting from thawedAt once thawed', () => {
        const portion = { id: 1, frozenAt: now - 10 * DAY, thawedAt: now - 3 * DAY, portionCount: 20, portionWeight_g: 18.5 };
        // age at freeze (2026-06-25 00:00 -> now-10d, i.e. 2026-06-25 12:00 = 0 whole days)
        // + 3 days since thawed
        expect(frozenPortionAgeDays('2026-06-25', portion, now)).toBe(0 + 3);
    });

    it('returns null for a missing/malformed portion or unparseable roast date', () => {
        expect(frozenPortionAgeDays('2026-06-25', null, now)).toBeNull();
        expect(frozenPortionAgeDays('2026-06-25', {} as { frozenAt: number }, now)).toBeNull();
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
        const d = new Date(ms!);
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

// ── #1953: frozen time counts at FROZEN_AGE_FACTOR ───────────────────────
// Shared fixture: roast 2026-07-09, one portion frozen 2026-07-23 at noon (the
// local-time value the freeze date picker stores). Local Date construction
// keeps these free of the runner's timezone.
const ROAST = '2026-07-09';
const FROZEN_AT = new Date(2026, 6, 23, 12).getTime();
const PORTION = { id: 100, frozenAt: FROZEN_AT };
const SHOT_SEC = new Date(2026, 10, 3, 8).getTime() / 1000;

function beanLibrary(extraBeans: Record<string, unknown>[] = []): NonNullable<typeof S.coffeeLibrary> {
    const bean: Record<string, unknown> = {
        id: 1,
        name: 'Test Bean',
        roastDate: ROAST,
        bags: [{ id: 1, roastDate: ROAST, frozenPortions: [PORTION] }],
    };
    return { beans: [bean, ...extraBeans], grinders: [] };
}

describe('frozenPortionAgeDays (frozen time at 0.05, #1953)', () => {
    it('gives the same value at 08:00 and 22:00 on the issue reference day', () => {
        expect(frozenPortionAgeDays(ROAST, PORTION, new Date(2026, 10, 3, 8).getTime())).toBe(19);
        expect(frozenPortionAgeDays(ROAST, PORTION, new Date(2026, 10, 3, 22).getTime())).toBe(19);
    });

    it('counts frozen days at the factor and thawed days at full rate', () => {
        const portion = { id: 100, frozenAt: FROZEN_AT, thawedAt: new Date(2026, 7, 14, 12).getTime() };
        // 14 whole days at the freeze + floor(22 frozen x 0.05 + 3 thawed)
        expect(frozenPortionAgeDays(ROAST, portion, new Date(2026, 7, 17, 12).getTime())).toBe(18);
    });

    it('stops the frozen stretch at the reference when the thaw is later', () => {
        const portion = { id: 100, frozenAt: FROZEN_AT, thawedAt: new Date(2026, 8, 1, 12).getTime() };
        // 14 + floor(22 x 0.05) — the thaw is in the future, so nothing thaws
        expect(frozenPortionAgeDays(ROAST, portion, new Date(2026, 7, 14, 12).getTime())).toBe(15);
    });

    it('falls back to plain calendar age for a reference before the freeze', () => {
        expect(frozenPortionAgeDays(ROAST, PORTION, new Date(2026, 6, 20, 12).getTime())).toBe(11);
    });
});

describe('shotBeanAge with a frozen portion (#1953)', () => {
    it('shows the portion age and agrees with the portion badge', () => {
        S.coffeeLibrary = beanLibrary();
        expect(shotBeanAge({ beanId: 1, coffee: 'Test Bean', frozenPortionId: 100, beanAgeDays: 118 }, SHOT_SEC))
            .toEqual({ days: 19, atShot: true });
        expect(frozenPortionAgeDays(ROAST, PORTION, SHOT_SEC * 1000)).toBe(19);
    });

    it('keeps calendar age for a shot with no frozen portion', () => {
        S.coffeeLibrary = beanLibrary();
        expect(calcBeanAgeAtShot('Test Bean', SHOT_SEC, 1)).toBe(117);
    });

    it('falls back to the stored age when the portion is gone', () => {
        S.coffeeLibrary = beanLibrary();
        expect(shotBeanAge({ beanId: 1, coffee: 'Test Bean', frozenPortionId: 999, beanAgeDays: 118 }, SHOT_SEC))
            .toEqual({ days: 118, atShot: true });
    });

    it('finds the portion on another bag of the bean than the one active at shot time', () => {
        S.coffeeLibrary = {
            beans: [{
                id: 1,
                name: 'Test Bean',
                roastDate: ROAST,
                bags: [
                    { id: 1, roastDate: ROAST, frozenPortions: [PORTION] },
                    { id: 2, roastDate: '2026-10-15', openedAt: new Date(2026, 9, 20, 12).getTime() },
                ],
            }],
            grinders: [],
        };
        expect(shotBeanAge({ beanId: 1, coffee: 'Test Bean', frozenPortionId: 100 }, SHOT_SEC))
            .toEqual({ days: 19, atShot: true });
    });

    it('uses plain calendar age for a shot before the freeze date', () => {
        S.coffeeLibrary = beanLibrary();
        const beforeFreeze = new Date(2026, 6, 20, 12).getTime() / 1000;
        expect(shotBeanAge({ beanId: 1, coffee: 'Test Bean', frozenPortionId: 100 }, beforeFreeze))
            .toEqual({ days: 11, atShot: true });
    });

    it('keeps calendar age for a mixed shot, whatever the portion says', () => {
        S.coffeeLibrary = beanLibrary([{ id: 2, name: 'Other Bean', roastDate: ROAST }]);
        const ann = {
            beanId: 1,
            coffee: 'Test Bean',
            frozenPortionId: 100,
            beanMix: [
                { beanId: 1, coffee: 'Test Bean', grams: 10 },
                { beanId: 2, coffee: 'Other Bean', grams: 8 },
            ],
        };
        expect(shotBeanAge(ann, SHOT_SEC)).toEqual({ days: 117, atShot: true });
    });
});

describe('beanAgeForSave (#1953)', () => {
    it('writes the live portion age when the portion still exists', () => {
        S.coffeeLibrary = beanLibrary();
        expect(beanAgeForSave('Test Bean', SHOT_SEC, 1, 100, 118)).toBe(19);
    });

    it('keeps the stored age when the portion has left the library', () => {
        S.coffeeLibrary = beanLibrary();
        expect(beanAgeForSave('Test Bean', SHOT_SEC, 1, 999, 118)).toBe(118);
    });

    it('writes null when the portion is gone and nothing was stored', () => {
        S.coffeeLibrary = beanLibrary();
        expect(beanAgeForSave('Test Bean', SHOT_SEC, 1, 999, null)).toBeNull();
    });

    it('does not keep a stale age for a cleared bean', () => {
        S.coffeeLibrary = beanLibrary();
        expect(beanAgeForSave(null, SHOT_SEC, null, null, 118)).toBeNull();
    });
});

describe('annotation panel and badges with a frozen portion (#1953)', () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it('_frozenShotAge returns the portion age, and nothing for plain or mixed shots', () => {
        S.coffeeLibrary = beanLibrary();
        expect(_frozenShotAge({ beanId: 1, coffee: 'Test Bean', frozenPortionId: 100 }, SHOT_SEC)).toBe(19);
        expect(_frozenShotAge({ beanId: 1, coffee: 'Test Bean' }, SHOT_SEC)).toBeUndefined();
        expect(_frozenShotAge({
            beanId: 1,
            coffee: 'Test Bean',
            frozenPortionId: 100,
            beanMix: [
                { beanId: 1, coffee: 'Test Bean', grams: 10 },
                { beanId: 2, coffee: 'Other Bean', grams: 8 },
            ],
        }, SHOT_SEC)).toBeUndefined();
    });

    it('keeps the last-portion choice in the hidden field when no active portions are left', () => {
        S.coffeeLibrary = {
            beans: [{
                id: 1,
                name: 'Test Bean',
                bags: [{ id: 1, roastDate: ROAST, frozenPortions: [{ id: 100, frozenAt: FROZEN_AT, portionCount: 4, remainingCount: 0 }] }],
            }],
            grinders: [],
        };
        const field     = { style: { display: '' } };
        const container = { innerHTML: '' };
        const hidden    = { value: 'unset' };
        g.document = {
            getElementById: (id: string) => ({ frozenPortionField: field, frozenPortionPillsContainer: container, annFrozenPortionId: hidden } as Record<string, unknown>)[id],
        };
        _renderFrozenPortionPills('Test Bean', SHOT_SEC * 1000, 100);
        expect(field.style.display).toBe('none');
        expect(hidden.value).toBe('100');
        _renderFrozenPortionPills('Test Bean', SHOT_SEC * 1000, null);
        expect(hidden.value).toBe('');
    });

    function fakeDegassingDom() {
        const tracker = { style: { display: '' } };
        const fill    = { style: { width: '', background: '' } };
        const label   = { style: { color: '' }, textContent: '' };
        g.document = {
            getElementById: (id: string) => ({ degassingTracker: tracker, degassingFill: fill, degassingLabel: label } as Record<string, unknown>)[id],
        };
        return label;
    }

    it('shows the passed effective age in the degassing tracker', () => {
        const label = fakeDegassingDom();
        updateDegassing(ROAST, 19);
        expect(label.textContent).toContain('19');
    });

    it('keeps reading the roast date relative to now without an effective age', () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date(2026, 10, 3, 12));
        const label = fakeDegassingDom();
        updateDegassing(ROAST, null);
        expect(label.textContent).toContain('117');
    });

    it('leaves the bag-level badge on calendar age', () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date(2026, 10, 3, 12));
        const badge = beanFreshBadge({
            id: 1,
            name: 'Test Bean',
            stock_g: 250,
            remainingG: 240,
            bags: [{ id: 1, roastDate: ROAST, stock_g: 250, consumedG: 10, remainingG: 240, current: true, frozenPortions: [PORTION] }],
        } as unknown as Parameters<typeof beanFreshBadge>[0]);
        expect(badge).toContain('>117d<');
    });
});
