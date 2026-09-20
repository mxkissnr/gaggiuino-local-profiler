// style.css has to survive PostCSS, because a stylesheet that does not parse
// fails at `npm run build` and nowhere earlier: the test suite never loads
// the file and ESLint does not look at CSS. That gap shipped a real break in
// this round -- an explanatory comment mentioned the token names
// "--gray-*/--err", and the "*/" inside it closed the comment early, so the
// rest of the prose was parsed as CSS.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import postcss from 'postcss';

const here = dirname(fileURLToPath(import.meta.url));
const CSS_PATH = join(here, '..', 'public-src', 'style.css');

describe('public-src/style.css', () => {
  it('parses as CSS', () => {
    const css = readFileSync(CSS_PATH, 'utf-8');
    expect(() => postcss.parse(css, { from: CSS_PATH })).not.toThrow();
  });

  it('has no comment that closes itself early', () => {
    // Independent of the parser, and it points straight at the offending
    // line instead of at the far-away place where parsing finally gave up.
    const lines = readFileSync(CSS_PATH, 'utf-8').split('\n');
    let open = false;
    lines.forEach((line, n) => {
      let i = 0;
      while (i < line.length - 1) {
        const two = line.slice(i, i + 2);
        if (!open && two === '/*') { open = true; i += 2; continue; }
        if (open && two === '*/') { open = false; i += 2; continue; }
        expect(
          !(!open && two === '*/'),
          `stray "*/" at style.css:${n + 1} — a comment closed earlier than intended`,
        ).toBe(true);
        i += 1;
      }
    });
    expect(open, 'style.css ends inside an unclosed comment').toBe(false);
  });
});
