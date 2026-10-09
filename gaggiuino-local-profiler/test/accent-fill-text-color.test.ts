import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// A rule that fills with the exact accent (background: var(--accent)) has to
// draw its text with --accent-text. On dark themes --accent-ink is just
// var(--accent), so using it as the text colour paints the label in its own
// fill colour (#1531). style.css is only ever read, never imported, like in
// test/library-shelf-tile-slots.test.ts.
const __dirname = dirname(fileURLToPath(import.meta.url));
const CSS = readFileSync(join(__dirname, '../public-src/style.css'), 'utf8');

// Comments mention token names too; only real declarations count.
const CSS_NO_COMMENTS = CSS.replace(/\/\*[\s\S]*?\*\//g, '');

// Exactly --accent: the trailing \) rules out --accent-* variants such as
// --accent-glow and --accent-from.
const ACCENT_BACKGROUND = /background\s*:\s*var\(\s*--accent\s*\)/g;
const ACCENT_INK_COLOR = /color\s*:\s*var\(\s*--accent-ink\s*\)/;

// Declarations do not nest, so a declaration belongs to the rule spanning from
// the nearest brace before it to the next closing brace.
function declarationBlock(source: string, index: number): string {
  const start = Math.max(source.lastIndexOf('{', index), source.lastIndexOf('}', index));
  const end = source.indexOf('}', index);
  return source.slice(start, end === -1 ? undefined : end);
}

describe('accent fill pairs with --accent-text (#1531)', () => {
  it('never sets --accent-ink as the text colour of an accent-filled rule', () => {
    const offenders: string[] = [];
    for (const match of CSS_NO_COMMENTS.matchAll(ACCENT_BACKGROUND)) {
      const block = declarationBlock(CSS_NO_COMMENTS, match.index ?? 0);
      if (ACCENT_INK_COLOR.test(block)) offenders.push(block.trim().slice(0, 160));
    }
    expect(offenders).toEqual([]);
  });

  it('gives .lib-sheet-save the --accent-text colour it shares with .lib-save-btn', () => {
    const rule = CSS_NO_COMMENTS.match(/\.lib-sheet-save\s*\{[^}]*\}/)?.[0] ?? '';
    expect(rule).toContain('background: var(--accent)');
    expect(rule).toContain('color: var(--accent-text)');
    expect(rule).not.toContain('color: var(--accent-ink)');
  });
});
