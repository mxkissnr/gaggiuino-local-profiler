// Configurable mobile bottom navigation (#443) — replaces the 8 hand-authored
// bnShots/bnLive/.../bnSettings buttons that used to be split hardcoded
// across #bottom-nav (4 main-bar buttons) and #moreSheet (4 "Mehr" buttons)
// in index.html. Same 8 DOM ids, same icons, same #bottom-nav-btn/
// .more-sheet-item classes — only WHERE each id ends up (main bar vs. Mehr
// sheet) is now driven by a user-chosen, localStorage-persisted order
// instead of being fixed in markup. mode.js's active-state toggling and
// status.js's Live/Orders capability gating both keep reading these ids via
// getElementById() exactly as before and need no changes.
import { S } from '../state.js';
import { t } from '../i18n.js';
import { switchMode } from './mode.js';
import { setMobileShotSubview } from './sidebar.js';

export const STORAGE_KEY = 'glp_bottom_nav_config';
export const MAX_MAIN_BAR = 4;

// Canonical list of all 8 possible nav destinations, in the same order
// they appeared in the old static markup (main-bar 4, then Mehr-sheet 4).
// iconPaths is the raw inner SVG markup (paths/circles only) so the same
// icon can be wrapped differently for a main-bar button (.bn-icon, 20px,
// class "rail-icon") vs. a Mehr-sheet row (class "rail-icon sm") without
// duplicating the vector data.
export const NAV_ITEMS = [
  { id: 'shots', i18nKey: 'nav_shots', label: 'Shots',
    iconPaths: '<path d="M17 8h1a3 3 0 0 1 0 6h-1M4 8h13v7a4 4 0 0 1-4 4H8a4 4 0 0 1-4-4V8z"/><path d="M8 2v2M12 2v2"/>' },
  { id: 'live', i18nKey: 'nav_live', label: 'Live', hasLiveDot: true, hiddenByDefault: true,
    iconPaths: '<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>' },
  { id: 'library', i18nKey: 'nav_library', label: 'Bibliothek',
    iconPaths: '<path d="M2 4h6a4 4 0 0 1 4 4v13a3 3 0 0 0-3-3H2zM22 4h-6a4 4 0 0 0-4 4v13a3 3 0 0 1 3-3h7z"/>' },
  { id: 'analytics', i18nKey: 'nav_analytics', label: 'Statistiken',
    iconPaths: '<path d="M6 20v-5M12 20V9M18 20V4"/>' },
  { id: 'dialin', i18nKey: 'nav_dialin', label: 'Bezugslog',
    iconPaths: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1"/>' },
  { id: 'maintenance', i18nKey: 'nav_maintenance', label: 'Wartung',
    iconPaths: '<path d="M14.7 6.3a4.8 4.8 0 0 0-6.4 6.4L3 18l3 3 5.3-5.3a4.8 4.8 0 0 0 6.4-6.4l-3 3-2.7-2.7z"/>' },
  { id: 'orders', i18nKey: 'nav_orders', label: 'Bestellungen', hiddenByDefault: true,
    iconPaths: '<path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4a2 2 0 0 0 1-1.73z"/><path d="m3.3 7 8.7 5 8.7-5"/><path d="M12 22V12"/>' },
  { id: 'settings', i18nKey: 'nav_settings', label: 'Einstellungen',
    iconPaths: '<path d="M4 8h10M18 8h2M4 16h2M10 16h10"/><circle cx="16" cy="8" r="2"/><circle cx="8" cy="16" r="2"/>' },
];

const NAV_ITEM_MAP = Object.fromEntries(NAV_ITEMS.map(i => [i.id, i]));
export const ALL_IDS = NAV_ITEMS.map(i => i.id);

// Today's fixed set, reproduced exactly whenever the stored config is
// missing, empty or corrupted — the regression-safety-net default.
export const DEFAULT_MAIN_BAR = ['shots', 'live', 'library', 'analytics'];

function bnDomId(id) {
  return 'bn' + id.charAt(0).toUpperCase() + id.slice(1);
}

// Parses+validates the persisted main-bar selection: drops unknown/duplicate
// ids, forces "shots" to always be present and first (#431 — it's the
// mandatory primary mobile screen), and caps the result at MAX_MAIN_BAR.
// Same JSON-blob-with-try/catch-fallback convention as state.js's
// dialinSession/profileDialinSession.
export function getBottomNavConfig() {
  let parsed = null;
  try {
    parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
  } catch {
    parsed = null;
  }
  if (!Array.isArray(parsed) || parsed.length === 0) return [...DEFAULT_MAIN_BAR];

  const seen = new Set();
  const valid = [];
  for (const id of parsed) {
    if (typeof id !== 'string' || !NAV_ITEM_MAP[id] || seen.has(id)) continue;
    seen.add(id);
    valid.push(id);
  }
  if (valid.length === 0) return [...DEFAULT_MAIN_BAR];

  const withoutShots = valid.filter(id => id !== 'shots');
  return ['shots', ...withoutShots].slice(0, MAX_MAIN_BAR);
}

export function setBottomNavConfig(ids) {
  const normalized = Array.isArray(ids) ? ids : [];
  const seen = new Set();
  const valid = [];
  for (const id of normalized) {
    if (typeof id !== 'string' || !NAV_ITEM_MAP[id] || seen.has(id)) continue;
    seen.add(id);
    valid.push(id);
  }
  const withoutShots = valid.filter(id => id !== 'shots');
  const finalIds = ['shots', ...withoutShots].slice(0, MAX_MAIN_BAR);
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(finalIds)); } catch {}
  return finalIds;
}

