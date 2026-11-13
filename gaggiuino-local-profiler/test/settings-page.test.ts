// #2038: Settings is a grouped list; a row opens a sub-page. These tests pin
// the markup contract (every setting in exactly one sub-page) and the switch
// itself, with the fake-DOM style the other frontend tests use — there is no
// jsdom in this repo.
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const g = globalThis as unknown as Record<string, unknown>;
g.localStorage ??= { getItem: () => null, setItem: () => {} };
g.navigator ??= { language: 'en-US' };
g.window ??= globalThis;

// Slice 5: a form card opens in the shared detail sheet, and closing it reloads
// the card from its stored values. Both sides are mocked so the table's reload
// functions can be observed and no component DOM is needed.
interface SettingsDialogOptions {
    title: string;
    dialog?: boolean;
    content?: unknown;
    onClose?: () => void;
}
const reloads = vi.hoisted(() => ({
    mqtt: vi.fn<() => void>(),
    shotDefaults: vi.fn<() => void>(),
    freshness: vi.fn<() => void>(),
    notify: vi.fn<() => Promise<void>>(),
    mcp: vi.fn<() => Promise<void>>(),
}));
const sheet = vi.hoisted(() => ({ openDetailSheet: vi.fn<(opts: SettingsDialogOptions) => void>() }));

vi.mock('../public-src/components/mqtt-settings.js', () => ({ loadMqttSettings: reloads.mqtt }));
vi.mock('../public-src/components/shot-defaults-settings.js', () => ({ renderShotDefaultsSettingsCard: reloads.shotDefaults }));
vi.mock('../public-src/components/bean-freshness-settings.js', () => ({ renderBeanFreshnessSettings: reloads.freshness }));
vi.mock('../public-src/components/notify-settings.js', () => ({ loadNotifySettingsCard: reloads.notify }));
vi.mock('../public-src/components/mcp-settings.js', () => ({ loadMcpSettingsCard: reloads.mcp }));
vi.mock('../public-src/components/detail-sheet.js', () => ({ openDetailSheet: sheet.openDetailSheet }));

const __dirname = dirname(fileURLToPath(import.meta.url));
const indexHtml = readFileSync(join(__dirname, '../public-src/index.html'), 'utf8');

const viewMarkup = (() => {
    const start = indexHtml.indexOf('<div id="settings-view">');
    const end = indexHtml.indexOf('</div><!-- /main -->', start);
    return indexHtml.slice(start, end);
})();
const chunks = viewMarkup.split('<section class="settings-page"');

const {
    SETTINGS_GROUPS, SETTINGS_DIALOG_ROWS, settingsGroupsHtml, openSettingsPage,
    closeSettingsPage, filterSettingsItems, wireSettingsPage,
} = await import('../public-src/boot/settings-page.js');
const { t } = await import('../public-src/i18n.js');
const en = (await import('../public-src/i18n/en.js')).default;

function occurrences(haystack: string, needle: string): number {
    return haystack.split(needle).length - 1;
}

