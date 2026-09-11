// Multi-machine registry UI (#319, #325) — Settings tab "Maschinen" card:
// list, add, edit, delete and test-connect the machines this GLP instance
// manages, against the /api/machines API added in #317. Also renders the
// topbar machine switcher and drives S.activeMachineId, which
// filterShotsByMachine() (state.js) and applyActiveMachineChange() below
// use to keep the Shots list / Analytics / Live view scoped to the
// selected machine.
import { S, setState, filterShotsByMachine } from '../state.js';
import { apiFetch } from '../api.js';
import { t } from '../i18n.js';
import { loadMachineProfileList } from '../views/library-profile-editor.js';
import { WARNING_ICON_SVG, CHECK_ICON_SVG, CLOSE_ICON_SVG } from '../icons.js';
import { updateStatus } from './status.js';
import { THEME_PRESETS, getThemePreset, resolveTheme } from '../shared/theme-presets.js';
import { migrateLegacyAccent } from '../theme.js';
import { machineIconSvg, machineIconMiniSvg } from '../machine-icon.js';
import { renderTopbarMachineIcon } from './topbar-machine-icon.js';

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// preset key -> i18n label key, e.g. 'ember-espresso' -> 'theme_preset_ember_espresso'.
export function presetLabelKey(key) {
  return `theme_preset_${key.replace(/-/g, '_')}`;
}

// Theme currently selected in the (single, static) machine form — kept as
// module state rather than re-read from the DOM since it isn't a plain
// input value (preset key vs. {a,b} custom colours). Reset in openMachineForm().
let _selectedTheme = null;

// #1044: the currently-editing gaggiuino machine's full 'system' settings
// category, as last fetched by loadReleaseChannel() -- kept so
// _saveReleaseChannel() can post the whole object back with only
// releaseChannel changed (see that function's own comment for why a full
// round trip, not a bare {releaseChannel} partial).
let _machineSystemSettings = null;

(function restoreActiveMachine() {
  const stored = localStorage.getItem('glp_active_machine');
  if (stored) S.activeMachineId = stored === 'all' ? 'all' : parseInt(stored, 10);
})();

export function setActiveMachine(id) {
  setState('activeMachineId', id);
  try { localStorage.setItem('glp_active_machine', String(id)); } catch { /* ignore */ }
}

// The default machine's id, or null before /api/machines has ever loaded —
// used by views/live.js to decide whether the currently active machine has
// real live-polling support (only the default machine does, in this round).
export function getDefaultMachineId() {
  return (S.machines || []).find(m => m.isDefault)?.id ?? null;
}

// #1019: resolves the currently ACTIVE machine object (topbar switcher,
// S.activeMachineId) rather than always the default one -- same
// null/'all'-means-default fallback semantics as views/live.js's
// _isActiveMachineLiveCapable(), plus falling back to the default machine
// when a stale/removed id no longer matches anything. Reads S.machines/
// S.activeMachineId live on every call, never cached, since both can change
// independently of each other (machine list reload vs. topbar switch).
export function getActiveMachine() {
  const machines = S.machines || [];
  const defaultMachine = machines.find(m => m.isDefault) || null;
  const active = S.activeMachineId;
  if (active == null || active === 'all') return defaultMachine;
  return machines.find(m => m.id === active) || defaultMachine;
}

