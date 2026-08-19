// Topbar ambient machine-status widget (#837) — the animated "Instrument"
// icon (machine-icon.js's machineIconAnimatedSvg(), #811) gets a second,
// permanent home in the app topbar (#content-topbar) so its brewing/steaming
// states are visible on every tab, not only while the Live view happens to
// be open and its own #liveMachineIcon panel isn't currently hidden behind
// the running-shot chart (see views/live.js's handleLiveData()).
//
// Fully independent from views/live.js's own icon instance: a separate SSE
// subscription (registered alongside live.js's, in main.js's bootstrap), its
// own _lastPreheat tracking and its own cached-SVG-per-machine-id state. The
// two only share the pure resolveMachineIconState() translator and the
// setMachineIconMode()/machineIconAnimatedSvg() renderers, all in
// machine-icon.js — see that module for why steaming can't be told apart
// from heating yet.
import { S } from '../state.js';
import { t } from '../i18n.js';
import { esc } from '../utils.js';
import { machineIconAnimatedSvg, setMachineIconMode, resolveMachineIconState,
         MACHINE_ICON_LIVE_CLASS } from '../machine-icon.js';

function host() {
  return document.getElementById('topbarMachineIcon');
}

// Rebuilt only when the active machine actually changes (theme/kind) — same
// caching convention as live.js's machineIconEl(), so a state change
// mid-animation never restarts it. The class reset below mirrors
// machineIconEl()'s own host.className reset on rebuild: the freshly
// inserted SVG has no is-* state classes yet (renders as the plain 'off'
// look) until the next SSE tick or fallback poll re-applies the real state —
// same brief transient views/live.js's own icon already has after a machine
// switch, not a new regression here.
let _iconFor = null;

export function renderTopbarMachineIcon() {
  const el = host();
  if (!el) return;
  const machine = (S.machines || []).find(m => m.id === S.activeMachineId)
               || (S.machines || []).find(m => m.isDefault)
               || (S.machines || [])[0];
  const id = machine?.id ?? null;
  if (_iconFor !== id || !el.firstChild) {
    el.className = `topbar-machine-icon ${MACHINE_ICON_LIVE_CLASS}`;
    el.innerHTML = machineIconAnimatedSvg(machine?.theme, machine?.type);
    _iconFor = id;
  }
}

let _lastPreheat = null;

// SSE push — registered once in main.js's bootstrap, independent of
// live.js's own handlers for the same two event types (multiple listeners
// per event are supported, see sse.js's onEvent()).
export function handleTopbarLiveSnapshotEvent(msg) {
  _applyState(msg);
}

export function handleTopbarPreheatUpdateEvent(preheat) {
  _lastPreheat = preheat;
  _applyState(null);
}

function _applyState(msg) {
  const el = host();
  if (!el) return;
  const { mode, heatFraction } = resolveMachineIconState(msg, _lastPreheat);
  setMachineIconMode(el, mode, heatFraction);
}

// Fallback when SSE isn't active — components/status.js's updateStatus()
// calls this with its /api/status response's machineReachable field, the
// same source #railStatusDot already uses. Coarse on/off only: without a
// live telemetry stream there's no heat-fraction/brewing/steaming detail to
// show. 'hot' (steady full colour, no per-state animation) stands in for
// "on, detail unknown" — the same default resolveMachineIconState() itself
// falls back to once a machine is reachable but reports neither isLive nor
// an active preheat.
export function syncTopbarMachineIconFallback(reachable) {
  if (S.sseActive) return;
  const el = host();
  if (!el) return;
  setMachineIconMode(el, reachable === false ? 'off' : 'hot', 1);
}

