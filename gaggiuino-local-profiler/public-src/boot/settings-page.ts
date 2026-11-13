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
      if (el && el.offsetParent !== null) el.scrollIntoView({ block: 'center' });
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
