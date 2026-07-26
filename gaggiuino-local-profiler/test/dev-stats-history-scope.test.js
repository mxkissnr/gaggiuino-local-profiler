import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { historyScope } from '../scripts/dev-stats.mjs';

// #527: dev-stats used to measure the checked-out HEAD, so a run from a
// main-based worktree published lower numbers than a run from dev (precedent:
// #523 rewrote DEVELOPMENT.md from 655 to 619 commits). The scope must depend
// on the repo's remote refs, never on which branch happens to be checked out.
describe('dev-stats history scope (#527)', () => {
    it('measures all origin refs when the repo has them', () => {
        const fakeGit = () => 'refs/remotes/origin/main\nrefs/remotes/origin/dev';
        expect(historyScope('/any/dir', fakeGit)).toBe('--remotes=origin');
    });

    it('is the same regardless of which branch is checked out', () => {
        // The helper never inspects HEAD, so a main worktree and a dev worktree
        // with identical remotes must resolve to the same scope.
        const refs = () => 'refs/remotes/origin/main\nrefs/remotes/origin/dev';
        expect(historyScope('/worktree-on-main', refs)).toBe(historyScope('/worktree-on-dev', refs));
    });

    it('falls back to HEAD in a clone without origin refs', () => {
        const noRefs = () => '';
        expect(historyScope('/fresh/init', noRefs)).toBe('HEAD');
    });

    it('falls back to HEAD when git itself errors out', () => {
        const throwing = () => { throw new Error('not a git repository'); };
        expect(historyScope('/not/a/repo', throwing)).toBe('HEAD');
    });
});

// #529: the tests above inject a fake runGit, so they exercise the branching
// logic but never run a real git command — which is how a malformed command
// string stayed invisible. The original implementation passed an unquoted
// `--format=%(refname)`, and since git() shells out via /bin/sh, the shell
// aborted before git ran. The throw landed in the same catch that handles the
// legitimate "no origin refs" case, so the scope silently degraded to HEAD and
// #528 never took effect. These tests use the real git binary.
describe('dev-stats history scope — real git (#529)', () => {
    let repo;

    const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' });

    beforeAll(() => {
        repo = mkdtempSync(path.join(tmpdir(), 'glp-devstats-'));
        git('init', '--quiet', '-b', 'main');
        git('config', 'user.email', 'test@example.com');
        git('config', 'user.name', 'Test');
        git('commit', '--quiet', '--allow-empty', '-m', 'initial');
    });

    afterAll(() => {
        if (repo) rmSync(repo, { recursive: true, force: true });
    });

    it('resolves to --remotes=origin against a repo that really has origin refs', () => {
        git('update-ref', 'refs/remotes/origin/main', 'HEAD');
        // Fails with 'HEAD' if the underlying git invocation is malformed.
        expect(historyScope(repo)).toBe('--remotes=origin');
    });

    it('resolves to HEAD against a repo that really has no origin refs', () => {
        git('update-ref', '-d', 'refs/remotes/origin/main');
        expect(historyScope(repo)).toBe('HEAD');
    });
});