// #604: parses a validated "#rrggbb" hex string (see machineSchema in
// lib/validation/schemas.js — theme.a/b are guaranteed hex by the time they
// reach here) into {r,g,b}, or null for anything else.
const HEX_RE = /^#([0-9a-f]{6})$/i;
function hexToRgb(hex) {
  const m = HEX_RE.exec(hex || '');
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

// Same relative-luminance formula as glp-card.js's _luminanceOf()
// (GLP-SHARED:contrast v1, sibling glp-lovelace-card repo) — sRGB channels
// linearized then weighted per WCAG. Reused here on raw {r,g,b} rather than
// via a computed-style probe since theme.a/b are already known-hex.
function relativeLuminance({ r, g, b }) {
  const lin = c => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

// #1021: --accent-ink light-theme overrides for the 8 THEME_PRESETS, picked
// by the same hand-audit method #811 used for the old 6-accent set (see
// git history on style.css around that PR): darken the raw preset hex
// (`p.a`, the same stop applyActiveMachineAccentTheme() below uses for
// --accent) along its own hue to the first value that clears the WCAG AA
// 4.5:1 floor against the darkest of the four light-theme surfaces
// (--raised, #e6e6e3 — the lowest-luminance of --gray-950/900/800/--raised,
// so clearing it guarantees clearing the other three too). Only presets
// that actually fail as raw hex get an entry here; ruby-ristretto (8.01:1
// on --raised) and mulberry-mocha (7.18:1) already clear the floor
// unmodified and are absent deliberately, not by oversight — see
// test/theme-contrast.test.js.
const LIGHT_ACCENT_INK_OVERRIDES = {
  'amber-americano':   '#905c06',
  'copper-cortado':    '#975730',
  'twilight-turkish':  '#06708a',
  'marbled-macchiato': '#905c06',
  'ember-espresso':    '#b73e1a',
  'frosty-flat-white': '#0f736b',
};

// Pure lookup (no DOM) so test/theme-contrast.test.js can assert the table
// above against the four light surfaces directly, the same way it already
// asserts the base token scale straight from style.css. `presetKey` is
// whichever THEME_PRESETS key is actually driving the current accent (see
// applyActiveMachineAccentTheme() below) — null for a fully custom
// per-machine {a,b} theme, which this audit doesn't cover (the old #811
// audit never covered arbitrary custom hex either, only the named
// accents). Dark theme, an unaudited/custom key, or a preset that already
// clears the floor raw all fall back to `accentHex` itself, i.e. the same
// var(--accent) alias --accent-ink used everywhere before this audit.
export function resolveAccentInk(presetKey, accentHex, isLightTheme) {
  if (!isLightTheme || !presetKey) return accentHex;
  return LIGHT_ACCENT_INK_OVERRIDES[presetKey] || accentHex;
}

// #604/#1019: reconciles the ACTIVE machine's per-machine colour theme
// (#594, previously icon-only) into the global --accent-* variables. #1019
// widened this from "only the default machine" to "whichever machine the
// topbar switcher currently has active" (getActiveMachine() above), and
// retired the style.css [data-accent="..."] swatch-preset blocks entirely —
// this function (plus the identical inline-var mechanism the user's own
// Farbschema pick now goes through below) is the SOLE place that sets these
// vars, machine-driven or user-picked alike.
//
// Sets the 5 vars as inline styles on <html>, which always outranks a
// stylesheet rule regardless of cascade order — same "inline style wins"
// pattern glp-card.js's _applySemanticColorContrast() uses. When the active
// machine has no theme of its own, falls back to resolving the user's own
// persisted Farbschema pick (post-migration, see theme.js's
// migrateLegacyAccent()) instead of just clearing the vars — there is no
// [data-accent] stylesheet fallback to catch that any more.
//
// --accent-text uses the DARKER of the two stops (a flat theme has a===b and
// reduces to a single check) at the same 0.179 WCAG flip-point crossover
// glp-card.js's _applySemanticColorContrast() uses: pure #000/#fff at that
// luminance split is a mathematical guarantee of >=4.58:1 against any
// resulting accent colour, so no need to hand-check each preset/custom value.
// --accent-glow doesn't need the same rigor (it's a low-alpha background
// wash, not text-on-fill contrast) — a flat 15% alpha of the first stop
// matches every existing preset's own glow convention (see style.css).
// --accent-ink (#1021) is the odd one out: unlike --accent-text/-glow it
// CAN'T be derived mathematically from the accent colour itself, because it
// is that colour used as text on a near-white light-theme surface, not
// paired with a #000/#fff/low-alpha counterpart — hence the hand-audited
// LIGHT_ACCENT_INK_OVERRIDES table above instead of a formula here.
export function applyActiveMachineAccentTheme() {
  const root = document.documentElement;
  // Some test doubles for `document` (and, in principle, any non-browser
  // caller) don't provide documentElement — a no-op here rather than a
  // thrown error, since loadMachines() must still reach
  // applyActiveMachineChange() right after this call regardless.
  if (!root) return;
  const machine = getActiveMachine();
  const machineThemeRaw = machine?.theme || null;
  const machineTheme = resolveTheme(machineThemeRaw);
  const swatchesEl = document.getElementById('accentSwatches');
  const noteEl = document.getElementById('accentMachineThemeNote');

  // getThemePreset('amber-americano') is a hardcoded, always-present
  // THEME_PRESETS entry, so this chain always resolves — there is no
  // "no accent at all" case left to handle.
  const savedKey = migrateLegacyAccent(localStorage.getItem('glp_accent_theme')) || 'amber-americano';
  const resolved = machineTheme || getThemePreset(savedKey) || getThemePreset('amber-americano');
  const rgbA = hexToRgb(resolved.a);
  const rgbB = hexToRgb(resolved.b);
  root.style.setProperty('--accent', resolved.a);
  root.style.setProperty('--accent-from', resolved.a);
  root.style.setProperty('--accent-to', resolved.b);
  const luminances = [rgbA, rgbB].filter(Boolean).map(relativeLuminance);
  const darkest = luminances.length ? Math.min(...luminances) : null;
  if (darkest != null) root.style.setProperty('--accent-text', darkest > 0.179 ? '#000' : '#fff');
  if (rgbA) root.style.setProperty('--accent-glow', `rgba(${rgbA.r},${rgbA.g},${rgbA.b},.15)`);
  // #1021: the active machine's own theme, when it's a preset, carries its
  // key straight through; when the machine has no theme of its own we fall
  // back to the user's persisted Farbschema pick (savedKey, always a valid
  // preset key). A fully custom per-machine {a,b} theme has no preset key
  // at all -- resolveAccentInk() treats that the same as an unaudited one.
  const activePresetKey = machineThemeRaw ? (machineThemeRaw.preset || null) : savedKey;
  const isLightTheme = root.dataset?.theme === 'light';
  root.style.setProperty('--accent-ink', resolveAccentInk(activePresetKey, resolved.a, isLightTheme));
  // The "disabled" dimmed styling + explainer note are only for when the
  // ACTIVE MACHINE's own theme is actually overriding the picker below --
  // when we fell back to the user's own pick above, that picker still
  // reflects and controls the accent normally.
  swatchesEl?.classList.toggle('accent-swatches-disabled', !!machineTheme);
  if (noteEl) noteEl.style.display = machineTheme ? '' : 'none';
}

export async function loadMachines() {
  try {
    const r = await apiFetch('api/machines');
    if (!r.ok) return;
    const machines = await r.json();
    setState('machines', machines);
    if (!S.activeMachineId) {
      const def = machines.find(m => m.isDefault) || machines[0];
      if (def) setActiveMachine(def.id);
    }
    renderMachinesList();
    renderMachineSwitcher();
    // #837: unlike renderMachineSwitcher() above, the topbar's ambient icon
    // is shown for every install (including single-machine ones), so this
    // runs unconditionally rather than being folded into that function.
    renderTopbarMachineIcon();
    // #604/#1019: recomputes on every loadMachines() completion (startup,
    // and — since saveMachineForm() on success calls loadMachines() itself —
    // every machine-edit save too) so editing the active machine's theme
    // updates the whole app's accent live, no reload. switchActiveMachine()
    // below has its own direct call for the topbar-switch case, since that
    // doesn't go through loadMachines() at all.
    applyActiveMachineAccentTheme();
    // loadData() and loadMachines() both fire around startup with no fixed
    // order — if shots already loaded before the default machine was known,
    // S.shots was filtered against a null activeMachineId (i.e. unfiltered).
    // #526: also covers a returning session that already has an
    // activeMachineId persisted (so the block above never runs) and was
    // already showing Analytics before this fetch resolved — its
    // machine-comparison card was built with S.machines still empty and had
    // nothing that re-rendered it afterwards. Unconditional and idempotent:
    // a no-op for single-machine installs and for the case where loadData()
    // simply hasn't run yet (S.allShots still empty).
    applyActiveMachineChange();
  } catch { /* offline/first-run — settings card just stays empty */ }
}

// Topbar switcher (#325) — only shown once >1 machine is registered, so a
// single-machine install never sees it. "All machines" is always the first
// option once the switcher is visible.
export function renderMachineSwitcher() {
  const el = document.getElementById('machineSwitcher');
  if (!el) return;
  // #411: the switcher lives in #content-topbar now (moved out of the old
  // horizontal #mode-bar, removed in the rail redesign) — this element only
  // hides/shows itself; #content-topbar is a small persistent bar (it also
  // hosts #expandSidebarBtn) rather than collapsing itself away, since that
  // visibility would depend on two independently-changing things (this and
  // the sidebar's own collapsed state) for one thin, low-cost bar.
  const machines = S.machines || [];
  if (machines.length < 2) {
    el.style.display = 'none'; el.innerHTML = '';
    return;
  }

  // codeql[js/xss-through-dom] false positive: esc()/escapeHtml() already applied, see #760
  el.innerHTML = `<option value="all">${escapeHtml(t('machine_switcher_all'))}</option>` +
    machines.map(m => `<option value="${m.id}">${escapeHtml(m.name)}</option>`).join('');
  el.value = String(S.activeMachineId ?? 'all');
  el.style.display = '';
}

export function switchActiveMachine(rawValue) {
  const value = rawValue === 'all' ? 'all' : parseInt(rawValue, 10);
  setActiveMachine(value);
  renderTopbarMachineIcon();
  // #1019: the actual bug fix -- switching the topbar machine used to leave
  // the app accent on whichever machine was active before (or the default
  // machine's, pre-#1019), since only loadMachines() ever recomputed it.
  applyActiveMachineAccentTheme();
  applyActiveMachineChange();
}

// Re-filters the cached shot list and refreshes whichever view is
// currently open (#325) — called after switchActiveMachine() and once
// machines first finish loading.
export function applyActiveMachineChange() {
  S.shots = filterShotsByMachine(S.allShots || [], S.activeMachineId);
  if (window.renderSidebar) window.renderSidebar();
  if (S.shots.length && !S.shots.some(s => s.id === S.primaryShotId)) {
    S.primaryShotId = S.shots[S.shots.length - 1].id;
    S.compareShotId = null;
  }
  if (window.updateView) window.updateView();
  if (S.currentMode === 'analytics' && window.initAnalytics) window.initAnalytics();
  if (S.currentMode === 'live' && window.connectLiveStream) window.connectLiveStream();
  // #334: library bean/grinder lists are filtered by active machine too —
  // re-render so switching machine while already on that tab updates live.
  if (S.currentMode === 'library') {
    if (window.renderBeanList) window.renderBeanList();
    if (window.renderGrinderList) window.renderGrinderList();
  }
  // #340: the Library "Profiles" tab shows the active machine's own live
  // profile list — refetch on switch so it doesn't keep showing whichever
  // machine was active when the tab was first opened. Fire-and-forget, but
  // caught (#846) — a network failure here shouldn't surface as an
  // unhandled rejection just because nothing else in this function awaits it.
  loadMachineProfileList().catch(() => {});
  // #464: the topbar status dot/hostname (#railStatusDot/#railMachineName)
  // used to keep showing the default machine's state until the next 30s
  // poll — refresh immediately, scoped to the newly active machine.
  updateStatus(S.activeMachineId);
}

export function renderMachinesList() {
  const list = document.getElementById('machinesList');
  if (!list) return;
  list.innerHTML = '';
  (S.machines || []).forEach(m => {
    // #334: per-machine shot count, computed client-side from S.allShots
    // (already carries machineId per shot, see ShotRepository) — no backend
    // change needed. A shot with no machineId at all belongs to the default
    // machine, matching the backend's own convention.
    const shotCount = (S.allShots || []).filter(s => (s.machineId ?? 1) === m.id).length;
    const row = document.createElement('div');
    row.className = 'machine-row';
    row.innerHTML = `
      <span class="machine-row-icon">${machineIconMiniSvg(m.theme, m.type)}</span>
      <span class="machine-row-name">${escapeHtml(m.name)}</span>
      <span class="machine-row-type">${m.type === 'gaggimate' ? 'GaggiMate' : 'Gaggiuino'}</span>
      <span class="machine-row-shot-count">${t('settings_machine_shot_count', shotCount)}</span>
      ${m.type === 'gaggimate' ? `<span class="machine-row-badge-experimental" title="${escapeHtml(t('settings_machine_type_gaggimate'))}">${WARNING_ICON_SVG} ${t('settings_machine_experimental_badge')}</span>` : ''}
      ${m.isDefault ? `<span class="machine-row-badge">${t('settings_machine_default')}</span>` : ''}
      <span class="machine-row-actions">
        <button type="button" class="machine-edit-btn">${t('settings_machine_edit')}</button>
        ${!m.isDefault ? `<button type="button" class="machine-set-default-btn">${t('settings_machine_set_default')}</button>` : ''}
        <button type="button" class="machine-delete-btn">${t('settings_machine_delete')}</button>
      </span>`;
    row.querySelector('.machine-edit-btn').addEventListener('click', () => openMachineForm(m));
    row.querySelector('.machine-set-default-btn')?.addEventListener('click', () => setDefaultMachine(m.id));
    row.querySelector('.machine-delete-btn')?.addEventListener('click', () => deleteMachine(m.id, m.isDefault));
    list.appendChild(row);
  });
}

// Renders the 8 preset swatches + "none" + "custom" as visual colour circles
// (not a bare <select> of names, per #594) and (re-)binds their click
// handlers — cheap enough (10 buttons) to fully re-render on every selection
// change rather than hand-tracking which button needs its `active` class
// toggled.
function renderThemeSwatches() {
  const wrap = document.getElementById('machineThemeSwatches');
  if (!wrap) return;
  const isCustom = !!(_selectedTheme && !_selectedTheme.preset);
  wrap.innerHTML = `
    <button type="button" class="machine-theme-swatch machine-theme-swatch-none${!_selectedTheme ? ' active' : ''}" data-theme-action="none" title="${escapeHtml(t('settings_machine_theme_none'))}" aria-label="${escapeHtml(t('settings_machine_theme_none'))}"></button>
    ${THEME_PRESETS.map(p => `<button type="button" class="machine-theme-swatch${_selectedTheme?.preset === p.key ? ' active' : ''}" data-theme-action="preset" data-preset-key="${escapeHtml(p.key)}" style="${p.a === p.b ? `background-color:${p.a}` : `background-image:linear-gradient(135deg,${p.a},${p.b})`}" title="${escapeHtml(t(presetLabelKey(p.key)))}" aria-label="${escapeHtml(t(presetLabelKey(p.key)))}"></button>`).join('')}
    <button type="button" class="machine-theme-swatch machine-theme-swatch-custom${isCustom ? ' active' : ''}" data-theme-action="custom" title="${escapeHtml(t('settings_machine_theme_custom'))}" aria-label="${escapeHtml(t('settings_machine_theme_custom'))}"></button>`;
  wrap.querySelectorAll('[data-theme-action]').forEach(btn => {
    btn.addEventListener('click', () => {
      const action = btn.dataset.themeAction;
      if (action === 'none') _selectedTheme = null;
      else if (action === 'preset') _selectedTheme = { preset: btn.dataset.presetKey };
      else if (action === 'custom') {
        _selectedTheme = (_selectedTheme && !_selectedTheme.preset) ? _selectedTheme : { a: '#f59e0b', b: '#f59e0b' };
      }
      syncThemeFormUI();
    });
  });
}

// #1019: Settings -> Farbschema picker -- renders the same 8 THEME_PRESETS
// as renderThemeSwatches() above (same per-preset swatch markup shape, no
// "none"/"custom" options since this picker always resolves to a concrete
// preset), replacing the old, unrelated 6-swatch static buttons that used
// to live directly in index.html. Marks whichever preset is currently
// persisted to localStorage as .active and wires each button straight to
// window.setAccentTheme() -- there's nothing static left for main.js to
// delegate a single click listener from, unlike the old swatches.
export function renderAccentSwatches() {
  const wrap = document.getElementById('accentSwatches');
  if (!wrap) return;
  const current = migrateLegacyAccent(localStorage.getItem('glp_accent_theme')) || 'amber-americano';
  wrap.innerHTML = THEME_PRESETS.map(p => `<button type="button" class="accent-swatch${current === p.key ? ' active' : ''}" data-preset-key="${escapeHtml(p.key)}" style="${p.a === p.b ? `background-color:${p.a}` : `background-image:linear-gradient(135deg,${p.a},${p.b})`}" title="${escapeHtml(t(presetLabelKey(p.key)))}" aria-label="${escapeHtml(t(presetLabelKey(p.key)))}"></button>`).join('');
  wrap.querySelectorAll('[data-preset-key]').forEach(btn => {
    // eslint-disable-next-line no-undef -- setAccentTheme is assigned onto window in main.js (Object.assign), resolves as a global at runtime
    btn.addEventListener('click', () => setAccentTheme(btn.dataset.presetKey));
  });
}

// Keeps the swatch active-states and the custom colour inputs in sync with
// _selectedTheme — called after every selection change (swatch click or
// custom colour/gradient-toggle edit).
function syncThemeFormUI() {
  renderThemeSwatches();
  const preview = document.getElementById('machineThemePreview');
  // Reads the type select directly (rather than a second module-level
  // _selectedType) — this function already runs after openMachineForm() has
  // set #machineFormType to the machine's own type (or the 'gaggiuino'
  // default for a new machine), so the DOM value is always current by the
  // time the preview is (re-)rendered.
  const previewType = document.getElementById('machineFormType')?.value;
  if (preview) preview.innerHTML = machineIconSvg(_selectedTheme, previewType);
  const customWrap = document.getElementById('machineThemeCustomInputs');
  const isCustom = !!(_selectedTheme && !_selectedTheme.preset);
  if (customWrap) customWrap.style.display = isCustom ? '' : 'none';
  if (!isCustom) return;
  const aInput = document.getElementById('machineThemeCustomA');
  const bInput = document.getElementById('machineThemeCustomB');
  const gradToggle = document.getElementById('machineThemeGradientToggle');
  const isGradient = _selectedTheme.a !== _selectedTheme.b;
  if (aInput) aInput.value = _selectedTheme.a;
  if (bInput) { bInput.value = _selectedTheme.b; bInput.style.display = isGradient ? '' : 'none'; }
  if (gradToggle) gradToggle.checked = isGradient;
}

// Static custom-colour input wiring (#machineThemeCustomA/B, the gradient
// toggle) — called once from main.js's DOMContentLoaded handler, same
// pattern as the other machine form buttons wired there.
export function onThemeCustomColorAChange() {
  if (!_selectedTheme || _selectedTheme.preset) return;
  const aInput = document.getElementById('machineThemeCustomA');
  const gradToggle = document.getElementById('machineThemeGradientToggle');
  _selectedTheme.a = aInput.value;
  if (!gradToggle?.checked) _selectedTheme.b = aInput.value;
  syncThemeFormUI();
}

export function onThemeCustomColorBChange() {
  if (!_selectedTheme || _selectedTheme.preset) return;
  _selectedTheme.b = document.getElementById('machineThemeCustomB').value;
  syncThemeFormUI();
}

export function onThemeGradientToggleChange() {
  if (!_selectedTheme || _selectedTheme.preset) return;
  const gradToggle = document.getElementById('machineThemeGradientToggle');
  if (!gradToggle.checked) _selectedTheme.b = _selectedTheme.a;
  syncThemeFormUI();
}

function syncWaterSensorRowVisibility() {
  const type = document.getElementById('machineFormType')?.value;
  const row = document.getElementById('machineWaterSensorRow');
  if (row) row.style.display = type === 'gaggimate' ? '' : 'none';
}

// #1044: the release-channel selector and firmware-update section are both
// Gaggiuino-only, same conditional-visibility pattern as the water-sensor
// row above -- but unlike hasWaterSensor (a plain field on GLP's own
// machine record), both proxy through the machine's own settings-proxy API
// (GET/POST api/machine/settings, api/machine/firmware/*), which needs a
// real, already-saved machineId to resolve against. A brand-new,
// not-yet-saved machine therefore shows neither section; editing it again
// after the initial save does.
function syncGaggiuinoOnlyRowsVisibility() {
  const type = document.getElementById('machineFormType')?.value;
  const id = document.getElementById('machineFormId')?.value;
  const show = type === 'gaggiuino' && !!id;
  const channelRow = document.getElementById('machineReleaseChannelRow');
  if (channelRow) channelRow.style.display = show ? '' : 'none';
  const fwSection = document.getElementById('machineFirmwareSection');
  if (fwSection) fwSection.style.display = show ? '' : 'none';
}

export function onMachineTypeChange() {
  syncWaterSensorRowVisibility();
  syncGaggiuinoOnlyRowsVisibility();
  stopFirmwarePolling();
}

// #1044: GET api/machine/settings?category=system -- the same settings-
// proxy route internal/web's own (server-rendered) Settings page uses (see
// go/internal/web/handlers_settings.go's doc comment), just consumed here
// from the SPA for the one field this form edits (releaseChannel) instead
// of that page's full opaque-JSON-textarea round trip. Keeps the whole
// fetched object in _machineSystemSettings so _saveReleaseChannel() below
// can post it back with only releaseChannel changed.
async function loadReleaseChannel(machineId) {
  const select = document.getElementById('machineFormReleaseChannel');
  if (!select) return;
  try {
    const r = await apiFetch(`api/machine/settings?machineId=${machineId}&category=system`);
    if (!r.ok) return;
    const settings = await r.json();
    _machineSystemSettings = (settings && typeof settings === 'object') ? settings : {};
    const ch = Number(_machineSystemSettings.releaseChannel);
    select.value = [0, 1, 2].includes(ch) ? String(ch) : '0';
  } catch { /* offline/unreachable -- leave the select at its default */ }
}

// #1044: called from saveMachineForm() after the main machine record has
// already saved successfully. A no-op whenever the release-channel row
// isn't currently shown (GaggiMate, or a machine that hasn't been saved
// yet -- see syncGaggiuinoOnlyRowsVisibility() above), so this is safe to
// call unconditionally on every save.
async function _saveReleaseChannel(machineId) {
  const row = document.getElementById('machineReleaseChannelRow');
  const select = document.getElementById('machineFormReleaseChannel');
  if (!row || !select || row.style.display === 'none') return;
  const channel = parseInt(select.value, 10);
  const payload = { ...(_machineSystemSettings || {}), machineId: Number(machineId), releaseChannel: channel };
  try {
    await apiFetch('api/machine/settings/system', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
    });
  } catch { /* best-effort -- the main machine record already saved either way */ }
}

// ── Firmware update (#1044) ─────────────────────────────────────────────
// GET api/machine/firmware/version + POST .../update + GET .../progress
// (go/internal/machines/handlers_control.go, unused by the frontend before
// this) -- status/trigger/progress for the machine's own OTA flow. There is
// no SSE push for firmware progress on the backend (unlike shot-import
// progress, components/status.js's renderSyncProgressBar/
// pollSyncProgressFallback), so this is polling-only throughout.

const FIRMWARE_POLL_INTERVAL_MS = 2000;
// ~10 minutes of polling before giving up inconclusively -- a real OTA
// (download + flash + reboot) normally finishes well inside this.
const FIRMWARE_POLL_MAX_TICKS = 300;

let _firmwarePollTimer = null;
let _firmwarePollMachineId = null;

async function loadFirmwareStatus(machineId) {
  const statusEl = document.getElementById('machineFirmwareStatus');
  if (!statusEl) return;
  statusEl.textContent = t('settings_machine_firmware_checking');
  try {
    const r = await apiFetch(`api/machine/firmware/version?machineId=${machineId}`);
    if (!r.ok) { statusEl.textContent = t('settings_machine_firmware_check_failed'); return; }
    renderFirmwareStatus(await r.json());
  } catch {
    statusEl.textContent = t('settings_machine_firmware_check_failed');
  }
}

function renderFirmwareStatus(data) {
  const statusEl = document.getElementById('machineFirmwareStatus');
  const banner = document.getElementById('machineFirmwareUpdateBanner');
  const msgEl = document.getElementById('machineFirmwareUpdateMsg');
  const linkEl = document.getElementById('machineFirmwareChangelogLink');
  if (!statusEl) return;
  statusEl.textContent = data?.installed
    ? t('settings_machine_firmware_installed', data.installed)
    : t('settings_machine_firmware_unknown');
  if (!banner) return;
  if (data?.updateAvailable && data.latest) {
    if (msgEl) msgEl.textContent = t('settings_machine_firmware_update_available', data.latest);
    if (linkEl) linkEl.href = data.releaseUrl || '#';
    banner.style.display = '';
  } else {
    banner.style.display = 'none';
  }
}

export async function triggerMachineFirmwareUpdate() {
  const id = document.getElementById('machineFormId')?.value;
  if (!id) return;
  const btn = document.getElementById('machineFirmwareUpdateBtn');
  if (btn) btn.disabled = true;
  try {
    const r = await apiFetch('api/machine/firmware/update', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ machineId: Number(id) }),
    });
    if (!r.ok) {
      const data = await r.json().catch(() => ({}));
      if (window.showToast) window.showToast(t('settings_machine_firmware_trigger_failed', data.error || r.status));
      if (btn) btn.disabled = false;
      return;
    }
    startFirmwarePolling(Number(id));
  } catch {
    if (window.showToast) window.showToast(t('settings_machine_firmware_trigger_failed', ''));
    if (btn) btn.disabled = false;
  }
}

