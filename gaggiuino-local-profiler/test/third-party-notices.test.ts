// #2027: THIRD_PARTY_NOTICES.md is copied into the image by the Dockerfile, but
// it only named onnxruntime-web and the image models — and named a version the
// lock file had already moved past. Nothing caught that: it is prose, so
// typecheck, lint and every DOM test stay green while the shipped file quietly
// stops matching what the app actually bundles. This guard ties the notices to
// the manifest and to each installed package's own version.
//
// #2080: the file moved to public-src/public/ so the Go server serves it to the
// settings UI, and it grew a Server section. That section is guarded on the Go
// side (go/cmd/server/third_party_notices_test.go), which compares it against
// `go list -deps`; this test only covers the npm packages and the fonts.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { NOTICE_GROUPS, parseNotices } from '../public-src/shared/third-party-notices.js';

const ROOT = resolve(import.meta.dirname, '..');

function read(...segments: string[]): string {
    return readFileSync(join(ROOT, ...segments), 'utf8');
}

function installedVersion(pkg: string): string {
    return (JSON.parse(read('node_modules', pkg, 'package.json')) as { version: string }).version;
}

const manifest = JSON.parse(read('package.json')) as { dependencies?: Record<string, string> };
const dependencies = Object.keys(manifest.dependencies ?? {}).sort();

// The fonts are not npm packages: they live as WOFF2 files in public-src/fonts
// with their OFL text next to them, so there is no manifest to read a version
// from and the heading only names the family.
const FONTS = ['Figtree', 'Fraunces'];

const notices = read('public-src', 'public', 'THIRD_PARTY_NOTICES.md');

const headings = notices.split('\n').filter((line) => line.startsWith('### '));

function hasSection(name: string, version: string): boolean {
    return headings.includes(`### ${name} ${version}`);
}

// Font headings name the family and the bundled weights, e.g.
// "### Figtree 400, 600", so they match on the family prefix only.
function hasFontSection(family: string): boolean {
    return headings.some((line) => line.startsWith(`### ${family} `));
}

describe('THIRD_PARTY_NOTICES.md', () => {
    it('has a section for every runtime dependency, at its installed version', () => {
        expect(dependencies.length).toBeGreaterThan(0);
        const missing: string[] = [];
        for (const name of dependencies) {
            const version = installedVersion(name);
            if (!hasSection(name, version)) missing.push(`${name} ${version}`);
        }
        expect(
            missing,
            'bundled package(s) with no matching "### <name> <version>" section:\n' + missing.join('\n'),
        ).toEqual([]);
    });

    it('has a section for every bundled font', () => {
        const missing = FONTS.filter((font) => !hasFontSection(font));
        expect(missing, 'bundled font(s) with no section:\n' + missing.join('\n')).toEqual([]);
    });

    // The settings UI and the parser in #2080 slice 3 group the components by
    // these headings and walk them in this order, so a reordering or a renamed
    // group breaks the About page rather than this test being cosmetic.
    it('groups the components under the headings the UI expects, in order', () => {
        const groups = ['## Libraries', '## Fonts', '## Models', '## Server', '## Full licence texts'].map(
            (heading) => notices.split('\n').indexOf(heading),
        );
        expect(groups, 'missing group heading(s) in THIRD_PARTY_NOTICES.md').not.toContain(-1);
        expect(groups, 'group headings are out of order').toEqual([...groups].sort((a, b) => a - b));
    });
});

