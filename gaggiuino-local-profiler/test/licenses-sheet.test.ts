// #2080: Settings → About → "Open-source licenses" renders the shipped
// THIRD_PARTY_NOTICES.md into the shared detail sheet. These tests pin the
// markup contract (every component a link, only https targets clickable,
// licence texts folded) and the load/cache behaviour, with the fake-DOM style
// the other frontend tests use — there is no jsdom in this repo.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const g = globalThis as unknown as Record<string, unknown>;
g.localStorage ??= { getItem: () => null, setItem: () => {} };
g.navigator ??= { language: 'en-US' };
g.window ??= globalThis;

interface SheetOptions {
    title: string;
    sub?: string;
    body: string;
    dialog?: boolean;
    onClose?: () => void;
}
const sheet = vi.hoisted(() => ({ openDetailSheet: vi.fn<(opts: SheetOptions) => void>() }));
vi.mock('../public-src/components/detail-sheet.js', () => ({ openDetailSheet: sheet.openDetailSheet }));

const ROOT = join(import.meta.dirname, '..');
const noticesMd = readFileSync(join(ROOT, 'public-src', 'public', 'THIRD_PARTY_NOTICES.md'), 'utf8');
const indexHtml = readFileSync(join(ROOT, 'public-src', 'index.html'), 'utf8');

const { licensesSheetHtml } = await import('../public-src/components/licenses-sheet.js');
const { parseNotices } = await import('../public-src/shared/third-party-notices.js');
const { t } = await import('../public-src/i18n.js');

const notices = parseNotices(noticesMd);

function count(haystack: string, re: RegExp): number {
    return [...haystack.matchAll(re)].length;
}

// vi.resetModules() gives each caching test a fresh module, so a rejection in
// one test cannot leak into the next.
async function loadSheet(): Promise<typeof import('../public-src/components/licenses-sheet.js')> {
    vi.resetModules();
    return import('../public-src/components/licenses-sheet.js');
}

function callAt(index: number): SheetOptions {
    const call = sheet.openDetailSheet.mock.calls[index];
    if (!call) throw new Error(`openDetailSheet was not called ${index + 1} time(s)`);
    return call[0];
}

function response(ok: boolean, body: string): Response {
    return { ok, status: ok ? 200 : 500, text: () => Promise.resolve(body) } as unknown as Response;
}

afterEach(() => {
    sheet.openDetailSheet.mockClear();
});

describe('licensesSheetHtml()', () => {
    const markup = licensesSheetHtml(notices);

    it('links every component and both app rows', () => {
        expect(count(markup, /<a /g)).toBe(notices.components.length + 2);
        expect(count(markup, /target="_blank"/g)).toBe(notices.components.length + 2);
        expect(count(markup, /rel="noopener"/g)).toBe(notices.components.length + 2);
    });

    it('renders only https targets as links and opens them in a new tab', () => {
        const hrefs = [...markup.matchAll(/href="([^"]*)"/g)].map(m => m[1] ?? '');
        expect(hrefs.length).toBeGreaterThan(0);
        for (const href of hrefs) expect(href.startsWith('https://'), href).toBe(true);
        expect(hrefs).toContain('https://github.com/mxkissnr/gaggiuino-local-profiler/blob/main/LICENSE');
    });

    it('folds one <details> per licence text', () => {
        expect(count(markup, /<details class="licenses-text"/g)).toBe(notices.licences.length);
        expect(notices.licences.length).toBeGreaterThan(0);
        expect(markup).toContain('<pre>');
    });

    it('heads every non-empty group with its translated label', () => {
        const headings = [...markup.matchAll(/<h3 class="licenses-heading">([^<]*)<span/g)].map(m => (m[1] ?? '').trim());
        expect(headings).toEqual([
            t('licenses_group_libraries'), t('licenses_group_fonts'),
            t('licenses_group_models'), t('licenses_group_server'), t('licenses_texts'),
        ]);
    });

    it('renders a non-https source as a static row and escapes component text', () => {
        const synthetic = {
            components: [{
                group: 'Libraries' as const,
                title: '<img src=x>',
                purpose: 'Purpose.',
                licence: 'MIT License',
                source: 'javascript:alert(1)',
            }],
            licences: [],
        };
        const out = licensesSheetHtml(synthetic);
        // Only the two app rows stay links.
        expect(count(out, /<a /g)).toBe(2);
        expect(out).not.toContain('javascript:');
        expect(out).toContain('settings-row settings-row-static licenses-row');
        expect(out).not.toContain('<img');
        expect(out).toContain('&lt;img src=x&gt;');
    });
});