function stopFirmwarePolling() {
  if (_firmwarePollTimer) { clearTimeout(_firmwarePollTimer); _firmwarePollTimer = null; }
  _firmwarePollMachineId = null;
  const btn = document.getElementById('machineFirmwareUpdateBtn');
  if (btn) btn.disabled = false;
}

function startFirmwarePolling(machineId) {
  stopFirmwarePolling();
  _firmwarePollMachineId = machineId;
  const btn = document.getElementById('machineFirmwareUpdateBtn');
  if (btn) btn.disabled = true;
  _pollFirmwareProgressTick(machineId, { ticks: 0, failCount: 0, seenActive: false });
}

// #1044: the machine reboots to apply the OTA near the end of a real
// update, so a short run of fetch failures right after having seen active
// progress is the expected "device is rebooting" shape, not a genuine
// error -- treated as success below. A failure run with no active progress
// ever observed (machine simply unreachable) is a genuine failure instead.
async function _pollFirmwareProgressTick(machineId, state) {
  // A stale cycle (form closed/reopened, or a poll for a different machine
  // started) must not keep writing into now-irrelevant DOM -- mirrors
  // _testMachine()'s own still-current-machine guard.
  if (_firmwarePollMachineId !== machineId) return;
  let ok = false;
  let progress = null;
  try {
    const r = await apiFetch(`api/machine/firmware/progress?machineId=${machineId}`);
    ok = r.ok;
    if (ok) progress = await r.json().catch(() => null);
  } catch { /* ok stays false */ }
  if (_firmwarePollMachineId !== machineId) return; // went stale while the fetch was in flight

  if (!ok || !progress) {
    state.failCount++;
    if (state.failCount >= 3) { finishFirmwarePolling(machineId, state.seenActive); return; }
    _firmwarePollTimer = setTimeout(() => _pollFirmwareProgressTick(machineId, state), FIRMWARE_POLL_INTERVAL_MS);
    return;
  }
  state.failCount = 0;

  const active = String(progress.status || '').toUpperCase() !== 'IDLE';
  if (active) {
    state.seenActive = true;
    renderFirmwareProgressBar(progress);
  } else if (state.seenActive) {
    // Was active, now idle again -- the update ran to completion.
    finishFirmwarePolling(machineId, true);
    return;
  }
  // else: still idle and never seen active yet -- the trigger may not have
  // taken effect on the machine's side yet, keep polling.

  state.ticks++;
  if (state.ticks >= FIRMWARE_POLL_MAX_TICKS) { finishFirmwarePolling(machineId, null); return; }
  _firmwarePollTimer = setTimeout(() => _pollFirmwareProgressTick(machineId, state), FIRMWARE_POLL_INTERVAL_MS);
}

