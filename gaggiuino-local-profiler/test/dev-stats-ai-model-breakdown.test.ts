import { describe, it, expect } from 'vitest';
import { isAiCoAuthor, billingTypeFor, aiModelInChunk } from '../scripts/dev-stats.mts';

// #1100: the model breakdown used to only recognize `Claude ...` co-author
// strings, so every DeepSeek/openhands/future-model commit silently fell out
// of both the model table and the AI-commit/line counts. isAiCoAuthor()
// replaces that hardcoded regex with an exclude-list of known non-AI
// trailers (humans, dependabot/renovate) — everything else counts as AI.
describe('dev-stats isAiCoAuthor (#1100)', () => {
    it('accepts Claude co-authors, any era/model string', () => {
        expect(isAiCoAuthor('Claude Sonnet 5')).toBe(true);
        expect(isAiCoAuthor('Claude Opus 4.8')).toBe(true);
        expect(isAiCoAuthor('Claude')).toBe(true);
    });

    it('accepts non-Claude AI co-authors', () => {
        expect(isAiCoAuthor('DeepSeek V4 Flash')).toBe(true);
        expect(isAiCoAuthor('GLP-Firma Coder (DeepSeek V4 Flash)')).toBe(true);
        expect(isAiCoAuthor('openhands')).toBe(true);
    });

    it('rejects known human co-authors', () => {
        expect(isAiCoAuthor('mxkissnr')).toBe(false);
        expect(isAiCoAuthor('Paul-Lukas Schäfer')).toBe(false);
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
