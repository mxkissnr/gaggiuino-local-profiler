import { describe, it, expect } from 'vitest';
import { isAiCoAuthor, billingTypeFor, aiModelInChunk, weekStart, weeklyModelSeries, lineChartSVG } from '../scripts/dev-stats.mts';

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

// #1800: weekly AI-commits-per-model timeline.
describe('dev-stats weekly model timeline (#1800)', () => {
    const c = (date: string, model: string) => ({ date, model });

    it('maps dates to their Monday', () => {
        expect(weekStart('2026-10-19')).toBe('2026-10-19');
        expect(weekStart('2026-10-25')).toBe('2026-10-19');
        expect(weekStart('2026-10-26')).toBe('2026-10-26');
    });

    it('buckets per week, including empty weeks up to today', () => {
        const r = weeklyModelSeries([c('2026-10-06', 'A'), c('2026-10-08', 'A'), c('2026-10-20', 'A')], '2026-10-23')!;
        expect(r.weeks).toEqual(['2026-10-05', '2026-10-12', '2026-10-19']);
        expect(r.series).toEqual([{ model: 'A', counts: [2, 0, 1] }]);
    });

    it('keeps the top N models and folds the rest into Other', () => {
        const commits = [c('2026-10-05', 'A'), c('2026-10-05', 'A'), c('2026-10-05', 'B'), c('2026-10-12', 'C'), c('2026-10-12', 'D')];
        const r = weeklyModelSeries(commits, '2026-10-13', 2)!;
        expect(r.series.map(s => s.model)).toEqual(['A', 'B', 'Other']);
        expect(r.series[2]!.counts).toEqual([0, 2]);
    });

    it('returns null / no SVG for an empty history', () => {
        expect(weeklyModelSeries([], '2026-10-23')).toBeNull();
        expect(lineChartSVG('t', null)).toBeNull();
    });

    it('renders one polyline per series with vendor colours and a legend', () => {
        const data = weeklyModelSeries([c('2026-10-05', 'Claude Sonnet 5'), c('2026-10-12', 'DeepSeek V4 Flash'), c('2026-10-12', 'GPT-5')], '2026-10-13', 2)!;
        const svg = lineChartSVG('Timeline', data, 'dark')!;
        expect(svg.match(/<polyline/g)).toHaveLength(3);
        expect(svg).toContain('stroke="#3987e5"');
        expect(svg).toContain('stroke="#d95926"');
        expect(svg).toContain('stroke-dasharray');
        expect(svg).toContain('<title id="t">Timeline</title>');
        expect(svg).toContain('Other');
    });
});