// success: true = update completed, false = genuinely unreachable/failed,
// null = gave up inconclusively (safety-cap timeout) without claiming either.
function finishFirmwarePolling(machineId, success) {
  stopFirmwarePolling();
  renderFirmwareProgressBar(null);
  if (success === true) {
    if (window.showToast) window.showToast(t('settings_machine_firmware_update_success_toast'));
    loadFirmwareStatus(machineId);
  } else if (success === false) {
    if (window.showToast) window.showToast(t('settings_machine_firmware_update_failed_toast'));
  } else {
    if (window.showToast) window.showToast(t('settings_machine_firmware_update_timeout_toast'));
  }
}

// Mirrors components/status.js's renderSyncProgressBar() -- same
// hide-when-null / label+fill-width shape, reusing that file's own
// .sync-progress-track/.sync-progress-fill classes (style.css), just
// against this section's own bar/label elements instead of the sidebar's.
function renderFirmwareProgressBar(progress) {
  const bar = document.getElementById('machineFirmwareProgressBar');
  if (!bar) return;
  if (!progress) { bar.style.display = 'none'; return; }
  const label = document.getElementById('machineFirmwareProgressLabel');
  const fill = bar.querySelector('.sync-progress-fill');
  const pct = Math.max(0, Math.min(100, Number(progress.progress) || 0));
  if (fill) fill.style.width = `${pct}%`;
  if (label) label.textContent = t('settings_machine_firmware_progress_label', Math.round(pct));
  bar.style.display = '';
}

