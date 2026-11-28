import Chart from 'chart.js/auto';
import type { ChartConfiguration } from 'chart.js';
import { S } from '../state/index.js';
import * as chartRegistry from '../state/charts.js';
import * as timerRegistry from '../state/timers.js';
import { t, tHtml } from '../i18n.js';
import { isApiPortBlocked } from '../api/transport.js';
import { getPreheat, getLiveData } from '../api/system.js';
import { setWatchedMachine } from '../sse.js';
import { annotateShot } from '../api/shots.js';
import type { Bean, MachineControlState, ShotAnnotation } from '../api/types.js';
import { mapToXY, formatTimeLabel, chartColors, mapShotDatapoints, formatDate, html, esc, joinHtml, detectPhases } from '../utils.js';
import { quickRatingHtml } from '../components/quick-rating.js';
import type { ShotDatapoints, ShotSeries } from '../utils.js';
import { getShotCurve } from '../shot-curves.js';
import { machineIconAnimatedSvg, setMachineIconMode, updateMachineIconBrewReadout,
         resolveMachineIconState, MACHINE_ICON_LIVE_CLASS } from '../machine-icon.js';
import { getDefaultMachineId } from '../components/machines-settings.js';
import { machineWarningLabel, renderMachineControl } from '../components/machine-control.js';
import { openDetailSheet, requestCloseDetailSheet } from '../components/detail-sheet.js';
import { localeFor, buildRecordedGmPhaseRanges } from '../constants.js';
import { renderGrinderField, getGrinderFieldValue, handleGrinderFieldChange,
         _renderBeanSelect, _renderBasketSelect, _renderPuckScreenSelect, _renderRecipeSelect } from './shots/annotation.js';
import { safeLocalStorage } from '../storage.js';
import { beanLabel } from '../shared/bean-mix.js';
import type { BeanMixPartInput } from '../shared/bean-mix.js';
import { defaultGrinderName, suggestGrindDoseForBean } from './shots/grind.js';
import { checkGrindField, getGrindFieldValue as grindFieldValue, grindSelectId,
         refreshGrindField, renderGrindField, tidyGrindField } from './shots/grind-field.js';

// GET /api/live/data (and the SSE live-snapshot passthrough) — the fields this
// view reads off the poll payload. Named locally rather than reusing
// openapi.yaml's generated LiveData, which types `datapoints` as an array of
// empty records and doesn't model the machine's cross-repo curve shape at all.
interface LiveModeDatapoints {
  timeInMode?: number[];
  pressure?: number[];
  temperature?: number[];
}

interface LiveDatapoints {
  timeInShot?: number[];
  pressure?: number[];
  pumpFlow?: number[];
  shotWeight?: number[];
  weight?: number[];
  temperature?: number[];
}

interface LiveMessage {
  // #2247: the machine this payload describes; absent = the default machine.
  machineId?: number;
  isLive?: boolean;
  profileName?: string;
  seq?: number;
  machineReachable?: boolean | null;
  machineWarnings?: string[];
  machineUpdateAvailable?: boolean;
  // #2139: the GaggiMate display's system state when it is not ready (''
  // when ready, without a sys object and for Gaggiuino), and the controller
  // error code for 'error' (0 = none).
  machineSystemState?: string;
  machineSystemErrorCode?: number;
  isSteaming?: boolean;
  isFlushing?: boolean;
  isDescaling?: boolean;
  machineControl?: MachineControlState | null;
  steamDatapoints?: LiveModeDatapoints | null;
  flushDatapoints?: LiveModeDatapoints | null;
  descaleDatapoints?: LiveModeDatapoints | null;
  datapoints?: LiveDatapoints | null;
  temperature?: number | null;
  targetTemperature?: number | null;
  pressure?: number | null;
  waterLevel?: number | null;
}

// GET /api/preheat — the fields updatePreheatWidget() reads. `ready`/`remaining`
// are always present in the payload, hence required.
interface PreheatData {
  // #2247: the machine this payload describes; absent = the default machine.
  machineId?: number;
  ready: boolean;
  remaining: number;
  pct?: number;
  preheatTime?: number;
  // #1498: true only when the machine itself reports standby/sleep (GaggiMate);
  // a standby machine is off, so it must not count down to "ready".
  standby?: boolean;
}

// The sticky, per-machine pre-shot setup draft persisted to localStorage.
interface LiveSetupDraft {
  coffee?: string;
  beanId?: number | null;
  basketId?: number | null;
  puckScreenId?: number | null;
  recipeId?: number | null;
  grinder?: string;
  grindSetting?: string;
  dose?: number | null;
}

// state/index.ts types shot rows as metadata-only ShotMeta (id/timestamp plus
// an index signature); this alias names the annotation fields this view reads,
// same pattern as views/shots/annotation.ts.
interface LiveShotAnnotation {
  coffee?: string | null;
  beanId?: number | null;
  beanMix?: readonly BeanMixPartInput[] | null;
  grinder?: string | null;
  grindSetting?: string | null;
  dose?: number | null;
  basketId?: number | null;
  puckScreenId?: number | null;
  recipeId?: number | null;
  score?: number | null;
}

// #2247: which machine the Live tab shows. 'default' stands for the default
// machine ('all', no machine list yet, or the default machine selected);
// otherwise the selected non-default machine's id.
type LiveMachineKey = number | 'default';

function _shownMachineKey(): LiveMachineKey {
  const active = S.activeMachineId;
  const def = getDefaultMachineId();
  if (typeof active !== 'number' || def == null || active === def) return 'default';
  return active;
}

// A payload without machineId (demo frames, older servers) is the default
// machine's.
function _payloadMachineKey(machineId: number | undefined): LiveMachineKey {
  const def = getDefaultMachineId();
  if (machineId === undefined || def == null || machineId === def) return 'default';
  return machineId;
}

// The ?machineId to request and watch: none for the default machine.
function _shownMachineParam(): number | undefined {
  const key = _shownMachineKey();
  return key === 'default' ? undefined : key;
}

// The key connectLiveStream last opened the view for, so a machine switch
// can drop the previous machine's remembered payloads.
let _liveShownKey: LiveMachineKey | null = null;

// #1120 review: whether the live session last observed was a brew. The live
// payload reports a brew via msg.isLive (poll.go's liveAccum, brew-only) and
// steam/flush/descale sessions via msg.isSteaming/isFlushing/isDescaling with
// their own *Seq counters. Tracking it here lets the post-brew draft apply
// below gate explicitly on "a brew finished" instead of trusting the comment
// that steam/flush sessions never create Shot rows. null = no live session
// observed yet (treated as brew, so a synthetic live→idle transition with no
// recorded mode isn't blocked).
let _liveSessionIsBrew: boolean | null = null;

// #2226: the shot the quick rating strip under the finished curve belongs to,
// null = no strip. Set once the finished brew's shot has synced, cleared by
// Later/Done and when the next brew starts. A shot id, never a machine scalar,
// so a machine switch cannot point it at another machine's shot.
let _quickRateShotId: number | null = null;

/** Draws the live quick rating strip from the shot list, or hides it. */
export function renderLiveQuickRating(): void {
  const host = document.getElementById('liveQuickRating');
  if (!host) return;
  const shot = _quickRateShotId === null ? undefined : S.shots.find(s => s.id === _quickRateShotId);
  if (!shot) {
    host.innerHTML = html``;
    host.style.display = 'none';
    return;
  }
  host.innerHTML = quickRatingHtml(shot, true);
  host.style.display = '';
}

/** Later/Done: hides the strip until the next shot ends. */
export function dismissLiveQuickRating(): void {
  _quickRateShotId = null;
  renderLiveQuickRating();
}