function buildIcon(item, sizeClass) {
  const dot = item.hasLiveDot ? '<span class="live-dot"></span>' : '';
  return `<svg class="${sizeClass}" viewBox="0 0 24 24" aria-hidden="true">${item.iconPaths}</svg>${dot}`;
}

function buildMainBarButton(item) {
  const btn = document.createElement('button');
  btn.className = 'bottom-nav-btn';
  btn.id = bnDomId(item.id);
  if (item.hiddenByDefault) btn.style.display = 'none';
  btn.innerHTML = `<span class="bn-icon" aria-hidden="true">${buildIcon(item, 'rail-icon')}</span>` +
    `<span class="bn-label" data-i18n="${item.i18nKey}">${t(item.i18nKey)}</span>`;
  return btn;
}

function buildMoreSheetButton(item) {
  const btn = document.createElement('button');
  btn.className = 'more-sheet-item';
  btn.id = bnDomId(item.id);
  if (item.hiddenByDefault) btn.style.display = 'none';
  btn.innerHTML = `${buildIcon(item, 'rail-icon sm')}<span data-i18n="${item.i18nKey}">${t(item.i18nKey)}</span>`;
  return btn;
}

// "Mehr" sheet open/close (#403, mobile) — moved here from main.js since the
// sheet is now owned by this module's render function.
export function toggleMoreSheet() {
  const open = document.getElementById('moreSheet').classList.toggle('open');
  document.getElementById('more-sheet-backdrop').classList.toggle('visible', open);
  document.getElementById('bnMore').setAttribute('aria-expanded', open ? 'true' : 'false');
}

export function closeMoreSheet() {
  document.getElementById('moreSheet').classList.remove('open');
  document.getElementById('more-sheet-backdrop').classList.remove('visible');
  document.getElementById('bnMore').setAttribute('aria-expanded', 'false');
}

function onNavClick(id) {
  if (id === 'shots') { switchMode('shots'); setMobileShotSubview('detail'); return; }
  switchMode(id);
}

function onMoreSheetClick(id) {
  closeMoreSheet();
  switchMode(id);
}

// Reflects `mode` as .active across all 8 bn* ids plus bnMore. Each bn* id
// is a direct mode-name match (mode names equal NAV_ITEMS ids); bnMore
// lights up instead whenever the active id's button currently lives inside
// #moreSheet — a DOM containment check rather than a static list of mode
// names, since #443 made main-bar-vs-Mehr placement user-configurable (a
// mode that defaults into the sheet, e.g. "maintenance", can now render in
// the main bar instead, and vice versa; a hardcoded mode-name list would
// desync from wherever the item actually renders).
//
// Exported so mode.js's switchMode() calls this directly instead of
// duplicating the projection inline — this used to be a private
// applyActiveState() re-run after every renderBottomNav() rebuild (nav
// re-renders replace the DOM nodes, which would otherwise drop whichever
// bn* button was showing .active), and mode.js had its own separate,
// hardcoded copy of the same logic; keeping one implementation avoids the
// two copies drifting out of sync.
export function applyBottomNavActiveState(mode) {
  ALL_IDS.forEach(id => {
    document.getElementById(bnDomId(id))?.classList.toggle('active', mode === id);
  });
  const activeEl = document.getElementById(bnDomId(mode));
  const moreSheetEl = document.getElementById('moreSheet');
  const inMoreSheet = !!(activeEl && moreSheetEl && moreSheetEl.contains(activeEl));
  document.getElementById('bnMore')?.classList.toggle('active', inMoreSheet);
}