export function openMachineForm(machine) {
  const card = document.getElementById('machineFormCard');
  if (!card) return;
  document.getElementById('machineFormId').value = machine?.id || '';
  document.getElementById('machineFormName').value = machine?.name || '';
  document.getElementById('machineFormType').value = machine?.type || 'gaggiuino';
  document.getElementById('machineFormHost').value = machine?.host || '';
  document.getElementById('machineFormSwitch').value = machine?.switchEntity || '';
  document.getElementById('machineFormWaterSensor').checked = machine?.hasWaterSensor || false;
  document.getElementById('machineFormTestResult').textContent = '';
  _selectedTheme = machine?.theme || null;
  syncThemeFormUI();
  syncWaterSensorRowVisibility();
  syncGaggiuinoOnlyRowsVisibility();
  stopFirmwarePolling();
  _machineSystemSettings = null;
  const fwStatus = document.getElementById('machineFirmwareStatus');
  if (fwStatus) fwStatus.textContent = '';
  const fwBanner = document.getElementById('machineFirmwareUpdateBanner');
  if (fwBanner) fwBanner.style.display = 'none';
  renderFirmwareProgressBar(null);
  if (machine?.id && machine.type === 'gaggiuino') {
    loadReleaseChannel(machine.id);
    loadFirmwareStatus(machine.id);
  }
  card.style.display = '';
}

