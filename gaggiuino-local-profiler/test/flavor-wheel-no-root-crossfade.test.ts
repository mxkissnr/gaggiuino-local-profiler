// #1482: opening the flavour wheel runs a shared-element view transition
// pinned to the `flavor-wheel` group. Every view transition also snapshots
// the root, and the browser's default cross-fade on
// ::view-transition-old(root) / ::view-transition-new(root) turns the whole
// screen into a flash on phones, where the modal covers the viewport (the
// same symptom #1452 fixed for the bean sheet). The root cross-fade has to be
// switched off with an unconditional rule: nested inside a prefers-* media
// block it would only apply for some users.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import postcss, { type AtRule, type Rule } from 'postcss';

const here = dirname(fileURLToPath(import.meta.url));
const CSS_PATH = join(here, '..', 'public-src', 'style.css');

function disablesRootCrossfade(rule: Rule): boolean {
  return (
    rule.selector.includes('::view-transition-old(root)') &&
    rule.selector.includes('::view-transition-new(root)')
  );
}

function nestedInMedia(rule: Rule): boolean {
  let node = rule.parent;
  while (node) {
    if (node.type === 'atrule' && (node as AtRule).name.toLowerCase() === 'media') return true;
    node = node.parent;
  }
  return false;
}

describe('public-src/style.css root view-transition cross-fade (#1482)', () => {
  const root = postcss.parse(readFileSync(CSS_PATH, 'utf-8'), { from: CSS_PATH });
  const rules: Rule[] = [];
  root.walkRules((rule) => {
    if (disablesRootCrossfade(rule)) rules.push(rule);
  });

  it('sets animation: none on the root view-transition pair', () => {
    expect(
      rules,
      'style.css has no ::view-transition-old(root), ::view-transition-new(root) rule',
    ).not.toHaveLength(0);
    const disabled = rules.filter((rule) =>
      rule.nodes?.some(
        (node) => node.type === 'decl' && node.prop === 'animation' && node.value.trim() === 'none',
      ),
    );
    expect(disabled, 'the root view-transition rule does not set `animation: none`').not.toHaveLength(0);
  });

  it('keeps the rule outside any @media block so it always applies', () => {
    for (const rule of rules) {
      expect(nestedInMedia(rule), `${rule.selector} must not be nested in an @media block`).toBe(false);
    }
  });
});
