import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// #1760: updateView() builds the shot detail imperatively (Chart.js legend,
// phase tags, stop-reason line), so a live language switch only reaches it
// when switchMode('shots') re-renders on entry. updateView() needs the whole
// index.html DOM and a canvas, so only the recorded-language getter is
// mocked; the mode-switch orchestration under test is the real one.
const shotDetail = vi.hoisted(() => ({ lang: null as string | null }));

vi.mock('../public-src/views/shots/index.js', () => ({
    shotsRenderedLang: () => shotDetail.lang,
}));

const g = globalThis as unknown as Record<string, unknown>;
g.localStorage ??= { getItem: () => null, setItem: () => {} };
g.navigator ??= { language: 'en-US' };
g.window ??= globalThis;

const { S } = await import('../public-src/state/index.js');
const { switchMode } = await import('../public-src/components/mode.js');

class FakeEl {
    style: Record<string, string> = {};
    classes = new Set<string>();
    classList = {
        add: (token: string): void => { this.classes.add(token); },
        remove: (token: string): void => { this.classes.delete(token); },
        toggle: (token: string, force?: boolean): void => {
            if (force === undefined ? this.classes.has(token) : !force) this.classes.delete(token);
            else this.classes.add(token);
        },
        contains: (token: string): boolean => this.classes.has(token),
    };
    closest(): FakeEl | null { return null; }
    contains(): boolean { return false; }
}

// Every id switchMode dereferences directly; the other lookups are optional.
const DIRECT_IDS = [
    'btnShots', 'btnLive', 'btnAnalytics', 'btnDialin', 'btnLibrary',
    'btnMaintenance', 'btnAchievements', 'btnOrders', 'btnSettings',
    'shots-view', 'live-view', 'analytics-view', 'dialin-view', 'library-view',
    'maintenance-view', 'achievements-view', 'orders-view', 'settings-view',
];

function setup(): { updateView: ReturnType<typeof vi.fn> } {
    const nodes: Record<string, FakeEl> = {};
    for (const id of DIRECT_IDS) nodes[id] = new FakeEl();
    g.document = {
        getElementById: (id: string) => nodes[id] ?? null,
        querySelector: () => null,
        querySelectorAll: () => [],
    };
    const updateView = vi.fn();
    (g.window as Record<string, unknown>).updateView = updateView;
    return { updateView };
}

describe('re-render the open shot detail after a language switch (#1760)', () => {
    beforeEach(() => {
        S.currentMode = 'library';
        S.primaryShotId = 7;
        S.currentLang = 'de';
        shotDetail.lang = 'de';
    });

    it('re-renders once on entry after a language change, not on later entries', () => {
        const { updateView } = setup();
        S.currentLang = 'en';
        switchMode('shots');
        expect(updateView).toHaveBeenCalledTimes(1);

        // updateView() records the language it just rendered in; the next entry
        // with no further change must not render again.
        shotDetail.lang = 'en';
        switchMode('live');
        switchMode('shots');
        expect(updateView).toHaveBeenCalledTimes(1);
    });

    it('does not re-render while the detail is already in the active language', () => {
        const { updateView } = setup();
        S.currentLang = 'de';
        switchMode('shots');
        expect(updateView).not.toHaveBeenCalled();
    });

    it('does not re-render when no shot is selected', () => {
        const { updateView } = setup();
        S.primaryShotId = null;
        S.currentLang = 'en';
        switchMode('shots');
        expect(updateView).not.toHaveBeenCalled();
    });

    it('localizes the statistics search accessible name', () => {
        const markup = readFileSync(resolve(import.meta.dirname, '..', 'public-src', 'index.html'), 'utf8');
        const input = /<input[^>]*id="analyticsSearch"[^>]*>/.exec(markup)?.[0] ?? '';
        expect(input).toContain('data-i18n-aria-label="analytics_search_ph"');
    });
});
