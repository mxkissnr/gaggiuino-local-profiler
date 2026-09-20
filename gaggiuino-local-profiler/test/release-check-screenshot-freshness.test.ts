import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import {
    checkScreenshotFreshness,
    stripJsLikeComments,
    stripHtmlComments,
    stripCssComments,
} from '../scripts/release-check.mjs';

// #537: check 3 used to compare each screenshot's commit time against the
// single most recent commit touching public-src/ as a whole, so a
// comment-only edit (e.g. v2.19.2's index.html/main.js comment tweaks)
// invalidated all seven screenshots. A first fix classified individual diff
// lines as comment-or-not, but that fails on the actual case #537 was filed
// for: this codebase's comments are routinely multi-line (a <!-- --> or
// /* */ block spanning several lines), and no single added/removed line in
// such a block opens *and* closes the comment on its own — so a per-line
// classifier calls all of them "code" and the bug persists. The check now
// strips comments from whole file contents (old vs. new blob) and compares
// what's left, which handles multi-line blocks the same as single-line
// ones.
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

    function writeFile(repo, relPath, body) {
        writeFileSync(path.join(repo, 'public-src', relPath), body);
    }

    // extraFiles lets a test seed additional public-src/ files (main.js,
    // style.css, ...) in the *same* initial commit as the screenshot, so
    // only the test's own follow-up commit is newer than the screenshot —
    // otherwise "add main.js" would itself be a brand-new (and correctly
    // relevant) file-creation commit newer than the screenshot.
    function seedRepo(repo, indexHtmlBody, extraFiles = {}) {
        writeFile(repo, 'index.html', indexHtmlBody);
        for (const [relPath, body] of Object.entries(extraFiles)) {
            writeFile(repo, relPath, body);
        }
        writeFileSync(path.join(repo, 'docs', 'screenshots', 'shot.png'), Buffer.from([0, 1, 2, 3]));
        commitAll(repo, 'initial: seed screenshot + public-src');
    }

    it('does not flag screenshots when a public-src/ commit is comment-only (single-line)', () => {
        const repo = makeRepo();
        seedRepo(repo, '<html>\n<div>Hello</div>\n</html>\n');

        writeFile(repo, 'index.html', '<html>\n<!-- just a comment -->\n<div>Hello</div>\n</html>\n');
        commitAll(repo, 'add an html comment');

        const failures = checkScreenshotFreshness(repo, 'public-src', 'docs/screenshots');
        expect(failures).toEqual([]);
    });

    it('flags screenshots when a public-src/ commit is a real markup change', () => {
        const repo = makeRepo();
        seedRepo(repo, '<html>\n<div>Hello</div>\n</html>\n');

        writeFile(repo, 'index.html', '<html>\n<div>Hello World</div>\n</html>\n');
        commitAll(repo, 'change visible text');

        const failures = checkScreenshotFreshness(repo, 'public-src', 'docs/screenshots');
        expect(failures).toHaveLength(1);
        expect(failures[0]).toContain('shot.png');
    });

    it('flags a mixed commit (comment line + one real line)', () => {
        const repo = makeRepo();
        seedRepo(repo, '<html>\n<div>Hello</div>\n</html>\n');

        writeFile(repo, 'index.html', '<html>\n<!-- comment -->\n<div>Hello World</div>\n</html>\n');
        commitAll(repo, 'comment plus a real change');

        const failures = checkScreenshotFreshness(repo, 'public-src', 'docs/screenshots');
        expect(failures).toHaveLength(1);
        expect(failures[0]).toContain('shot.png');
    });

    it('flags the set when only one of several newer commits is real', () => {
        const repo = makeRepo();
        seedRepo(repo, '<html>\n<!-- comment one -->\n<div>Hello</div>\n</html>\n');

        writeFile(repo, 'index.html', '<html>\n<!-- comment one -->\n<div>Hello there</div>\n</html>\n');
        commitAll(repo, 'the one real change');

        writeFile(repo, 'index.html', '<html>\n<!-- comment one -->\n<!-- comment two -->\n<div>Hello there</div>\n</html>\n');
        commitAll(repo, 'comment-only #2');

        const failures = checkScreenshotFreshness(repo, 'public-src', 'docs/screenshots');
        expect(failures).toHaveLength(1);
        expect(failures[0]).toContain('shot.png');
    });

    it('does not crash and reports nothing stale when public-src/ has no commits newer than the screenshot', () => {
        const repo = makeRepo();
        seedRepo(repo, '<html>\n<div>Hello</div>\n</html>\n');

        const failures = checkScreenshotFreshness(repo, 'public-src', 'docs/screenshots');
        expect(failures).toEqual([]);
    });

    it('does not flag a reworded multi-line HTML comment block', () => {
        const repo = makeRepo();
        seedRepo(
            repo,
            '<html>\n' +
            '<!-- Only shown once a valid session token was obtained (ingress or\n' +
            '     already-authenticated) -->\n' +
            '<div>Hello</div>\n</html>\n'
        );

        writeFile(
            repo,
            'index.html',
            '<html>\n' +
            '<!-- Shown once the session holds a token. Since #533 /api/token serves\n' +
            '     any caller that can reach the port, so this is populated on ingress\n' +
            '     and direct-port access alike. -->\n' +
            '<div>Hello</div>\n</html>\n'
        );
        commitAll(repo, 'reword a multi-line html comment');

        const failures = checkScreenshotFreshness(repo, 'public-src', 'docs/screenshots');
        expect(failures).toEqual([]);
    });

    it('does not flag a reworded multi-line JS block comment', () => {
        const repo = makeRepo();
        seedRepo(repo, '<html></html>\n', {
            'main.js': '/*\n * old explanation\n * across lines\n */\nconsole.log("hi");\n',
        });

        writeFile(
            repo,
            'main.js',
            '/*\n * new explanation\n * still across lines\n */\nconsole.log("hi");\n'
        );
        commitAll(repo, 'reword a multi-line js comment');

        const failures = checkScreenshotFreshness(repo, 'public-src', 'docs/screenshots');
        expect(failures).toEqual([]);
    });

    it('does not flag a reworded multi-line CSS block comment', () => {
        const repo = makeRepo();
        seedRepo(repo, '<html></html>\n', {
            'style.css': '/*\n * old note\n * about this rule\n */\n.foo { color: red; }\n',
        });

        writeFile(
            repo,
            'style.css',
            '/*\n * new note\n * about this rule\n */\n.foo { color: red; }\n'
        );
        commitAll(repo, 'reword a multi-line css comment');

        const failures = checkScreenshotFreshness(repo, 'public-src', 'docs/screenshots');
        expect(failures).toEqual([]);
    });

    it('flags a commit that reworks a multi-line comment AND changes a code line in the same file', () => {
        const repo = makeRepo();
        seedRepo(repo, '<html></html>\n', {
            'main.js': '/*\n * old explanation\n * across lines\n */\nconsole.log("hi");\n',
        });

        writeFile(
            repo,
            'main.js',
            '/*\n * new explanation\n * still across lines\n */\nconsole.log("bye");\n'
        );
        commitAll(repo, 'reword comment and change a real line');

        const failures = checkScreenshotFreshness(repo, 'public-src', 'docs/screenshots');
        expect(failures).toHaveLength(1);
        expect(failures[0]).toContain('shot.png');
    });

    // Regression fixture for the exact case reported against the first fix:
    // v2.19.2's real diff on public-src/index.html was a multi-line <!-- -->
    // block being reworded, nothing else. The line-based classifier flagged
    // it as relevant (bug); the content-diff approach must not.
    it('reproduces the v2.19.2 index.html comment-reword as not relevant (regression fixture)', () => {
        const repo = makeRepo();
        seedRepo(
            repo,
            '<div class="token-note">\n' +
            '        <!-- Only shown once a valid session token was obtained (ingress or\n' +
            '             already-authenticated) — the endpoint no longer hands out the\n' +
            '             token to unauthenticated LAN callers, see #276 -->\n' +
            '</div>\n'
        );

        writeFile(
            repo,
            'index.html',
            '<div class="token-note">\n' +
            '        <!-- Shown once the session holds a token. Since #533 /api/token serves\n' +
            '             any caller that can reach the port, so this is populated on ingress\n' +
            '             and direct-port access alike. -->\n' +
            '</div>\n'
        );
        commitAll(repo, 'fix: /api/token direct-port regression comment update');

        const failures = checkScreenshotFreshness(repo, 'public-src', 'docs/screenshots');
        expect(failures).toEqual([]);
    });
});

