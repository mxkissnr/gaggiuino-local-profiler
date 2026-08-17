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
// playful animation burst (style.css's .topbar-machine-icon-easter-egg) —
// no new persistent state, purely a CSS class toggle.
const EASTER_EGG_CLICKS = 7;
const EASTER_EGG_WINDOW_MS = 3000;
const EASTER_EGG_DURATION_MS = 2500;
const EASTER_EGG_CLASS = 'topbar-machine-icon-easter-egg';

let _clickTimes = [];

export function handleTopbarMachineIconClick() {
  const el = host();
  if (!el) return;
  const now = Date.now();
  _clickTimes = _clickTimes.filter(ts => now - ts < EASTER_EGG_WINDOW_MS);
  _clickTimes.push(now);
  if (_clickTimes.length < EASTER_EGG_CLICKS) return;
  _clickTimes = [];
  el.classList.remove(EASTER_EGG_CLASS);
  void el.offsetWidth; // restart the animation if a previous burst is still playing
  el.classList.add(EASTER_EGG_CLASS);
  setTimeout(() => el.classList.remove(EASTER_EGG_CLASS), EASTER_EGG_DURATION_MS);
}
