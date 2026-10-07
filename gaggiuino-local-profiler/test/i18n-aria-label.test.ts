// #1514: the desktop topbar's Settings button is icon-only, so its only
// accessible name is its aria-label — a hard-coded German value would be
// announced as-is in EN/IT/FR/ES/NL. applyTranslations() now localizes
// [data-i18n-aria-label] the way it already localizes [data-i18n-title].
// vitest runs in the node environment with no browser globals, so they are
// stubbed here exactly like test/i18n-html-lang.test.ts does.
import { describe, it, expect } from 'vitest';

const g = globalThis as unknown as Record<string, unknown>;
g.localStorage ??= { getItem: () => null, setItem: () => {}, removeItem: () => {} };
g.window ??= globalThis;

const attrs: Record<string, string> = {};
const settingsBtn = {
    dataset: { i18nAriaLabel: 'nav_settings' },
    setAttribute: (name: string, value: string): void => { attrs[name] = value; },
};

g.document = {
    documentElement: { lang: 'de' },
    getElementById: (): null => null,
    querySelectorAll: (selector: string): unknown[] => (selector === '[data-i18n-aria-label]' ? [settingsBtn] : []),
};

const { setLang } = await import('../public-src/i18n.js');

describe('applyTranslations() localizes aria-label from data-i18n-aria-label (#1514)', () => {
    it('sets the accessible name to the active language, not a fixed German string', () => {
        setLang('en');
        expect(attrs['aria-label']).toBe('Settings');
    });
});
