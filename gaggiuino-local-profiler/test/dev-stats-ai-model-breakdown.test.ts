import { describe, it, expect } from 'vitest';
import { isAiCoAuthor, billingTypeFor, aiModelInChunk, monthlyModelSeries, lineChartSVG } from '../scripts/dev-stats.mts';

// #1769: isAiCoAuthor() now uses an allowlist of known AI model name prefixes.
// The previous exclude-list treated every unrecognized trailer as AI, so human
// co-authors missing from it (e.g. m471j4) were counted as AI models.
describe('dev-stats isAiCoAuthor (#1769)', () => {
    it('accepts known AI model co-authors', () => {
        expect(isAiCoAuthor('Claude Opus 5.5')).toBe(true);
        expect(isAiCoAuthor('Claude Sonnet 5')).toBe(true);
        expect(isAiCoAuthor('Claude')).toBe(true);
        expect(isAiCoAuthor('Claude Haiku 4.5')).toBe(true);
        expect(isAiCoAuthor('Claude Fable 5')).toBe(true);
        expect(isAiCoAuthor('DeepSeek V4.1 Flash')).toBe(true);
        expect(isAiCoAuthor('DeepSeek V4 Flash')).toBe(true);
        expect(isAiCoAuthor('GLP-Firma Coder (DeepSeek V4 Flash)')).toBe(true);
        expect(isAiCoAuthor('GLP-Firma Planner (Claude Sonnet 5)')).toBe(true);
        expect(isAiCoAuthor('Big Pickle')).toBe(true);
    });

    it('rejects human co-authors', () => {
        expect(isAiCoAuthor('m471j4')).toBe(false);
        expect(isAiCoAuthor('mxkissnr')).toBe(false);
        expect(isAiCoAuthor('ppops-oh')).toBe(false);
        expect(isAiCoAuthor('openhands')).toBe(false);
        expect(isAiCoAuthor('Paul-Lukas Schäfer')).toBe(false);
        expect(isAiCoAuthor('Paul Lukas Schäfer')).toBe(false);
        expect(isAiCoAuthor('Jane Doe')).toBe(false);
    });

    it('rejects known bots', () => {
        expect(isAiCoAuthor('dependabot[bot]')).toBe(false);
        expect(isAiCoAuthor('renovate[bot]')).toBe(false);
    });
});

// #1597: git and GitHub write the trailer as `Co-authored-by:`, but the
// extractor used a case-sensitive regex, so every one of those commits fell
// through to "human" and the published AI share came out too low. The trailer
// match must ignore case and still classify the model string as AI.
describe('dev-stats aiModelInChunk (#1597)', () => {
    it('recognizes a lowercase Co-authored-by trailer', () => {
        const chunk = 'Fix the thing\n\nCo-authored-by: Claude Opus 5.5 <noreply@anthropic.com>';
        expect(aiModelInChunk(chunk)).toBe('Claude Opus 5.5');
    });

    it('still recognizes the capitalized Co-Authored-By trailer', () => {
        const chunk = 'Fix the thing\n\nCo-Authored-By: DeepSeek V4.1 Flash <noreply@deepseek.com>';
        expect(aiModelInChunk(chunk)).toBe('DeepSeek V4.1 Flash');
    });

    it('returns undefined for a human-only co-author', () => {
        const chunk = 'Fix the thing\n\nCo-authored-by: mxkissnr <mx@example.com>';
        expect(aiModelInChunk(chunk)).toBeUndefined();
    });

    // #1769: an unknown human trailer must not hide the AI trailer that follows it.
    it('skips a human trailer and finds the AI model after it', () => {
        const chunk =
            'Fix the thing\n\n' +
            'Co-authored-by: m471j4 <m471j4@users.noreply.github.com>\n' +
            'Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>';
        expect(aiModelInChunk(chunk)).toBe('Claude Opus 5.5');
    });

    it('returns undefined when only an unknown human trailer is present', () => {
        const chunk = 'Fix the thing\n\nCo-authored-by: m471j4 <m471j4@users.noreply.github.com>';
        expect(aiModelInChunk(chunk)).toBeUndefined();
    });
});