// ── Pre-shot setup (bean/dose/grinder/grind/basket/puckscreen/recipe) ──────
// Lets the user pick the upcoming shot's setup right on the Live/idle screen
// instead of only after the fact on the Shots detail view. The draft is
// sticky per machine (most sessions pull several shots in a row with the
// same bean/grinder/basket) and gets written onto the next shot's annotation
// automatically once that shot finishes syncing (see fetchLiveData's "brew
// just ended" branch below) — same POST api/shots/{id}/annotate endpoint and
// field shape shots/annotation.ts's own auto-save uses, just triggered from
// here instead of from the annotation panel's own fields.
function _liveSetupStorageKey(): string {
  return `glp_live_shot_setup_${S.activeMachineId ?? 'default'}`;
}

function _loadLiveSetupDraft(): LiveSetupDraft {
  try {
    return (JSON.parse(localStorage.getItem(_liveSetupStorageKey()) ?? 'null') || {}) as LiveSetupDraft;
  } catch {
    return {};
  }
}

function _saveLiveSetupDraft(draft: LiveSetupDraft): void {
  try {
    localStorage.setItem(_liveSetupStorageKey(), JSON.stringify(draft));
  } catch (e) {
    // Quota exceeded / private-browsing storage restrictions — the draft
    // just doesn't persist across reloads this time; every field is still
    // live in the DOM for the current session, so this is a degraded
    // experience, not a broken one.
    console.error('[GLP] saving live shot setup draft failed:', e);
  }
  // #2153: the Live tab's next-shot rows show the draft.
  renderLiveSetupSummary(draft);
}

// ── Next shot rows (#2153) ────────────────────────────────────────────────
// The Live tab shows the draft as grouped rows (label left, value right);
// any row opens the fields in the shared detail sheet. Text only, so a
// re-render is a handful of textContent writes.
const NO_VALUE = '–';

function _libraryName(list: readonly { id: number; name: string }[] | undefined, id: number | null | undefined): string {
  if (id == null) return NO_VALUE;
  return list?.find(x => x.id === id)?.name || NO_VALUE;
}

export function renderLiveSetupSummary(draft: LiveSetupDraft = _loadLiveSetupDraft()): void {
  const lib = S.coffeeLibrary;
  const set = (id: string, text: string): void => {
    const el = document.getElementById(id);
    if (el) el.textContent = text;
  };
  const grind = [draft.grinder, draft.grindSetting].filter(Boolean).join(' · ');
  set('liveSetupBean', draft.coffee || NO_VALUE);
  set('liveSetupGrinder', grind || NO_VALUE);
  set('liveSetupDose', draft.dose != null ? String(draft.dose) : NO_VALUE);
  set('liveSetupBasket', _libraryName(lib?.baskets, draft.basketId));
  set('liveSetupPuckScreen', _libraryName(lib?.puckScreens, draft.puckScreenId));
  set('liveSetupRecipe', _libraryName(lib?.recipes, draft.recipeId));
  // Same rule as the recipe field: no recipes in the library, no row.
  const recipeRow = document.getElementById('liveSetupRecipeRow');
  if (recipeRow) recipeRow.hidden = !(lib?.recipes || []).length;
}

// #2153: the fields stay one element with their ids and listeners; the
// detail sheet holds it while open and puts it back on close (#2038).
export function openLiveSetupSheet(): void {
  const panel = document.getElementById('lsFields');
  if (!panel) return;
  openDetailSheet({
    title: t('live_setup_toggle'),
    dialog: true,
    body: html``,
    content: panel,
    onClose: () => renderLiveSetupSummary(),
  });
}

let _lsWired = false;

export function renderLiveShotSetupPanel(): void {
  const draft = _loadLiveSetupDraft();
  renderLiveSetupSummary(draft);
  _renderBeanSelect(draft.coffee || '', draft.beanId ?? null, 'lsBean');
  _renderBasketSelect(draft.basketId ?? null, 'lsBasket');
  _renderPuckScreenSelect(draft.puckScreenId ?? null, 'lsPuckScreen');
  _renderRecipeSelect(draft.recipeId ?? null, 'lsRecipeField', 'lsRecipe');
  renderGrinderField('lsGrinder', 'lsGrinderOther', draft.grinder || '');
  renderGrindField('lsGrindSetting', draft.grinder || '', draft.grindSetting || '');
  // The tests' fake DOM records the raw assigned value (no <input> string
  // coercion), so the dose field stays number-or-string when assigned;
  // a real input stringifies on assignment.
  const doseEl = document.getElementById('lsDose') as (HTMLElement & { value: number | string }) | null;
  if (doseEl) doseEl.value = draft.dose ?? '';

  if (_lsWired) return;
  _lsWired = true;

  const beanSelect = document.getElementById('lsBean') as HTMLSelectElement | null;
  beanSelect?.addEventListener('change', () => {
    const d = _loadLiveSetupDraft();
    d.coffee = beanSelect.value;
    const opt = beanSelect.selectedOptions[0];
    d.beanId = opt?.dataset.beanId ? parseInt(opt.dataset.beanId, 10) : null;
    // Prefill grinder/grind setting from the bean's known-grind-setting
    // record (dial-in-wizard's own prefill source, see library.ts) — only
    // when the user hasn't already typed something into those fields, so
    // this never clobbers a manual override.
    //
    // #1954: with a default grinder in the library the first known entry is
    // not a safe source — it is whichever grinder the bean was dialled in on
    // first, and the draft is written onto the next shot, so copying another
    // grinder's number here would pollute that grinder's history. The
    // grind module's bean-aware suggestion already restricts itself to the
    // default grinder's own history.
    if (!d.grinder && !d.grindSetting && d.beanId != null) {
      if (defaultGrinderName(S.coffeeLibrary)) {
        const s = suggestGrindDoseForBean(d.coffee, S.coffeeLibrary, S.shots, { beanId: d.beanId });
        d.grinder = s.grinder;
        d.grindSetting = String(s.grindSetting);
      } else {
        const bean = (S.coffeeLibrary?.beans || []).find((b): b is Bean => b.id === d.beanId);
        const known = bean?.knownGrindSettings?.[0];
        if (known) { d.grinder = known.grinder || ''; d.grindSetting = known.grindSetting || ''; }
      }
    }
    _saveLiveSetupDraft(d);
    renderLiveShotSetupPanel();
  });

  document.getElementById('lsGrinder')?.addEventListener('change', () => {
    handleGrinderFieldChange('lsGrinder', 'lsGrinderOther');
    const d = _loadLiveSetupDraft();
    d.grinder = getGrinderFieldValue('lsGrinder', 'lsGrinderOther');
    _saveLiveSetupDraft(d);
    refreshGrindField('lsGrindSetting', d.grinder);
  });
  document.getElementById('lsGrinderOther')?.addEventListener('input', () => {
    const d = _loadLiveSetupDraft();
    d.grinder = getGrinderFieldValue('lsGrinder', 'lsGrinderOther');
    _saveLiveSetupDraft(d);
    refreshGrindField('lsGrindSetting', d.grinder);
  });
  document.getElementById('lsGrindSetting')?.addEventListener('input', () => {
    checkGrindField('lsGrindSetting');
    const d = _loadLiveSetupDraft();
    d.grindSetting = grindFieldValue('lsGrindSetting');
    _saveLiveSetupDraft(d);
  });
  document.getElementById('lsGrindSetting')?.addEventListener('blur', () => tidyGrindField('lsGrindSetting'));
  document.getElementById(grindSelectId('lsGrindSetting'))?.addEventListener('change', () => {
    const d = _loadLiveSetupDraft();
    d.grindSetting = grindFieldValue('lsGrindSetting');
    _saveLiveSetupDraft(d);
  });
  document.getElementById('lsDose')?.addEventListener('input', () => {
    const d = _loadLiveSetupDraft();
    d.dose = parseFloat((document.getElementById('lsDose') as HTMLInputElement).value) || null;
    _saveLiveSetupDraft(d);
  });
  document.getElementById('lsBasket')?.addEventListener('change', () => {
    const d = _loadLiveSetupDraft();
    const sel = document.getElementById('lsBasket') as HTMLSelectElement;
    const opt = sel.selectedOptions[0];
    d.basketId = opt?.dataset.basketId ? parseInt(opt.dataset.basketId, 10) : null;
    _saveLiveSetupDraft(d);
  });
  document.getElementById('lsPuckScreen')?.addEventListener('change', () => {
    const d = _loadLiveSetupDraft();
    const sel = document.getElementById('lsPuckScreen') as HTMLSelectElement;
    const opt = sel.selectedOptions[0];
    d.puckScreenId = opt?.dataset.puckscreenId ? parseInt(opt.dataset.puckscreenId, 10) : null;
    _saveLiveSetupDraft(d);
  });
  document.getElementById('lsRecipe')?.addEventListener('change', () => {
    const d = _loadLiveSetupDraft();
    d.recipeId = parseInt((document.getElementById('lsRecipe') as HTMLSelectElement).value, 10) || null;
    _saveLiveSetupDraft(d);
  });
  document.getElementById('lsReset')?.addEventListener('click', () => {
    safeLocalStorage.removeItem(_liveSetupStorageKey());
    renderLiveShotSetupPanel();
  });
}

