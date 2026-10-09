import { describe, it, expect } from 'vitest';
import { compareMetrics, formatReport } from '../scripts/perf-compare.mts';
import type { Metric } from '../scripts/perf-compare.mts';

// #1558: the compare step is a report, not a gate. These tests pin the
// percentage math, the `review` marker in both `better` directions, the
// threshold argument and the "metric present in only one file" case.

function metric(value: number, better: 'lower' | 'higher' = 'lower', unit = 'ms'): Metric {
    return { value, unit, better };
}

describe('compareMetrics (#1558)', () => {
    it('computes the signed percentage change', () => {
        const up = compareMetrics({ a: metric(100) }, { a: metric(120) }, 15);
        expect(up[0]?.changePct).toBeCloseTo(20);

        const down = compareMetrics({ a: metric(200) }, { a: metric(150) }, 15);
        expect(down[0]?.changePct).toBeCloseTo(-25);
    });

    it('marks a worse change `review` for a lower-is-better metric', () => {
        const rows = compareMetrics({ a: metric(100, 'lower') }, { a: metric(120, 'lower') }, 15);
        expect(rows[0]?.review).toBe(true);
    });

    it('marks a worse change `review` for a higher-is-better metric', () => {
        const rows = compareMetrics({ a: metric(100, 'higher') }, { a: metric(80, 'higher') }, 15);
        expect(rows[0]?.review).toBe(true);
    });

    it('does not mark an improvement', () => {
        const faster = compareMetrics({ a: metric(100, 'lower') }, { a: metric(80, 'lower') }, 15);
        expect(faster[0]?.review).toBe(false);

        const higher = compareMetrics({ a: metric(100, 'higher') }, { a: metric(130, 'higher') }, 15);
        expect(higher[0]?.review).toBe(false);
    });

    it('respects the threshold argument', () => {
        const under = compareMetrics({ a: metric(100) }, { a: metric(110) }, 15);
        expect(under[0]?.review).toBe(false);

        const over = compareMetrics({ a: metric(100) }, { a: metric(110) }, 5);
        expect(over[0]?.review).toBe(true);
    });

    it('lists a metric missing on one side with n/a', () => {
        const rows = compareMetrics({ onlyBase: metric(10) }, { onlyHead: metric(20) }, 15);

        const missingHead = rows.find((row) => row.metric === 'onlyBase');
        expect(missingHead?.head).toBeNull();
        expect(missingHead?.changePct).toBeNull();
        expect(missingHead?.review).toBe(false);

        const missingBase = rows.find((row) => row.metric === 'onlyHead');
        expect(missingBase?.base).toBeNull();

        expect(formatReport(rows)).toContain('n/a');
    });

    it('renders the `review` marker in the report table', () => {
        const rows = compareMetrics({ a: metric(100) }, { a: metric(200) }, 15);
        expect(formatReport(rows)).toContain('`review`');
    });
});