// Pure comment strippers used by the commit-relevance scan above. No git
// involved — these pin down string/template-literal awareness and the
// conservative token-boundary handling (a stripped comment becomes a
// single space, never nothing, so adjacent tokens can't fuse together).
describe('stripJsLikeComments', () => {
    it('strips single-line // and whole-line /* */ comments', () => {
        expect(stripJsLikeComments('// a comment\ncode();')).toBe('\ncode();');
        expect(stripJsLikeComments('/* a comment */code();')).toBe(' code();');
    });

    it('strips a multi-line block comment, preserving line count', () => {
        const src = '/*\n * line one\n * line two\n */\ncode();';
        const stripped = stripJsLikeComments(src);
        expect(stripped).not.toContain('line one');
        expect(stripped).not.toContain('line two');
        expect(stripped).toContain('code();');
    });

    it('does not strip comment-like sequences inside strings', () => {
        expect(stripJsLikeComments('const u = "http://example.com/*x*/";')).toBe(
            'const u = "http://example.com/*x*/";'
        );
        expect(stripJsLikeComments("const c = '// not a comment';")).toBe(
            "const c = '// not a comment';"
        );
    });

    it('does not strip comment-like sequences inside a template literal, including nested backticks', () => {
        const src = 'const html = `<span>${items.map(i => `// ${i}`).join("")}</span>`;';
        expect(stripJsLikeComments(src)).toBe(src);
    });

    it('does not merge tokens across a removed comment', () => {
        expect(stripJsLikeComments('x/*c*/y')).toBe('x y');
    });
});

describe('stripHtmlComments', () => {
    it('strips a multi-line <!-- --> block', () => {
        const src = '<div>\n<!-- line one\n     line two -->\n<span>keep</span>\n</div>';
        const stripped = stripHtmlComments(src);
        expect(stripped).not.toContain('line one');
        expect(stripped).not.toContain('line two');
        expect(stripped).toContain('<span>keep</span>');
    });

    it('leaves an unterminated comment marker untouched rather than eating the rest of the file', () => {
        const src = '<div><!-- never closed<span>real content</span>';
        expect(stripHtmlComments(src)).toBe(src);
    });
});

describe('stripCssComments', () => {
    it('strips a multi-line /* */ block', () => {
        const src = '/*\n * line one\n * line two\n */\n.foo { color: red; }';
        const stripped = stripCssComments(src);
        expect(stripped).not.toContain('line one');
        expect(stripped).toContain('.foo { color: red; }');
    });

    it('does not strip comment-like sequences inside a CSS string', () => {
        const src = '.foo::before { content: "/* not a comment */"; }';
        expect(stripCssComments(src)).toBe(src);
    });
});