// Writes the current draft onto shotId's annotation — called once a shot
// that started while this draft was active finishes syncing. Only sends
// the fields the draft actually has a value for (an empty draft sends
// nothing — no-ops rather than a POST) and only when the shot's annotation
// is still blank: by the time this runs (4s after brew end + sync delay),
// the backend's shot-defaults auto-fill (#654) may already have populated
// it from the bean/grinder library defaults for this machine, and blindly
// overwriting here would silently clobber that instead of merging with it
// — this feature only ever fills a shot that would otherwise stay
// unannotated, same as #654 itself.
async function _applyLiveSetupToShot(shotId: number): Promise<void> {
  const draft = _loadLiveSetupDraft();
  if (!Object.keys(draft).length) return;
  const shot = S.shots.find(s => s.id === shotId);
  const existing: LiveShotAnnotation = (shot?.annotation as LiveShotAnnotation | undefined) || {};
  const alreadyAnnotated = !!(existing.coffee || existing.beanId != null || existing.grinder ||
    existing.grindSetting || existing.dose != null || existing.basketId != null ||
    existing.puckScreenId != null || existing.recipeId != null);
  if (alreadyAnnotated) return;

  const payload: ShotAnnotation = {};
  if (draft.coffee) { payload.coffee = draft.coffee; payload.beanId = draft.beanId ?? null; }
  if (draft.grinder) payload.grinder = draft.grinder;
  if (draft.grindSetting) payload.grindSetting = draft.grindSetting;
  if (draft.dose != null) payload.dose = draft.dose;
  if (draft.basketId != null) payload.basketId = draft.basketId;
  if (draft.puckScreenId != null) payload.puckScreenId = draft.puckScreenId;
  if (draft.recipeId != null) payload.recipeId = draft.recipeId;
  if (!Object.keys(payload).length) return;

  try {
    const r = await annotateShot(shotId, payload);
    if (r.ok) {
      const idx = S.shots.findIndex(s => s.id === shotId);
      const shotRow = idx !== -1 ? S.shots[idx] : undefined;
      if (shotRow) shotRow.annotation = { ...(shotRow.annotation as Record<string, unknown>), ...payload };
      // This page's own write is not echoed back, and the dose changes the bean's stock.
      void window.loadLibrary?.();
    }
  } catch (e) {
    // Best-effort — the shot still exists, just unannotated — but log it
    // rather than swallowing silently, matching every other network-call
    // catch in this file.
    console.error('[GLP] applying live shot setup to shot', shotId, 'failed:', e);
  }
}

// ── Live chart init ───────────────────────────────────────────────────────
export function initLiveChart(): void {
  // #814: resolved per render, never at module load — the value has to be
  // whatever the ACTIVE theme resolves to right now.
  const C = chartColors();
  const ctx = document.getElementById('liveChart') as HTMLCanvasElement;
  chartRegistry.dispose('liveChart');

  // Chart.js infers the dataset data type from the (empty) arrays below as
  // never[], so the config is asserted to the line shape once, same convention
  // as views/shots/index.ts's full chart config.
  chartRegistry.set('liveChart', new Chart(ctx, {
    type: 'line',
    data: {
      datasets: [
        { label: t('chart_pressure'), data: [], yAxisID: 'y',  borderWidth: 2.5, tension: 0.1, borderColor: '#3498db', backgroundColor: 'transparent', pointStyle: false },
        { label: t('chart_flow'),     data: [], yAxisID: 'y',  borderWidth: 2,   tension: 0.1, borderColor: '#f39c12', backgroundColor: 'transparent', pointStyle: false },
        { label: t('chart_weight'),   data: [], yAxisID: 'y1', borderWidth: 2,   tension: 0.1, borderColor: '#2ecc71', backgroundColor: 'transparent', pointStyle: false },
        { label: t('chart_temp'),     data: [], yAxisID: 'y1', borderWidth: 2.5, tension: 0.1, borderColor: '#e74c3c', backgroundColor: 'transparent', pointStyle: false },
        // Reference datasets (4-7) — dashed, semi-transparent
        { label: t('ref_pressure'), data: [], yAxisID: 'y',  borderWidth: 1.5, tension: 0.1, borderColor: 'rgba(52,152,219,0.4)',  borderDash: [6,3], backgroundColor: 'transparent', pointStyle: false },
        { label: t('ref_flow'),     data: [], yAxisID: 'y',  borderWidth: 1.5, tension: 0.1, borderColor: 'rgba(243,156,18,0.4)',  borderDash: [6,3], backgroundColor: 'transparent', pointStyle: false },
        { label: t('ref_weight'),   data: [], yAxisID: 'y1', borderWidth: 1.5, tension: 0.1, borderColor: 'rgba(46,204,113,0.4)',  borderDash: [6,3], backgroundColor: 'transparent', pointStyle: false },
        { label: t('ref_temp'),     data: [], yAxisID: 'y1', borderWidth: 1.5, tension: 0.1, borderColor: 'rgba(231,76,60,0.4)',   borderDash: [6,3], backgroundColor: 'transparent', pointStyle: false }
      ]
    },
    options: {
      ...chartRegistry.chartBaseOptions(),
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { labels: chartRegistry.chartLegendLabels(C.text) },
        tooltip: { callbacks: { title: (ctx: { parsed: { x: number } }[]) => t('chart_time', formatTimeLabel(ctx[0]?.parsed.x ?? 0)) } }
      },
      scales: {
        x:  { type: 'linear', min: 0, max: 60, ticks: { color: C.tick, ...chartRegistry.chartTimeTicks() }, grid: { color: C.grid } },
        y:  { type: 'linear', position: 'left',  min: 0, max: 12, ticks: { color: C.tick }, grid: { color: C.grid } },
        y1: { type: 'linear', position: 'right', min: 0, max: 100, ticks: { color: C.tick }, grid: { drawOnChartArea: false } }
      }
    }
  } as ChartConfiguration<'line'>));

  // Re-apply reference shot after chart re-init
  if (S.refShotId) void _applyRefShotById(S.refShotId);
}

// #957: reference-overlay curves are lazy per shot now — fetch through the
// curve cache, then feed _applyRefDatasets the mapped XY form.
async function _applyRefShotById(shotId: number): Promise<void> {
  const dp = await getShotCurve(shotId);
  if (S.refShotId !== shotId) return; // ref changed while we were fetching
  const series = mapShotDatapoints(dp);
  _applyRefDatasets(series);
  // #2153: the phase bar follows the reference shot's phases.
  _setRefPhases(refPhaseRanges(dp, series));
}

