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
import { calcShotScore } from '../public-src/shared/score.js';

interface ParityCase {
    name: string;
    shot: unknown;
    bean?: unknown;
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
    expect(calcShotScore(c.shot, c.bean)).toBe(c.expected);
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
