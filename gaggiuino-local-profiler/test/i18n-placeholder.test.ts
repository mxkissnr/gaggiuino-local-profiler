// #1620: index.html marks placeholders with the short data-i18n-ph attribute,
// which applyTranslations() used to ignore, so the placeholder stayed in its
// hard-coded markup language. vitest runs in the node environment with no
// browser globals, so they are stubbed here like test/i18n-aria-label.test.ts.
import { describe, it, expect } from 'vitest';

const g = globalThis as unknown as Record<string, unknown>;
g.localStorage ??= { getItem: () => null, setItem: () => {}, removeItem: () => {} };
g.window ??= globalThis;

const shortInput = { dataset: { i18nPh: 'orders_menu_name_ph' } as Record<string, string>, placeholder: 'Name …' };
const longInput = { dataset: { i18nPlaceholder: 'search_placeholder' } as Record<string, string>, placeholder: '' };

g.document = {
    documentElement: { lang: 'de' },
    getElementById: (): null => null,
    querySelectorAll: (selector: string): unknown[] => (selector.includes('[data-i18n-ph]') ? [shortInput, longInput] : []),
};

const { setLang, t } = await import('../public-src/i18n.js');

describe('applyTranslations() localizes placeholders from data-i18n-ph (#1620)', () => {
    it('sets the placeholder from a data-i18n-ph key in the active language', () => {
        setLang('nl');
        expect(shortInput.placeholder).toBe('Naam …');
        setLang('it');
        expect(shortInput.placeholder).toBe('Nome …');
    });

    it('keeps handling the long data-i18n-placeholder form', () => {
        setLang('en');
        expect(longInput.placeholder).toBe(t('search_placeholder'));
        expect(longInput.placeholder).not.toBe('');
    });
});