function _applyRefDatasets(d: ShotSeries): void {
  const liveChart = chartRegistry.get('liveChart') as Chart<'line'> | null;
  if (!liveChart) return;
  const datasets = liveChart.data.datasets;
  const ds4 = datasets[4], ds5 = datasets[5], ds6 = datasets[6], ds7 = datasets[7];
  if (ds4) ds4.data = d.pressure;
  if (ds5) ds5.data = d.flow;
  if (ds6) ds6.data = d.weight;
  if (ds7) ds7.data = d.temp;
  liveChart.update('none');
}

// ── Phase bar (#2153) ─────────────────────────────────────────────────────
// The live payload carries no phase, so the bar follows the reference
// shot: the phase changes it recorded (GaggiMate firmware v1.9.0+), else
// the preinfusion/extraction split of its pressure curve, the same two
// sources the shot page uses. Widths follow the reference's phase lengths;
// the current phase is the one the elapsed time falls into (the last one
// once past its end). No reference, no bar. Repainted only when the phase
// changes, never per sample.
export interface LivePhase {
  name: string;
  t0: number;
  t1: number;
}

let _refPhases: LivePhase[] = [];
let _phaseIdx = -2; // -2: not painted yet, -1: hidden

export function refPhaseRanges(dp: ShotDatapoints, series: ShotSeries = mapShotDatapoints(dp)): LivePhase[] {
  const end = series.rawTimes.at(-1) ?? 0;
  const recorded = buildRecordedGmPhaseRanges(dp.phaseTransitions, end);
  if (recorded.length) return recorded.map(r => ({ name: r.name, t0: r.t0, t1: r.t1 }));
  const split = detectPhases(series.pressure.map(p => p.x), series.pressure.map(p => p.y));
  if (!split) return [];
  return [
    { name: t('phase_preinfusion'), t0: 0, t1: split.preinfusion },
    { name: t('phase_extraction'), t0: split.preinfusion, t1: end },
  ];
}

export function currentPhaseIndex(phases: readonly LivePhase[], elapsed: number): number {
  if (!phases.length) return -1;
  const i = phases.findIndex(p => elapsed < p.t1);
  return i === -1 ? phases.length - 1 : i;
}

// Exported for the tests, which set the phases without fetching a curve.
export function _setRefPhases(phases: LivePhase[]): void {
  _refPhases = phases;
  _phaseIdx = -2;
}

// elapsed null (steam, flush, descale): no bar.
function _syncPhaseBar(elapsed: number | null): void {
  const idx = elapsed == null ? -1 : currentPhaseIndex(_refPhases, elapsed);
  if (idx === _phaseIdx) return;
  _phaseIdx = idx;
  const phase = idx >= 0 ? _refPhases[idx] : undefined;
  const bar  = document.getElementById('livePhases');
  const text = document.getElementById('livePhaseText');
  if (bar) {
    // codeql[js/xss-through-dom] false positive: esc()/html already applied, see #760
    bar.innerHTML = phase
      ? joinHtml(_refPhases.map((p, i) => html`<span class="live-phase${esc(i < idx ? ' is-done' : i === idx ? ' is-current' : '')}" style="flex-grow: ${esc(Math.max(1, Math.round(p.t1 - p.t0)))}"></span>`))
      : html``;
    bar.hidden = !phase;
  }
  if (text) {
    // Numbers and the phase's own name, so no translation is needed.
    text.textContent = phase ? `${idx + 1}/${_refPhases.length} · ${phase.name}` : '';
    text.hidden = !phase;
  }
}

// #2153: the reference is a chip in the running view's toolbar that opens
// the list (openRefPicker). The name stays: the mode switch and the machine
// switch call it through window to repaint the chip.
export function populateRefSelector(): void {
  renderRefChip();
}

// One row of the reference list: the newest 40 shots with a curve, the set
// the old dropdown listed.
export interface RefShotChoice {
  id: number;
  title: string;
  sub: string;
  score: number | null;
}

export function refShotChoices(): RefShotChoice[] {
  return S.shots.filter(s => s.hasChartData)
    .slice().reverse().slice(0, 40)
    .map(s => {
      const ann     = (s.annotation as LiveShotAnnotation | undefined) || {};
      const profile = (s.profile as { name?: string } | undefined)?.name || (s.profileName as string | undefined) || '?';
      return {
        id: s.id,
        title: `${formatDate(s.timestamp * 1000, localeFor(S.currentLang))} · ${profile}`,
        // #1853: a mixed shot names every bean, like the shot list does; a
        // single-bean shot keeps its plain coffee name.
        sub: beanLabel(ann),
        score: ann.score ?? null,
      };
    });
}

function _refChipLabel(): string {
  const id = S.refShotId;
  if (id == null) return t('ref_none');
  const shot = S.shots.find(s => s.id === id);
  if (!shot) return `#${id}`;
  const score = ((shot.annotation as LiveShotAnnotation | undefined) || {}).score;
  return `${formatDate(shot.timestamp * 1000, localeFor(S.currentLang))}${score != null ? ` · ${score}` : ''}`;
}

// The chip names the reference (or says there is none); Clear shows only
// while there is one.
export function renderRefChip(): void {
  const chip  = document.getElementById('refChip');
  const clear = document.getElementById('refClearBtn');
  if (chip) {
    chip.textContent = _refChipLabel();
    chip.setAttribute('aria-pressed', S.refShotId != null ? 'true' : 'false');
  }
  if (clear) clear.style.display = S.refShotId != null ? '' : 'none';
}

// The chip opens the list in the shared detail sheet: a popover next to
// the chip on desktop, a bottom sheet on a phone.
export function openRefPicker(anchor: HTMLElement | null): void {
  const current = S.refShotId;
  const rows = refShotChoices().map(c => html`<button type="button" class="settings-row" data-action="live-ref-choose" data-id="${esc(c.id)}" aria-current="${esc(c.id === current ? 'true' : 'false')}">
      <span class="settings-row-text"><span class="settings-row-title">${esc(c.title)}</span>${c.sub ? html`<span class="settings-row-sub">${esc(c.sub)}</span>` : html``}</span>
      ${c.score != null ? html`<span class="settings-row-value">${esc(c.score)}</span>` : html``}
    </button>`);
  openDetailSheet({
    title: t('live_ref_title'),
    body: rows.length
      ? html`<div class="settings-group live-ref-list">${joinHtml(rows)}</div>`
      : html`<p class="settings-card-desc">${tHtml('ref_none')}</p>`,
    anchor,
  });
}

// A row of the list: apply that shot and close the sheet.
export function chooseReferenceShot(id: string): void {
  requestCloseDetailSheet();
  onRefShotChange(id);
}

export function autoApplyRefShot(profileName: string): void {
  const match = S.shots
    .filter(s => ((s.profile as { name?: string } | undefined)?.name || (s.profileName as string | undefined) || '') === profileName && s.hasChartData)
    .sort((a, b) => b.timestamp - a.timestamp)[0];
  if (!match) return;
  S.refShotId = match.id;
  void _applyRefShotById(match.id);
  renderRefChip();
}

export function onRefShotChange(val: string): void {
  if (!val) { clearReferenceShot(); return; }
  S.refShotId = parseInt(val);
  renderRefChip();
  const shot = S.shots.find(s => s.id === S.refShotId);
  if (!shot) return;
  void _applyRefShotById(shot.id);
}

export function clearReferenceShot(): void {
  S.refShotId = null;
  _setRefPhases([]);
  const liveChart = chartRegistry.get('liveChart') as Chart<'line'> | null;
  if (liveChart) {
    [4, 5, 6, 7].forEach(i => {
      const ds = liveChart.data.datasets[i];
      if (ds) ds.data = [];
    });
    liveChart.update('none');
  }
  renderRefChip();
}

