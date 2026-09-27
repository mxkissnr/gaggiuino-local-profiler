import { describe, it, expect } from 'vitest';
import { barChartSVG } from '../scripts/dev-stats.mjs';

// #1180: the two SVGs in README's "Development at a glance" used to size
// themselves to their own row count (4 repos vs ~10 models), so GitHub
// rendered them at different heights and they sat misaligned. barChartSVG()
// now takes a minHeight; renderCharts() passes both charts the taller of the
// two natural heights. These tests pin the geometry contract that makes that
// work: padding only extends the canvas, it never moves a bar.
describe('dev-stats barChartSVG equal-height padding (#1180)', () => {
    const items = (n: number) => Array.from({ length: n }, (_, i) => ({ label: `item-${i}`, value: n - i }));

    const heightOf = (svg: string | null): number => Number(/<svg[^>]*\bheight="(\d+)"/.exec(svg ?? '')?.[1]);
    const viewBoxOf = (svg: string | null): string => /<svg[^>]*\bviewBox="([^"]+)"/.exec(svg ?? '')?.[1] ?? '';
    const barYs = (svg: string | null): number[] =>
        [...(svg ?? '').matchAll(/M\d+,(\d+) H/g)].map(m => Number(m[1]));

    it('renders a short and a tall chart at the same height when given the same minHeight', () => {
        const minHeight = Math.max(heightOf(barChartSVG('t', items(4), 0)), heightOf(barChartSVG('t', items(10), 0)));

        const four = barChartSVG('t', items(4), minHeight);
        const ten = barChartSVG('t', items(10), minHeight);

        expect(heightOf(four)).toBe(heightOf(ten));
        expect(viewBoxOf(four)).toBe(viewBoxOf(ten));
    });

    it('uses minHeight as the total height when it is taller than the content', () => {
        const minHeight = heightOf(barChartSVG('t', items(10), 0));
        expect(heightOf(barChartSVG('t', items(4), minHeight))).toBe(minHeight);
    });

    it('pads only the canvas — every bar keeps its natural y position', () => {
        const natural = barChartSVG('t', items(4), 0);
        const padded = barChartSVG('t', items(4), heightOf(barChartSVG('t', items(10), 0)));

        expect(barYs(padded)).toEqual(barYs(natural));
    });

    it('grows to the content height when minHeight is smaller', () => {
        expect(heightOf(barChartSVG('t', items(10), 100))).toBe(heightOf(barChartSVG('t', items(10), 0)));
    });

    it('returns null for an empty series regardless of minHeight', () => {
        expect(barChartSVG('t', [], 400)).toBeNull();
    });
});
