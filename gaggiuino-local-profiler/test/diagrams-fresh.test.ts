// #1239: README.md embeds the architecture diagrams as SVG images, not
// Mermaid source. Each SVG carries a source-sha256 comment written by
// scripts/render-diagrams.ts; if a .mmd changes without re-rendering, the
// committed SVG goes stale and this test fails.
import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const diagramsDir = join(__dirname, '..', '..', 'docs', 'diagrams');
const STALE_MESSAGE =
    'diagram SVG is stale: run `npm run diagrams:render` in gaggiuino-local-profiler/';

const mmdFiles = readdirSync(diagramsDir).filter((file) => file.endsWith('.mmd'));
const variants: ReadonlyArray<readonly [string, string]> = [
    ['light', ''],
    ['dark', '-dark'],
];

describe('README architecture diagrams are fresh (#1239)', () => {
    it('has .mmd sources to check', () => {
        expect(mmdFiles.length).toBeGreaterThan(0);
    });

    for (const mmdFile of mmdFiles) {
        const name = mmdFile.slice(0, -'.mmd'.length);
        const sha256 = createHash('sha256')
            .update(readFileSync(join(diagramsDir, mmdFile), 'utf8'))
            .digest('hex');
        const marker = `<!-- source-sha256: ${sha256} -->`;

        for (const [label, suffix] of variants) {
            it(`${name}${suffix}.svg (${label}) matches ${mmdFile}`, () => {
                const svgPath = join(diagramsDir, `${name}${suffix}.svg`);
                expect(existsSync(svgPath), STALE_MESSAGE).toBe(true);
                expect(readFileSync(svgPath, 'utf8'), STALE_MESSAGE).toContain(marker);
            });
        }
    }
});
