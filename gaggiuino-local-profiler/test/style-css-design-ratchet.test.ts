// #2092: ratchet for the shared design system (#2091). It counts what
// style.css still has to migrate and pins each count to its current value.
// The test fails when a count rises (a page added its own radius, padding or
// look) and also when it falls: lower the pinned number in the same change,
// so progress cannot slip back. The last slice of the epic brings every count
// to zero.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import postcss from 'postcss';

const here = dirname(fileURLToPath(import.meta.url));
const CSS_PATH = join(here, '..', 'public-src', 'style.css');
const TOKENS_PATH = join(here, '..', 'public-src', 'tokens.css');

// Measured on dev when #2092 landed. Only ever lower these.
const PINNED = {
  literalRadius: 0,
  literalPadding: 0,
  transitionAll: 0,
  pageLookClasses: 2,
} as const;

type Debt = Record<keyof typeof PINNED, string[]>;

const RADIUS_PROP = /^border(?:-[a-z]+-[a-z]+)?-radius$/;          // border-radius and its longhands
const RADIUS_ALLOWED = /^(?:0|50%|var\(--radius(?:-[a-z]+)?\))$/;   // per space- or slash-separated part; calc() and var() fallbacks count as literal
const PADDING_PROP = /^padding(?:-[a-z]+)*$/;                        // padding, padding-top, padding-inline, ...
const PX_NUMBER = /(?<![\w.-])(\d*\.?\d+)px\b/g;                     // any non-zero px number in the value, calc() included; 0px (env() fallback) is skipped
const TRANSITION_PROP = /^transition(?:-property)?$/;
const LOOK_CLASS = /\.[\w-]+-(?:chip|badge|pill|tag|btn)(?![\w-])/;  // a class NAMED *-chip etc.; .chip, .btn--primary, .badge--ok never match
const LOOK_PROP = /^(?:color|background(?:-color|-image)?|border(?:-[a-z]+)*)$/; // colour, background, border, radius