function _setDisplay(ids: readonly string[], value: string): void {
  for (const id of ids) {
    const el = document.getElementById(id);
    if (el) el.style.display = value;
  }
}

// #2153: the running state (a brew, steam, flush or descale, or a finished
// shot) shows its verdict and toolbar (#live-content), the phase bar and
// chart (#liveChartArea) and the four figures (#liveFigures, the right
// column on desktop); the idle state shows #live-idle instead.
function _showRunning(on: boolean): void {
  _setDisplay(['live-content'], on ? 'block' : 'none');
  _setDisplay(['liveChartArea', 'liveFigures'], on ? '' : 'none');
  _setDisplay(['live-idle'], on ? 'none' : 'flex');
}

export function connectLiveStream(): void {
  const content = document.getElementById('live-content');
  const refBar  = document.getElementById('live-ref-bar');
  if (content) content.style.display = '';
  if (refBar)  refBar.style.display  = '';
  // #2153: the chart area must be visible before initLiveChart() sizes
  // the canvas; handleLiveData() hides it again for the idle state.
  _setDisplay(['liveChartArea', 'live-shot-setup'], '');
  _stopLiveTimers();
  initLiveChart();
  renderLiveShotSetupPanel();
  setLiveBadge('connecting');
  S.liveLastSeq = -1;
  S.liveWasLive = false;
  _liveSessionIsBrew = null;
  const key = _shownMachineKey();
  if (_liveShownKey !== key) {
    _liveShownKey = key;
    _lastLiveMsg = null;
    _lastPreheat = null;
    dismissLiveQuickRating();
  }
  setWatchedMachine(_shownMachineParam() ?? null);
  void fetchLiveData();
  void fetchPreheatData();
  // #736 review: SSE push (handleLiveSnapshotEvent/handlePreheatUpdateEvent,
  // wired once in boot/data.ts) covers both once connected -- these
  // polling intervals are only needed as the fallback for whenever SSE
  // hasn't (yet, or ever) taken over for this session. A one-time
  // `if (!S.sseActive)` check here (at the moment the tab opens) isn't
  // enough: EventSource can take up to sse.ts's WATCHDOG_MS (8s, longer
  // still over HA Ingress per #738/#740) to actually open, so S.sseActive
  // can still be null/false right now even though it flips true moments
  // later -- these intervals must always start, and instead self-correct on
  // every tick, same convention as status.ts's own 30s updateStatus()
  // interval, which likewise always fires rather than deciding once at
  // startup.
  timerRegistry.set('livePollInterval',    setInterval(() => { if (!S.sseActive) void fetchLiveData(); }, 1000));
  timerRegistry.set('preheatPollInterval', setInterval(() => { if (!S.sseActive) void fetchPreheatData(); }, 10000));
}

export async function fetchPreheatData(): Promise<void> {
  // #2247: a response that arrives after a machine switch is dropped.
  const key = _shownMachineKey();
  try {
    const r = await getPreheat(_shownMachineParam());
    if (!r.ok) return;
    const d = await r.json() as PreheatData;
    if (key !== _shownMachineKey()) return;
    updatePreheatWidget(d);
  } catch { /* ignore */ }
}

// #811: the animated machine icon in the Live view's idle panel. Built once
// and then only switched between states — rebuilding the SVG on every poll
// tick (once a second) would restart every animation mid-cycle, so the
// element is only re-created when the machine itself changes.
let _machineIconFor: number | null = null;   // machine id the current SVG was built for

function machineIconEl(): HTMLElement | null {
  const host = document.getElementById('liveMachineIcon');
  if (!host) return null;
  const machine = (S.machines || []).find(m => m.id === S.activeMachineId)
               || (S.machines || []).find(m => m.isDefault)
               || (S.machines || [])[0];
  const id = machine?.id ?? null;
  if (_machineIconFor !== id || !host.firstChild) {
    host.className = `idle-icon ${MACHINE_ICON_LIVE_CLASS}`;
    host.innerHTML = machineIconAnimatedSvg(machine?.theme, machine?.type);
    _machineIconFor = id;
  }
  return host;
}

let _lastPreheat: PreheatData | null = null;

// #837: raw-data-to-icon-state translation itself now lives in
// resolveMachineIconState() (machine-icon.ts) — shared with the topbar's
// own ambient icon instance (components/topbar-machine-icon.ts) — this stays
// the Live view's own wiring: which element to drive and which preheat
// snapshot to translate against.
// #1383: a preheat event carries no reachability of its own, so remember the
// last live message to resolve against instead of dropping what we know.
let _lastLiveMsg: LiveMessage | null = null;

export function syncMachineIcon(msg: LiveMessage | null): void {
  if (msg) _lastLiveMsg = msg;
  const el = machineIconEl();
  if (!el) return;
  const { mode, heatFraction } = resolveMachineIconState(msg, _lastPreheat);
  // #1541: the icon's little display mirrors the live temperature instead of
  // the old hardcoded "18.0°".
  setMachineIconMode(el, mode, heatFraction, _lastLiveMsg?.temperature);
}

export function updatePreheatWidget(d: PreheatData): void {
  const warmingWrap = document.getElementById('preheat-warming-wrap');
  const barFill     = document.getElementById('preheat-bar-fill') as HTMLElement;
  const countdown   = document.getElementById('preheat-countdown') as HTMLElement;
  if (!warmingWrap) return;
  // #811: remembered so the icon can show heat progress on poll ticks that
  // carry live data but no preheat payload. #1383: resolve against the last
  // live message rather than null, so a machine we already know is off stays
  // off instead of flipping to the heating state (heat 0) and showing accent.
  _lastPreheat = d;
  syncMachineIcon(_lastLiveMsg);

  // #1498: a GaggiMate in standby is off, so no warm-up countdown may show;
  // the payload can still carry a stale remaining. A machine whose last live
  // message reported it unreachable is hidden the same way, and so is a
  // display whose last live message reports a system state other than ready
  // (#2139; handleLiveData re-applies this payload when it changes). The idle
  // title is owned by handleLiveData; don't write it here. #2153: no "ready
  // to brew" badge and no "warming up" text here any more: the idle title
  // already says both.
  const hidden = !!d.standby || _lastLiveMsg?.machineReachable === false || !!_lastLiveMsg?.machineSystemState;
  if (!hidden && !d.ready && d.remaining > 0) {
    warmingWrap.style.display = '';
    barFill.style.width       = `${Math.round((d.pct || 0) * 100)}%`;
    const m = Math.floor(d.remaining / 60);
    const s = d.remaining % 60;
    countdown.textContent     = t('preheat_remain', m, s);
  } else {
    warmingWrap.style.display = 'none';
  }

  // #1541: a preheat update can arrive while the idle panel is shown (e.g. the
  // machine just finished warming), so refresh the status badge from the same
  // phase instead of waiting for the next live message. The idle title stays
  // owned by handleLiveData above.
  const idleEl = document.getElementById('live-idle');
  if (idleEl && idleEl.style.display !== 'none' && _lastLiveMsg?.machineReachable !== false) {
    setIdleBadge(idlePhase());
  }
}

export async function fetchLiveData(): Promise<void> {
  // #2247: a response that arrives after a machine switch is dropped.
  const key = _shownMachineKey();
  try {
    const r = await getLiveData(_shownMachineParam());
    if (!r.ok) {
      // #807: same reasoning as the Shots view -- a bare "HTTP 401" in the
      // Live badge says nothing about the deliberately-closed direct port.
      setLiveBadge('error', isApiPortBlocked(r.status) ? t('api_port_closed_badge') : `HTTP ${r.status}`);
      return;
    }
    const msg = await r.json() as LiveMessage;
    if (key !== _shownMachineKey()) return;

    // First successful response — mark as ready
    const statusEl = document.getElementById('live-status-text');
    if (timerRegistry.get('livePollInterval') && statusEl && statusEl.textContent === t('live_connecting')) {
      setLiveBadge('ready');
    }

    handleLiveData(msg);
  } catch {
    // #913: a network-level failure (e.g. the machine lost power and dropped
    // off the network entirely, not just an HTTP error) used to only flip
    // the badge -- the previously-rendered live values (preheat countdown,
    // pressure/weight, machine-icon state) stayed frozen on screen
    // indefinitely. Route through the same unreachable path as the explicit
    // msg.machineReachable === false branch below so this failure mode
    // clears the panel exactly like the other two already do.
    if (key === _shownMachineKey()) handleLiveData({ machineReachable: false, datapoints: {} });
  }
}