describe('settings markup: every setting sits in exactly one sub-page (#2038)', () => {
    it('has one section per group id', () => {
        for (const group of SETTINGS_GROUPS) {
            expect(occurrences(viewMarkup, `data-settings-page="${group.id}"`), group.id).toBe(1);
            expect(chunks.filter(c => c.includes(`data-settings-page="${group.id}"`)).length, group.id).toBe(1);
        }
    });

    const SETTING_IDS = [
        'themeToggleGroup', 'accentSwatches', 'bottomNavConfigList',
        'popupSettingsCard', 'notifySettingsList', 'notifySettingsSaveBtn',
        'mcpSettingsList', 'mcpSettingsSaveBtn', 'machineControlEnabled',
        'sdDrinkType', 'sdDose', 'shotDefaultsSaveBtn',
        'bfDegasUntil', 'bfLowStock', 'bfSaveBtn', 'bfResetBtn',
        'mqttTransportToggle', 'mqttSaveBtn', 'machinesList', 'addMachineBtn',
        'machineFormCard', 'backupDownloadBtn', 'backupRestoreInput',
        'apiTokenCard', 'devToolsCard', 'devScoreModel',
        'whatsNewList', 'settingsVersion', 'settingsLang', 'settingsSearch',
    ];

    it('keeps every setting id in the document exactly once, inside a section', () => {
        for (const id of SETTING_IDS) {
            expect(occurrences(indexHtml, `id="${id}"`), id).toBe(1);
            expect(chunks.some(c => c.includes(`id="${id}"`)), id).toBe(true);
        }
        // The search belongs to the bar above the list, not to any sub-page.
        expect(occurrences(indexHtml, 'id="settingsSearch"')).toBe(1);
        expect(chunks.slice(1).some(c => c.includes('id="settingsSearch"'))).toBe(false);
    });

    // #2038: six visible buttons broke the "at most five pills" rule, so the
    // language picker is one dropdown; the stored glp_lang key is unchanged.
    it('puts the language dropdown in the appearance chunk', () => {
        const appearance = chunks.find(c => c.includes('data-settings-page="appearance"')) ?? '';
        expect(appearance).toContain('<select id="settingsLang"');
        expect(appearance).toContain('<label for="settingsLang"');
        const values = [...appearance.matchAll(/<option value="([a-z]{2})"/g)].map(m => m[1]);
        expect(values).toEqual(['de', 'en', 'es', 'fr', 'it', 'nl']);
        expect(indexHtml).not.toContain('lang-option-btn');
    });

    it('puts the search field in the settings bar, never inside a sub-page', () => {
        const bar = indexHtml.match(/<div class="settings-bar" id="settingsBar">[\s\S]*?<\/div>\s*<div class="settings-layout">/)?.[0] ?? '';
        expect(bar).toContain('id="settingsSearch"');
        expect(bar).toContain('data-i18n-aria-label="settings_search_ph"');
        expect(bar).toContain('data-i18n-placeholder="settings_search_ph"');
    });

    it('moves "Restart setup tour" into the bar overflow menu', () => {
        expect(occurrences(indexHtml, 'id="restartSetupWizardBtn"')).toBe(1);
        const more = indexHtml.match(/<details[^>]*class="lib-sheet-more settings-more"[^>]*>[\s\S]*?<\/details>/)?.[0] ?? '';
        expect(more).toContain('id="restartSetupWizardBtn"');
    });
});

describe('settingsGroupsHtml()', () => {
    const markup = settingsGroupsHtml();

    it('renders one row per group, in table order', () => {
        const ids = [...markup.matchAll(/data-settings-open="([^"]+)"/g)].map(m => m[1]);
        expect(ids).toEqual(SETTINGS_GROUPS.map(g => g.id));
    });

    it('labels every row title and subtitle with an English dictionary key', () => {
        for (const group of SETTINGS_GROUPS) {
            expect(markup).toContain(`data-i18n="${group.titleKey}"`);
            expect(markup).toContain(`data-i18n="${group.subKey}"`);
            expect(en[group.titleKey], group.titleKey).toBeTypeOf('string');
            expect(en[group.subKey], group.subKey).toBeTypeOf('string');
        }
    });

    it('renders the rows in two group cards', () => {
        expect(occurrences(markup, 'class="settings-group"')).toBe(2);
    });
});

describe('filterSettingsItems() (#2038)', () => {
    const items = [
        { group: 'machines', label: 'MQTT', el: null },
        { group: 'coffee', label: 'Café', el: null },
        { group: 'appearance', label: 'Sprache', el: null },
        { group: 'appearance', label: 'Sprache', el: null },
        { group: 'machines', label: 'Sprache', el: null },
    ];

    it('matches a label anywhere inside it, ignoring case', () => {
        expect(filterSettingsItems(items, 'mqtt').map(i => i.label)).toEqual(['MQTT']);
        expect(filterSettingsItems(items, 'MQTT').map(i => i.label)).toEqual(['MQTT']);
        const labels = filterSettingsItems(items, 'sprach').map(i => i.label);
        expect(labels).toEqual(['Sprache', 'Sprache']);
    });

    it('ignores diacritics in the label and in the query', () => {
        expect(filterSettingsItems(items, 'cafe').map(i => i.label)).toEqual(['Café']);
        expect(filterSettingsItems(items, 'café').map(i => i.label)).toEqual(['Café']);
    });

    it('keeps one entry for a label repeated inside a group, but not across groups', () => {
        const sameGroup = filterSettingsItems(items, 'sprache');
        expect(sameGroup.filter(i => i.group === 'appearance').length).toBe(1);
        expect(sameGroup.filter(i => i.group === 'machines').length).toBe(1);
        expect(sameGroup.length).toBe(2);
    });

    it('returns every match in input order', () => {
        expect(filterSettingsItems(items, 'sprache').map(i => i.group)).toEqual(['appearance', 'machines']);
        const order = filterSettingsItems(items, 'e').map(i => i.label);
        expect(order).toEqual(['Café', 'Sprache', 'Sprache']);
    });

    it('returns nothing for a blank query', () => {
        expect(filterSettingsItems(items, '')).toEqual([]);
        expect(filterSettingsItems(items, '   ')).toEqual([]);
        expect(filterSettingsItems(items, 'zzz')).toEqual([]);
    });
});

