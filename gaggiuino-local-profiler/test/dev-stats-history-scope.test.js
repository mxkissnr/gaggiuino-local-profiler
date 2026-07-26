import { describe, it, expect } from 'vitest';
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