// The parser below is what the About sheet will read the file with, so these
// cases are the guard that every licence a component names also has a full
// text: prose can name a licence the file never reproduces, and nothing else
// in the tree would notice.
describe('parseNotices', () => {
    const parsed = parseNotices(notices);

    it('finds components in every group', () => {
        const missing = NOTICE_GROUPS.filter(
            (group) => !parsed.components.some((component) => component.group === group),
        );
        expect(missing, 'group(s) with no parsed component:\n' + missing.join('\n')).toEqual([]);
    });

    it('gives every component a unique title', () => {
        const seen = new Set<string>();
        const duplicates: string[] = [];
        for (const component of parsed.components) {
            if (seen.has(component.title)) duplicates.push(component.title);
            seen.add(component.title);
        }
        expect(duplicates, 'duplicate component heading(s):\n' + duplicates.join('\n')).toEqual([]);
    });

    it('gives every component a purpose, a licence and a source', () => {
        const bad = parsed.components
            .filter(
                (component) =>
                    !component.purpose.endsWith('.') ||
                    component.licence === '' ||
                    !/^https:\/\/\S+$/.test(component.source),
            )
            .map((component) => component.title);
        expect(bad, 'component(s) with an incomplete entry:\n' + bad.join('\n')).toEqual([]);
    });

    it('reproduces a full text for every licence a component names', () => {
        const names = parsed.licences.map((licence) => licence.name);
        const uncovered = parsed.components
            .filter((component) => !names.some((name) => component.licence.includes(name)))
            .map((component) => `${component.title} (${component.licence})`);
        expect(uncovered, 'component(s) naming a licence with no text:\n' + uncovered.join('\n')).toEqual([]);
    });

    it('reproduces the GPL and MPL texts in full', () => {
        for (const name of ['GNU General Public License v3.0', 'Mozilla Public License 2.0']) {
            const licence = parsed.licences.find((entry) => entry.name === name);
            expect(licence, `no licence block for ${name}`).toBeDefined();
            expect(licence?.text.length ?? 0, `${name} text looks truncated`).toBeGreaterThan(1000);
        }
    });

    it('counts every licence block heading', () => {
        const headingsWithCovers = notices
            .split('\n')
            .filter((line) => line.startsWith('### ') && line.includes(' — ')).length;
        expect(parsed.licences.length).toBe(headingsWithCovers);
    });

    it('keeps only the first sentence of a wrapped purpose paragraph', () => {
        const md = [
            '## Libraries',
            '',
            '### thing 1.0.0',
            '',
            'Renders the shot card. It also does more,',
            'wrapped onto a second line.',
            '',
            '- Licensed under the MIT License.',
        ].join('\n');
        const [component] = parseNotices(md).components;
        expect(component?.purpose).toBe('Renders the shot card.');
    });

    it('drops the note in brackets from a wrapped Licensed under bullet', () => {
        const md = [
            '## Server',
            '',
            '### github.com/example/mod v1.0.0',
            '',
            'Something.',
            '',
            '- Licensed under the BSD 3-Clause License (as the Eclipse Distribution',
            '  License 1.0).',
        ].join('\n');
        const [component] = parseNotices(md).components;
        expect(component?.licence).toBe('BSD 3-Clause License');
    });

    it('takes the first URL of a Sources bullet', () => {
        const md = [
            '## Models',
            '',
            '### model',
            '',
            'Something.',
            '',
            '- Sources: https://example.com/a and',
            '  https://example.com/b',
        ].join('\n');
        const [component] = parseNotices(md).components;
        expect(component?.source).toBe('https://example.com/a');
    });

    it('parses CRLF input the same as LF', () => {
        const md = [
            '## Libraries',
            '',
            '### thing 1.0.0',
            '',
            'Purpose here.',
            '',
            '- Licensed under the MIT License.',
            '- Source: https://example.com/thing',
            '',
            '## Full licence texts',
            '',
            '### MIT License — thing',
            '',
            'Text.',
        ].join('\n');
        expect(parseNotices(md.replace(/\n/g, '\r\n'))).toEqual(parseNotices(md));
    });

    it('ignores ### headings under an unknown ## heading', () => {
        const md = ['## Notes', '', '### stray', '', 'Body.'].join('\n');
        expect(parseNotices(md)).toEqual({ components: [], licences: [] });
    });

    it('returns a component with empty fields rather than throwing', () => {
        const md = ['## Libraries', '', '### bare 1.0.0'].join('\n');
        const [component] = parseNotices(md).components;
        expect(component).toEqual({ group: 'Libraries', title: 'bare 1.0.0', purpose: '', licence: '', source: '' });
    });

    it('leaves covers empty when a licence heading has no dash', () => {
        const md = ['## Full licence texts', '', '### MIT License', '', 'Text.'].join('\n');
        const [licence] = parseNotices(md).licences;
        expect(licence?.name).toBe('MIT License');
        expect(licence?.covers).toBe('');
    });

    it('keeps the inner blank lines of a licence text', () => {
        const md = [
            '## Full licence texts',
            '',
            '### MIT License — thing',
            '',
            'First paragraph.',
            '',
            'Second paragraph.',
        ].join('\n');
        const [licence] = parseNotices(md).licences;
        expect(licence?.text).toBe('First paragraph.\n\nSecond paragraph.');
    });
});