function splitTopLevel(value: string, separator: RegExp): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of value) {
    if (ch === '(') depth += 1;
    else if (ch === ')') depth -= 1;
    if (depth === 0 && separator.test(ch)) {
      parts.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  parts.push(current);
  return parts.map((part) => part.trim()).filter((part) => part !== '');
}

function countDesignDebt(css: string): Debt {
  const debt: Debt = { literalRadius: [], literalPadding: [], transitionAll: [], pageLookClasses: [] };
  const root = postcss.parse(css);
  root.walkDecls((decl) => {
    const prop = decl.prop.toLowerCase();
    const where = `${prop}: ${decl.value} (style.css:${decl.source?.start?.line})`;
    if (RADIUS_PROP.test(prop) && splitTopLevel(decl.value, /[\s/]/).some((part) => !RADIUS_ALLOWED.test(part))) {
      debt.literalRadius.push(where);
    }
    if (PADDING_PROP.test(prop) && [...decl.value.matchAll(PX_NUMBER)].some((m) => Number(m[1] ?? '0') !== 0)) {
      debt.literalPadding.push(where);
    }
    if (TRANSITION_PROP.test(prop) && splitTopLevel(decl.value, /,/).some((part) => /^all\b/i.test(part))) {
      debt.transitionAll.push(where);
    }
  });
  root.walkRules((rule) => {
    if (!LOOK_CLASS.test(rule.selector)) return;
    const stylesItsLook = rule.nodes?.some((node) => node.type === 'decl' && LOOK_PROP.test(node.prop.toLowerCase()));
    if (!stylesItsLook) return;
    debt.pageLookClasses.push(`${rule.selector} (style.css:${rule.source?.start?.line})`);
  });
  return debt;
}

describe('style.css design ratchet (#2091)', () => {
  const css = readFileSync(CSS_PATH, 'utf-8');
  const debt = countDesignDebt(css);

  for (const key of Object.keys(PINNED) as (keyof typeof PINNED)[]) {
    it(`keeps ${key} at its pinned count`, () => {
      const found = debt[key];
      const message =
        found.length > PINNED[key]
          ? `${key} rose from ${PINNED[key]} to ${found.length}: use a token or a shared component (.chip, .btn, .badge, .section-title) instead.\n` +
            found.join('\n')
          : `${key} fell from ${PINNED[key]} to ${found.length}: lower PINNED.${key} to ${found.length} in this change.`;
      expect(found.length, message).toBe(PINNED[key]);
    });
  }

  it('counts one more literal radius when a page adds one', () => {
    const grown = countDesignDebt(css + '\n.x-page { border-radius: 3px; }\n');
    expect(grown.literalRadius.length).toBe(debt.literalRadius.length + 1);
  });

  it('applies the counting rules', () => {
    const lengths = (source: string): Record<keyof typeof PINNED, number> => {
      const found = countDesignDebt(source);
      return {
        literalRadius: found.literalRadius.length,
        literalPadding: found.literalPadding.length,
        transitionAll: found.transitionAll.length,
        pageLookClasses: found.pageLookClasses.length,
      };
    };

    expect(
      lengths(
        '.a{border-radius:3px}.b{border-radius:0}.c{border-radius:50%}.d{border-radius:var(--radius-ctl) var(--radius) 0 0}.e{border-top-left-radius:calc(var(--radius) - 2px)}.f{border-radius:var(--radius-lg, var(--radius))}.g{border-radius:999px}',
      ),
    ).toEqual({ literalRadius: 4, literalPadding: 0, transitionAll: 0, pageLookClasses: 0 });

    expect(
      lengths(
        '.a{padding:2px var(--sp-2)}.b{padding-bottom:env(safe-area-inset-bottom, 0px)}.c{padding:var(--sp-2) 0}.d{padding-inline:calc(56px + var(--sp-1))}.e{padding:0px}',
      ),
    ).toEqual({ literalRadius: 0, literalPadding: 2, transitionAll: 0, pageLookClasses: 0 });

    expect(
      lengths(
        '.a{transition:all .2s}.b{transition:color .2s, all .1s}.c{transition:background-color .15s, border-color .15s}.d{transition-property:all}.e{transition:allow-discrete}',
      ),
    ).toEqual({ literalRadius: 0, literalPadding: 0, transitionAll: 3, pageLookClasses: 0 });

    expect(
      lengths(
        '.x-chip{color:var(--gray-200)}.x-chip{display:flex}.chip{color:var(--accent)}.x-chips{background:none}.a .y-btn:hover{border-color:var(--gray-500)}.has-badge::after{background:var(--err)}.btn--primary{background:var(--accent)}#live-status-badge{color:var(--ok)}',
      ),
    ).toEqual({ literalRadius: 0, literalPadding: 0, transitionAll: 0, pageLookClasses: 3 });
  });

  it('defines the shared components', () => {
    const selectors: string[] = [];
    postcss.parse(css).walkRules((rule) => {
      selectors.push(...rule.selectors);
    });
    for (const selector of [
      '.chip',
      '.chip[aria-pressed="true"]',
      '.chip--input',
      '.btn',
      '.btn--primary',
      '.btn--tonal',
      '.btn--quiet',
      '.btn--danger',
      '.btn--icon',
      '.badge',
      '.badge--ok',
      '.badge--warn',
      '.badge--err',
      '.badge--info',
      '.badge--accent',
      '.badge--score-great',
      '.badge--score-good',
      '.badge--score-ok',
      '.badge--score-low',
      '.badge--score-bad',
      '.badge--scrim',
      '.section-title',
      '.section-title__count',
    ]) {
      expect(selectors, `style.css is missing the shared component ${selector}`).toContain(selector);
    }
  });

  it('defines the role radii once for both themes', () => {
    const root = postcss.parse(readFileSync(TOKENS_PATH, 'utf-8'));
    const declarationsOf = (selector: string): string[] => {
      const found: string[] = [];
      root.walkRules((rule) => {
        if (rule.selector !== selector) return;
        rule.walkDecls((decl) => {
          found.push(`${decl.prop}: ${decl.value}`);
        });
      });
      return found;
    };
    const dark = declarationsOf(':root');
    expect(dark).toContain('--radius-ctl: 8px');
    expect(dark).toContain('--radius-full: 999px');
    const light = declarationsOf('[data-theme="light"]');
    expect(light.some((decl) => decl.startsWith('--radius-ctl:'))).toBe(false);
    expect(light.some((decl) => decl.startsWith('--radius-full:'))).toBe(false);
  });

  it('has retired --radius-sm from the tokens and both stylesheets (#2096)', () => {
    const kiosk = readFileSync(join(here, '..', 'public-src', 'kiosk.css'), 'utf-8');
    for (const [name, text] of [['tokens.css', readFileSync(TOKENS_PATH, 'utf-8')], ['style.css', css], ['kiosk.css', kiosk]]) {
      expect(text, name).not.toContain('--radius-sm');
    }
  });
});