function _stopLiveTimers(): void {
  timerRegistry.dispose('livePollInterval');
  timerRegistry.dispose('preheatPollInterval');
  timerRegistry.dispose('liveTimerTick');
  chartRegistry.dispose('liveChart');
  S.liveBrewStartWall = null;
}

export function disconnectLiveStream(): void {
  _stopLiveTimers();
  // #2247: leaving the Live tab ends the watch, so the backend stops polling
  // a non-default machine nobody looks at.
  setWatchedMachine(null);
}

// #2096: the live status is a shared status badge; the state picks its
// variant. #902/#983: steaming, flushing and descaling share the accent,
// distinct from a brewing shot. #1541: standby, connecting and idle stay
// neutral, warming takes the accent.
const LIVE_BADGE_VARIANTS: Record<string, string> = {
  ready: 'badge--ok',
  brewing: 'badge--err',
  error: 'badge--err',
  unreachable: 'badge--err',
  steaming: 'badge--accent',
  flushing: 'badge--accent',
  descaling: 'badge--accent',
  warming: 'badge--accent',
  // #2139: a display that is not ready warns; a controller error is an error.
  'system-state': 'badge--warn',
  'system-error': 'badge--err',
};

// #2139: the GaggiMate display's own system state (firmware v1.9.0+) while it
// is reachable but not ready. The backend sends only these six states; a
// controller error adds its code when the machine reports one.
const MACHINE_SYSTEM_STATE_KEYS: Record<string, string> = {
  starting: 'machine_system_starting',
  waiting: 'machine_system_waiting',
  updating: 'machine_system_updating',
  autotuning: 'machine_system_autotuning',
  mismatch: 'machine_system_mismatch',
  error: 'machine_system_error',
};

export function machineSystemStateLabel(state: string, code?: number | null): string {
  if (state === 'error' && code != null && code > 0) return t('machine_system_error_code', code);
  const key = MACHINE_SYSTEM_STATE_KEYS[state];
  return key ? t(key) : state;
}

export function setLiveBadge(state: string, detail = ''): void {
  const badge   = document.getElementById('live-status-badge') as HTMLElement;
  const textEl  = document.getElementById('live-status-text') as HTMLElement;
  const liveBtn = document.getElementById('btnLive') as HTMLElement;

  const variant = LIVE_BADGE_VARIANTS[state];
  badge.className = variant ? `badge ${variant} ${state}` : `badge ${state}`;
  liveBtn.classList.remove('live-brewing', 'live-ready');

  const labels: Record<string, string> = {
    connecting:  t('live_connecting'),
    ready:       t('live_ready_status'),
    brewing:     t('live_brewing'),
    // #902: steam/flush get their own badge labels/status-dot color (see
    // style.css's #live-status-badge.steaming/.flushing) -- distinct from
    // brewing (a shot) even though both are "something is actively running".
    steaming:    t('live_steaming'),
    flushing:    t('live_flushing'),
    // #983: descale mirrors steam/flush's own badge treatment.
    descaling:   t('live_descaling'),
    // #1541: the idle badge mirrors the idle title's standby/warming states
    // (no new translations -- the same keys the title already uses).
    standby:     t('machine_standby'),
    warming:     t('preheat_warming'),
    // #2139: the caller passes the translated system state as detail.
    'system-state': detail,
    'system-error': detail,
    error:       detail || t('live_error_status'),
    idle:        t('live_ready_status'),
    unreachable: detail || t('live_unreachable_status')
  };
  textEl.textContent = labels[state] || state;

  if (state === 'brewing') liveBtn.classList.add('live-brewing');
  if (state === 'ready' || state === 'idle') liveBtn.classList.add('live-ready');
}

// #902: shared elapsed-timer pair, used by all three "something is
// currently running" branches in handleLiveData() below (brewing/steaming/
// flushing) instead of each inlining its own setInterval -- the three modes
// are mutually exclusive (one physical operation mode at a time), so one
// shared S.liveBrewStartWall/`liveTimerTick` timer pair is enough; no per-mode
// state needed.
function startElapsedTimer(startWall: number, elId: string): void {
  S.liveBrewStartWall = startWall;
  if (!timerRegistry.get('liveTimerTick')) {
    timerRegistry.set('liveTimerTick', setInterval(() => {
      if (S.liveBrewStartWall) {
        const s = (Date.now() - S.liveBrewStartWall) / 1000;
        document.getElementById(elId)!.textContent = formatTimeLabel(s);
      }
    }, 100));
  }
}

function stopElapsedTimer(elId: string | null, finalElapsedSec: number | null): void {
  timerRegistry.dispose('liveTimerTick');
  S.liveBrewStartWall = null;
  if (elId != null && finalElapsedSec != null) {
    document.getElementById(elId)!.textContent = formatTimeLabel(finalElapsedSec);
  }
}

// #736: SSE push handlers -- registered once in boot/data.ts
// (connectEvents()/onEvent()), independent of whichever view is currently
// open. Both payloads are already the identical shape their REST
// counterparts (GET /api/live/data, GET /api/preheat) return -- so these
// are thin passthroughs, not adapters. #2247: the stream also carries the
// machine this tab watches; a payload of another machine than the shown one
// is dropped here.
export function handleLiveSnapshotEvent(payload: LiveMessage): void {
  if (_payloadMachineKey(payload.machineId) !== _shownMachineKey()) return;
  handleLiveData(payload);
}

export function handlePreheatUpdateEvent(payload: PreheatData): void {
  if (_payloadMachineKey(payload.machineId) !== _shownMachineKey()) return;
  updatePreheatWidget(payload);
}

// #1541: one derivation of the machine's idle phase, shared by the idle title
// and the status badge so the two can never disagree. Standby wins (a GaggiMate
// in standby is off), then a display that reports a system state other than
// ready (#2139), then a preheat still counting down, else ready.
type IdlePhase = 'standby' | 'system' | 'warming' | 'ready';
function idlePhase(): IdlePhase {
  if (_lastPreheat?.standby) return 'standby';
  if (_lastLiveMsg?.machineSystemState) return 'system';
  if (_lastPreheat && !_lastPreheat.ready && _lastPreheat.remaining > 0) return 'warming';
  return 'ready';
}

// #2139: sets the status badge for an idle phase. A display that is not ready
// shows its own state, as a warning, or as an error for a controller error.
function setIdleBadge(phase: IdlePhase): void {
  if (phase !== 'system') {
    setLiveBadge(phase);
    return;
  }
  const systemState = _lastLiveMsg?.machineSystemState ?? '';
  setLiveBadge(systemState === 'error' ? 'system-error' : 'system-state',
    machineSystemStateLabel(systemState, _lastLiveMsg?.machineSystemErrorCode));
}

