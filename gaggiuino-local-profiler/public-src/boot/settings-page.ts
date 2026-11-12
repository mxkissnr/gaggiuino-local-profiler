// #2038: the settings page is a grouped list (Home Assistant's pattern) with
// one sub-page per group. This module only switches between those sub-pages:
// every card inside a sub-page keeps its own wiring (boot/settings.ts etc.).
import { t, tHtml } from '../i18n.js';
import { machineIconMiniSvg } from '../machine-icon.js';
import {
  BEAN_ICON_SVG, BELL_ICON_SVG, CLOCK_ICON_SVG, COFFEE_ICON_SVG,
  LINK_ICON_SVG, STAR_ICON_SVG, SUN_ICON_SVG,
} from '../icons.js';
import { esc, html, joinHtml } from '../utils.js';
import type { Html } from '../utils.js';
import { isPhoneSheetWidth } from '../components/sheet-swipe.js';

export interface SettingsGroup {
  id: string;
  titleKey: string;
  subKey: string;
  icon: Html;
  tint: string;
  card: 1 | 2;
}

export const SETTINGS_GROUPS: readonly SettingsGroup[] = [
  { id: 'appearance', titleKey: 'settings_group_appearance', subKey: 'settings_group_appearance_sub', icon: SUN_ICON_SVG, tint: 'var(--swatch-pink)', card: 1 },
  { id: 'machines', titleKey: 'settings_machines', subKey: 'settings_group_machines_sub', icon: machineIconMiniSvg(null), tint: 'var(--accent)', card: 1 },
  { id: 'coffee', titleKey: 'settings_group_coffee', subKey: 'settings_group_coffee_sub', icon: BEAN_ICON_SVG, tint: 'var(--amber-deep)', card: 1 },
  { id: 'notifications', titleKey: 'settings_notify_title', subKey: 'settings_group_notify_sub', icon: BELL_ICON_SVG, tint: 'var(--warn)', card: 1 },
  { id: 'data', titleKey: 'settings_group_data', subKey: 'settings_group_data_sub', icon: CLOCK_ICON_SVG, tint: 'var(--swatch-green)', card: 1 },
  { id: 'whats-new', titleKey: 'settings_whats_new', subKey: 'settings_whats_new_desc', icon: STAR_ICON_SVG, tint: 'var(--swatch-amber)', card: 2 },
  { id: 'developer', titleKey: 'settings_group_dev', subKey: 'settings_group_dev_sub', icon: LINK_ICON_SVG, tint: 'var(--swatch-cyan)', card: 2 },
  { id: 'about', titleKey: 'settings_group_about', subKey: 'settings_group_about_sub', icon: COFFEE_ICON_SVG, tint: 'var(--gray-400)', card: 2 },
];

function _row(g: SettingsGroup): Html {
  // The data-i18n spans hold text only, so a language switch relabels them.
  return html`<button type="button" class="settings-row" data-settings-open="${esc(g.id)}" style="--settings-tint:${esc(g.tint)}">
                    <span class="settings-row-icon" aria-hidden="true">${g.icon}</span>
                    <span class="settings-row-text"><span class="settings-row-title" data-i18n="${esc(g.titleKey)}">${tHtml(g.titleKey)}</span><span class="settings-row-sub" data-i18n="${esc(g.subKey)}">${tHtml(g.subKey)}</span></span>
                    <span class="settings-chev" aria-hidden="true"></span>
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

export function showSettingsPage(id: string): void {
  const view = _view();
  if (!view) return;
  const page = view.querySelector(`.settings-page[data-settings-page="${id}"]`);
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
  showSettingsPage(id);
  if (!view) return;
  view.dataset.page = id;
  view.scrollTop = 0;
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

export function wireSettingsPage(): void {
  const view = _view();
  if (!view) return;
  const groups = document.getElementById('settingsGroups');
  if (groups) groups.innerHTML = settingsGroupsHtml();
  // Desktop default: Appearance is open on the right. On a phone the list
  // stays in front because data-page is only set by a row click.
  showSettingsPage('appearance');
  view.addEventListener('click', (ev: MouseEvent) => {
    const target = ev.target as HTMLElement | null;
    const open = target?.closest<HTMLElement>('[data-settings-open]');
    if (open?.dataset.settingsOpen) {
      openSettingsPage(open.dataset.settingsOpen);
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
}