export function closeMachineForm() {
  const card = document.getElementById('machineFormCard');
  if (card) card.style.display = 'none';
  stopFirmwarePolling();
}

// #727: shared by saveMachineForm() and testMachineForm() so the
// payload-building/fetch logic (and the SSRF-guard error surfacing from
// #336) lives in exactly one place. Returns the saved machine's id on
// success (the form field's existing value when editing, the server's
// newly-assigned id when creating), or null on failure/validation no-op —
// callers that need to distinguish "failed" from "nothing to save" can
// inspect the DOM themselves, neither existing caller needs to.
//
// #731: triggerSync defaults to true (saveMachineForm()'s explicit "Speichern"
// still fires the post-save shot sync) but testMachineForm() passes false —
// "Verbindung testen" needs a saved machine id to test against, but that
// implicit save must not itself start an import. Carried to the server as
// a `?sync=0` query param rather than a body field: machineSchema/
// machineSchema.partial() (lib/validation/schemas.js) validate the body
// strictly, so an extra JSON field would be unclean at best.
async function _saveMachine({ triggerSync = true } = {}) {
  const id = document.getElementById('machineFormId').value;
  const type = document.getElementById('machineFormType').value;
  const payload = {
    name: document.getElementById('machineFormName').value.trim(),
    type,
    host: document.getElementById('machineFormHost').value.trim(),
    switchEntity: document.getElementById('machineFormSwitch').value.trim() || null,
    theme: _selectedTheme,
    hasWaterSensor: type === 'gaggimate' ? (document.getElementById('machineFormWaterSensor')?.checked || false) : false,
  };
  if (!payload.name || !payload.host) return null;
  const base   = id ? `api/machines/${id}` : 'api/machines';
  const url    = triggerSync ? base : `${base}?sync=0`;
  const method = id ? 'PUT' : 'POST';
  const resultEl = document.getElementById('machineFormTestResult');
  const r = await apiFetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  if (r.ok) {
    const data = await r.json().catch(() => ({}));
    return id || data?.id || null;
  }
  // #336: used to fail silently here (no visible error at all), which made
  // the SSRF-guard-blocks-LAN-hosts bug far harder to diagnose than it
  // needed to be — always surface the server's actual error now.
  const data = await r.json().catch(() => ({}));
  if (resultEl) resultEl.textContent = t('settings_machine_save_error', data.error || r.status);
  return null;
}

