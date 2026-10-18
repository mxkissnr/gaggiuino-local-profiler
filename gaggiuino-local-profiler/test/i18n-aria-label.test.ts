// #1514: the desktop topbar's Settings button is icon-only, so its only
// accessible name is its aria-label — a hard-coded German value would be
// announced as-is in EN/IT/FR/ES/NL. applyTranslations() now localizes
// [data-i18n-aria-label] the way it already localizes [data-i18n-title].
// #1760: the shot-list drawer button and the topbar machine-status icon are
// icon-only too, so they use the same attribute.
// vitest runs in the node environment with no browser globals, so they are
// stubbed here exactly like test/i18n-html-lang.test.ts does.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const indexHtml = readFileSync(join(__dirname, '../public-src/index.html'), 'utf8');

const g = globalThis as unknown as Record<string, unknown>;
g.localStorage ??= { getItem: () => null, setItem: () => {}, removeItem: () => {} };
g.window ??= globalThis;

const attrs: Record<string, Record<string, string>> = {};
const ariaElements = ['nav_settings', 'sidebar_drawer_open', 'topbar_machine_icon_title'].map(key => {
    const elAttrs: Record<string, string> = {};
    attrs[key] = elAttrs;
    return {
        dataset: { i18nAriaLabel: key },
        setAttribute: (name: string, value: string): void => { elAttrs[name] = value; },
    };
});

g.document = {
    documentElement: { lang: 'de' },
    getElementById: (): null => null,
    querySelectorAll: (selector: string): unknown[] => (selector === '[data-i18n-aria-label]' ? ariaElements : []),
};

const { setLang } = await import('../public-src/i18n.js');

describe('applyTranslations() localizes aria-label from data-i18n-aria-label (#1514, #1760)', () => {
    it('sets the accessible name to the active language, not a fixed German string', () => {
        setLang('en');
        expect(attrs['nav_settings']?.['aria-label']).toBe('Settings');
        expect(attrs['sidebar_drawer_open']?.['aria-label']).toBe('Open shot list');
        expect(attrs['topbar_machine_icon_title']?.['aria-label']).toBe('Machine status');
    });

    it('opts the shot-list and machine-status buttons into aria-label translation', () => {
        const expected: [string, string][] = [
            ['mobileDrawerBtn', 'sidebar_drawer_open'],
            ['topbarMachineIcon', 'topbar_machine_icon_title'],
        ];
        for (const [id, key] of expected) {
            const tag = indexHtml.match(new RegExp(`<button[^>]*\\bid="${id}"[^>]*>`))?.[0] ?? '';
            expect(tag).toContain(`data-i18n-aria-label="${key}"`);
        }
    });
});
