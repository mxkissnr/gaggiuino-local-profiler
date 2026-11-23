// #1622: the shot score is computed twice — Go (go/internal/shots/score.go,
// CalcShotScoreDetail) and here (public-src/shared/score.ts, calcShotScore).
// Nothing checked that the two agree, so they could drift silently. This test
// and its Go twin (go/internal/shots/score_parity_test.go) both load the same
// synthetic fixture (test/fixtures/score-parity.json) and assert the same
// expected total, so any divergence fails both CI jobs.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { calcShotScore, durationScore } from '../public-src/shared/score.js';

interface ParityCase {
    name: string;
    shot: unknown;
    bean?: unknown;
    // #1504: the profile's own duration window, scored by both twins.
    timeTarget?: { minS: number; maxS: number } | null;
    expected: number | null;
    // Set only when the Go and TypeScript scorers genuinely disagree on a case:
    // "expected" is then the Go value and both tests skip the case with the
    // reason, keeping the divergence visible without failing CI. Absent for
    // every agreed case.
    knownDivergence?: string;
}

const here = dirname(fileURLToPath(import.meta.url));
const cases = JSON.parse(
    readFileSync(join(here, 'fixtures', 'score-parity.json'), 'utf8'),
) as ParityCase[];

function assertCase(c: ParityCase): void {
    expect(calcShotScore(c.shot, c.bean, c.timeTarget ?? null)).toBe(c.expected);
}

describe('Go/TS shot score parity (#1622)', () => {
    it('loads at least one fixture case', () => {
        expect(cases.length).toBeGreaterThan(0);
    });

    for (const c of cases) {
        // A diverging case is skipped (not silently passed): its title carries
        // the reason so the gap stays visible in the test report.
        if (c.knownDivergence) {
            it.skip(`${c.name} (known Go/TS divergence: ${c.knownDivergence})`, () => assertCase(c));
        } else {
            it(c.name, () => assertCase(c));
        }
    }
});

// #1504: the windowed duration curve must reproduce the old ternary chain
// exactly for the generic band, so a caller that passes no window (or the
// 25-35 band) keeps today's scores.
function legacyDurationScore(secs: number): number {
    return secs >= 25 && secs <= 35 ? 100
        : (secs >= 20 && secs < 25) || (secs > 35 && secs <= 42) ? 82
        : secs > 42 && secs <= 55 ? 62
        : secs < 20 ? Math.max(15, 70 - (20 - secs) * 5)
        : Math.max(15, 62 - (secs - 55) * 3);
}

const textbookShot = (cases.find(c => c.name === 'textbook shot')?.shot ?? {}) as Record<string, unknown>;
function textbookShotWithDuration(duration: number): Record<string, unknown> {
    return { ...textbookShot, duration };
}

describe('durationScore matches the legacy generic band (#1504)', () => {
    // Guards the shorthand below: a missing fixture case would leave
    // textbookShot empty and both sides would score null, passing vacuously.
    it('builds the comparison shot from the fixture', () => {
        expect(textbookShot).toHaveProperty('duration');
    });

    it('durationScore with the 25-35 window equals the legacy band', () => {
        for (let i = 51; i <= 1200; i++) {
            const secs = i / 10;
            expect(durationScore(secs, 25, 35), `${secs} s duration curve`)
                .toBe(legacyDurationScore(secs));
            const shot = textbookShotWithDuration(i);
            const scored = calcShotScore(shot);
            expect(scored, `${secs} s shot scores`).not.toBeNull();
            expect(calcShotScore(shot, undefined, { minS: 25, maxS: 35 }), `${secs} s with the 25-35 window`).toBe(scored);
        }
    });
});