// #727: shared by testMachineForm() — runs the connection test against a
// known machine id and renders the result into #machineFormTestResult.
//
// #734 review: #733 removed testMachineForm()'s auto-close, so the form
// (and the still-clickable machines list behind it) can now stay open long
// enough for the user to switch to editing a *different* machine while this
// test is still in flight — openMachineForm() overwrites #machineFormId
// synchronously, so by the time this resolves the form may no longer be
// showing the machine that was actually tested. Re-check #machineFormId
// still matches before writing the result, so a stale in-flight test can't
// land its result under the wrong machine's name/host.
async function _testMachine(id) {
  const resultEl = document.getElementById('machineFormTestResult');
  if (!resultEl) return;
  resultEl.textContent = t('settings_machine_testing');
  try {
    const r = await apiFetch(`api/machines/${id}/test`, { method: 'POST' });
    const data = await r.json().catch(() => ({}));
    if (String(document.getElementById('machineFormId').value) !== String(id)) return;
    resultEl.innerHTML = data.reachable
      ? `${CHECK_ICON_SVG} ${t('settings_machine_test_ok')}`
      : `${CLOSE_ICON_SVG} ${t('settings_machine_test_fail')}`;
  } catch {
    if (String(document.getElementById('machineFormId').value) !== String(id)) return;
    resultEl.innerHTML = `${CLOSE_ICON_SVG} ${t('settings_machine_test_fail')}`;
  }
}

