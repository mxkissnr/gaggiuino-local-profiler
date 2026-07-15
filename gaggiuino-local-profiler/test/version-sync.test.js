import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { load } from 'js-yaml';

const ROOT = path.resolve(import.meta.dirname, '..');

describe('version sync', () => {
    it('keeps package.json, config.yaml and lib/constants.js on the same version', () => {
        const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
        const config = load(fs.readFileSync(path.join(ROOT, 'config.yaml'), 'utf8'));
        const constants = fs.readFileSync(path.join(ROOT, 'lib/constants.js'), 'utf8');
        const constantsMatch = constants.match(/GLP_VERSION\s*=\s*'([^']+)'/);

        expect(constantsMatch).not.toBeNull();
        const constantsVersion = constantsMatch[1];

        expect(pkg.version).toBe(config.version);
        expect(pkg.version).toBe(constantsVersion);
    });
});
