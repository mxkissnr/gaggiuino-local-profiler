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
import postcss from 'postcss';

const here = dirname(fileURLToPath(import.meta.url));
const CSS_PATH = join(here, '..', 'public-src', 'style.css');

const EXPECTED_HEIGHT = 'calc(100vh - var(--dev-banner-h, 0px))';

const root = postcss.parse(readFileSync(CSS_PATH, 'utf-8'), { from: CSS_PATH });

// The mobile layout is the rule that pins the element full-screen: exact
// selector plus `position: fixed` + `inset: 0` keeps the desktop rules (which
// set a plain height: 100vh without inset: 0) out of the selection.
function checkFullScreenRule(selector: string) {
    let found = 0;
    root.walkRules((rule) => {
        if (rule.selector.replace(/\s+/g, ' ').trim() !== selector) return;
        const decls = rule.nodes ?? [];
        const value = (prop: string): string | undefined => {
            for (const node of decls) {
                if (node.type === 'decl' && node.prop === prop) return node.value.trim();
            }
            return undefined;
        };
        if (value('position') !== 'fixed' || value('inset') !== '0') return;
        found += 1;
        expect(value('height')).toBe(EXPECTED_HEIGHT);
        expect(rule.toString()).not.toMatch(/height:\s*100vh\b/);
    });
    expect(found, `style.css has no full-screen \`${selector}\` rule`).toBe(1);
}

describe('mobile #main/#sidebar height clears the dev banner', () => {
    for (const selector of ['#main', '#sidebar']) {
        it(`${selector} shrinks by --dev-banner-h and keeps no bare 100vh`, () => {
            checkFullScreenRule(selector);
        });
    }
});