export async function saveMachineForm() {
  const id = await _saveMachine();
  if (id !== null) {
    // #1044: a no-op unless the release-channel row is actually shown (see
    // syncGaggiuinoOnlyRowsVisibility()) -- safe to call unconditionally.
    await _saveReleaseChannel(id);
    closeMachineForm();
    loadMachines();
    // #748: dedicated signal for an *explicit* save, separate from the
    // generic 'machines' state that testMachineForm()'s implicit
    // save-before-test also triggers via loadMachines() — the setup wizard
    // subscribes to this one so "Test connection" can't prematurely close it.
    setState('machineExplicitSave', id);
  }
}

// #753: reassigns the default machine, then reloads so both this list's
// badge/actions and getDefaultMachineId() consumers (views/live.js,
// applyDefaultMachineAccentTheme() below) pick up the change.
export async function setDefaultMachine(id) {
  const r = await apiFetch(`api/machines/${id}/default`, { method: 'POST' });
  if (r.ok) loadMachines();
}

// #753: deleting the current default is more consequential (reassigns
// activeMachineId/theme fallout for whoever was viewing it) than a regular
// non-default machine, so it gets its own, more explicit confirmation text.
// Both cases can still be rejected by the backend (still-default after a
// stale read, or the last remaining machine) -- that error is surfaced via
// showToast rather than silently doing nothing, same as the sync-failed
// toast pattern in components/status.js.
export async function deleteMachine(id, isDefault) {
  const confirmKey = isDefault ? 'settings_machine_delete_default_confirm' : 'settings_machine_delete_confirm';
  if (!confirm(t(confirmKey))) return;
  const r = await apiFetch(`api/machines/${id}`, { method: 'DELETE' });
  if (r.ok) { loadMachines(); return; }
  const body = await r.json().catch(() => ({}));
  if (window.showToast) window.showToast(body.error || t('settings_machine_delete_failed'));
}

// #729: saves first (create or update, same as saveMachineForm()) so a
// not-yet-saved machine can be tested too, then runs the connection test
// against the now-known id and shows the result inline.
//
// #733: unlike saveMachineForm(), this deliberately does NOT close the
// form -- testing is meant to be an in-place check the user can react to
// (e.g. fix a bad host and test again) without losing their place. #729
// originally auto-closed it to mirror Save, but that turned out to be
// confusing for a *test* action; only the explicit Save button closes now.
//
// #731: this save is only a means to get a testable id -- it must not start
// a shot import the way an explicit "Speichern" does, so triggerSync:false
// is passed through to _saveMachine() (server-side gate in go/internal/machines).
//
// #730 review: the form stays open (and clickable) while the request is in
// flight -- a double-click used to re-enter _saveMachine() with
// #machineFormId still empty (never written back after the first save),
// turning a single "new machine" save into two POSTs. Fixed two ways: the
// id is written back into the DOM the moment the first save succeeds (so
// even a concurrent second call would PUT, not POST again), and the button
// itself is disabled for the whole in-flight window so a second click can't
// start a second call in the first place.
export async function testMachineForm() {
  const btn = document.getElementById('machineFormTestBtn');
  if (btn) btn.disabled = true;
  const id = await _saveMachine({ triggerSync: false });
  if (id === null) {
    if (btn) btn.disabled = false;
    return;
  }
  document.getElementById('machineFormId').value = id;
  await _testMachine(id);
  loadMachines();
  if (btn) btn.disabled = false;
}
