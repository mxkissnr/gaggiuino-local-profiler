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
import { WARNING_ICON_SVG } from '../icons.js';
import { updateStatus } from './status.js';
import { THEME_PRESETS, resolveTheme } from '../../lib/machines/theme-presets.js';
import { machineIconSvg, machineIconMiniSvg } from '../machine-icon.js';

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// preset key -> i18n label key, e.g. 'ember-espresso' -> 'theme_preset_ember_espresso'.
function presetLabelKey(key) {
  return `theme_preset_${key.replace(/-/g, '_')}`;
}

// Theme currently selected in the (single, static) machine form — kept as
// module state rather than re-read from the DOM since it isn't a plain
// input value (preset key vs. {a,b} custom colours). Reset in openMachineForm().
let _selectedTheme = null;

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

// #604: reconciles the default machine's per-machine colour theme (#594,
// previously icon-only) into the global --accent-* variables that style.css's
// [data-accent="..."] swatch presets normally drive, so it becomes the whole
// app's accent instead of only the machine icon's. Only the DEFAULT
// machine's theme does this — non-default machines stay icon-only (their own
// device context), same default-machine-only scope as getDefaultMachineId()
// above (and machine_coordinator.py's multi-machine scope note in the
// sibling glp-integration repo).
//
// Sets the 5 vars as inline styles on <html>, which always outrank the
// [data-accent] stylesheet rules regardless of which swatch is selected —
// same "inline style wins over the cascade" pattern glp-card.js's
// _applySemanticColorContrast() uses. Clears them (falling back to the
// swatch picker again) when the default machine has no theme set.
//
// --accent-text uses the DARKER of the two stops (a flat theme has a===b and
// reduces to a single check) at the same 0.179 WCAG flip-point crossover
// glp-card.js's _applySemanticColorContrast() uses: pure #000/#fff at that
// luminance split is a mathematical guarantee of >=4.58:1 against any
// resulting accent colour, so no need to hand-check each preset/custom value.
// --accent-glow doesn't need the same rigor (it's a low-alpha background
// wash, not text-on-fill contrast) — a flat 15% alpha of the first stop
// matches every existing preset's own glow convention (see style.css).
export function applyDefaultMachineAccentTheme() {
  const root = document.documentElement;
  // Some test doubles for `document` (and, in principle, any non-browser
  // caller) don't provide documentElement — a no-op here rather than a
  // thrown error, since loadMachines() must still reach
  // applyActiveMachineChange() right after this call regardless.
  if (!root) return;
  const machine = (S.machines || []).find(m => m.isDefault);
  const resolved = resolveTheme(machine?.theme);
  const swatchesEl = document.getElementById('accentSwatches');
  const noteEl = document.getElementById('accentMachineThemeNote');
  if (!resolved) {
    ['--accent', '--accent-from', '--accent-to', '--accent-text', '--accent-glow']
      .forEach(prop => root.style.removeProperty(prop));
    swatchesEl?.classList.remove('accent-swatches-disabled');
    if (noteEl) noteEl.style.display = 'none';
    return;
  }
  const rgbA = hexToRgb(resolved.a);
  const rgbB = hexToRgb(resolved.b);
  root.style.setProperty('--accent', resolved.a);
  root.style.setProperty('--accent-from', resolved.a);
  root.style.setProperty('--accent-to', resolved.b);
  const luminances = [rgbA, rgbB].filter(Boolean).map(relativeLuminance);
  const darkest = luminances.length ? Math.min(...luminances) : null;
  if (darkest != null) root.style.setProperty('--accent-text', darkest > 0.179 ? '#000' : '#fff');
  if (rgbA) root.style.setProperty('--accent-glow', `rgba(${rgbA.r},${rgbA.g},${rgbA.b},.15)`);
  swatchesEl?.classList.add('accent-swatches-disabled');
  if (noteEl) noteEl.style.display = '';
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
    // #604: recomputes on every loadMachines() completion (startup, machine
    // switch, and — since saveMachineForm() on success calls loadMachines()
    // itself — every machine-edit save too) so switching the default machine
    // or editing its theme updates the whole app's accent live, no reload.
    applyDefaultMachineAccentTheme();
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
  const iconEl = document.getElementById('machineSwitcherIcon');
  if (machines.length < 2) {
    el.style.display = 'none'; el.innerHTML = '';
    iconEl?.classList.remove('visible');
    return;
  }

  el.innerHTML = `<option value="all">${escapeHtml(t('machine_switcher_all'))}</option>` +
    machines.map(m => `<option value="${m.id}">${escapeHtml(m.name)}</option>`).join('');
  el.value = String(S.activeMachineId ?? 'all');
  el.style.display = '';
  updateMachineSwitcherIcon();
}

// Small coloured machine glyph next to the topbar switcher (#594) so
// multi-machine users can tell which machine is active at a glance, not
// just by name — a plain <select> can't reliably render swatches inside
// its own <option>s across browsers.
function updateMachineSwitcherIcon() {
  const iconEl = document.getElementById('machineSwitcherIcon');
  if (!iconEl) return;
  const machine = (S.machines || []).find(m => m.id === S.activeMachineId);
  if (!machine) { iconEl.classList.remove('visible'); iconEl.innerHTML = ''; return; }
  iconEl.innerHTML = machineIconMiniSvg(machine.theme);
  iconEl.classList.add('visible');
}

