import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');

// config.yaml's `version:` is the canonical GLP version (Home Assistant
// Supervisor reads it directly). Every other place the version is hard-coded
// must match it: package.json plus the two Go consts the backend serves from
// (GET /api/version) and stamps into backup bundles. Bumped in exactly these
// four spots at release time — see CLAUDE.md's Versioning section.
function read(rel: string): string {
    return readFileSync(join(ROOT, rel), 'utf8');
}

// package.json is foreign JSON here; only its `version` column is read.
interface PackageJson {
    version: string;
}

describe('version sync', () => {
    const configMatch = read('config.yaml').match(/^version:\s*"([^"]+)"/m);
    const canonical = configMatch && configMatch[1];

    it('has a parseable canonical version in config.yaml', () => {
        expect(canonical).toMatch(/^\d+\.\d+\.\d+$/);
    });

    it('matches package.json', () => {
        const pkg = JSON.parse(read('package.json')) as PackageJson;
        expect(pkg.version).toBe(canonical);
    });

    it('matches go/internal/system/version.go glpVersion', () => {
        const m = read('go/internal/system/version.go').match(/const\s+glpVersion\s*=\s*"([^"]+)"/);
        expect(m).not.toBeNull();
        expect(m?.[1]).toBe(canonical);
    });

    it('matches go/internal/backup/bundle.go glpVersion', () => {
        const m = read('go/internal/backup/bundle.go').match(/const\s+glpVersion\s*=\s*"([^"]+)"/);
        expect(m).not.toBeNull();
        expect(m?.[1]).toBe(canonical);
    });
});