// billingTypeFor() distinguishes the maintainer's flat-rate Claude Pro subscription
// (no per-model API cost derivable from git history) from usage-billed
// models like DeepSeek, so the cost section never claims a flat-rate
// subscription covers a model it doesn't.
describe('dev-stats billingTypeFor (#1100)', () => {
    it('classifies any Claude model string as subscription', () => {
        expect(billingTypeFor('Claude Sonnet 5')).toBe('subscription');
        expect(billingTypeFor('Claude Fable 5')).toBe('subscription');
    });

    it('classifies DeepSeek as api-billed', () => {
        expect(billingTypeFor('DeepSeek V4 Flash')).toBe('api-billed');
        expect(billingTypeFor('GLP-Firma Coder (DeepSeek V4 Flash)')).toBe('api-billed');
    });

    it('defaults an unrecognized future model to api-billed, not subscription', () => {
        expect(billingTypeFor('SomeFutureModel 1')).toBe('api-billed');
    });
});

// #1800: monthly AI-commits-per-model timeline.
describe('dev-stats monthly model timeline (#1800)', () => {
    const c = (date: string, model: string) => ({ date, model });

    it('buckets per calendar month, including empty months up to today', () => {
        const r = monthlyModelSeries([c('2026-08-06', 'A'), c('2026-08-31', 'A'), c('2026-10-20', 'A')], '2026-10-23')!;
        expect(r.months).toEqual(['2026-08', '2026-09', '2026-10']);
        expect(r.series).toEqual([{ model: 'A', counts: [2, 0, 1] }]);
    });

    it('crosses year boundaries', () => {
        expect(monthlyModelSeries([c('2026-12-31', 'A')], '2027-02-01')!.months).toEqual(['2026-12', '2027-01', '2027-02']);
    });

    it('keeps every model as its own series, largest first, with no Other', () => {
        const commits = [c('2026-10-05', 'A'), c('2026-10-05', 'B'), c('2026-10-06', 'B'), c('2026-11-12', 'C'), c('2026-11-12', 'D'), c('2026-11-13', 'E'), c('2026-11-14', 'F'), c('2026-11-14', 'G')];
        const r = monthlyModelSeries(commits, '2026-11-20')!;
        expect(r.series.map(s => s.model)).toEqual(['B', 'A', 'C', 'D', 'E', 'F', 'G']);
        expect(r.series[0]!.counts).toEqual([2, 0]);
    });

    it('returns null / no SVG for an empty history', () => {
        expect(monthlyModelSeries([], '2026-10-23')).toBeNull();
        expect(lineChartSVG('t', null)).toBeNull();
    });

    it('renders one polyline per model with vendor colours, distinct dashes and no Other', () => {
        const data = monthlyModelSeries([c('2026-09-05', 'Claude Sonnet 5'), c('2026-10-12', 'DeepSeek V4 Flash'), c('2026-10-12', 'GPT-5')], '2026-10-13')!;
        const svg = lineChartSVG('Timeline', data, 'dark')!;
        expect(svg.match(/<polyline/g)).toHaveLength(3);
        expect(svg).toContain('stroke="#4d8dff"');
        expect(svg).toContain('stroke="#ff7a3d"');
        expect(svg).toContain('stroke-dasharray="10 5"');
        expect(svg).not.toContain('Other');
        expect(svg).toContain('<title id="t">Timeline</title>');
    });

    it('wraps the legend into rows and grows the card height', () => {
        const model = (n: number) => `Claude Model Number ${n}`;
        const heightOf = (n: number) => {
            const commits = Array.from({ length: n }, (_, i) => c('2026-10-05', model(i)));
            return Number(lineChartSVG('t', monthlyModelSeries(commits, '2026-10-05'))!.match(/viewBox="0 0 880 (\d+)"/)![1]);
        };
        expect(heightOf(12)).toBeGreaterThan(heightOf(2));
        const svg = lineChartSVG('t', monthlyModelSeries(Array.from({ length: 12 }, (_, i) => c('2026-10-05', model(i))), '2026-10-05'))!;
        for (let i = 0; i < 12; i++) expect(svg).toContain(model(i));
        expect(Math.max(...[...svg.matchAll(/<line x1="(\d+)" y1="[\d.]+" x2="(\d+)"/g)].map(m => Number(m[2])))).toBeLessThanOrEqual(880);
    });
});
