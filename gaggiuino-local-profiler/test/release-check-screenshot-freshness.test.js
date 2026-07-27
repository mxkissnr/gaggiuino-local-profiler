import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import {
    checkScreenshotFreshness,
    isCommentOrBlankLine,
} from '../scripts/release-check.mjs';

// #537: check 3 used to compare each screenshot's commit time against the
// single most recent commit touching public-src/ as a whole, so a
// comment-only edit (e.g. v2.19.2's index.html/main.js comment tweaks)
// invalidated all seven screenshots. It now inspects each public-src/
// commit's actual diff and only counts it as visually relevant if at least
// one added/removed line isn't a whole-line comment or blank.
//
// These tests use the real git binary against throwaway temp repos, not a
// faked git — a fully mocked git layer is exactly what hid the #529
// shell-quoting bug in dev-stats.mjs.
describe('release-check screenshot freshness (#537)', () => {
    const repos = [];

    afterEach(() => {
        while (repos.length) {
            rmSync(repos.pop(), { recursive: true, force: true });
        }
    });

    function run(repo, args) {
        return execFileSync('git', args, { cwd: repo, encoding: 'utf8' });
    }

    let commitSeq = 0;
    function commitAll(repo, message) {
        commitSeq += 1;
        // Real successive `git commit` calls can land in the same wall-clock
        // second, which would make the "newer than the screenshot" ordering
        // this check depends on flaky. Pin author/committer dates so each
        // commit in a test is unambiguously later than the last.
        const iso = `2026-01-01T00:${String(commitSeq).padStart(2, '0')}:00Z`;
        run(repo, ['add', '-A']);
        execFileSync('git', ['commit', '--quiet', '-m', message], {
            cwd: repo,
            env: {
                ...process.env,
                GIT_AUTHOR_DATE: iso,
                GIT_COMMITTER_DATE: iso,
            },
        });
    }

    function makeRepo() {
        const repo = mkdtempSync(path.join(tmpdir(), 'glp-release-check-'));
        repos.push(repo);
        run(repo, ['init', '--quiet', '-b', 'main']);
        run(repo, ['config', 'user.email', 'test@example.com']);
        run(repo, ['config', 'user.name', 'Test']);
        mkdirSync(path.join(repo, 'public-src'), { recursive: true });
        mkdirSync(path.join(repo, 'docs', 'screenshots'), { recursive: true });
        return repo;
    }

    function writeIndexHtml(repo, body) {
        writeFileSync(path.join(repo, 'public-src', 'index.html'), body);
    }

    function seedRepo(repo) {
        writeIndexHtml(repo, '<html>\n<div>Hello</div>\n</html>\n');
        writeFileSync(path.join(repo, 'docs', 'screenshots', 'shot.png'), Buffer.from([0, 1, 2, 3]));
        commitAll(repo, 'initial: seed screenshot + public-src');
    }

    it('does not flag screenshots when a public-src/ commit is comment-only', () => {
        const repo = makeRepo();
        seedRepo(repo);

        writeIndexHtml(repo, '<html>\n<!-- just a comment -->\n<div>Hello</div>\n</html>\n');
        commitAll(repo, 'add an html comment');

        const failures = checkScreenshotFreshness(repo, 'public-src', 'docs/screenshots');
        expect(failures).toEqual([]);
    });

    it('flags screenshots when a public-src/ commit is a real markup change', () => {
        const repo = makeRepo();
        seedRepo(repo);

        writeIndexHtml(repo, '<html>\n<div>Hello World</div>\n</html>\n');
        commitAll(repo, 'change visible text');

        const failures = checkScreenshotFreshness(repo, 'public-src', 'docs/screenshots');
        expect(failures).toHaveLength(1);
        expect(failures[0]).toContain('shot.png');
    });

    it('flags a mixed commit (comment line + one real line)', () => {
        const repo = makeRepo();
        seedRepo(repo);

        writeIndexHtml(repo, '<html>\n<!-- comment -->\n<div>Hello World</div>\n</html>\n');
        commitAll(repo, 'comment plus a real change');

        const failures = checkScreenshotFreshness(repo, 'public-src', 'docs/screenshots');
        expect(failures).toHaveLength(1);
        expect(failures[0]).toContain('shot.png');
    });

    it('flags the set when only one of several newer commits is real', () => {
        const repo = makeRepo();
        seedRepo(repo);

        writeIndexHtml(repo, '<html>\n<!-- comment one -->\n<div>Hello</div>\n</html>\n');
        commitAll(repo, 'comment-only #1');

        writeIndexHtml(repo, '<html>\n<!-- comment one -->\n<div>Hello there</div>\n</html>\n');
        commitAll(repo, 'the one real change');

        writeIndexHtml(repo, '<html>\n<!-- comment one -->\n<!-- comment two -->\n<div>Hello there</div>\n</html>\n');
        commitAll(repo, 'comment-only #2');

        const failures = checkScreenshotFreshness(repo, 'public-src', 'docs/screenshots');
        expect(failures).toHaveLength(1);
        expect(failures[0]).toContain('shot.png');
    });

    it('does not crash and reports nothing stale when public-src/ has no commits newer than the screenshot', () => {
        const repo = makeRepo();
        seedRepo(repo);

        const failures = checkScreenshotFreshness(repo, 'public-src', 'docs/screenshots');
        expect(failures).toEqual([]);
    });
});

// Pure classification used by the commit-relevance scan above. No git
// involved — these pin down the conservative "ambiguous means code" rule
// the diff scanner relies on.
describe('isCommentOrBlankLine', () => {
    it('treats blank lines as non-visual regardless of file type', () => {
        expect(isCommentOrBlankLine('   ', '.js')).toBe(true);
        expect(isCommentOrBlankLine('', '.html')).toBe(true);
    });

    it('recognizes whole-line single-line comments per file type', () => {
        expect(isCommentOrBlankLine('// a js comment', '.js')).toBe(true);
        expect(isCommentOrBlankLine('/* a js block comment */', '.js')).toBe(true);
        expect(isCommentOrBlankLine('<!-- an html comment -->', '.html')).toBe(true);
        expect(isCommentOrBlankLine('/* a css comment */', '.css')).toBe(true);
    });

    it('treats a line with code plus a trailing comment as real', () => {
        expect(isCommentOrBlankLine('const x = 1; // trailing comment', '.js')).toBe(false);
    });

    it('treats multi-line comment continuation/boundary lines as code (conservative)', () => {
        expect(isCommentOrBlankLine('/* start of a multi-line comment', '.js')).toBe(false);
        expect(isCommentOrBlankLine(' * continuation line', '.js')).toBe(false);
        expect(isCommentOrBlankLine(' end of comment */', '.js')).toBe(false);
    });

    it('treats file types with no known comment syntax as always real', () => {
        expect(isCommentOrBlankLine('// looks like a comment but this is json', '.json')).toBe(false);
    });
});
