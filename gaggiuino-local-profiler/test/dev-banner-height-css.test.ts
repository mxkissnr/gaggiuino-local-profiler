// #2053: on the dev channel the banner in components/dev-banner.ts pushes
// #main and #sidebar down with an inline `top` and sets --dev-banner-h. Below
// the max-width: 768px block, style.css makes both position: fixed with a hard
// height of 100vh, so their bottom ends up one banner-height below the
// viewport, under the fixed bottom navigation. They have to shrink by the same
// amount instead.
//
// Read as text rather than through postcss: that package is not a declared
// dependency of this one (the other CSS tests here only get it transitively),
// and a brace scan is all this check needs.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const CSS_PATH = join(here, '..', 'public-src', 'style.css');

const EXPECTED_HEIGHT = 'calc(100vh - var(--dev-banner-h, 0px))';

// Comments are dropped first: several name #main/#sidebar, and a comment body
// would otherwise be read as part of the selector that follows it.
const CSS = readFileSync(CSS_PATH, 'utf-8').replace(/\/\*[\s\S]*?\*\//g, '');

function bodyAt(open: number): string | undefined {
    let depth = 0;
    for (let i = open; i < CSS.length; i += 1) {
        const ch = CSS.charAt(i);
        if (ch === '{') depth += 1;
        else if (ch === '}') {
            depth -= 1;
            if (depth === 0) return CSS.slice(open + 1, i);
        }
    }
    return undefined;
}

// Every rule with exactly this selector, wherever it sits (the mobile ones are
// inside @media, which this scan does not need to understand).
function ruleBodies(selector: string): string[] {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const bodies: string[] = [];
    for (const match of CSS.matchAll(new RegExp(`(?:^|[{};,])\\s*${escaped}\\s*\\{`, 'g'))) {
        const open = (match.index ?? 0) + (match[0] ?? '').length - 1;
        const body = bodyAt(open);
        if (body !== undefined) bodies.push(body);
    }
    return bodies;
}

function declaration(body: string, prop: string): string | undefined {
    const match = new RegExp(`(?:^|[;{])\\s*${prop}\\s*:([^;}]*)`, 'i').exec(body);
    return match?.[1]?.replace(/\s+/g, ' ').trim();
}

// The mobile layout is the rule that pins the element full-screen: exact
// selector plus `position: fixed` + `inset: 0` keeps the desktop rules (which
// set a plain height: 100vh without inset: 0) out of the selection.
function fullScreenRule(selector: string): string {
    const matches = ruleBodies(selector).filter(
        (body) => declaration(body, 'position') === 'fixed' && declaration(body, 'inset') === '0',
    );
    expect(matches, `style.css has no full-screen \`${selector}\` rule`).toHaveLength(1);
    const body = matches[0];
    if (body === undefined) throw new Error(`style.css has no full-screen \`${selector}\` rule`);
    return body;
}

describe('mobile #main/#sidebar height clears the dev banner', () => {
    for (const selector of ['#main', '#sidebar']) {
        it(`${selector} shrinks by --dev-banner-h`, () => {
            expect(declaration(fullScreenRule(selector), 'height')).toBe(EXPECTED_HEIGHT);
        });

        it(`${selector} keeps no bare 100vh height`, () => {
            expect(fullScreenRule(selector)).not.toMatch(/height\s*:\s*100vh\b/);
        });
    }
});
