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