// Easter egg (#837): 7 clicks within 3s triggers a short, reversible
// rainbow burst — no new persistent state.
//
// #886: this used to be a `::after` overlay blended on top of the finished
// icon (style.css's now-removed .topbar-machine-icon-easter-egg), which
// read as a filter slapped over the machine rather than the machine's own
// colour changing. animateGradientRainbow() below instead rotates the
// icon's own hot-gradient `<stop>` colours (`.mi-grad-a`/`.mi-grad-b`,
// machine-icon.js) directly, so RGB mode is genuinely the machine's theme
// cycling through the hue wheel.
const EASTER_EGG_CLICKS = 7;
const EASTER_EGG_WINDOW_MS = 3000;
const EASTER_EGG_DURATION_MS = 2500;
const RAINBOW_PERIOD_MS = 3000; // one full hue rotation
const RAINBOW_HUE_SPAN = 40;    // degrees between the two stops, keeps the two-tone gradient look while it rotates
const RAINBOW_SAT = 85;
const RAINBOW_LIGHT = 50;

function hslToHex(h, s, l) {
  s /= 100; l /= 100;
  const k = n => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = n => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  const toHex = x => Math.round(255 * x).toString(16).padStart(2, '0');
  return `#${toHex(f(0))}${toHex(f(8))}${toHex(f(4))}`;
}

// Rotates one icon's `.mi-grad-a`/`.mi-grad-b` stop colours through the hue
// wheel starting now. `durationMs` null means loop forever (the panel icon)
// until .stop() is called; a number auto-restores the original colours and
// calls `onDone` once elapsed (the topbar burst). Respects
// prefers-reduced-motion by applying one static rainbow hue instead of
// animating — matches this app's rule that decorative motion, not just
// state-carrying motion, still needs a reduced-motion fallback.
function animateGradientRainbow(el, { durationMs = null, onDone = null } = {}) {
  const stopA = el.querySelector('.mi-grad-a');
  const stopB = el.querySelector('.mi-grad-b');
  if (!stopA || !stopB) return null;
  const origA = stopA.getAttribute('stop-color');
  const origB = stopB.getAttribute('stop-color');
  const restore = () => {
    stopA.setAttribute('stop-color', origA);
    stopB.setAttribute('stop-color', origB);
  };
  const setHue = hue => {
    stopA.setAttribute('stop-color', hslToHex((hue - RAINBOW_HUE_SPAN + 360) % 360, RAINBOW_SAT, RAINBOW_LIGHT));
    stopB.setAttribute('stop-color', hslToHex((hue + RAINBOW_HUE_SPAN) % 360, RAINBOW_SAT, RAINBOW_LIGHT));
  };
  if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
    setHue(0);
    if (durationMs != null) setTimeout(() => { restore(); onDone?.(); }, durationMs);
    return { stop: restore };
  }
  const start = performance.now();
  let rafId = null;
  function tick(now) {
    const elapsed = now - start;
    if (durationMs != null && elapsed >= durationMs) {
      restore();
      onDone?.();
      return;
    }
    setHue((elapsed / RAINBOW_PERIOD_MS) * 360 % 360);
    rafId = requestAnimationFrame(tick);
  }
  rafId = requestAnimationFrame(tick);
  return { stop() { if (rafId != null) cancelAnimationFrame(rafId); restore(); } };
}

let _clickTimes = [];
let _topbarRainbow = null;

export function handleTopbarMachineIconClick() {
  const el = host();
  if (!el) return;
  const now = Date.now();
  _clickTimes = _clickTimes.filter(ts => now - ts < EASTER_EGG_WINDOW_MS);
  _clickTimes.push(now);
  if (_clickTimes.length < EASTER_EGG_CLICKS) return;
  _clickTimes = [];
  _topbarRainbow?.stop(); // restart if a previous burst is still playing
  _topbarRainbow = animateGradientRainbow(el, {
    durationMs: EASTER_EGG_DURATION_MS,
    onDone: () => { _topbarRainbow = null; },
  });
  openEasterEggPanel();
}

