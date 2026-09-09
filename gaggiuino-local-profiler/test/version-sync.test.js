import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');

// config.yaml's `version:` is the canonical GLP version (Home Assistant
// Supervisor reads it directly). Every other place the version is hard-coded
// must match it: package.json plus the two Go consts the backend serves from
// (GET /api/version) and stamps into backup bundles. Bumped in exactly these
// four spots at release time — see CLAUDE.md's Versioning section.
function read(rel) {
    return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

describe('version sync', () => {
    const configMatch = read('config.yaml').match(/^version:\s*"([^"]+)"/m);
    const canonical = configMatch && configMatch[1];

    it('has a parseable canonical version in config.yaml', () => {
        expect(canonical).toMatch(/^\d+\.\d+\.\d+$/);
    });

    it('matches package.json', () => {
        expect(JSON.parse(read('package.json')).version).toBe(canonical);
    });

    it('matches go/internal/system/version.go glpVersion', () => {
        const m = read('go/internal/system/version.go').match(/const\s+glpVersion\s*=\s*"([^"]+)"/);
        expect(m).not.toBeNull();
        expect(m[1]).toBe(canonical);
    });

    it('matches go/internal/backup/bundle.go glpVersion', () => {
        const m = read('go/internal/backup/bundle.go').match(/const\s+glpVersion\s*=\s*"([^"]+)"/);
        expect(m).not.toBeNull();
        expect(m[1]).toBe(canonical);
    });
});
