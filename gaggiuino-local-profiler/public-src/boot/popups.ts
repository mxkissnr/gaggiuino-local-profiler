// #1956: in-app popups. What's New opens once per new version; see
// components/popup-queue.ts for how popups wait for their turn. Preferences and
// seen markers live in the shared ui-prefs store (ui-prefs.ts).
import { S } from '../state/index.js';
import { t, tHtml } from '../i18n.js';
import { reloadBlocked } from '../live-sync.js';
import {
  POPUPS_PREF, SEEN_ACHIEVEMENTS_PREF, SEEN_WHATS_NEW_PREF, advanceSeenMarker,
  getUiPref, loadUiPrefsFromServer, setUiPref, uiPrefsInSync,
} from '../ui-prefs.js';
import { getWhatsNewEntries } from '../shared/whats-new.js';
import type { WhatsNewEntry } from '../shared/whats-new.js';
import { whatsNewEntriesHtml } from '../components/whats-new.js';
import { openDetailSheet } from '../components/detail-sheet.js';
import { enqueuePopup, initPopupQueue } from '../components/popup-queue.js';
import { esc, html, joinHtml } from '../utils.js';
import { getAchievements } from '../api/system.js';
import { badgeDesc, badgeName } from '../views/achievements.js';
import type { Achievement } from '../views/achievements.js';

export interface PopupSwitches {
  enabled: boolean;
  whats_new: boolean;
  achievements: boolean;
}

/** The stored switches; anything but an explicit false counts as on. */
export function popupSwitches(): PopupSwitches {
  const v = getUiPref<Partial<PopupSwitches> | null>(POPUPS_PREF);
  const o: Partial<PopupSwitches> = v && typeof v === 'object' ? v : {};
  return {
    enabled: o.enabled !== false,
    whats_new: o.whats_new !== false,
    achievements: o.achievements !== false,
  };
}

function _allowed(kind: 'whats_new' | 'achievements'): boolean {
  const s = popupSwitches();
  return s.enabled && s[kind];
}

/** A release version as one comparable number; 0 when it is not x.y.z. */
export function versionCode(version: string): number {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!m) return 0;
  return Number(m[1]) * 1_000_000 + Number(m[2]) * 1_000 + Number(m[3]);
}

export interface WhatsNewPlan {
  marker: number;
  /** Entries to show; empty means record the marker and show nothing. */
  entries: WhatsNewEntry[];
}

/** Decides the What's New popup; null when there is nothing to do. */
export function planWhatsNew(
  entries: readonly WhatsNewEntry[],
  seen: unknown,
  hasHistory: boolean,
): WhatsNewPlan | null {
  const newest = entries[0];
  if (!newest) return null;
  const marker = versionCode(newest.version);
  if (typeof seen !== 'number') return { marker, entries: hasHistory ? [newest] : [] };
  if (marker <= seen) return null;
  return { marker, entries: entries.filter(e => versionCode(e.version) > seen) };
}

interface Stamped {
  unlocked?: boolean;
  unlockedAt?: number | null;
}

function _unlockedTime(b: Stamped): number | null {
  return b.unlocked === true && typeof b.unlockedAt === 'number' ? b.unlockedAt : null;
}

/**
 * Decides the achievement popup. Without a marker (the first run) it only
 * returns the baseline. `fresh` holds nothing but unlocked badges.
 */
export function planAchievements<T extends Stamped>(
  badges: readonly T[],
  seen: unknown,
): { marker: number; fresh: T[] } {
  const newest = badges.reduce((max, b) => Math.max(max, _unlockedTime(b) ?? 0), 0);
  if (typeof seen !== 'number') return { marker: newest, fresh: [] };
  return { marker: Math.max(seen, newest), fresh: badges.filter(b => (_unlockedTime(b) ?? 0) > seen) };
}

function _canShow(): boolean {
  return document.visibilityState === 'visible' && !S.liveWasLive && !reloadBlocked();
}

function _isBehind(key: string, marker: number): boolean {
  const seen = getUiPref<unknown>(key);
  return !(typeof seen === 'number' && seen >= marker);
}

function _checkWhatsNew(): void {
  const plan = planWhatsNew(getWhatsNewEntries(), getUiPref(SEEN_WHATS_NEW_PREF), S.allShots.length > 0);
  if (!plan) return;
  if (!plan.entries.length || !_allowed('whats_new')) {
    advanceSeenMarker(SEEN_WHATS_NEW_PREF, plan.marker);
    return;
  }
  enqueuePopup({
    id: 'whats-new',
    isDue: () => _allowed('whats_new') && _isBehind(SEEN_WHATS_NEW_PREF, plan.marker),
    show: done => {
      advanceSeenMarker(SEEN_WHATS_NEW_PREF, plan.marker);
      openDetailSheet({
        title: t('settings_whats_new'),
        body: html`<div class="whats-new-list" style="max-height:none">${whatsNewEntriesHtml(plan.entries)}</div>`,
        onClose: done,
      });
    },
  });
}