describe('opening a sub-page (#2038)', () => {
    class FakeRow {
        dataset: Record<string, string> = {};
        attrs: Record<string, string> = {};
        focused = false;
        setAttribute(name: string, value: string): void { this.attrs[name] = value; }
        removeAttribute(name: string): void { delete this.attrs[name]; }
        focus(): void { this.focused = true; }
    }
    class FakePage {
        hidden = false;
        readonly id: string;
        constructor(id: string) { this.id = id; }
    }

    function setup(matches = false) {
        const pages = SETTINGS_GROUPS.map(g => new FakePage(g.id));
        const rows = SETTINGS_GROUPS.map(g => {
            const row = new FakeRow();
            row.dataset['settingsOpen'] = g.id;
            return row;
        });
        const back = new FakeRow();
        const view = {
            dataset: {} as Record<string, string>,
            scrollTop: 250,
            querySelectorAll: (selector: string): unknown[] => (
                selector === '.settings-page' ? pages : rows
            ),
            querySelector: (selector: string): unknown => {
                if (selector === '[data-settings-back]') return back;
                const page = selector.match(/\.settings-page\[data-settings-page="([^"]+)"\]/)?.[1];
                if (page) return pages.find(p => p.id === page) ?? null;
                const row = selector.match(/\[data-settings-open="([^"]+)"\]/)?.[1];
                if (row) return rows.find(r => r.dataset['settingsOpen'] === row) ?? null;
                return null;
            },
        };
        const title = { textContent: '', dataset: {} as Record<string, string> };
        g.document = {
            getElementById: (id: string): unknown => (
                id === 'settings-view' ? view : id === 'settingsPageTitle' ? title : null
            ),
        };
        (g.window as Record<string, unknown>).matchMedia = vi.fn(() => ({ matches, addEventListener: () => {}, removeEventListener: () => {} }));
        return { view, pages, rows, title, back };
    }

    it('shows only the opened page, marks its row and retitles the sub-bar', () => {
        const { view, pages, rows, title } = setup();
        openSettingsPage('coffee');
        expect(view.dataset['page']).toBe('coffee');
        expect(pages.filter(p => !p.hidden).map(p => p.id)).toEqual(['coffee']);
        expect(rows.filter(r => r.attrs['aria-current'] === 'page').map(r => r.dataset['settingsOpen'])).toEqual(['coffee']);
        expect(title.textContent).toBe(t('settings_group_coffee'));
        expect(title.dataset['i18n']).toBe('settings_group_coffee');
    });

    it('scrolls the view to the top and focuses the back button on a phone', () => {
        const desktop = setup(false);
        openSettingsPage('coffee');
        expect(desktop.view.scrollTop).toBe(0);
        expect(desktop.back.focused).toBe(false);

        const phone = setup(true);
        openSettingsPage('coffee');
        expect(phone.back.focused).toBe(true);
    });

    it('goes back to the list and focuses the row that was open', () => {
        const { view, rows } = setup();
        openSettingsPage('coffee');
        closeSettingsPage();
        expect(view.dataset['page']).toBeUndefined();
        expect(rows.find(r => r.dataset['settingsOpen'] === 'coffee')?.focused).toBe(true);
    });

    it('does nothing when the section is missing', () => {
        const { view, pages } = setup();
        openSettingsPage('nope');
        expect(view.dataset['page']).toBeUndefined();
        expect(pages.every(p => !p.hidden)).toBe(true);
    });
});

