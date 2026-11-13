// #2038: the settings page is a grouped list (Home Assistant's pattern) with
// one sub-page per group. This module switches between those sub-pages and
// filters the settings by label; every card inside a sub-page keeps its own
// wiring (boot/settings.ts etc.).
import { t, tHtml } from '../i18n.js';
import { machineIconMiniSvg } from '../machine-icon.js';
import {
  BEAN_ICON_SVG, BELL_ICON_SVG, CLOCK_ICON_SVG, COFFEE_ICON_SVG,
  LINK_ICON_SVG, STAR_ICON_SVG, SUN_ICON_SVG,
} from '../icons.js';
import { esc, html, joinHtml } from '../utils.js';
import type { Html } from '../utils.js';
import { isPhoneSheetWidth } from '../components/sheet-swipe.js';
import { markWhatsNewRead, syncWhatsNewDot } from './popups.js';
import { loadMqttSettings } from '../components/mqtt-settings.js';
import { renderShotDefaultsSettingsCard } from '../components/shot-defaults-settings.js';
import { renderBeanFreshnessSettings } from '../components/bean-freshness-settings.js';
import { loadNotifySettingsCard } from '../components/notify-settings.js';
import { loadMcpSettingsCard } from '../components/mcp-settings.js';
import { openDetailSheet } from '../components/detail-sheet.js';

export interface SettingsGroup {
  id: string;
  titleKey: string;
  subKey: string;
  icon: Html;
  tint: string;
  card: 1 | 2;
  /** The row also shows the unread-release roast dot (#2038). */
  dot?: true;
}

export const SETTINGS_GROUPS: readonly SettingsGroup[] = [
  { id: 'appearance', titleKey: 'settings_group_appearance', subKey: 'settings_group_appearance_sub', icon: SUN_ICON_SVG, tint: 'var(--swatch-pink)', card: 1 },
  { id: 'machines', titleKey: 'settings_machines', subKey: 'settings_group_machines_sub', icon: machineIconMiniSvg(null), tint: 'var(--accent)', card: 1 },
  { id: 'coffee', titleKey: 'settings_group_coffee', subKey: 'settings_group_coffee_sub', icon: BEAN_ICON_SVG, tint: 'var(--amber-deep)', card: 1 },
  { id: 'notifications', titleKey: 'settings_notify_title', subKey: 'settings_group_notify_sub', icon: BELL_ICON_SVG, tint: 'var(--warn)', card: 1 },
  { id: 'data', titleKey: 'settings_group_data', subKey: 'settings_group_data_sub', icon: CLOCK_ICON_SVG, tint: 'var(--swatch-green)', card: 1 },
  { id: 'whats-new', titleKey: 'settings_whats_new', subKey: 'settings_whats_new_desc', icon: STAR_ICON_SVG, tint: 'var(--swatch-amber)', card: 2, dot: true },
  { id: 'developer', titleKey: 'settings_group_dev', subKey: 'settings_group_dev_sub', icon: LINK_ICON_SVG, tint: 'var(--swatch-cyan)', card: 2 },
  { id: 'about', titleKey: 'settings_group_about', subKey: 'settings_group_about_sub', icon: COFFEE_ICON_SVG, tint: 'var(--gray-400)', card: 2 },
];

// #2038 slice 5: a form card that still sits open in its sub-page becomes one
// row whose value is read off the form controls; tapping it opens the very
// same card (same ids, same boot wiring) in the shared detail sheet.
export interface SettingsDialogRow {
  id: string;
  group: string;
  anchorId: string;
  titleKey: string;
  value: () => string;
  /** Fills the card from its stored values, dropping an unsaved edit. */
  reload: () => void | Promise<void>;
}

// The click and value helpers below run on a phone too, where a stable
// document is not guaranteed mid-render; a missing element means an empty value.
function _query<T extends HTMLElement>(selector: string): T | null {
  return typeof document.querySelector === 'function' ? document.querySelector<T>(selector) : null;
}

function _checkedTransport(): string {
  return _query<HTMLElement>('#mqttTransportToggle .theme-btn.active')?.textContent?.trim() ?? '';
}

function _shotDefaultsValue(): string {
  const coffee = document.getElementById('sdCoffee') as HTMLSelectElement | null;
  const bean = coffee?.selectedOptions?.[0]?.textContent?.trim() ?? '';
  const dose = (document.getElementById('sdDose') as HTMLInputElement | null)?.value.trim() ?? '';
  const parts = [bean, dose ? `${dose} g` : ''].filter(Boolean);
  return parts.join(' · ') || (document.getElementById('sdCoffee') ? t('sd_none') : '');
}

