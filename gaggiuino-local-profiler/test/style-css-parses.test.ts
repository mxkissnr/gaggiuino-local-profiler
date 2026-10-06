// style.css has to survive PostCSS, because a stylesheet that does not parse
// fails at `npm run build` and nowhere earlier: the test suite never loads
// the file and ESLint does not look at CSS. That gap shipped a real break in
// this round -- an explanatory comment mentioned the token names
// "--gray-*/--err", and the "*/" inside it closed the comment early, so the
// rest of the prose was parsed as CSS.
// flavor-wheel-no-root-crossfade.test.ts (#1482) reads this same stylesheet
// and asserts the root view-transition rule, so keep this parse check over
// the whole file.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
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
    // The scan touches every character, so the first stray is recorded and
    // asserted once: calling expect() per character is slow enough on this
    // ~220 kB stylesheet to blow the default test timeout.
    const lines = readFileSync(CSS_PATH, 'utf-8').split('\n');
    let open = false;
    let strayLine = 0;
    lines.forEach((line, n) => {
      let i = 0;
      while (i < line.length - 1) {
        const two = line.slice(i, i + 2);
        if (!open && two === '/*') { open = true; i += 2; continue; }
        if (open && two === '*/') { open = false; i += 2; continue; }
        if (!open && two === '*/' && strayLine === 0) strayLine = n + 1;
        i += 1;
      }
    });
    expect(
      strayLine,
      `stray "*/" at style.css:${strayLine} — a comment closed earlier than intended`,
    ).toBe(0);
    expect(open, 'style.css ends inside an unclosed comment').toBe(false);
  });

  it('disables the tap highlight in the body rule', () => {
    const root = postcss.parse(readFileSync(CSS_PATH, 'utf-8'), { from: CSS_PATH });
    const body = root.nodes.find((n) => n.type === 'rule' && n.selector === 'body');
    expect(body, 'style.css has no `body { ... }` rule').toBeDefined();
    expect(body?.toString()).toContain('-webkit-tap-highlight-color: transparent');
  });
});