let _started = false;

/** Compares the unlocked badges with the seen marker; at start and after new shots. */
export async function checkAchievementPopups(): Promise<void> {
  if (!_started) return;
  let badges: Achievement[];
  try {
    const r = await getAchievements(S.currentLang);
    if (!r.ok) return;
    badges = ((await r.json()) as { badges?: Achievement[] }).badges ?? [];
  } catch {
    return;
  }
  const plan = planAchievements(badges, getUiPref(SEEN_ACHIEVEMENTS_PREF));
  if (!plan.fresh.length || !_allowed('achievements')) {
    advanceSeenMarker(SEEN_ACHIEVEMENTS_PREF, plan.marker);
    return;
  }
  enqueuePopup({
    id: 'achievements',
    isDue: () => _allowed('achievements') && _isBehind(SEEN_ACHIEVEMENTS_PREF, plan.marker),
    show: done => {
      // Only what this device has not seen by now; a secret badge without copy is left out.
      const items = planAchievements(plan.fresh, getUiPref(SEEN_ACHIEVEMENTS_PREF)).fresh.filter(b => badgeName(b));
      advanceSeenMarker(SEEN_ACHIEVEMENTS_PREF, plan.marker);
      if (!items.length) { done(); return; }
      openDetailSheet({
        title: items.length === 1 ? t('popups_ach_title_one') : t('popups_ach_title_many', items.length),
        body: html`<div class="whats-new-list" style="max-height:none">${joinHtml(items.map(b => html`
          <div class="whats-new-entry">
            <h4 class="whats-new-version">${esc(badgeName(b) ?? '')}</h4>
            <p class="settings-card-desc">${esc(badgeDesc(b) ?? '')}</p>
          </div>`))}</div>`,
        onClose: done,
      });
    },
  });
}

function _bindSwitch(id: string, key: keyof PopupSwitches, s: PopupSwitches): void {
  const box = document.getElementById(id) as HTMLInputElement | null;
  if (!box) return;
  box.checked = s[key];
  if (key !== 'enabled') box.disabled = !s.enabled;
  box.onchange = () => {
    setUiPref(POPUPS_PREF, { ...popupSwitches(), [key]: box.checked });
    renderPopupSettings();
  };
}

/** Fills the switches from the shared preferences; the markup is built once. */
export function renderPopupSettings(): void {
  const card = document.getElementById('popupSettingsCard');
  if (!card) return;
  if (!card.dataset.ready) {
    card.dataset.ready = '1';
    card.innerHTML = html`
      <h3 class="settings-card-title" data-i18n="settings_popups_title">${tHtml('settings_popups_title')}</h3>
      <p class="settings-card-desc" data-i18n="settings_popups_desc">${tHtml('settings_popups_desc')}</p>
      <div class="orders-broadcast-row" style="min-height:44px"><input type="checkbox" id="popupsEnabled"><label for="popupsEnabled" data-i18n="settings_popups_enabled">${tHtml('settings_popups_enabled')}</label></div>
      <div class="orders-broadcast-row" style="min-height:44px"><input type="checkbox" id="popupsWhatsNew"><label for="popupsWhatsNew" data-i18n="settings_popups_whats_new">${tHtml('settings_popups_whats_new')}</label></div>
      <div class="orders-broadcast-row" style="min-height:44px"><input type="checkbox" id="popupsAchievements"><label for="popupsAchievements" data-i18n="settings_popups_achievements">${tHtml('settings_popups_achievements')}</label></div>`;
    card.style.display = '';
  }
  const s = popupSwitches();
  _bindSwitch('popupsEnabled', 'enabled', s);
  _bindSwitch('popupsWhatsNew', 'whats_new', s);
  _bindSwitch('popupsAchievements', 'achievements', s);
}

/** Boot entry point. `applyPrefs` applies a changed shared-preferences read. */
export function startPopups(applyPrefs: () => void): void {
  if (S.isDemo || !uiPrefsInSync()) return;
  initPopupQueue({
    canShow: _canShow,
    refresh: async () => {
      if (await loadUiPrefsFromServer()) applyPrefs();
      return uiPrefsInSync();
    },
  });
  _started = true;
  _checkWhatsNew();
  void checkAchievementPopups();
}
