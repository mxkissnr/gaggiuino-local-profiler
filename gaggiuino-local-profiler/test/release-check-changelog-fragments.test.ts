import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkChangelogFragments } from '../scripts/release-check.mts';

// #1421 slice 2/2: the fragment collector folds changelog.d/<issue>.<section>.md
// into CHANGELOG.md and deletes the collected files at release time. A release
// cut while a fragment is still on disk ships a changelog missing that PR's
// entry, so the gate must refuse to pass rather than silently drop it. These
// tests exercise the check against real temp directories (no mocked fs), which
// is where a path/readdir mistake would actually show up.
describe('release-check changelog fragments (#1421)', () => {
    const dirs: string[] = [];

    afterEach(() => {
        while (dirs.length) {
            rmSync(dirs.pop()!, { recursive: true, force: true });
        }
    });

    function makeDir(): string {
        const dir = mkdtempSync(join(tmpdir(), 'glp-changelog-fragments-'));
        dirs.push(dir);
        return dir;
    }

    it('passes when changelog.d/ does not exist', () => {
        expect(checkChangelogFragments(join(makeDir(), 'changelog.d'))).toEqual([]);
    });

    it('passes when only README.md is present', () => {
        const dir = makeDir();
        writeFileSync(join(dir, 'README.md'), '# Changelog fragments\n');
        expect(checkChangelogFragments(dir)).toEqual([]);
    });

    it('fails and names a leftover fragment', () => {
        const dir = makeDir();
        writeFileSync(join(dir, 'README.md'), '# Changelog fragments\n');
        writeFileSync(join(dir, '1421.fixed.md'), '- **Fix.** Closes #1421\n');

        const failures = checkChangelogFragments(dir);
        expect(failures).toHaveLength(1);
        expect(failures[0]).toContain('1421.fixed.md');
        expect(failures[0]).toContain('1 changelog fragment(s) not collected');
        expect(failures[0]).toContain('npm run changelog:collect');
    });
});