export function switchActiveMachine(rawValue) {
  const value = rawValue === 'all' ? 'all' : parseInt(rawValue, 10);
  setActiveMachine(value);
  updateMachineSwitcherIcon();
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
  // machine was active when the tab was first opened.
  loadMachineProfileList();
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
      <span class="machine-row-icon">${machineIconMiniSvg(m.theme)}</span>
      <span class="machine-row-name">${escapeHtml(m.name)}</span>
      <span class="machine-row-type">${m.type === 'gaggimate' ? 'GaggiMate' : 'Gaggiuino'}</span>
      <span class="machine-row-shot-count">${t('settings_machine_shot_count', shotCount)}</span>
      ${m.type === 'gaggimate' ? `<span class="machine-row-badge-experimental" title="${escapeHtml(t('settings_machine_type_gaggimate'))}">${WARNING_ICON_SVG} ${t('settings_machine_experimental_badge')}</span>` : ''}
      ${m.isDefault ? `<span class="machine-row-badge">${t('settings_machine_default')}</span>` : ''}
      <span class="machine-row-actions">
        <button type="button" class="machine-edit-btn">${t('settings_machine_edit')}</button>
        ${!m.isDefault ? `<button type="button" class="machine-delete-btn">${t('settings_machine_delete')}</button>` : ''}
      </span>`;
    row.querySelector('.machine-edit-btn').addEventListener('click', () => openMachineForm(m));
    row.querySelector('.machine-delete-btn')?.addEventListener('click', () => deleteMachine(m.id));
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
    ${THEME_PRESETS.map(p => `<button type="button" class="machine-theme-swatch${_selectedTheme?.preset === p.key ? ' active' : ''}" data-theme-action="preset" data-preset-key="${escapeHtml(p.key)}" style="background:${p.a === p.b ? p.a : `linear-gradient(135deg,${p.a},${p.b})`}" title="${escapeHtml(t(presetLabelKey(p.key)))}" aria-label="${escapeHtml(t(presetLabelKey(p.key)))}"></button>`).join('')}
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

// Keeps the swatch active-states and the custom colour inputs in sync with
// _selectedTheme — called after every selection change (swatch click or
// custom colour/gradient-toggle edit).
function syncThemeFormUI() {
  renderThemeSwatches();
  const preview = document.getElementById('machineThemePreview');
  if (preview) preview.innerHTML = machineIconSvg(_selectedTheme);
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

export function openMachineForm(machine) {
  const card = document.getElementById('machineFormCard');
  if (!card) return;
  document.getElementById('machineFormId').value = machine?.id || '';
  document.getElementById('machineFormName').value = machine?.name || '';
  document.getElementById('machineFormType').value = machine?.type || 'gaggiuino';
  document.getElementById('machineFormHost').value = machine?.host || '';
  document.getElementById('machineFormSwitch').value = machine?.switchEntity || '';
  document.getElementById('machineFormTestResult').textContent = '';
  _selectedTheme = machine?.theme || null;
  syncThemeFormUI();
  card.style.display = '';
}

export function closeMachineForm() {
  const card = document.getElementById('machineFormCard');
  if (card) card.style.display = 'none';
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
  const payload = {
    name: document.getElementById('machineFormName').value.trim(),
    type: document.getElementById('machineFormType').value,
    host: document.getElementById('machineFormHost').value.trim(),
    switchEntity: document.getElementById('machineFormSwitch').value.trim() || null,
    theme: _selectedTheme,
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
async function _testMachine(id) {
  const resultEl = document.getElementById('machineFormTestResult');
  if (!resultEl) return;
  resultEl.textContent = t('settings_machine_testing');
  try {
    const r = await apiFetch(`api/machines/${id}/test`, { method: 'POST' });
    const data = await r.json().catch(() => ({}));
    resultEl.textContent = data.reachable ? t('settings_machine_test_ok') : t('settings_machine_test_fail');
  } catch {
    resultEl.textContent = t('settings_machine_test_fail');
  }
}

export async function saveMachineForm() {
  const id = await _saveMachine();
  if (id !== null) { closeMachineForm(); loadMachines(); }
}

export async function deleteMachine(id) {
  if (!confirm(t('settings_machine_delete_confirm'))) return;
  const r = await apiFetch(`api/machines/${id}`, { method: 'DELETE' });
  if (r.ok) loadMachines();
}

// #729: saves first (create or update, same as saveMachineForm()) so a
// not-yet-saved machine can be tested too, then runs the connection test
// against the now-known id, briefly shows the result inline, and closes the
// form like saveMachineForm() does. On save failure, _saveMachine() already
// surfaced the save error; the test is skipped entirely.
//
// #731: this save is only a means to get a testable id -- it must not start
// a shot import the way an explicit "Speichern" does, so triggerSync:false
// is passed through to _saveMachine() (server-side gate in routes/machines.js).
//
// #730 review: the form stays open (and clickable) for the 1200ms dwell
// before it auto-closes -- a double-click used to re-enter _saveMachine()
// with #machineFormId still empty (never written back after the first
// save), turning a single "new machine" save into two POSTs. Fixed two
// ways: the id is written back into the DOM the moment the first save
// succeeds (so even a concurrent second call would PUT, not POST again),
// and the button itself is disabled for the whole in-flight+dwell window so
// a second click can't start a second call in the first place.
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
  setTimeout(() => {
    closeMachineForm();
    loadMachines();
    if (btn) btn.disabled = false;
  }, 1200);
}
