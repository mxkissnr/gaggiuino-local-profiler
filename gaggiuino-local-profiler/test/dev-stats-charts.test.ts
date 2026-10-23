import { describe, it, expect } from 'vitest';
import {
    barChartSVG,
    chartPictureHTML,
    dividerSVG,
    modelBreakdownData,
    modelDisplayLabel,
    modelVendor,
} from '../scripts/dev-stats.mts';

// #1210: the dev-stats charts lost their fixed width and opaque dark
// background, gained a light/dark pair switched with <picture>, and now colour
// the model breakdown by vendor instead of by rank.
const ITEMS = [
    { label: 'gaggiuino-local-profiler', value: 700 },
    { label: 'glp-integration', value: 300 },
];

function barFills(svg: string): string[] {
    const fills: string[] = [];
    for (const m of svg.matchAll(/<rect x="[\d.]+" y="[\d.]+" width="[\d.]+" height="24" fill="([^"]+)"/g)) {
        const fill = m[1];
        if (fill !== undefined) fills.push(fill);
    }
    return fills;
}

describe('dev-stats barChartSVG (#1210)', () => {
    it('uses a viewBox with no fixed width/height and draws a bordered card with a hard shadow', () => {
        const svg = barChartSVG('Commits per repo', ITEMS)!;
        const rootTag = svg.slice(0, svg.indexOf('>') + 1);
        expect(rootTag).toContain('viewBox="0 0 880 ');
        expect(rootTag).not.toContain('width=');
        expect(rootTag).not.toContain('height=');
        expect(svg).toContain('role="img"');
        expect(svg).toContain('<title id="t">Commits per repo</title>');
        expect(svg).toContain('<desc id="d">');
        expect(svg).toContain('COMMITS PER REPO');
        expect(svg).not.toMatch(/<rect width="/);
        // Offset shadow first, then the card with its 3px ink border.
        expect(svg).toMatch(/<rect x="12" y="12"[^>]*fill="#0b0b0b"\/>\n<rect x="5.5" y="5.5"[^>]*fill="#fffaf0" stroke="#0b0b0b" stroke-width="3"\/>/);
    });

    it('returns null for an empty series', () => {
        expect(barChartSVG('Empty', [])).toBeNull();
    });

    it('renders different ink for the light and dark themes', () => {
        const light = barChartSVG('T', ITEMS, { theme: 'light' })!;
        const dark = barChartSVG('T', ITEMS, { theme: 'dark' })!;
        expect(light).toContain('fill="#0b0b0b" font-weight="800"');
        expect(dark).toContain('fill="#f5f1e6" font-weight="800"');
        expect(light).not.toBe(dark);

        const valueFills = [...dark.matchAll(/fill="([^"]+)" font-weight="800" font-size="14"/g)].map(m => m[1]);
        expect(valueFills.length).toBe(ITEMS.length);
        expect(valueFills.every(f => f === '#f5f1e6')).toBe(true);
        expect(light).not.toContain('#f5f1e6');
    });

    it('uses one colour for a single-series chart', () => {
        const svg = barChartSVG('Commits per repo', ITEMS, { theme: 'light' })!;
        const fills = barFills(svg);
        expect(fills.length).toBe(ITEMS.length);
        expect(new Set(fills).size).toBe(1);
        expect(fills[0]).toBe('#1f5fff');
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

        expect(claudeFills[0]).toBe('#1f5fff');
        expect(deepseekFills[0]).toBe('#ff5a1f');
        expect(legend.map(l => l.label)).toEqual(['Claude', 'DeepSeek']);
    });

    it('omits vendors that are not present from the legend', () => {
        const { legend } = modelBreakdownData({ 'Claude Opus 4': 4 }, 'dark');
        expect(legend.map(l => l.label)).toEqual(['Claude']);
        expect(legend[0]?.color).toBe('#4d8dff');
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

describe('dev-stats dividerSVG (#1802)', () => {
    it('draws the card-style bar with an accessible name in both themes', () => {
        for (const theme of ['light', 'dark'] as const) {
            const svg = dividerSVG(theme);
            expect(svg).toContain('role="img"');
            expect(svg).toContain('<title>Section divider</title>');
            expect(svg).toContain('stroke-width="3"');
        }
        expect(dividerSVG('dark')).toContain('#ff7a3d');
        expect(dividerSVG('light')).not.toBe(dividerSVG('dark'));
    });
});