function _freshnessValue(): string {
  const from = (document.getElementById('bfPeakFrom') as HTMLInputElement | null)?.value.trim() ?? '';
  const until = (document.getElementById('bfPeakUntil') as HTMLInputElement | null)?.value.trim() ?? '';
  return from && until ? t('settings_value_days', from, until) : '';
}

function _notifyValue(): string {
  const list = document.getElementById('notifySettingsList');
  if (!list) return '';
  const boxes = Array.from(list.querySelectorAll<HTMLInputElement>('[data-notify-key]'));
  if (!boxes.length) return '';
  return t('settings_value_n_on', boxes.filter(b => b.checked).length, boxes.length);
}

function _mcpValue(): string {
  const on = (document.getElementById('mcpEnabled') as HTMLInputElement | null)?.checked;
  if (on === undefined) return '';
  return t(on ? 'settings_value_on' : 'settings_value_off');
}

export const SETTINGS_DIALOG_ROWS: readonly SettingsDialogRow[] = [
  { id: 'live', group: 'machines', anchorId: 'mqttTransportToggle', titleKey: 'settings_mqtt_title', value: _checkedTransport, reload: loadMqttSettings },
  { id: 'shot-defaults', group: 'coffee', anchorId: 'sdDrinkType', titleKey: 'settings_shot_defaults_title', value: _shotDefaultsValue, reload: renderShotDefaultsSettingsCard },
  { id: 'freshness', group: 'coffee', anchorId: 'bfDegasUntil', titleKey: 'bf_title', value: _freshnessValue, reload: renderBeanFreshnessSettings },
  { id: 'push', group: 'notifications', anchorId: 'notifySettingsList', titleKey: 'settings_push_title', value: _notifyValue, reload: loadNotifySettingsCard },
  { id: 'mcp', group: 'developer', anchorId: 'mcpSettingsList', titleKey: 'settings_mcp_title', value: _mcpValue, reload: loadMcpSettingsCard },
];

export interface SettingsSearchItem {
  group: string;
  label: string;
  el: HTMLElement | null;
}

// Search matches labels regardless of accents and case ("cafe" finds "Café").
export function normalizeSettingsText(s: string): string {
  return s
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ' ');
}

