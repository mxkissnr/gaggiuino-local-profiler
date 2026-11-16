// #2080: Settings → About → "Open-source licenses". The sheet reads the
// shipped THIRD_PARTY_NOTICES.md — the single source of truth, kept in step
// with the manifest and the module list by the notices tests — and renders it
// into the shared detail sheet: a centred dialog on desktop, a bottom sheet on
// phones. Component purposes and licence texts stay English in every language;
// only the sheet's own labels are translated.
import { t, tHtml } from '../i18n.js';
import { esc, html, joinHtml } from '../utils.js';
import type { Html } from '../utils.js';
import { NOTICE_GROUPS, parseNotices } from '../shared/third-party-notices.js';
import type { NoticeComponent, NoticeGroup, ParsedNotices } from '../shared/third-party-notices.js';
import { openDetailSheet } from './detail-sheet.js';

// Relative, so it resolves behind the Home Assistant Ingress path as well.
const NOTICES_URL = 'THIRD_PARTY_NOTICES.md';
const APP_LICENSE_URL = 'https://github.com/mxkissnr/gaggiuino-local-profiler/blob/main/LICENSE';
const APP_SOURCE_URL = 'https://github.com/mxkissnr/gaggiuino-local-profiler';

const GROUP_KEYS: Record<NoticeGroup, string> = {
    Libraries: 'licenses_group_libraries',
    Fonts: 'licenses_group_fonts',
    Models: 'licenses_group_models',
    Server: 'licenses_group_server',
};

// Only https targets become links: a notices entry with any other scheme stays
// a plain row rather than a clickable href.
function _link(url: string, inner: Html): Html {
    if (url.startsWith('https://')) {
        return html`<a class="settings-row licenses-row" href="${esc(url)}" target="_blank" rel="noopener">${inner}<span class="settings-chev" aria-hidden="true"></span></a>`;
    }
    return html`<div class="settings-row settings-row-static licenses-row">${inner}</div>`;
}

function _appCard(): Html {
    return html`<div class="settings-group">
                    ${_link(APP_LICENSE_URL, html`<span class="settings-row-text"><span class="settings-row-title">Gaggiuino Local Profiler</span><span class="settings-row-sub">${tHtml('licenses_app_desc')}</span></span>`)}
                    ${_link(APP_SOURCE_URL, html`<span class="settings-row-text"><span class="settings-row-title">${tHtml('licenses_app_source')}</span><span class="settings-row-sub">github.com/mxkissnr/gaggiuino-local-profiler</span></span>`)}
                </div>`;
}

function _componentRow(component: NoticeComponent): Html {
    const inner = html`<span class="settings-row-text"><span class="settings-row-title">${esc(component.title)}</span><span class="settings-row-sub">${esc(component.purpose)}</span><span class="licenses-licence">${esc(component.licence)}</span></span>`;
    return _link(component.source, inner);
}

function _group(group: NoticeGroup, components: readonly NoticeComponent[]): Html {
    const items = components.filter(component => component.group === group);
    if (items.length === 0) return esc('');
    return html`<h3 class="licenses-heading">${tHtml(GROUP_KEYS[group])} <span class="licenses-count">${esc(items.length)}</span></h3>
                <div class="settings-group">${joinHtml(items.map(_componentRow))}</div>`;
}

function _licenceTexts(notices: ParsedNotices): Html {
    if (notices.licences.length === 0) return esc('');
    const items = notices.licences.map(licence => html`<details class="licenses-text"><summary><span class="settings-row-text"><span class="settings-row-title">${esc(licence.name)}</span><span class="settings-row-sub">${esc(licence.covers)}</span></span></summary><pre>${esc(licence.text)}</pre></details>`);
    return html`<h3 class="licenses-heading">${tHtml('licenses_texts')} <span class="licenses-count">${esc(notices.licences.length)}</span></h3>
                <div class="settings-group">${joinHtml(items)}</div>`;
}

export function licensesSheetHtml(notices: ParsedNotices): Html {
    return joinHtml([
        _appCard(),
        ...NOTICE_GROUPS.map(group => _group(group, notices.components)),
        _licenceTexts(notices),
    ]);
}

let _notices: Promise<ParsedNotices> | null = null;

// One fetch per page load; a rejection clears the cache so the next open retries.
function _load(): Promise<ParsedNotices> {
    _notices ??= (async (): Promise<ParsedNotices> => {
        const res = await fetch(NOTICES_URL);
        if (!res.ok) throw new Error(`notices: HTTP ${res.status}`);
        const parsed = parseNotices(await res.text());
        if (parsed.components.length === 0) throw new Error('notices: no components');
        return parsed;
    })().catch((err: unknown) => {
        _notices = null;
        throw err;
    });
    return _notices;
}

export async function openLicensesSheet(): Promise<void> {
    let closed = false;
    const show = (body: Html): void => {
        openDetailSheet({
            title: t('settings_licenses'),
            sub: t('licenses_intro'),
            body,
            dialog: true,
            onClose: () => { closed = true; },
        });
    };
    show(html`<p class="licenses-state">${tHtml('licenses_loading')}</p>`);
    let notices: ParsedNotices;
    try {
        notices = await _load();
    } catch {
        if (!closed) show(html`<p class="licenses-state">${tHtml('licenses_error')}</p>`);
        return;
    }
    if (closed) return;
    show(licensesSheetHtml(notices));
}
