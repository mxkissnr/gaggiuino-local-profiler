// #2093: every filter chip and single-choice pill group uses the shared
// .chip (docs/DESIGN.md, "Shapes and components"); its active state is
// aria-pressed="true" only. Each slice of #2093 adds the classes it retires
// to RETIRED.
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import postcss from 'postcss';
import type { Root, Rule } from 'postcss';

const here = dirname(fileURLToPath(import.meta.url));
const SRC = join(here, '..', 'public-src');

// test/node-builtins.d.ts types readdirSync for the one-argument call only.
const readdirRecursive = readdirSync as unknown as (
  path: string,
  options: { recursive: true; encoding: 'utf8' },
) => string[];

function read(rel: string): string {
  return readFileSync(join(SRC, rel), 'utf8');
}

// Chip classes retired by #2093. No rule, markup or code may use them again.
const RETIRED = ['lib-shelf-chip', 'lib-shelf-view-btn', 'sort-btn'] as const;

function declsOf(rules: Rule[]): string[] {
  const out: string[] = [];
  for (const rule of rules) {
    for (const node of rule.nodes ?? []) {
      if (node.type === 'decl') out.push(`${node.prop}: ${node.value}`);
    }
  }
  return out;
}

function rulesWith(root: Root, selector: string): Rule[] {
  const found: Rule[] = [];
  root.walkRules(rule => {
    if (rule.selector === selector) found.push(rule);
  });
  return found;
}

describe('shared filter chips (#2093)', () => {
  it('sizes controls by pointer: 36 px fine, 44 px coarse', () => {
    const root = postcss.parse(read('tokens.css'));

    const base: Rule[] = [];
    root.each(node => {
      if (node.type === 'rule' && node.selector === ':root') base.push(node);
    });

    const coarse: Rule[] = [];
    root.walkAtRules(atRule => {
      if (atRule.name !== 'media' || atRule.params !== '(pointer: coarse)') return;
      atRule.each(node => {
        if (node.type === 'rule' && node.selector === ':root') coarse.push(node);
      });
    });

    expect(declsOf(base)).toContain('--ctl-height: 36px');
    expect(declsOf(coarse)).toEqual(['--ctl-height: 44px']);
  });

  it('gives chips, buttons and the shelf search the shared height and radius', () => {
    const root = postcss.parse(read('style.css'));

    for (const selector of ['.chip', '.btn']) {
      const found = rulesWith(root, selector);
      expect(found.length, selector).toBeGreaterThan(0);
      expect(declsOf(found), selector).toContain('min-height: var(--ctl-height)');
    }

    const search = declsOf(rulesWith(root, '.lib-shelf-search'));
    expect(search).toContain('min-height: var(--ctl-height)');
    expect(search).toContain('border-radius: var(--radius-ctl)');
  });

  it('leaves no rule, markup or code using a retired chip class', () => {
    const files = readdirRecursive(SRC, { recursive: true, encoding: 'utf8' })
      .filter(name => name.endsWith('.ts') || name.endsWith('.html') || name.endsWith('.css'));

    const hits: string[] = [];
    for (const file of files) {
      const text = read(file);
      for (const name of RETIRED) {
        if (new RegExp(`(?<![\\w-])${name}(?![\\w-])`).test(text)) hits.push(`${file}: ${name}`);
      }
    }
    expect(hits).toEqual([]);
  });
});

function buttons(action: string): string[] {
  return read('index.html').match(new RegExp(`<button[^>]*data-action="${action}"[^>]*>`, 'g')) ?? [];
}

describe('analytics chips (#2093)', () => {
  it.each(['analytics-range', 'set-bean-shelf-sort'])('%s: shared chips with exactly one pressed', action => {
    const found = buttons(action);
    expect(found.length).toBeGreaterThan(1);
    for (const button of found) {
      expect(button).toContain('class="chip"');
      expect(button).toMatch(/aria-pressed="(true|false)"/);
      expect(button).not.toMatch(/class="[^"]*\bactive\b/);
    }
    expect(found.filter(button => button.includes('aria-pressed="true"')).length).toBe(1);
  });

  it('syncs the period chips through aria-pressed only', () => {
    const views = read('boot/views.ts');
    expect(views).toContain("chip.setAttribute('aria-pressed'");
    expect(views).not.toContain("classList.toggle('active'");
  });

  it('renders the world map country chips as shared chips', () => {
    const map = read('views/analytics/world-map.ts');
    expect(map).toContain('class="chip" data-code=');
    expect(map).toContain("querySelectorAll<HTMLElement>('.chip')");
    expect(map).not.toContain('analytics-filter-btn');
  });
});