export function filterSettingsItems(items: readonly SettingsSearchItem[], query: string): SettingsSearchItem[] {
  const q = normalizeSettingsText(query);
  if (!q) return [];
  const seen = new Set<string>();
  const out: SettingsSearchItem[] = [];
  for (const item of items) {
    const label = normalizeSettingsText(item.label);
    if (!label.includes(q)) continue;
    const key = `${item.group}\u0000${label}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function _row(g: SettingsGroup): Html {
  // The data-i18n spans hold text only, so a language switch relabels them.
  const dot: Html = g.dot
    ? html`<span class="settings-roast-dot" id="settingsWhatsNewDot" role="img" aria-label="${tHtml('settings_whats_new_unread')}" data-i18n-aria-label="settings_whats_new_unread" hidden></span>`
    : esc('');
  return html`<button type="button" class="settings-row" data-settings-open="${esc(g.id)}" style="--settings-tint:${esc(g.tint)}">
                    <span class="settings-row-icon" aria-hidden="true">${g.icon}</span>
                    <span class="settings-row-text"><span class="settings-row-title" data-i18n="${esc(g.titleKey)}">${tHtml(g.titleKey)}</span><span class="settings-row-sub" data-i18n="${esc(g.subKey)}">${tHtml(g.subKey)}</span></span>
                    ${dot}<span class="settings-chev" aria-hidden="true"></span>
                </button>`;
}

export function settingsGroupsHtml(groups: readonly SettingsGroup[] = SETTINGS_GROUPS): Html {
  return joinHtml(([1, 2] as const).map(card => html`<div class="settings-group">
                ${joinHtml(groups.filter(g => g.card === card).map(_row))}
            </div>`));
}

function _view(): HTMLElement | null {
  return document.getElementById('settings-view');
}

function _group(id: string): SettingsGroup | undefined {
  return SETTINGS_GROUPS.find(g => g.id === id);
}

function _page(view: HTMLElement, id: string): HTMLElement | null {
  return view.querySelector<HTMLElement>(`.settings-page[data-settings-page="${id}"]`);
}

function _dialogRowHtml(row: SettingsDialogRow): Html {
  return html`<button type="button" class="settings-row" data-settings-dialog="${esc(row.id)}">
                    <span class="settings-row-text"><span class="settings-row-title" data-i18n="${esc(row.titleKey)}">${tHtml(row.titleKey)}</span></span>
                    <span class="settings-row-value" data-settings-value="${esc(row.id)}"></span>
                    <span class="settings-chev" aria-hidden="true"></span>
                </button>`;
}

// Moves each form card out of the page flow (the row stands in for it) and
// appends the rows to their group, at the end so they follow the machine list.
function _mountDialogRows(): void {
  const view = _view();
  if (!view) return;
  const hosts = new Map<string, HTMLElement>();
  for (const row of SETTINGS_DIALOG_ROWS) {
    const card = document.getElementById(row.anchorId)?.closest<HTMLElement>('.settings-card');
    if (!card) continue;
    card.classList.add('settings-dialog-card');
    let host = hosts.get(row.group);
    if (!host) {
      const page = _page(view, row.group);
      if (!page) continue;
      host = document.createElement('div');
      host.className = 'settings-card settings-row-card settings-row-group';
      page.appendChild(host);
      hosts.set(row.group, host);
    }
    host.insertAdjacentHTML('beforeend', _dialogRowHtml(row));
  }
}

function _dialogRowForCard(card: HTMLElement): SettingsDialogRow | undefined {
  return SETTINGS_DIALOG_ROWS.find(row => document.getElementById(row.anchorId)?.closest<HTMLElement>('.settings-card') === card);
}

function _openDialogRow(row: SettingsDialogRow): void {
  const card = document.getElementById(row.anchorId)?.closest<HTMLElement>('.settings-card');
  if (!card) return;
  openDetailSheet({
    title: t(row.titleKey),
    dialog: true,
    body: html``,
    content: card,
    // Closing drops an unsaved edit: the card is filled from its stored
    // values again and the row shows what is actually stored.
    onClose: () => {
      void Promise.resolve(row.reload()).then(_renderDialogValues).catch(() => {});
    },
  });
}

function _renderDialogValues(): void {
  for (const row of SETTINGS_DIALOG_ROWS) {
    const el = _query<HTMLElement>(`[data-settings-value="${row.id}"]`);
    if (el) el.textContent = row.value();
  }
}

export function showSettingsPage(id: string): void {
  const view = _view();
  if (!view) return;
  const page = _page(view, id);
  if (!page) return;
  for (const el of Array.from(view.querySelectorAll<HTMLElement>('.settings-page'))) {
    el.hidden = el !== page;
  }
  for (const row of Array.from(view.querySelectorAll<HTMLElement>('[data-settings-open]'))) {
    if (row.dataset.settingsOpen === id) row.setAttribute('aria-current', 'page');
    else row.removeAttribute('aria-current');
  }
  const title = document.getElementById('settingsPageTitle');
  const group = _group(id);
  if (title && group) {
    title.textContent = t(group.titleKey);
    title.dataset.i18n = group.titleKey;
  }
  _renderDialogValues();
}

export function openSettingsPage(id: string): void {
  const view = _view();
  if (!view || !_page(view, id)) return;
  showSettingsPage(id);
  view.dataset.page = id;
  view.scrollTop = 0;
  if (id === 'whats-new') markWhatsNewRead();
  if (isPhoneSheetWidth()) view.querySelector<HTMLElement>('[data-settings-back]')?.focus();
}

export function closeSettingsPage(): void {
  const view = _view();
  if (!view) return;
  const open = view.dataset.page;
  delete view.dataset.page;
  if (!open) return;
  view.querySelector<HTMLElement>(`[data-settings-open="${open}"]`)?.focus();
}

let _searchResults: readonly SettingsSearchItem[] = [];

function _resultRow(item: SettingsSearchItem, index: number): Html {
  const group = _group(item.group);
  const icon = group ? group.icon : esc('');
  const tint = group ? group.tint : 'var(--gray-400)';
  const groupTitle = group ? t(group.titleKey) : '';
  return html`<button type="button" class="settings-row" data-settings-open="${esc(item.group)}" data-settings-result="${esc(index)}" style="--settings-tint:${esc(tint)}">
                    <span class="settings-row-icon" aria-hidden="true">${icon}</span>
                    <span class="settings-row-text"><span class="settings-row-title">${esc(item.label)}</span><span class="settings-row-sub">${esc(groupTitle)}</span></span>
                    <span class="settings-chev" aria-hidden="true"></span>
                </button>`;
}

// Cards the build or the session hides (dev tools on a stable install, the API
// token card without a token) are not settings the user can reach.
function _collectSettingsItems(): SettingsSearchItem[] {
  const items: SettingsSearchItem[] = SETTINGS_GROUPS.map(g => ({ group: g.id, label: t(g.titleKey), el: null }));
  // A group title that also heads a card ("Notifications") is one entry: keep
  // the card title, so the result jumps to it instead of stopping at the top.
  const seen = new Map<string, SettingsSearchItem>(
    items.map(item => [`${item.group}\u0000${normalizeSettingsText(item.label)}`, item] as const),
  );
  const view = _view();
  if (!view) return items;
  for (const page of Array.from(view.querySelectorAll<HTMLElement>('.settings-page'))) {
    const group = page.dataset.settingsPage ?? '';
    const labels = page.querySelectorAll<HTMLElement>('.settings-card-title, .settings-row-title, label');
    for (const el of Array.from(labels)) {
      const label = el.textContent?.trim() ?? '';
      if (!label) continue;
      if (el.closest<HTMLElement>('.settings-card')?.style.display === 'none') continue;
      const key = `${group}\u0000${normalizeSettingsText(label)}`;
      const existing = seen.get(key);
      if (existing) {
        if (!existing.el) existing.el = el;
        continue;
      }
      const item: SettingsSearchItem = { group, label, el };
      seen.set(key, item);
      items.push(item);
    }
  }
  return items;
}

function _renderSearch(query: string): void {
  const resultsEl = document.getElementById('settingsSearchResults');
  const emptyEl = document.getElementById('settingsSearchEmpty');
  const groupsEl = document.getElementById('settingsGroups');
  if (!resultsEl || !emptyEl || !groupsEl) return;
  const verdictEl = document.getElementById('settingsVerdict');
  if (!normalizeSettingsText(query)) {
    _searchResults = [];
    resultsEl.hidden = true;
    emptyEl.hidden = true;
    groupsEl.hidden = false;
    if (verdictEl) verdictEl.hidden = false;
    return;
  }
  groupsEl.hidden = true;
  if (verdictEl) verdictEl.hidden = true;
  _searchResults = filterSettingsItems(_collectSettingsItems(), query);
  resultsEl.innerHTML = joinHtml(_searchResults.map(_resultRow));
  resultsEl.hidden = _searchResults.length === 0;
  emptyEl.hidden = _searchResults.length > 0;
}

export function wireSettingsPage(): void {
  const view = _view();
  if (!view) return;
  const groups = document.getElementById('settingsGroups');
  if (groups) groups.innerHTML = settingsGroupsHtml();
  syncWhatsNewDot();
  _mountDialogRows();
  // Desktop default: Appearance is open on the right. On a phone the list
  // stays in front because data-page is only set by a row click.
  showSettingsPage('appearance');
  view.addEventListener('click', (ev: MouseEvent) => {
    const target = ev.target as HTMLElement | null;
    const open = target?.closest<HTMLElement>('[data-settings-open]');
    if (open?.dataset.settingsOpen) {
      openSettingsPage(open.dataset.settingsOpen);
      const result = open.dataset.settingsResult;
      const el = result === undefined ? null : _searchResults[Number(result)]?.el ?? null;
      // A label inside a dialog card is reachable by search; its row is what
      // the result opens, since the card itself is not on the page.
      const card = el?.closest<HTMLElement>('.settings-dialog-card') ?? null;
      const dialogRow = card ? _dialogRowForCard(card) : undefined;
      if (dialogRow) {
        _openDialogRow(dialogRow);
        return;
      }
      if (el && el.offsetParent !== null) el.scrollIntoView({ block: 'center' });
      return;
    }
    const dialogOpen = target?.closest<HTMLElement>('[data-settings-dialog]');
    if (dialogOpen?.dataset.settingsDialog) {
      const row = SETTINGS_DIALOG_ROWS.find(r => r.id === dialogOpen.dataset.settingsDialog);
      if (row) _openDialogRow(row);
      return;
    }
    if (target?.closest('[data-settings-back]')) {
      closeSettingsPage();
      return;
    }
    // The button's own handler (boot/settings.ts) ran first; folding the menu
    // here keeps the bar's overflow closed after it was used.
    if (target?.closest('#settingsMore .lib-sheet-menu-btn')) {
      const more = document.getElementById('settingsMore') as HTMLDetailsElement | null;
      if (more) more.open = false;
    }
  });

  // The query survives while a sub-page is open, so the phone back arrow
  // returns to the same results.
  const search = document.getElementById('settingsSearch') as HTMLInputElement | null;
  const bar = document.getElementById('settingsBar');
  if (search) {
    search.addEventListener('input', () => _renderSearch(search.value));
    search.addEventListener('keydown', (ev: KeyboardEvent) => {
      if (ev.key !== 'Escape') return;
      search.value = '';
      _renderSearch('');
      bar?.classList.remove('is-searching');
    });
    search.addEventListener('blur', () => {
      if (!search.value.trim()) bar?.classList.remove('is-searching');
    });
    document.getElementById('settingsSearchBtn')?.addEventListener('click', () => {
      bar?.classList.add('is-searching');
      search.focus();
    });
  }
}
