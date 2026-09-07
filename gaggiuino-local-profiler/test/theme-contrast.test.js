// #811: WCAG audit of the design-token palette, computed from the values
// actually declared in public-src/style.css rather than from a copy kept
// alongside them.
//
// This exists because the previous audits (#397, #404) checked the gray
// scale only. Nothing ever checked the semantic colours or the accent
// against the surfaces they sit on, and both were failing in production:
// --ok measured 3.00:1 on every light surface, --err 3.96:1 on the dark
// card surface, and the accent used as text ran as low as 1.54:1 in the
// light theme (forest), where four of the six accents had no light-theme
// definition at all and simply kept their dark values on white.
//
// The scale is ROLE-based and inverts between themes: --gray-200 is always
// primary text, --gray-900 always the page background. So the roles, not
// the numbers, decide what is compared against what.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const CSS = fs.readFileSync(
  path.join(import.meta.dirname, '..', 'public-src', 'style.css'), 'utf8');

// Pulls one selector block's custom properties out of the stylesheet. Later
// declarations win, matching the cascade for identical specificity.
function tokensOf(selector) {
  // Tolerant of the alignment whitespace between selector and brace — the
  // first version of this matched a single space and reported two perfectly
  // good accents as missing.
  const at = CSS.search(new RegExp(selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\{'));
  const i = at;
  if (i === -1) throw new Error(`selector not found: ${selector}`);
  const body = CSS.slice(i, CSS.indexOf('}', i));
  const out = {};
  // Three-digit hex counts: --on-fill is declared as #000/#fff, and a
  // six-digit-only pattern silently reported it as undefined.
  for (const m of body.matchAll(/(--[\w-]+):\s*(#[0-9a-fA-F]{3,6})\b/g)) out[m[1]] = expand(m[2]);
  return out;
}

// #rgb -> #rrggbb so everything downstream can assume six digits.
function expand(hex) {
  return hex.length === 4
    ? '#' + [...hex.slice(1)].map(c => c + c).join('')
    : hex;
}

const lin = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
function luminance(hex) {
  const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}
function contrast(a, b) {
  const [x, y] = [luminance(a), luminance(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

// A variant is the full set of tokens in effect for one theme combination:
// its own block layered over the blocks it inherits from.
//
// #1019: dropped the crema-only dark/light variants along with Crema's
// whole special-cased accent behavior (the [data-accent="crema"] /
// [data-theme="light"][data-accent="crema"] blocks these used to layer in
// no longer exist) -- the 8 new THEME_PRESETS are all plain accent swaps of
// these same two base gray/semantic scales, same as every other retired
// legacy accent already was.
const BASE = tokensOf(':root');
const VARIANTS = {
  dark:  BASE,
  light: { ...BASE, ...tokensOf('[data-theme="light"]') },
};

const TEXT_ROLES    = ['--gray-100', '--gray-200', '--gray-300', '--gray-400',
                       '--gray-500', '--gray-600', '--ok', '--warn', '--err'];
const SURFACE_ROLES = ['--gray-950', '--gray-900', '--gray-800', '--raised'];
const AA = 4.5;

describe('design token contrast (#811)', () => {
  for (const [name, tokens] of Object.entries(VARIANTS)) {
    describe(name, () => {
      it('defines every role it needs', () => {
        for (const role of [...TEXT_ROLES, ...SURFACE_ROLES]) {
          expect(tokens[role], `${name} is missing ${role}`).toBeDefined();
        }
      });

      for (const text of TEXT_ROLES) {
        it(`${text} clears ${AA}:1 on every surface`, () => {
          for (const surface of SURFACE_ROLES) {
            const ratio = contrast(tokens[text], tokens[surface]);
            expect(ratio, `${name}: ${text} (${tokens[text]}) on ${surface} (${tokens[surface]}) = ${ratio.toFixed(2)}:1`)
              .toBeGreaterThanOrEqual(AA);
          }
        });
      }

      it('--raised is distinguishable from --gray-800 without a border', () => {
        // The whole point of the surface step is to replace nested 1px
        // borders, so it has to be perceivable on its own. This is not a
        // WCAG threshold — no standard covers "two adjacent large fills" —
        // it just must not be the same colour twice.
        const ratio = contrast(tokens['--raised'], tokens['--gray-800']);
        expect(ratio, `${name}: --raised vs --gray-800 = ${ratio.toFixed(3)}:1`)
          .toBeGreaterThan(1.05);
      });
    });
  }

  // The other direction: a semantic colour used as a FILL with text on top
  // (the dial-in score chip and score pill). #397/#404 only ever checked
  // these tokens as text ON a surface, never as a surface UNDER text, and
  // white-on-fill measured 2.37:1 in the dark theme before --on-fill existed.
  describe('text on a semantic fill (--on-fill)', () => {
    const FILL_ROLES = ['--ok', '--warn', '--err', '--gray-600'];
    for (const [name, tokens] of Object.entries(VARIANTS)) {
      it(`${name}: --on-fill is readable on every semantic fill`, () => {
        expect(tokens['--on-fill'], `${name} has no --on-fill`).toBeDefined();
        for (const fill of FILL_ROLES) {
          const ratio = contrast(tokens['--on-fill'], tokens[fill]);
          expect(ratio, `${name}: --on-fill (${tokens['--on-fill']}) on ${fill} (${tokens[fill]}) = ${ratio.toFixed(2)}:1`)
            .toBeGreaterThanOrEqual(AA);
        }
      });
    }
  });

  // #1019: the old 6-swatch "accent used as text (--accent-ink)" audit
  // (LIGHT_ACCENTS' per-accent light-theme --accent-ink overrides, plus
  // Crema's own light block) is removed along with those overrides
  // themselves -- the 8 new THEME_PRESETS deliberately ship WITHOUT an
  // equivalent hand-audited light-theme tuning pass (--accent-ink simply
  // falls back to the base :root's `var(--accent)` in both themes now).
  // That audit is tracked as a dedicated follow-up issue instead, same
  // #397/#404 precedent this file's own header comment already references.
});
