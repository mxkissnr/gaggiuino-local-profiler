import { describe, it, expect } from 'vitest';
import {
    barChartSVG,
    chartPictureHTML,
    modelBreakdownData,
    modelDisplayLabel,
    modelVendor,
} from '../scripts/dev-stats.mjs';

// #1210: the dev-stats charts lost their fixed width and opaque dark
// background, gained a light/dark pair switched with <picture>, and now colour
// the model breakdown by vendor instead of by rank.
const ITEMS = [
    { label: 'gaggiuino-local-profiler', value: 700 },
    { label: 'glp-integration', value: 300 },
];

function barFills(svg: string): string[] {
    return [...svg.matchAll(/<path d="[^"]*" fill="([^"]+)"/g)].map(m => m[1]);
}

describe('dev-stats barChartSVG (#1210)', () => {
    it('uses a viewBox with no fixed width/height and no background rect', () => {
        const svg = barChartSVG('Commits per repo', ITEMS)!;
        const rootTag = svg.slice(0, svg.indexOf('>') + 1);
        expect(rootTag).toContain('viewBox="0 0 880 ');
        expect(rootTag).not.toContain('width=');
        expect(rootTag).not.toContain('height=');
        expect(svg).toContain('role="img"');
        expect(svg).toContain('<title>Commits per repo</title>');
        // The old full-bleed #1a1a19 surface is gone; the only <rect>s left are
        // the 10px legend swatches.
        expect(svg).not.toContain('#1a1a19');
        expect(svg).not.toMatch(/<rect width="/);
    });

    it('returns null for an empty series', () => {
        expect(barChartSVG('Empty', [])).toBeNull();
    });

    it('renders different ink for the light and dark themes', () => {
        const light = barChartSVG('T', ITEMS, { theme: 'light' })!;
        const dark = barChartSVG('T', ITEMS, { theme: 'dark' })!;
        expect(light).toContain('fill="#0b0b0b"');
        expect(dark).toContain('fill="#ffffff"');
        expect(light).not.toBe(dark);

        const valueFills = [...dark.matchAll(/fill="([^"]+)" font-size="13" font-weight="600"/g)].map(m => m[1]);
        expect(valueFills.length).toBe(ITEMS.length);
        expect(valueFills.every(f => f === '#ffffff')).toBe(true);
        expect(light).not.toContain('fill="#ffffff"');
    });

    it('uses one colour for a single-series chart', () => {
        const svg = barChartSVG('Commits per repo', ITEMS, { theme: 'light' })!;
        const fills = barFills(svg);
        expect(fills.length).toBe(ITEMS.length);
        expect(new Set(fills).size).toBe(1);
        expect(fills[0]).toBe('#2a78d6');
    });

    it('XML-escapes the title and labels', () => {
        const svg = barChartSVG('A & B', [{ label: 'x < y & "z"', value: 1 }])!;
        expect(svg).toContain('A &amp; B');
        expect(svg).toContain('x &lt; y &amp; &quot;z&quot;');
        expect(svg).not.toContain('x < y');
    });
});

describe('dev-stats model breakdown (#1210)', () => {
    it('classifies vendors by co-author prefix', () => {
        expect(modelVendor('Claude')).toBe('claude');
        expect(modelVendor('Claude Opus 4.8')).toBe('claude');
        expect(modelVendor('DeepSeek V4 Flash')).toBe('deepseek');
        expect(modelVendor('openhands')).toBe('other');
    });

    it('colours model rows by vendor and lists only present vendors', () => {
        const { items, legend } = modelBreakdownData({
            'Claude Sonnet 5': 10,
            'Claude': 3,
            'DeepSeek V4 Flash': 5,
        }, 'light');

        const claudeFills = items.filter(i => i.label.startsWith('Claude')).map(i => i.color);
        const deepseekFills = items.filter(i => i.label.startsWith('DeepSeek')).map(i => i.color);
        expect(claudeFills.length).toBe(2);
        expect(new Set(claudeFills).size).toBe(1);
        expect(new Set(deepseekFills).size).toBe(1);
        expect(claudeFills[0]).not.toBe(deepseekFills[0]);

        expect(claudeFills[0]).toBe('#2a78d6');
        expect(deepseekFills[0]).toBe('#eb6834');
        expect(legend.map(l => l.label)).toEqual(['Claude', 'DeepSeek']);
    });

    it('omits vendors that are not present from the legend', () => {
        const { legend } = modelBreakdownData({ 'Claude Opus 4': 4 }, 'dark');
        expect(legend.map(l => l.label)).toEqual(['Claude']);
        expect(legend[0].color).toBe('#3987e5');
    });

    it('shows the unversioned Claude row as "Claude (version not recorded)"', () => {
        expect(modelDisplayLabel('Claude')).toBe('Claude (version not recorded)');
        expect(modelDisplayLabel('Claude Sonnet 5')).toBe('Claude Sonnet 5');

        const { items } = modelBreakdownData({ 'Claude': 2, 'Claude Sonnet 5': 9 }, 'light');
        const svg = barChartSVG('AI model breakdown (by commits)', items)!;
        expect(svg).toContain('Claude (version not recorded)');
    });
});

describe('dev-stats chartPictureHTML (#1210)', () => {
    it('builds light/dark picture markup', () => {
        expect(chartPictureHTML('commits-per-repo', 'Commits per repo')).toBe(
            '<picture>\n'
            + '  <source media="(prefers-color-scheme: dark)" srcset="docs/dev-stats/commits-per-repo-dark.svg">\n'
            + '  <img src="docs/dev-stats/commits-per-repo-light.svg" alt="Commits per repo" width="100%">\n'
            + '</picture>',
        );
    });
});
