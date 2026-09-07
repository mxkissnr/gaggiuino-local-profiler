import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const { CARD_TOKENS } = require('../lib/card');

// #811: lib/card.js hand-mirrors public-src/style.css's design tokens
// because the server-side canvas renderer can't read CSS custom properties
// (see the GLP-CARD-TOKENS comment in lib/card.js). Nothing keeps that
// mirror in sync automatically -- THIS test is the only thing that does: it
// re-parses style.css's actual declarations and fails if lib/card.js's
// CARD_TOKENS constant has drifted from them.
//
// This does not implement full CSS cascade resolution -- it knows, by hand,
// which of the two gray-scale blocks fully re-declares every property it
// mirrors (both do) so no inheritance step is needed for those. If a future
// style.css change makes a block start relying on inheritance for a
// property this test checks, this test's block map needs updating by hand,
// same as lib/card.js's own CARD_TOKENS does.
//
// #1019: the crema-only dark/light variants (and their own style.css
// [data-accent="crema"] / [data-theme="light"][data-accent="crema"] blocks)
// were dropped along with Crema's whole special-cased accent behavior --
// every accent, old and new, now shares just these two plain scales.
const cssPath = path.join(__dirname, '..', 'public-src', 'style.css');
const css = fs.readFileSync(cssPath, 'utf8');

// Extracts the text of the FIRST top-level `selector { ... }` block whose
// selector text matches `selector` exactly (brace-depth scan, not regex, so
// nested/edge-case CSS can't fool it).
function blockFor(selector) {
  const start = css.indexOf(selector);
  if (start === -1) throw new Error(`selector not found in style.css: ${selector}`);
  const braceStart = css.indexOf('{', start);
  let depth = 0, i = braceStart;
  for (; i < css.length; i++) {
    if (css[i] === '{') depth++;
    else if (css[i] === '}') { depth--; if (depth === 0) break; }
  }
  return css.slice(braceStart, i + 1);
}

function cssVar(block, name) {
  const m = block.match(new RegExp(`--${name}:\\s*([^;]+);`));
  return m ? m[1].trim() : null;
}

const rootBlock  = blockFor(':root {');
const lightBlock = blockFor('[data-theme="light"] {');

describe('CARD_TOKENS mirrors public-src/style.css (#811 drift guard)', () => {
  it('type scale (--fs-1..6) matches :root', () => {
    for (let i = 1; i <= 6; i++) {
      const cssVal = cssVar(rootBlock, `fs-${i}`);
      expect(cssVal).not.toBeNull();
      expect(`${CARD_TOKENS.fs[i]}rem`).toBe(cssVal);
    }
  });

  it('spacing ladder (--sp-1..6) matches :root', () => {
    for (let i = 1; i <= 6; i++) {
      const cssVal = cssVar(rootBlock, `sp-${i}`);
      expect(cssVal).not.toBeNull();
      expect(`${CARD_TOKENS.sp[i]}px`).toBe(cssVal);
    }
  });

  it('radii (--radius / --radius-sm) match :root', () => {
    expect(`${CARD_TOKENS.radius}px`).toBe(cssVar(rootBlock, 'radius'));
    expect(`${CARD_TOKENS.radiusSm}px`).toBe(cssVar(rootBlock, 'radius-sm'));
  });

  const grayKeys = ['200', '400', '500', '700', '800', '900', '950'];

  it('dark gray scale matches :root', () => {
    for (const k of grayKeys) expect(CARD_TOKENS.gray.dark[k]).toBe(cssVar(rootBlock, `gray-${k}`));
  });

  it('light gray scale matches [data-theme="light"]', () => {
    for (const k of grayKeys) expect(CARD_TOKENS.gray.light[k]).toBe(cssVar(lightBlock, `gray-${k}`));
  });

  const semanticKeys = ['ok', 'warn', 'err'];

  it('dark semantic colours (--ok/--warn/--err) match :root', () => {
    for (const k of semanticKeys) expect(CARD_TOKENS.semantic.dark[k]).toBe(cssVar(rootBlock, k));
  });

  it('light semantic colours match [data-theme="light"]', () => {
    for (const k of semanticKeys) expect(CARD_TOKENS.semantic.light[k]).toBe(cssVar(lightBlock, k));
  });
});
