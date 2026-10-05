import { describe, it, expect } from 'vitest';
import { collectChangelog } from '../scripts/changelog-collect.mts';

// #1421: every PR used to edit the same spot under `## [Unreleased]` in
// CHANGELOG.md, so each merge into dev made every other open PR conflict and
// the resync push dismissed approvals. Fragments (one new file per PR) never
// conflict; these tests exercise the pure collector that folds them back into
// CHANGELOG.md.

function fragment(name: string, content: string) {
    return { name, content };
}

const release = '## [3.3.0] – 2026-10-02';

describe('collectChangelog (#1421)', () => {
    it('appends a fragment under an existing subheading, after its bullets', () => {
        const changelog = ['## [Unreleased]', '### Added', '- **Existing.**', '', release].join('\n');

        const out = collectChangelog(changelog, [
            fragment('1421.added.md', '- **New thing.** Closes #1421'),
        ]);

        expect(out).toContain('### Added\n- **Existing.**\n- **New thing.** Closes #1421');
    });

    it('creates a missing subheading in Keep-a-Changelog order', () => {
        const changelog = ['## [Unreleased]', '### Added', '- **Existing.**', '', release].join('\n');

        const out = collectChangelog(changelog, [
            fragment('1421.security.md', '- **Secure thing.**'),
            fragment('1421.fixed.md', '- **Fixed thing.**'),
        ]);

        expect(out).toContain(
            '### Added\n- **Existing.**\n### Fixed\n- **Fixed thing.**\n### Security\n- **Secure thing.**',
        );
    });

    it('creates `## [Unreleased]` at the top when it is missing', () => {
        const changelog = [release, '### Added', '- **Shipped.**'].join('\n');

        const out = collectChangelog(changelog, [fragment('1421.fixed.md', '- **Fixed thing.**')]);

        expect(out.startsWith('## [Unreleased]\n### Fixed\n- **Fixed thing.**\n\n')).toBe(true);
        expect(out).toContain(release);
    });

    it('sorts by issue number, then by suffix', () => {
        const changelog = ['## [Unreleased]', '', release].join('\n');

        const out = collectChangelog(changelog, [
            fragment('1421-2.fixed.md', '- **second**'),
            fragment('1421.fixed.md', '- **first**'),
            fragment('999.fixed.md', '- **older**'),
            fragment('1430.fixed.md', '- **later**'),
        ]);

        expect(out).toContain(
            '### Fixed\n- **older**\n- **first**\n- **second**\n- **later**',
        );
    });

    it('rejects an unknown section, naming the file', () => {
        expect(() =>
            collectChangelog('## [Unreleased]\n', [fragment('1421.banana.md', '- **x**')]),
        ).toThrow(/1421\.banana\.md/);
    });

    it('rejects a name without a leading issue number, naming the file', () => {
        expect(() =>
            collectChangelog('## [Unreleased]\n', [fragment('nope.fixed.md', '- **x**')]),
        ).toThrow(/nope\.fixed\.md/);
    });

    it('rejects a fragment with no bullet line, naming the file', () => {
        expect(() =>
            collectChangelog('## [Unreleased]\n', [fragment('1421.fixed.md', 'no bullet here')]),
        ).toThrow(/1421\.fixed\.md/);
    });

    it('leaves released sections untouched', () => {
        const releasedBody = [
            release,
            '### Added',
            '- **Shipped.**',
            '',
            '## [3.2.0] – 2026-09-26',
            '### Fixed',
            '- **Old fix.**',
        ].join('\n');
        const changelog = ['## [Unreleased]', '', releasedBody].join('\n');

        const out = collectChangelog(changelog, [fragment('1421.fixed.md', '- **New fix.**')]);

        expect(out).toContain(releasedBody);
    });

    it('is a no-op for an empty fragment list', () => {
        const changelog = '## [Unreleased]\n### Added\n- **Existing.**\n';

        expect(collectChangelog(changelog, [])).toBe(changelog);
    });
});
