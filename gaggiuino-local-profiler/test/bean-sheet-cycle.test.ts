// #1479: bean-sheet.ts and views/library.ts import each other. In the bundle
// bean-sheet's module body can run before library.ts finishes initialising, so
// copying the library namespace into a module-level alias captures it while it
// is still undefined and every sheet render then throws on the first call. The
// namespace is safe only when dereferenced inside a function, at call time.
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const appRoot = resolve(import.meta.dirname, '..');
const source = readFileSync(join(appRoot, 'public-src', 'views', 'library', 'bean-sheet.ts'), 'utf8');

describe('bean sheet / library import cycle (#1479)', () => {
    it('never copies the library namespace into a module-level alias', () => {
        // A top-level `const|let|var <name> = libraryView` is the pattern that
        // reads the namespace before library.ts has initialised; the call sites
        // inside functions are `libraryView.foo()` and are unaffected.
        const alias = /^[ \t]*(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*=\s*libraryView\b/m;
        expect(source).not.toMatch(alias);
    });

    it('keeps the namespace import for call-time use', () => {
        expect(source).toMatch(/import \* as libraryView from '\.\.\/library\.js';/);
    });
});
