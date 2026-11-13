// #2025: the bean age is computed twice — in Go (go/internal/library/bean_age.go,
// RoastAgeDays/BeanAgeAtShot/BeanAgeForAnnotation) and here (public-src/utils.ts,
// public-src/views/shots/utils.ts). This test and its Go twin
// (go/internal/library/bean_age_parity_test.go) both load the same fixture
// (test/fixtures/bean-age-parity.json) and assert the same expected age, so any
// divergence fails both CI jobs. The fixture's local wall-clock timestamps are
// converted in its own zone, so local-midnight and daylight-saving cases really
// bite.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

// The annotation shape shotBeanAge() reads, so the fixture cases need no cast.
type Annotation = Parameters<(typeof import('../public-src/views/shots/utils.js'))['shotBeanAge']>[0];

interface ParityCase {
    name: string;
    bean: Record<string, unknown>;
    annotation: Annotation;
    shotLocal: string;
    expected: number | null;
}

interface ParityFixture {
    timeZone: string;
    cases: ParityCase[];
}

const here = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(
    readFileSync(join(here, 'fixtures', 'bean-age-parity.json'), 'utf8'),
) as ParityFixture;

// Pin the zone before any date arithmetic runs (the score parity test's shape,
// plus the freshness test's minimal browser globals, since the state module and
// the shot view utils read them at load time).
process.env.TZ = fixture.timeZone;
const g = globalThis as unknown as Record<string, unknown>;
g.localStorage ??= { getItem: () => null, setItem: () => {} };
g.navigator    ??= { language: 'en-US' };
g.window       ??= { calcShotScore: () => null, getShotData: () => ({}) };

const { S } = await import('../public-src/state/index.js');
const { shotBeanAge } = await import('../public-src/views/shots/utils.js');
const { roastAgeDays } = await import('../public-src/utils.js');

const LOCAL_STAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;

// The fixture writes local wall-clock stamps as `*Local` keys; the readers want
// epoch milliseconds, local time per the spec.
function localMs(stamp: string): number {
    return new Date(stamp).getTime();
}

function withLocalStamps(value: unknown): unknown {
    if (Array.isArray(value)) return (value as unknown[]).map(withLocalStamps);
    if (!value || typeof value !== 'object') return value;
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
        const base = key.replace(/Local$/, '');
        if (base !== key && typeof v === 'string' && LOCAL_STAMP.test(v)) {
            out[base] = localMs(v);
        } else {
            out[key] = withLocalStamps(v);
        }
    }
    return out;
}

function shotSec(c: ParityCase): number {
    return localMs(c.shotLocal) / 1000;
}

function ageFor(c: ParityCase): number | null {
    const bean = withLocalStamps(c.bean) as Record<string, unknown>;
    S.coffeeLibrary = { beans: [bean], grinders: [] };
    return shotBeanAge(c.annotation, shotSec(c), { relativeToNow: false })?.days ?? null;
}

describe('Go/TS bean age parity (#2025)', () => {
    it('loads the fixture cases', () => {
        expect(fixture.cases.length).toBeGreaterThan(0);
    });

    for (const c of fixture.cases) {
        it(c.name, () => {
            expect(ageFor(c)).toBe(c.expected);
        });
    }

    it('the bean card bag badge agrees with the shot badge', () => {
        const late = fixture.cases.find(c => c.name === 'late evening rounds down');
        expect(late, 'fixture case missing').toBeDefined();
        if (!late) return;
        // The bean card's own rule is roastAgeDays() over the same roast date and moment.
        expect(roastAgeDays('2026-07-09', localMs(late.shotLocal))).toBe(10);
        expect(ageFor(late)).toBe(10);
    });
});
