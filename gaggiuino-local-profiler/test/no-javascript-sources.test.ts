// #1270 A1: the repository is Go + TypeScript only (backend Go; browser code,
// build and dev tooling TypeScript). This test fails when a tracked
// `.js`/`.mjs`/`.cjs` file appears outside third-party vendored code and the
// explicit allowlist below, and when an allowlist entry disappears — so a PR
// that ports or deletes one of today's leftovers must drop its entry, and the
// allowlist can only shrink. See CLAUDE.md and DEVELOPMENT.md for the rule.
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const APP_ROOT = resolve(import.meta.dirname, '..');
const REPO_ROOT = execFileSync('git', ['rev-parse', '--show-toplevel'], {
    cwd: APP_ROOT,
    encoding: 'utf8',
}).trim();

// Today's leftovers on `dev`, verbatim from `git ls-files`. Sorted, and it may
// only shrink; see #1270. Vendored third-party files are skipped by the scan
// below, not listed here.
//
// Every path below is an allowlist entry naming a file that #1270 has not
// ported yet — an entry is not a file this change modifies. #1270 A1 only
// records the rule and adds this enforcement test; porting each entry to
// TypeScript is a later #1270 slice, which must delete that entry here (the
// second test below enforces the deletion).
const ALLOWLIST: readonly string[] = [
    'gaggiuino-local-profiler/demo/sw/demo-sw.js',
    'gaggiuino-local-profiler/demo/sw/sw-core.js',
    'gaggiuino-local-profiler/public-src/public/sw.js',
    'gaggiuino-local-profiler/scripts/demo-fixtures.mjs',
    'gaggiuino-local-profiler/scripts/demo-smoke.mjs',
    'gaggiuino-local-profiler/scripts/dev-stats.mjs',
    'gaggiuino-local-profiler/scripts/e2e-harness.mjs',
    'gaggiuino-local-profiler/scripts/release-check.mjs',
    'gaggiuino-local-profiler/scripts/screenshots.mjs',
    'gaggiuino-local-profiler/scripts/sync-dev-config.mjs',
    'gaggiuino-local-profiler/test/e2e/smoke.test.mjs',
];

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
    it('has no JavaScript sources outside the allowlist', () => {
        const allowed = new Set(ALLOWLIST);
        const unexpected = trackedJavaScriptSources().filter((path) => !allowed.has(path));

        const message = [
            `Found ${unexpected.length} tracked JavaScript source(s) outside the allowlist — port it to TypeScript (Go + TypeScript only, see #1270):`,
            ...unexpected.map((path) => `  ${path}`),
        ].join('\n');

        expect(unexpected, message).toEqual([]);
    });

    it('keeps every allowlist entry still existing', () => {
        const found = new Set(trackedJavaScriptSources());
        const stale = ALLOWLIST.filter((path) => !found.has(path));

        const message = [
            `Found ${stale.length} allowlist entry/entries that no longer exist — remove it from the allowlist (see #1270):`,
            ...stale.map((path) => `  ${path}`),
        ].join('\n');

        expect(stale, message).toEqual([]);
    });
});