// #1613: the live-session transitions (reference-shot auto-apply at brew
// start, pre-shot draft apply after brew end, and the _liveSessionIsBrew /
// S.liveWasLive bookkeeping they depend on) used to live only in
// fetchLiveData's polling path, so with SSE (the default) they never ran.
// handleLiveData now runs them first, before rendering, for both paths.
function handleLiveTransitions(msg: LiveMessage): void {
  // A network blip routes through handleLiveData({ machineReachable: false }) with no isLive; without this guard it would clear S.liveWasLive and fire the brew-end draft apply.
  if (msg.machineReachable === false || msg.isLive === undefined) return;
  // #1120 review: record whether this live session is a brew, so the
  // draft-apply branch below only ever fires for a finished brew. A brew is
  // msg.isLive; steam/flush/descale sessions (msg.isSteaming/isFlushing/
  // isDescaling) are a different mode and must never seed the draft.
  const liveMode = msg.isLive ? 'brew'
    : (msg.isSteaming || msg.isFlushing || msg.isDescaling) ? 'other'
    : null;
  if (liveMode) _liveSessionIsBrew = liveMode === 'brew';
  // Brew just started → auto-select last same-profile shot as reference
  if (!S.liveWasLive && msg.isLive && msg.profileName) {
    autoApplyRefShot(msg.profileName);
  }
  // #2226: the next brew ends the previous shot's quick rating strip.
  if (!S.liveWasLive && msg.isLive && _quickRateShotId !== null) dismissLiveQuickRating();

  // Brew just ended → reload shot list after sync delay, then write the
  // pre-shot setup panel's draft (bean/dose/grinder/grind/basket/
  // puckscreen/recipe) onto the freshly-synced shot. Snapshotting via
  // _applyLiveSetupToShot's own read happens after loadData resolves, not
  // captured here, since a sticky draft is expected to still be current a
  // few seconds later — see that function's own doc comment.
  //
  // The target shot is picked by machine + id, not S.shots[length-1]:
  // machineId is captured now (S.activeMachineId can change during the
  // 4s wait in a multi-machine setup — the draft that's about to be
  // applied belongs to whichever machine was live when the brew ended,
  // not whichever machine happens to be selected when the timer fires),
  // and priorNewestId is the highest id already synced for that machine
  // before this brew — after loadData() reloads, the highest id above
  // that watermark is unambiguously "the shot this brew produced", never
  // an older shot the sync happened to reorder and never a steam/flush
  // session (those never create shots.Shot rows at all, so they can't
  // satisfy `id > priorNewestId` regardless of timing).
  // Explicit brew-only gate: `_liveSessionIsBrew !== false` is false after a
  // steam/flush/descale session, so its finish can never apply the draft
  // even if S.liveWasLive was somehow set.
  if (S.liveWasLive && !msg.isLive && _liveSessionIsBrew !== false && msg.seq !== S.liveLastSeq) {
    S.liveLastSeq = msg.seq!;
    // #2247: the shown machine's real id ('all' shows the default machine).
    const machineId = typeof S.activeMachineId === 'number' ? S.activeMachineId : getDefaultMachineId();
    const priorNewestId = S.shots.reduce((max, s) => (s.machineId === machineId && s.id > max ? s.id : max), 0);
    setTimeout(() => { void (async () => {
      if (window.loadData) await window.loadData();
      const newest = S.shots
        .filter(s => s.machineId === machineId && s.id > priorNewestId)
        .sort((a, b) => b.id - a.id)[0];
      if (newest) {
        void _applyLiveSetupToShot(newest.id);
        // #2226: offer the quick rating for the shot this brew produced,
        // unless the next brew already started during the sync wait.
        if (!S.liveWasLive) {
          _quickRateShotId = newest.id;
          renderLiveQuickRating();
        }
      }
    })(); }, 4000);
  }
  S.liveWasLive = msg.isLive;
}