// Builds #bottom-nav (main-bar items + the always-present "Mehr" control)
// and #moreSheet (everything not currently in the main bar) from the
// persisted config. Capability gating (Live/Orders visibility) is untouched
// here — every one of the 8 ids is always rendered somewhere, with the same
// hiddenByDefault inline display:none the old static markup used, and
// status.js's updateStatus()/updatePowerButton() (which run right after
// this on every load, and again on every ~30s poll) apply the real
// show/hide state on top, same as before.
export function renderBottomNav() {
  const bar = document.getElementById('bottom-nav');
  const sheet = document.getElementById('moreSheet');
  if (!bar || !sheet) return;

  const mainBarIds = getBottomNavConfig();
  const moreSheetIds = ALL_IDS.filter(id => !mainBarIds.includes(id));

  bar.innerHTML = '';
  mainBarIds.forEach(id => bar.appendChild(buildMainBarButton(NAV_ITEM_MAP[id])));
  const moreBtn = document.createElement('button');
  moreBtn.className = 'bottom-nav-btn';
  moreBtn.id = 'bnMore';
  moreBtn.setAttribute('aria-haspopup', 'true');
  moreBtn.setAttribute('aria-expanded', 'false');
  moreBtn.innerHTML = '<span class="bn-icon" aria-hidden="true"><svg class="rail-icon" viewBox="0 0 24 24"><circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/></svg></span>' +
    `<span class="bn-label" data-i18n="nav_more">${t('nav_more')}</span>`;
  bar.appendChild(moreBtn);

  sheet.innerHTML = '';
  moreSheetIds.forEach(id => sheet.appendChild(buildMoreSheetButton(NAV_ITEM_MAP[id])));

  mainBarIds.forEach(id => document.getElementById(bnDomId(id)).addEventListener('click', () => onNavClick(id)));
  moreBtn.addEventListener('click', toggleMoreSheet);
  moreSheetIds.forEach(id => document.getElementById(bnDomId(id)).addEventListener('click', () => onMoreSheetClick(id)));

  applyBottomNavActiveState(S.currentMode);
}

// Pure projection of the persisted config into what the settings list needs
// to render: selected (main-bar) items first in their current bar order,
// then everything else in canonical order. Kept separate from DOM building
// below so the max-4/shots-pinned/reorder-boundary rules are unit-testable
// without a DOM. Max-4 enforcement strategy: disable further checkboxes
// once 4 are selected, rather than silently bumping the oldest pick out — a
// disabled control is a visible, predictable limit, whereas an
// auto-evicted earlier choice would look like Max's own selection got lost.
export function computeSettingsRows(selected = getBottomNavConfig()) {
  const unselected = ALL_IDS.filter(id => !selected.includes(id));
  return [...selected, ...unselected].map(id => {
    const isSelected = selected.includes(id);
    const selIdx = selected.indexOf(id);
    const isShots = id === 'shots';
    return {
      id,
      isSelected,
      isShots,
      checkDisabled: isShots || (!isSelected && selected.length >= MAX_MAIN_BAR),
      // Slot 0 is always "shots" — reordering never touches it.
      canMoveUp: isSelected && !isShots && selIdx > 1,
      canMoveDown: isSelected && !isShots && selIdx < selected.length - 1,
    };
  });
}

function moveSelectedItem(id, dir) {
  const cur = getBottomNavConfig();
  const i = cur.indexOf(id);
  if (i <= 0) return; // not selected, or "shots" (always index 0)
  const j = dir === 'up' ? i - 1 : i + 1;
  if (j <= 0 || j >= cur.length) return; // never swap into/out of the shots slot
  [cur[i], cur[j]] = [cur[j], cur[i]];
  setBottomNavConfig(cur);
  renderBottomNav();
  renderBottomNavSettings();
}

function buildReorderButton(dir, row, label) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'bottom-nav-reorder-btn';
  btn.dataset.dir = dir;
  btn.setAttribute('aria-label', label);
  btn.disabled = dir === 'up' ? !row.canMoveUp : !row.canMoveDown;
  btn.innerHTML = dir === 'up' ? '&#8593;' : '&#8595;';
  btn.addEventListener('click', () => moveSelectedItem(row.id, dir));
  return btn;
}

// Settings view "Mobile Navigationsleiste" card (#443): a checkbox +
// up/down reorder pair per destination, built from computeSettingsRows().
export function renderBottomNavSettings() {
  const container = document.getElementById('bottomNavConfigList');
  if (!container) return;

  container.innerHTML = '';
  computeSettingsRows().forEach(row => {
    const item = NAV_ITEM_MAP[row.id];
    const rowEl = document.createElement('div');
    rowEl.className = 'bottom-nav-config-row';

    const label = document.createElement('label');
    label.className = 'bottom-nav-config-check';
    label.title = t('settings_bottom_nav_checkbox_label');
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = row.isSelected;
    checkbox.disabled = row.checkDisabled;
    checkbox.setAttribute('aria-label', t('settings_bottom_nav_checkbox_label'));
    checkbox.addEventListener('change', () => {
      let next = getBottomNavConfig();
      if (checkbox.checked) {
        if (!next.includes(row.id) && next.length < MAX_MAIN_BAR) next = [...next, row.id];
      } else {
        next = next.filter(x => x !== row.id);
      }
      setBottomNavConfig(next);
      renderBottomNav();
      renderBottomNavSettings();
    });
    const labelText = document.createElement('span');
    labelText.setAttribute('data-i18n', item.i18nKey);
    labelText.textContent = t(item.i18nKey);
    label.appendChild(checkbox);
    label.appendChild(labelText);

    const reorder = document.createElement('span');
    reorder.className = 'bottom-nav-config-reorder';
    reorder.appendChild(buildReorderButton('up', row, t('settings_bottom_nav_move_up')));
    reorder.appendChild(buildReorderButton('down', row, t('settings_bottom_nav_move_down')));

    rowEl.appendChild(label);
    rowEl.appendChild(reorder);
    container.appendChild(rowEl);
  });
}
