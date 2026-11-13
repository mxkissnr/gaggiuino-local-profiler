// #2053: on the dev channel the banner in components/dev-banner.ts pushes
// #main and #sidebar down with an inline `top` and sets --dev-banner-h. Below
// the max-width: 768px block, style.css makes both position:fixed with a hard
// height of 100vh, so their bottom ends up one banner-height below the
// viewport, under the fixed bottom navigation. They have to shrink by the same
// amount instead.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import postcss, { type Rule } from 'postcss';

const here = dirname(fileURLToPath(import.meta.url));
const CSS_PATH = join(here, '..', 'public-src', 'style.css');

const EXPECTED_HEIGHT = 'calc(100vh - var(--dev-banner-h, 0px))';

const root = postcss.parse(readFileSync(CSS_PATH, 'utf-8'), { from: CSS_PATH });

function declValue(rule: Rule, prop: string): string | undefined {
    for (const node of rule.nodes ?? []) {
        if (node.type === 'decl' && node.prop === prop) return node.value.trim();
    }
    return undefined;
}

// The mobile layout is the rule that pins the element full-screen: matching on
// `position: fixed` + `inset: 0` keeps the desktop rules (which use a plain
// height: 100vh without inset: 0) out of the selection.
function fullScreenRule(selector: string): Rule {
    const matches: Rule[] = [];
    root.walkRules((rule) => {
        if (rule.selector.replace(/\s+/g, ' ').trim() !== selector) return;
        if (declValue(rule, 'position') !== 'fixed') return;
        if (declValue(rule, 'inset') !== '0') return;
        matches.push(rule);
    });
    expect(matches, `style.css has no full-screen \`${selector}\` rule`).toHaveLength(1);
    const rule = matches[0];
    if (!rule) throw new Error(`style.css has no full-screen \`${selector}\` rule`);
    return rule;
}

describe('mobile #main/#sidebar height clears the dev banner', () => {
    for (const selector of ['#main', '#sidebar']) {
        it(`${selector} shrinks by --dev-banner-h`, () => {
            const rule = fullScreenRule(selector);
            expect(declValue(rule, 'height')).toBe(EXPECTED_HEIGHT);
        });

        it(`${selector} keeps no bare 100vh height`, () => {
            const rule = fullScreenRule(selector);
            expect(rule.toString()).not.toMatch(/height:\s*100vh\b/);
        });
    }
});