// The panel's own icon copy is a second, independent instance (its own
// cached SVG, no SSE wiring) — it only ever needs to show one thing: the
// active machine, permanently colour-cycling via the same gradient-rotation
// as the topbar burst above (animateGradientRainbow()), just looping for as
// long as the panel stays open instead of the burst's fade-out/auto-stop —
// the panel itself is the "off switch" (closeEasterEggPanel() stops it). No
// new persistent state, no analytics, nothing recorded — see this module's
// top-of-file note and #845: intentionally never mentioned in
// CHANGELOG.md/whats-new.js, it's meant to stay a secret.
let _panelIconFor = null;
let _panelRainbow = null;

function panelHost() {
  return document.getElementById('easterEggPanelIcon');
}

function renderPanelIcon() {
  const el = panelHost();
  if (!el) return;
  const machine = (S.machines || []).find(m => m.id === S.activeMachineId)
               || (S.machines || []).find(m => m.isDefault)
               || (S.machines || [])[0];
  const id = machine?.id ?? null;
  if (_panelIconFor !== id || !el.firstChild) {
    // #848: must keep the position:relative easter-egg-panel-icon class —
    // machineIconAnimatedSvg()'s own clip-paths rely on it, and it keeps the
    // 140px icon box from resolving against the next positioned ancestor up
    // (.easter-egg-panel itself, position:fixed; inset:0 — the whole
    // viewport).
    el.className = `easter-egg-panel-icon ${MACHINE_ICON_LIVE_CLASS}`;
    el.innerHTML = machineIconAnimatedSvg(machine?.theme, machine?.type);
    _panelIconFor = id;
    _panelRainbow?.stop();
    _panelRainbow = animateGradientRainbow(el);
  }
  const { mode, heatFraction } = resolveMachineIconState(null, _lastPreheat);
  setMachineIconMode(el, mode === 'off' ? 'hot' : mode, heatFraction || 1);
}

function machineLabel() {
  if (S.activeMachineId == null || S.activeMachineId === 'all') return t('machine_switcher_all');
  const machine = (S.machines || []).find(m => m.id === S.activeMachineId);
  return machine?.name || t('machine_switcher_all');
}

function renderPanelStats() {
  const el = document.getElementById('easterEggPanelStats');
  if (!el) return;
  const version = document.getElementById('glpVersionBadge')?.textContent?.trim() || '–';
  const rows = [
    [t('easter_egg_stat_version'), version],
    [t('easter_egg_stat_connection'), S.sseActive ? t('easter_egg_stat_sse_live') : t('easter_egg_stat_sse_poll')],
    [t('machine_switcher_title'), machineLabel()],
  ];
  // codeql[js/xss-through-dom] false positive: esc()/escapeHtml() already applied, see #760
  el.innerHTML = rows.map(([label, value]) => `<dt>${esc(label)}</dt><dd>${esc(value)}</dd>`).join('');
}

export function openEasterEggPanel() {
  const panel = document.getElementById('easterEggPanel');
  if (!panel) return;
  renderPanelIcon();
  // renderPanelIcon() only (re)starts the rainbow when it rebuilds the SVG
  // (machine changed) — a reopen of the same machine's panel needs its own
  // restart since closeEasterEggPanel() below stops the previous loop.
  const el = panelHost();
  if (el && !_panelRainbow) _panelRainbow = animateGradientRainbow(el);
  renderPanelStats();
  panel.style.display = 'flex';
  document.getElementById('easterEggPanelCloseBtn')?.focus();
}

export function closeEasterEggPanel() {
  const panel = document.getElementById('easterEggPanel');
  if (!panel) return;
  panel.style.display = 'none';
  _panelRainbow?.stop();
  _panelRainbow = null;
}

// Called once from main.js's bootstrap, not at module-import time — this
// module is imported by test files (via machines-settings.js/status.js)
// under Node/vitest, where `document` doesn't exist.
export function bindEasterEggPanelEscape() {
  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape') return;
    const panel = document.getElementById('easterEggPanel');
    if (panel && panel.style.display !== 'none') closeEasterEggPanel();
  });
}