describe('SETTINGS_DIALOG_ROWS table (slice 5)', () => {
    it('finds every dialog anchor inside its group section', () => {
        for (const row of SETTINGS_DIALOG_ROWS) {
            const section = chunks.find(c => c.includes(`data-settings-page="${row.group}"`)) ?? '';
            expect(section, row.id).toContain(`id="${row.anchorId}"`);
        }
    });

    it('labels every dialog row with an English dictionary key', () => {
        for (const row of SETTINGS_DIALOG_ROWS) {
            expect(en[row.titleKey], row.titleKey).toBeTypeOf('string');
        }
    });

    it('reads the values off the form controls', () => {
        const rows = new Map(SETTINGS_DIALOG_ROWS.map(r => [r.id, r] as const));
        const byId: Record<string, unknown> = {
            bfPeakFrom: { value: '7' },
            bfPeakUntil: { value: '21' },
            mcpEnabled: { checked: false },
        };
        const boxes = [{ checked: true }, { checked: false }];
        g.document = {
            getElementById: (id: string) => byId[id] ?? null,
            querySelector: () => null,
        };
        byId['notifySettingsList'] = { querySelectorAll: () => boxes };

        expect(rows.get('freshness')?.value()).toBe('7–21 days');
        expect(rows.get('push')?.value()).toBe('1 of 2 on');
        expect(rows.get('mcp')?.value()).toBe('Off');
        expect(rows.get('live')?.value()).toBe('');
        expect(rows.get('shot-defaults')?.value()).toBe('');
    });

    it('opens the card in the detail sheet as a dialog and reloads it on close', async () => {
        const card = { classList: { add: vi.fn() }, style: { display: '' } };
        const appended: { className: string; innerHTML: string }[] = [];
        const page = { appendChild: (el: { className: string; innerHTML: string }): void => { appended.push(el); } };
        const pages = new Map<string, typeof page>();
        for (const id of ['machines', 'coffee', 'notifications', 'developer', 'appearance']) pages.set(id, page);

        const listeners: Record<string, (ev: unknown) => void> = {};
        const view = {
            addEventListener: (type: string, fn: (ev: unknown) => void) => { listeners[type] = fn; },
            querySelector: (sel: string) => {
                const id = sel.match(/data-settings-page="([^"]+)"/)?.[1];
                return (id ? pages.get(id) : null) ?? null;
            },
            querySelectorAll: () => [],
        };
        const byId: Record<string, unknown> = {
            'settings-view': view,
            settingsGroups: { innerHTML: '' },
            mqttTransportToggle: { closest: () => card },
            sdDrinkType: { closest: () => card },
            bfDegasUntil: { closest: () => card },
            notifySettingsList: { closest: () => card, querySelectorAll: () => [] },
            mcpSettingsList: { closest: () => card, querySelectorAll: () => [] },
        };
        g.document = {
            getElementById: (id: string) => byId[id] ?? null,
            createElement: () => ({ className: '', innerHTML: '' }),
            querySelector: () => null,
        };

        wireSettingsPage();
        // One row card per group that holds a form; the coffee page holds two.
        expect(appended.length).toBe(4);
        expect(appended.every(host => host.className.includes('settings-row-group'))).toBe(true);
        const markup = appended.map(host => host.innerHTML).join('');
        expect(occurrences(markup, 'data-settings-dialog=')).toBe(5);
        expect(markup).toContain('data-settings-value="freshness"');

        const target = { closest: (sel: string) => (sel === '[data-settings-dialog]' ? { dataset: { settingsDialog: 'freshness' } } : null) };
        listeners['click']?.({ target });

        expect(sheet.openDetailSheet).toHaveBeenCalledTimes(1);
        const opts = sheet.openDetailSheet.mock.calls[0]?.[0];
        expect(opts?.dialog).toBe(true);
        expect(opts?.content).toBe(card);

        opts?.onClose?.();
        await Promise.resolve();
        await Promise.resolve();
        expect(reloads.freshness).toHaveBeenCalledTimes(1);
    });
});