describe('openLicensesSheet()', () => {
    it('shows the loading body, then the rendered sheet, from the relative notices URL', async () => {
        const fetchMock = vi.fn(() => Promise.resolve(response(true, noticesMd)));
        globalThis.fetch = fetchMock;
        const { openLicensesSheet } = await loadSheet();

        await openLicensesSheet();

        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(fetchMock).toHaveBeenCalledWith('THIRD_PARTY_NOTICES.md');
        expect(sheet.openDetailSheet).toHaveBeenCalledTimes(2);
        for (const index of [0, 1]) {
            expect(callAt(index).title).toBe(t('settings_licenses'));
            expect(callAt(index).dialog).toBe(true);
        }
        expect(callAt(0).body).toContain(t('licenses_loading'));
        expect(callAt(0).body).not.toContain('onnxruntime-web');
        expect(callAt(1).body).toContain('onnxruntime-web 1.31.1');
        expect(callAt(1).body).not.toContain(t('licenses_loading'));
    });

    it('keeps the sheet on the notices file after a successful load', async () => {
        const fetchMock = vi.fn(() => Promise.resolve(response(true, noticesMd)));
        globalThis.fetch = fetchMock;
        const { openLicensesSheet } = await loadSheet();

        await openLicensesSheet();
        await openLicensesSheet();

        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(sheet.openDetailSheet).toHaveBeenCalledTimes(4);
    });

    it('shows the error body and retries on the next open after a rejected fetch', async () => {
        const fetchMock = vi.fn((): Promise<Response> => Promise.reject(new Error('offline')));
        globalThis.fetch = fetchMock;
        const { openLicensesSheet } = await loadSheet();

        await openLicensesSheet();
        expect(callAt(1).body).toContain(t('licenses_error'));

        await openLicensesSheet();
        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(callAt(3).body).toContain(t('licenses_error'));
    });

    it('shows the error body for a non-ok response', async () => {
        const fetchMock = vi.fn(() => Promise.resolve(response(false, '')));
        globalThis.fetch = fetchMock;
        const { openLicensesSheet } = await loadSheet();

        await openLicensesSheet();

        expect(callAt(1).body).toContain(t('licenses_error'));
        expect(callAt(1).body).not.toContain('onnxruntime-web');
    });

    it('does not repaint the sheet when it was closed before the fetch resolved', async () => {
        const pendingFetch: { resolve?: (res: Response) => void } = {};
        globalThis.fetch = vi.fn(() => new Promise<Response>((resolve) => { pendingFetch.resolve = resolve; }));
        const { openLicensesSheet } = await loadSheet();

        const pending = openLicensesSheet();
        expect(sheet.openDetailSheet).toHaveBeenCalledTimes(1);
        callAt(0).onClose?.();
        pendingFetch.resolve?.(response(true, noticesMd));
        await pending;

        expect(sheet.openDetailSheet).toHaveBeenCalledTimes(1);
    });
});

describe('About sub-page wiring', () => {
    it('has the licenses row with its own label key', () => {
        const about = indexHtml.slice(indexHtml.indexOf('data-settings-page="about"'));
        const section = about.slice(0, about.indexOf('</section>'));
        expect(section).toContain('data-settings-licenses');
        expect(section).toContain('data-i18n="settings_licenses"');
    });
});
