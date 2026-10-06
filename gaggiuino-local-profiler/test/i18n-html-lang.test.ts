// #1499: `<html lang>` used to stay "de" in every language — only kiosk.ts
// synced it — so browsers treated an English UI as German and offered (or
// auto-applied) page translation, which papered over the GaggiMate editor's
// last hardcoded-German footer buttons. applyTranslations() now mirrors
// S.currentLang onto document.documentElement, and those two buttons carry
// data-i18n like every other button in index.html.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// vitest's node environment has no browser globals; stub them through a loose
// view of globalThis (the same bridge the other DOM tests use).
const g = globalThis as unknown as Record<string, unknown>;
g.localStorage ??= { getItem: () => null, setItem: () => {}, removeItem: () => {} };
g.window ??= globalThis;

interface I18nButton {
    dataset: { i18n: string };
    textContent: string;
}
const cancelBtn: I18nButton = { dataset: { i18n: 'lib_cancel' }, textContent: '' };
const saveBtn: I18nButton = { dataset: { i18n: 'gm_editor_save_to_machine' }, textContent: '' };
const closeAttrs: Record<string, string> = {};
const closeBtn = {
    setAttribute: (name: string, value: string): void => {
        closeAttrs[name] = value;
    },
};

g.document = {
    documentElement: { lang: 'de' },
    getElementById: (id: string): unknown => (id === 'easterEggPanelCloseBtn' ? closeBtn : null),
    querySelectorAll: (selector: string): I18nButton[] => (selector === '[data-i18n]' ? [cancelBtn, saveBtn] : []),
};

const { S } = await import('../public-src/state/index.js');
const { setLang } = await import('../public-src/i18n.js');

describe('applyTranslations() keeps <html lang> and the editor footer in sync (#1499)', () => {
    it('mirrors the active language onto document.documentElement.lang', () => {
        setLang('en');
        expect(S.currentLang).toBe('en');
        const doc = (g.document as { documentElement: { lang: string } }).documentElement;
        expect(doc.lang).toBe('en');
    });

    it('translates the two GaggiMate editor footer buttons and the close aria-label', () => {
        setLang('en');
        expect(cancelBtn.textContent).toBe('Cancel');
        expect(saveBtn.textContent).toBe('Save to machine');
        expect(closeAttrs['aria-label']).toBe('Close');
    });
});

describe('index.html has no hardcoded-German button left (#1499)', () => {
    const __dirname = dirname(fileURLToPath(import.meta.url));
    const html = readFileSync(join(__dirname, '../public-src/index.html'), 'utf8');

    it('every <button> whose visible text is "Abbrechen" carries a data-i18n attribute', () => {
        const offenders: string[] = [];
        for (const m of html.matchAll(/<button\b[^>]*>([\s\S]*?)<\/button>/g)) {
            const visible = (m[1] ?? '').replace(/<[^>]*>/g, '').trim();
            if (visible === 'Abbrechen' && !/data-i18n=/.test(m[0])) offenders.push(m[0].slice(0, 140));
        }
        expect(offenders, `German buttons without data-i18n:\n${offenders.join('\n')}`).toEqual([]);
    });
});
