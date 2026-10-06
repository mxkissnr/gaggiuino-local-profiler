// #1270: the repository is Go + TypeScript only (backend Go; browser code,
// build and dev tooling TypeScript). Any tracked `.js`/`.mjs`/`.cjs` file
// outside a vendored `/vendor/` path fails this test. #1270 finished the
// port, so the allowlist that once tracked the leftovers is gone. See
// CLAUDE.md and DEVELOPMENT.md for the rule.
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const APP_ROOT = resolve(import.meta.dirname, '..');
const REPO_ROOT = execFileSync('git', ['rev-parse', '--show-toplevel'], {
    cwd: APP_ROOT,
    encoding: 'utf8',
}).trim();

const JAVASCRIPT_SOURCE = /\.(js|mjs|cjs)$/;

// Tracked JavaScript sources, minus vendored third-party code (any path with a
// `/vendor/` segment), relative to the repository root.
function trackedJavaScriptSources(): string[] {
    const output = execFileSync('git', ['ls-files', '-z'], {
        cwd: REPO_ROOT,
        encoding: 'utf8',
    });
    return output
        .split('\0')
        .filter((path) => JAVASCRIPT_SOURCE.test(path))
        .filter((path) => !path.split('/').includes('vendor'))
        .sort();
}

describe('Go + TypeScript only (#1270)', () => {
    it('has no JavaScript sources', () => {
        const unexpected = trackedJavaScriptSources();

        const message = [
            `Found ${unexpected.length} tracked JavaScript source(s) — port it to TypeScript (Go + TypeScript only, see #1270):`,
            ...unexpected.map((path) => `  ${path}`),
        ].join('\n');

        expect(unexpected, message).toEqual([]);
    });
});
