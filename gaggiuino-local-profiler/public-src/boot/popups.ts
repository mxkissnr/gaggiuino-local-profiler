// #1956: in-app popups. What's New opens once per new version; see
// components/popup-queue.ts for how popups wait for their turn. Preferences and
// seen markers live in the shared ui-prefs store (ui-prefs.ts).
import { S } from '../state/index.js';
import { t } from '../i18n.js';
import { reloadBlocked } from '../live-sync.js';
import {
  POPUPS_PREF, SEEN_WHATS_NEW_PREF, advanceSeenMarker, getUiPref,
  loadUiPrefsFromServer, uiPrefsInSync,
} from '../ui-prefs.js';
import { getWhatsNewEntries } from '../shared/whats-new.js';
import type { WhatsNewEntry } from '../shared/whats-new.js';
import { whatsNewEntriesHtml } from '../components/whats-new.js';
import { openDetailSheet } from '../components/detail-sheet.js';
import { enqueuePopup, initPopupQueue } from '../components/popup-queue.js';
import { html } from '../utils.js';

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
  _checkWhatsNew();
}