export function handleLiveData(msg: LiveMessage): void {
  handleLiveTransitions(msg);
  const dp: LiveDatapoints = msg.datapoints || {};
  const times   = dp.timeInShot  || [];
  const lastIdx = times.length - 1;

  const metaEl      = document.getElementById('live-meta') as HTMLElement;
  const idleEl      = document.getElementById('live-idle') as HTMLElement;
  const idleTitleEl = document.getElementById('liveIdleTitle');
  const idleTextEl  = document.getElementById('liveIdleText');

  // #655: machineReachable === false is the authoritative "machine is off/
  // unreachable" signal (the 1s backend poll) and must win over
  // the isLive-based "ready" fallback below — otherwise a powered-off
  // machine renders identically to an idle-but-reachable one (state.liveAccum
  // is null in both cases) and the live tab keeps showing "Ready to brew"
  // indefinitely, which was the reported bug.
  // #2139: the system state of the previous live message, read before
  // syncMachineIcon replaces it, to notice when it changes.
  const prevSystemState = _lastLiveMsg?.machineSystemState ?? '';
  syncMachineIcon(msg);   // #811

  if (msg.machineReachable === false) {
    setLiveBadge('unreachable');
    metaEl.textContent = '–';
    _showRunning(false);
    idleEl.classList.add('unreachable');
    if (idleTitleEl) idleTitleEl.textContent = t('machine_unreachable_title');
    if (idleTextEl)  idleTextEl.textContent  = t('live_unreachable_text');
    // #902: the idle-stats row (temp/target/pressure/water-level) must be
    // cleared here too -- otherwise the last-known numbers stay visible
    // under the red "machine unreachable" message as if still live, same
    // stale-data trap #655 originally fixed for the rest of this panel.
    const idleTempEl       = document.getElementById('liveIdleTemp');
    const idleTargetTempEl = document.getElementById('liveIdleTargetTemp');
    const idlePressureEl   = document.getElementById('liveIdlePressure');
    const idleWaterEl      = document.getElementById('liveIdleWaterLevel');
    if (idleTempEl)       idleTempEl.textContent       = '–';
    if (idleTargetTempEl) idleTargetTempEl.textContent = '';
    if (idlePressureEl)   idlePressureEl.textContent   = '–';
    if (idleWaterEl)       idleWaterEl.textContent      = '–';
    // #1409: same stale-data reasoning -- a warning or update hint from the
    // last reachable poll must not stay under "machine unreachable".
    const idleWarnEl   = document.getElementById('liveIdleWarnings');
    const idleUpdateEl = document.getElementById('liveIdleUpdateHint');
    if (idleWarnEl)   idleWarnEl.style.display   = 'none';
    if (idleUpdateEl) idleUpdateEl.style.display = 'none';
    // #1498 follow-up: an unreachable machine shows no preheat state -- hide
    // the warm-up countdown a stale preheat payload may have left visible
    // (the element updatePreheatWidget toggles).
    const preheatWarmingEl = document.getElementById('preheat-warming-wrap');
    if (preheatWarmingEl) preheatWarmingEl.style.display = 'none';
    // #1324: machine control is unavailable while unreachable -- hide the flush
    // button and close the brew-confirmation dialog (the machine answered it,
    // or the answer is moot now).
    renderMachineControl(null);
    return;
  }
  idleEl.classList.remove('unreachable');
  renderMachineControl(msg.machineControl);
  // #2139: a display that is not ready hides the preheat badge and countdown
  // (updatePreheatWidget reads the state off the last live message). When the
  // state changes, re-apply the last preheat payload so they hide at once and
  // come back as soon as the display is ready again.
  if ((msg.machineSystemState ?? '') !== prevSystemState && _lastPreheat) updatePreheatWidget(_lastPreheat);
  // #811: "machine_ready" means REACHABLE, but it reads as "ready to brew" —
  // and while preheating it sat directly under a widget counting down "heating
  // ... 20 min", flatly contradicting it. The animated icon made that obvious
  // by showing the heating state right between the two. Reuses the existing
  // preheat_warming key rather than adding a seventh translation of the same
  // idea.
  // machineReachable == null means "never polled yet" (startup) — show
  // connecting rather than "Maschine bereit" which implies confirmed reachability.
  // #1541: title and idle badge share idlePhase() so they cannot disagree.
  const phase       = idlePhase();
  const neverPolled = msg.machineReachable == null;
  // #1498: a standby GaggiMate is off — say so instead of "warming"/"ready".
  // #2139: a display that is not ready names its own state, after standby.
  if (idleTitleEl) idleTitleEl.textContent = phase === 'standby' ? t('machine_standby')
    : phase === 'system' ? machineSystemStateLabel(msg.machineSystemState ?? '', msg.machineSystemErrorCode)
    : neverPolled ? t('live_connecting') : phase === 'warming' ? t('preheat_warming') : t('machine_ready');
  if (idleTextEl)  idleTextEl.textContent  = t('live_idle_text');

  // #902: idle stats row -- always kept current (not gated behind the true-
  // idle branch below), same reasoning as syncMachineIcon(msg) above, so the
  // numbers are already fresh the moment the idle panel becomes visible.
  const idleTempEl       = document.getElementById('liveIdleTemp');
  const idleTargetTempEl = document.getElementById('liveIdleTargetTemp');
  const idlePressureEl   = document.getElementById('liveIdlePressure');
  const idleWaterEl      = document.getElementById('liveIdleWaterLevel');
  if (idleTempEl)       idleTempEl.textContent       = msg.temperature       != null ? `${msg.temperature.toFixed(1)}°`         : '–';
  if (idleTargetTempEl) idleTargetTempEl.textContent = msg.targetTemperature != null ? ` / ${msg.targetTemperature.toFixed(0)}°` : '';
  if (idlePressureEl)   idlePressureEl.textContent   = msg.pressure          != null ? `${msg.pressure.toFixed(1)} bar`          : '–';
  if (idleWaterEl)       idleWaterEl.textContent      = msg.waterLevel        != null ? `${msg.waterLevel}%`                     : '–';

  {
    const waterStat = document.getElementById('liveIdleWaterStat');
    if (waterStat) waterStat.style.display = msg.waterLevel != null ? '' : 'none';
  }

  // #1409: the machine's own active warnings (already-translated keys) and a
  // hint that its firmware has an update. Both live behind the idle panel and
  // are hidden when the machine has nothing to report.
  {
    const warningsEl = document.getElementById('liveIdleWarnings');
    const updateEl   = document.getElementById('liveIdleUpdateHint');
    const warnings   = msg.machineWarnings || [];
    if (warningsEl) {
      warningsEl.textContent = warnings.map(machineWarningLabel).join(' · ');
      warningsEl.style.display = warnings.length > 0 ? '' : 'none';
    }
    if (updateEl) updateEl.style.display = msg.machineUpdateAvailable ? '' : 'none';
  }

  // #902/#983: steam/flush/descale live sessions -- same live-content
  // readout the brew branch below uses (duration/pressure/temperature),
  // sourced from steamDatapoints/flushDatapoints/descaleDatapoints instead
  // of the brew shot's datapoints. No flow/weight equivalent for any mode
  // (none moves the scale), so those two tiles stay blank. Checked ahead of
  // the pure-idle fallback below since each of these is itself a non-idle
  // state.
  if (msg.isSteaming || msg.isFlushing || msg.isDescaling) {
    const badgeState  = msg.isSteaming ? 'steaming' : msg.isFlushing ? 'flushing' : 'descaling';
    const modeDp: LiveModeDatapoints = msg.isSteaming ? (msg.steamDatapoints || {})
      : msg.isFlushing  ? (msg.flushDatapoints || {})
      : (msg.descaleDatapoints || {});
    const modeTimes    = modeDp.timeInMode || [];
    const modeLastIdx  = modeTimes.length - 1;

    setLiveBadge(badgeState);
    metaEl.textContent       = t(`live_${badgeState}`);
    _showRunning(true);
    _syncPhaseBar(null);

    if (modeLastIdx >= 0) {
      const elapsed = (modeTimes[modeLastIdx] ?? 0) / 10;
      const modePressure = modeDp.pressure?.[modeLastIdx];
      const modeTemp     = modeDp.temperature?.[modeLastIdx];
      const pressure = modePressure != null ? modePressure / 10 : null;
      const temp     = modeTemp     != null ? modeTemp / 10     : null;

      startElapsedTimer(Date.now() - elapsed * 1000, 'liveTime');

      document.getElementById('livePressure')!.textContent = pressure != null ? pressure.toFixed(1) : '–';
      document.getElementById('liveFlow')!.textContent     = '–';
      document.getElementById('liveWeight')!.textContent   = '–';
      document.getElementById('liveTemp')!.textContent     = temp != null ? temp.toFixed(1) : '–';
    }
    return;
  }

  if (!msg.isLive && times.length === 0) {
    // #1541: the badge follows the same standby/warming/ready phase as the
    // idle title above instead of always saying "Ready".
    setIdleBadge(phase);
    metaEl.textContent = '–';
    _showRunning(false);
    return;
  }

  _showRunning(true);

  if (msg.isLive) {
    setLiveBadge('brewing');
    metaEl.textContent = msg.profileName || '–';
  } else {
    setLiveBadge('idle');
    metaEl.textContent = t('live_profile_finished', msg.profileName || '–');
  }

  if (lastIdx >= 0) {
    const elapsed = (times[lastIdx] ?? 0) / 10;
    const rawPressure = dp.pressure?.[lastIdx];
    const rawFlow     = dp.pumpFlow?.[lastIdx];
    const weightSrc   = dp.shotWeight || dp.weight;
    const rawWeight   = weightSrc?.[lastIdx];
    const rawTemp     = dp.temperature?.[lastIdx];
    const pressure = rawPressure != null ? rawPressure / 10 : null;
    const flow     = rawFlow     != null ? rawFlow / 10     : null;
    const weight   = rawWeight   != null ? rawWeight / 10   : null;
    const temp     = rawTemp     != null ? rawTemp / 10     : null;

    if (msg.isLive) {
      // #811: the icon's on-device readout mirrors the real shot.
      const iconEl = document.getElementById('liveMachineIcon');
      if (iconEl) updateMachineIconBrewReadout(iconEl, {
        weightG: weight ?? 0, elapsedSec: elapsed ?? 0, pressureBar: pressure,
      });
      // Re-sync wall clock so timer stays accurate
      startElapsedTimer(Date.now() - elapsed * 1000, 'liveTime');
    } else {
      stopElapsedTimer('liveTime', elapsed);
    }

    // #2153: the phase bar follows the elapsed time and repaints only when
    // the phase changes.
    _syncPhaseBar(elapsed);

    document.getElementById('livePressure')!.textContent = pressure != null ? pressure.toFixed(1) : '–';
    document.getElementById('liveFlow')!.textContent     = flow     != null ? flow.toFixed(1)     : '–';
    document.getElementById('liveWeight')!.textContent   = weight   != null ? weight.toFixed(1)   : '–';
    document.getElementById('liveTemp')!.textContent     = temp     != null ? temp.toFixed(1)     : '–';
  }

  const liveChart = chartRegistry.get('liveChart') as Chart<'line'> | null;
  if (liveChart) {
    const maxTime = times.length > 0 ? (times[times.length - 1] ?? 0) / 10 : 60;
    const datasets = liveChart.data.datasets;
    const ds0 = datasets[0], ds1 = datasets[1], ds2 = datasets[2], ds3 = datasets[3];
    if (ds0) ds0.data = mapToXY(times, dp.pressure);
    if (ds1) ds1.data = mapToXY(times, dp.pumpFlow);
    if (ds2) ds2.data = mapToXY(times, dp.shotWeight || dp.weight);
    if (ds3) ds3.data = mapToXY(times, dp.temperature);
    const scales = liveChart.options.scales;
    if (scales) {
      scales.x!.max  = Math.max(maxTime + 5, 30);

      const maxTemp = dp.temperature?.length
        ? dp.temperature.reduce((m, v) => v > m ? v : m, 0) / 10 : 0;
      scales.y1!.max = Math.ceil(maxTemp + 5) || 100;
    }

    liveChart.update('none');
  }
}
