import { S } from '../state/index.js';
import { t, tHtml } from '../i18n.js';
import {
  getMaintenance, markMaintenanceDone, saveMaintenanceThreshold,
  getMaintenanceLog, addMaintenanceLogEntry, deleteMaintenanceLogEntry,
  addCustomMaintenanceTask, deleteCustomMaintenanceTask,
} from '../api/maintenance.js';
import { MAINT_META, GUIDED_MAINT_STEPS, localeFor } from '../constants.js';
import { esc, html, joinHtml, todayIsoDate } from '../utils.js';
import type { Html } from '../utils.js';
import { getDefaultMachineId } from '../components/machines-settings.js';
import { ICON_TRASH } from '../icons.js';
import { closeDetailSheet, requestCloseDetailSheet } from '../components/detail-sheet.js';
// Circular with maintenance-sheet.ts (it reads this module's helpers): only
// ever touched at call time, never at module load — same as
// library/bean-form-sheet.ts.
import { openMaintTaskSheet } from './maintenance-sheet.js';

// One task's status block as GET /api/maintenance serves it (flat for a
// single machine, nested under machines[]/global for the fleet view).
export interface MaintTaskData {
  status: string;
  pct: number;
  daysSince?: number | null;
  shotsSince: number;
  threshold_shots?: number | null;
  threshold_days?: number | null;
  threshold_g?: number | null;
  gramsSince?: number | null;
  machineSyncedAt?: string | number | null;
  lastDate?: string | null;
  grinderName?: string | null;
  disabled?: boolean;
  label?: string | null;
}

interface MaintMachineGroup {
  machineId: number;
  machineName: string | null;
  tasks?: Record<string, MaintTaskData | null | undefined>;
}

// Either response shape (#392's grouped one, or the single-machine flat map).
interface MaintResponse {
  machines?: MaintMachineGroup[];
  global?: Record<string, MaintTaskData | null | undefined>;
  [task: string]: unknown;
}

export interface MaintTile {
  task: string;
  d: MaintTaskData;
  machineId: string | number;
  machineName: string | null;
  isGlobal: boolean;
  showMachineTag: boolean;
}

// The subset of fields taskTitle resolves a display name from — shared by
// live tiles (MaintTaskData) and log entries (MaintLogEntry).
interface MaintTaskNames {
  grinderName?: string | null;
  label?: string | null;
}

export interface MaintLogEntry {
  id: number;
  task: string;
  ts: number;
  machineId?: number | null;
  machine?: string | null;
  grinderName?: string | null;
  label?: string | null;
  shotCountAtTime?: number | null;
  notes?: string | null;
}

type MaintScope = string | number;

// Marker the backend writes into a log entry's notes for entries taken over
// from the machine's service log; the log renders it as a translated badge.
export const AUTO_SYNCED_NOTE = 'Auto-synced from machine';

// ── Task icons (#393) — plain inline SVG line icons, no emoji, matching the
// Dashboard mockup the maintainer picked. Purely decorative; task identity always comes
// from MAINT_META's translation key (or the grinder's own name), never the
// icon alone, so a missing/unmapped icon never loses information.
const TASK_ICON_PATHS: Record<string, Html> = {
  descaling:   html`<path d="M3 6h8v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6zM11 7h1.5a1.5 1.5 0 0 1 0 3H11M5 3.5v1M8 3.5v1"/>`,
  backflush:   html`<path d="M8 2v6M4.5 5.5 8 8l3.5-2.5M3 11h10M4 11v2h8v-2"/>`,
  grouphead:   html`<circle cx="8" cy="8" r="5"/><path d="M8 5.5v.01M6.2 8h.01M9.8 8h.01M8 10.5v.01"/>`,
  gaskets:     html`<circle cx="8" cy="8" r="5"/><circle cx="8" cy="8" r="2"/>`,
  waterfilter: html`<path d="M8 2.5S4 7 4 9.8a4 4 0 0 0 8 0C12 7 8 2.5 8 2.5z"/>`,
  grinder:     html`<circle cx="8" cy="8" r="2"/><path d="M8 2v2.5M8 11.5V14M2 8h2.5M11.5 8H14M4 4l1.8 1.8M10.2 10.2 12 12M12 4l-1.8 1.8M5.8 10.2 4 12"/>`,
  custom:      html`<path d="M10.5 2.5a2 2 0 0 1 2.83 2.83l-7 7L3 13l.67-3.33 7-7z"/>`,
};
function taskIconSvg(task: string): Html {
  const key = task.startsWith('grinder_') ? 'grinder' : task.startsWith('custom_') ? 'custom' : task;
  const path = TASK_ICON_PATHS[key] ?? html``;
  return html`<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5">${path}</svg>`;
}

// waterfilter and grinder_* tasks are shared equipment, never split per
// machine.
function isGlobalTask(task: string): boolean {
  return task === 'waterfilter' || task.startsWith('grinder_');
}

export function taskTitle(task: string, d: MaintTaskNames): string {
  if (task.startsWith('grinder_')) return d.grinderName || task;
  if (task.startsWith('custom_')) return d.label || task.replace(/^custom_/, '').replace(/_/g, ' ');
  return t(MAINT_META[task]?.key || task);
}

export function maintStatusLabel(status: string): string {
  const labels: Record<string, string> =
    { ok: t('maint_ok'), soon: t('maint_soon'), due: t('maint_due'), never: t('maint_never') };
  return labels[status] || '';
}

// ── Local view scope (#393) ────────────────────────────────────────────────
// Independent of the global machine switcher (S.activeMachineId) — this view
// gets its own filter so browsing "all machines" here never changes what the
// rest of the app shows. Defaults to 'all' so the dashboard opens on the
// full-fleet overview; the segment control (and this scope) only matters
// once >1 machine is registered — single-machine installs always resolve to
// the (only) active machine.
let _maintScope: MaintScope = 'all';

// Last-rendered active (non-disabled) tiles, keyed for openMaintLogForm's
// task dropdown — the ONLY correct source for "which tasks exist right
// now with what display name", since it's built by the exact same
// _normalizeMaintTiles/_partitionTiles/taskTitle path the dashboard cards
// themselves render from (previously the log form independently listed
// MAINT_META's 5 static keys only, silently dropping every custom_/
// grinder_ task and never respecting a task's disabled state).
let _lastActiveTiles: MaintTile[] = [];

// Last log entries the log render received — openMaintTask's history source.
let _lastLogEntries: MaintLogEntry[] = [];

function _effectiveScope(): MaintScope {
  if ((S.machines || []).length <= 1) return S.activeMachineId === 'all' ? 1 : (S.activeMachineId ?? 1);
  return _maintScope;
}

export function setMaintScope(scope: string): void {
  _maintScope = scope === 'all' ? 'all' : parseInt(scope, 10);
  void loadMaintenanceView();
}

// Write routes (done/threshold) always need one concrete machine — 'all'
// scope has no single target, so it falls back to the default machine (#1605:
// the manual log entry made in the all-machines view must land on the default
// machine, not merely the first registered one, which can differ when the
// machine list is ordered differently). Global tasks are unaffected: the
// backend always redirects waterfilter/grinder_* writes to the shared sentinel
// machine regardless of which machineId is passed.
function _writeMachineId(explicit?: string | number | null): string | number {
  if (explicit !== undefined && explicit !== null && explicit !== '') return explicit;
  const scope = _effectiveScope();
  return scope === 'all' ? (getDefaultMachineId() ?? S.machines?.[0]?.id ?? 1) : scope;
}

// ── Data normalization ──────────────────────────────────────────────────────
// Flattens either API response shape (single-machine flat object, or #392's
// { all, machines[], global } grouped shape) into one uniform tile list, so
// the rest of this module never has to branch on scope. Each tile carries
// the concrete machineId its own actions must target — never S.activeMachineId
// or _maintScope directly, since those can be 'all'.
export function _normalizeMaintTiles(data: MaintResponse | null | undefined, scope: MaintScope): MaintTile[] {
  const tiles: MaintTile[] = [];
  if (scope === 'all') {
    for (const m of data?.machines || []) {
      for (const [task, d] of Object.entries(m.tasks || {})) {
        if (!d) continue;
        tiles.push({ task, d, machineId: m.machineId, machineName: m.machineName, isGlobal: false, showMachineTag: true });
      }
    }
    const writeMachineId = data?.machines?.[0]?.machineId ?? 1;
    for (const [task, d] of Object.entries(data?.global || {})) {
      if (!d) continue;
      tiles.push({ task, d, machineId: writeMachineId, machineName: null, isGlobal: true, showMachineTag: true });
    }
  } else {
    for (const [task, d] of Object.entries(data || {})) {
      if (!d || typeof d !== 'object') continue;
      tiles.push({ task, d: d as MaintTaskData, machineId: scope, machineName: null, isGlobal: isGlobalTask(task), showMachineTag: false });
    }
  }
  return tiles;
}

// Split tiles into active and disabled groups.
export function _partitionTiles(tiles: MaintTile[]): { active: MaintTile[]; disabled: MaintTile[] } {
  const active: MaintTile[] = [], disabled: MaintTile[] = [];
  for (const tile of tiles) {
    (tile.d.disabled ? disabled : active).push(tile);
  }
  return { active, disabled };
}

// How overdue a tile is, in whichever unit its threshold uses — used only to
// rank tiles for the verdict, never shown to the user directly.
function _urgency(d: MaintTaskData): number {
  if (d.status !== 'due' && d.status !== 'never') return -Infinity;
  let overage = 0;
  if (d.threshold_shots) overage = Math.max(overage, d.shotsSince - d.threshold_shots);
  if (d.threshold_days && d.daysSince != null) overage = Math.max(overage, d.daysSince - d.threshold_days);
  if (d.status === 'never') overage = Math.max(overage, d.shotsSince || 0);
  return overage;
}

export function _pickNextDueTile(tiles: MaintTile[]): MaintTile | null {
  let best: MaintTile | null = null, bestScore = -Infinity;
  for (const tile of tiles) {
    const score = _urgency(tile.d);
    if (score > bestScore) { bestScore = score; best = tile; }
  }
  return bestScore > -Infinity ? best : null;
}

// The page's verdict (#1923): what needs attention, in one line plus the
// count of tasks that are due. 'never' counts as due, matching the badge.
export interface MaintVerdictState {
  kind: 'due' | 'soon' | 'ok' | 'empty';
  tile: MaintTile | null;
  dueCount: number;
}

export function _maintVerdictState(active: MaintTile[]): MaintVerdictState {
  let dueCount = 0;
  let soon: MaintTile | null = null;
  let highest: MaintTile | null = null;
  for (const tile of active) {
    if (tile.d.status === 'due' || tile.d.status === 'never') dueCount++;
    else if (tile.d.status === 'soon' && (!soon || tile.d.pct > soon.d.pct)) soon = tile;
    if (!highest || tile.d.pct > highest.d.pct) highest = tile;
  }
  if (dueCount > 0) return { kind: 'due', tile: _pickNextDueTile(active), dueCount };
  if (soon) return { kind: 'soon', tile: soon, dueCount };
  if (active.length > 0) return { kind: 'ok', tile: highest, dueCount };
  return { kind: 'empty', tile: null, dueCount };
}

// ── Rendering ───────────────────────────────────────────────────────────────

export async function loadMaintenanceView(): Promise<void> {
  const container = document.getElementById('maint-cards') as HTMLElement;
  container.innerHTML = html`<div class="loading-state">${tHtml('loading')}</div>`;
  try {
    const scope = _effectiveScope();
    const r = await getMaintenance(scope);
    const data = await r.json() as MaintResponse;
    renderMaintenanceDashboard(data, scope);
  } catch {
    container.innerHTML = html`<div class="loading-state" style="color:var(--err)">${tHtml('error_load')}</div>`;
  }
  void loadMaintLog();
}

export function renderMaintenanceDashboard(data: MaintResponse, scope: MaintScope): void {
  const container = document.getElementById('maint-cards') as HTMLElement;
  const allTiles   = _normalizeMaintTiles(data, scope);
  const { active, disabled } = _partitionTiles(allTiles);
  _lastActiveTiles = active;
  const verdict     = _maintVerdictState(active);
  const hasMachines = (S.machines || []).length > 1;

  container.innerHTML = html`
    ${_maintVerdictHtml(verdict)}
    <section class="analytics-sec maint-tasks-sec">
      <div class="analytics-card-head">
        <h3 class="analytics-section-title">${esc(t('maint_log_col_task'))}</h3>
        <span class="analytics-shelf-count">${esc(active.length)}</span>
      </div>
      <div class="maint-rows" id="maintGrid"></div>
      <div class="maint-custom-section" id="maintCustomSection"></div>
      <div class="maint-disabled-section" id="maintDisabledSection" style="display:none"></div>
    </section>
  `;

  const seg = document.getElementById('maintScopeSeg');
  if (seg) {
    // codeql[js/xss-through-dom] false positive: esc()/escapeHtml() already applied, see #760
    seg.innerHTML = joinHtml([
      html`<button type="button" class="${esc(scope === 'all' ? 'analytics-filter-btn active' : 'analytics-filter-btn')}" data-action="set-maint-scope" data-scope="all" aria-pressed="${esc(scope === 'all' ? 'true' : 'false')}">${tHtml('machine_switcher_all')}</button>`,
      ...S.machines.map(m => {
        const on = scope === m.id;
        return html`<button type="button" class="${esc(on ? 'analytics-filter-btn active' : 'analytics-filter-btn')}" data-action="set-maint-scope" data-scope="${esc(m.id)}" aria-pressed="${esc(on ? 'true' : 'false')}">${esc(m.name as string)}</button>`;
      }),
    ]);
    seg.hidden = !hasMachines;
  }
  const hint = document.getElementById('maintScopeHint');
  if (hint) hint.hidden = !(hasMachines && active.some(x => x.isGlobal));

  const grid = document.getElementById('maintGrid') as HTMLElement;
  grid.innerHTML = joinHtml(active.map(_maintRowHtml));

  _renderCustomSection(document.getElementById('maintCustomSection'), scope);

  const disabledSec = document.getElementById('maintDisabledSection');
  if (disabledSec && disabled.length > 0) {
    disabledSec.style.display = '';
    _renderDisabledSection(disabledSec, disabled);
  }

  const badge = document.getElementById('maintBadge');
  if (badge) badge.style.display = verdict.dueCount > 0 ? 'inline-block' : 'none';
}

function _renderCustomSection(container: HTMLElement | null, scope: MaintScope): void {
  if (!container) return;
  const writeMid = _writeMachineId(scope === 'all' ? undefined : scope);
  // codeql[js/xss-through-dom] false positive: esc() applied
  container.innerHTML = html`
    <details class="maint-custom-add">
      <summary>${esc(t('maint_custom_add_summary'))}</summary>
      <div class="maint-custom-form">
        <input type="text" aria-label="${esc(t('maint_custom_label_ph'))}" id="customTaskLabel" placeholder="${esc(t('maint_custom_label_ph'))}" maxlength="100">
        <div class="maint-custom-thresholds">
          <label>${esc(t('maint_custom_every'))} <input type="number" id="customTaskShots" min="1" max="10000" placeholder="–"> ${esc(t('maint_unit_shots'))}</label>
          <label>${esc(t('maint_custom_every'))} <input type="number" id="customTaskDays" min="1" max="3650" placeholder="–"> ${esc(t('maint_by_days'))}</label>
        </div>
        <button data-action="add-custom-maint-task" data-machine-id="${esc(writeMid)}">${esc(t('maint_custom_add'))}</button>
      </div>
    </details>
  `;
}

function _renderDisabledSection(container: HTMLElement, tiles: MaintTile[]): void {
  const rows = joinHtml(tiles.map(tile => {
    const title = taskTitle(tile.task, tile.d);
    return html`<div class="maint-disabled-row">
      <span class="maint-row-icon">${taskIconSvg(tile.task)}</span>
      <span class="maint-disabled-title">${esc(title)}</span>
      <button class="maint-reenable-btn" data-action="toggle-maint-disabled" data-task="${esc(tile.task)}" data-machine-id="${esc(tile.machineId)}" data-disabled="false">${tHtml('maint_enable_btn')}</button>
    </div>`;
  }));
  // codeql[js/xss-through-dom] false positive: esc() applied
  container.innerHTML = html`<details class="analytics-more maint-disabled"><summary class="analytics-more-summary">${tHtml('maint_disabled_section', tiles.length)}</summary><div class="maint-rows">${rows}</div></details>`;
}

function _maintDueDetail(d: MaintTaskData): string {
  if (d.status === 'never') return t('maint_never_done');
  if (d.threshold_shots && d.shotsSince > d.threshold_shots) return t('maint_next_shots_over', d.shotsSince - d.threshold_shots);
  if (d.threshold_days && (d.daysSince as number) > d.threshold_days) return t('maint_next_days_over', (d.daysSince as number) - d.threshold_days);
  return t('maint_next_due');
}

// #1923: the page's one emphasised block — one sentence plus the number of
// tasks that are due. The title for 'ok' and the section heading on the tasks
// section are deliberate interims that plan-1923e replaces with new keys.
export function _maintVerdictHtml(state: MaintVerdictState): Html {
  const tile = state.tile;
  const machinePart = tile && !tile.isGlobal && tile.machineName ? ` · ${tile.machineName}` : '';
  const taskName = tile ? taskTitle(tile.task, tile.d) : '';

  let title: string;
  let sub = '';
  if (state.kind === 'due' || state.kind === 'soon') {
    title = `${t('maint_next_label')} ${taskName}`;
    sub = (state.kind === 'due' && tile ? _maintDueDetail(tile.d) : t('maint_soon')) + machinePart;
  } else {
    title = t('maint_ok');
    if (state.kind === 'ok') sub = `${t('maint_next_label')} ${taskName}`;
  }

  const doneBtn = state.kind === 'due' && tile
    ? html`<button type="button" class="maint-banner-btn" data-action="mark-maint-done" data-task="${esc(tile.task)}" data-machine-id="${esc(tile.machineId)}">${tHtml('maint_next_action')}</button>`
    : html``;
  const numClass = state.dueCount > 0 ? 'due' : 'ok';

  // codeql[js/xss-through-dom] false positive: esc()/escapeHtml() already applied, see #760
  return html`
    <section class="analytics-sec analytics-verdict-card maint-verdict" id="maintVerdict">
      <div class="analytics-verdict-head">
        <div class="analytics-verdict-text">
          <h2 class="analytics-verdict-title serif-display">${esc(title)}</h2>
          ${sub ? html`<p class="analytics-verdict-sub">${esc(sub)}</p>` : html``}
        </div>
        <div class="analytics-verdict-score">
          <span class="analytics-verdict-score-num maint-verdict-num ${esc(numClass)}">${esc(state.dueCount)}</span>
          <span class="analytics-verdict-score-lbl">${esc(t('maint_due'))}</span>
        </div>
      </div>
      ${doneBtn}
    </section>
  `;
}

// True only when a task's last done date IS the machine's own service-log
// timestamp — i.e. a machine-recorded backflush/descale (ApplyMachineServiceLog)
// moved it. machineSyncedAt alone can't decide this: it is advanced even when a
// newer manual "done" wins (lastDate unchanged), and a later manual "done"
// leaves a stale machineSyncedAt in place — so keying the badge off it alone
// would label a manually completed task "Auto".
export function isAutoSynced(d: MaintTaskData): boolean {
  if (d.machineSyncedAt == null || d.lastDate == null) return false;
  const syncedMs = typeof d.machineSyncedAt === 'number' ? d.machineSyncedAt : Date.parse(d.machineSyncedAt);
  const lastMs = Date.parse(d.lastDate);
  return Number.isFinite(syncedMs) && Number.isFinite(lastMs) && syncedMs === lastMs;
}

// The card's meta count and the sheet's subtitle share this text, so both
// always describe the interval the same way (including the 'never' case).
export function _maintCountText(task: string, d: MaintTaskData): string {
  const hasShots = d.threshold_shots != null;
  const hasDays  = d.threshold_days != null;
  const hasG     = task.startsWith('grinder_') && d.threshold_g != null;
  if (d.status === 'never') return t('maint_never_done');
  if (hasShots && hasDays) {
    return `${d.shotsSince}/${d.threshold_shots} ${t('maint_by_shots')} · ${d.daysSince ?? '?'}/${d.threshold_days} ${t('maint_by_days')}`;
  }
  if (hasShots) return `${d.shotsSince} / ${d.threshold_shots} ${t('maint_by_shots')}`;
  if (hasDays) return `${d.daysSince ?? '?'} / ${d.threshold_days} ${t('maint_by_days')}`;
  if (hasG) return `${d.gramsSince ?? 0}g / ${d.threshold_g}g`;
  return t('maint_never_done');
}

// Opens one task's details in the shared popover / bottom sheet (#1923).
// Matched by task and machine so the all-machines scope opens the tile the
// user clicked, not the first tile with that task.
export function openMaintTask(task: string, machineId: string, anchor: HTMLElement | null): void {
  const tile = _lastActiveTiles.find(t => t.task === task && String(t.machineId) === machineId);
  if (!tile) return;
  openMaintTaskSheet(tile, _lastLogEntries, anchor);
}

// After a write the dashboard re-renders; an open task sheet would keep
// showing the state from before the write, so it is closed first.
function _closeOpenTaskSheet(): void {
  if (document.querySelector('#detailSheet .maint-sheet[data-task]')) requestCloseDetailSheet();
}

// #1923: one task as a full-width row — the row itself is the button that
// opens the task sheet, so there is no separate "Details" affordance.
export function _maintRowHtml(tile: MaintTile): Html {
  const { task, d, machineName, machineId, isGlobal, showMachineTag } = tile;
  const title = taskTitle(task, d);

  const machineTagText = isGlobal ? t('maint_shared_tag') : (showMachineTag ? machineName : null);
  const countText = _maintCountText(task, d);
  const pct = Math.round(d.pct * 100);

  // codeql[js/xss-through-dom] false positive: esc()/escapeHtml() already applied, see #760
  return html`<button type="button" class="maint-row status-${esc(d.status)}" data-action="open-maint-task" data-task="${esc(task)}" data-machine-id="${esc(machineId)}" aria-haspopup="dialog" title="${esc(t('maint_tile_details'))}">
    <span class="maint-row-icon">${taskIconSvg(task)}</span>
    <span class="maint-row-title">${esc(title)}</span>
    <span class="maint-chip ${esc(d.status)}">${esc(maintStatusLabel(d.status))}</span>
    <span class="maint-row-meta">
      ${machineTagText ? html`<span class="shot-machine-badge">${esc(machineTagText)}</span>` : html``}
      <span class="num">${esc(countText)}</span>
      ${isAutoSynced(d) ? html`<span class="maint-auto-synced" title="${tHtml('maint_auto_synced_hint')}">${tHtml('maint_auto_synced')}</span>` : html``}
    </span>
    <span class="maint-row-bar" aria-hidden="true"><span class="maint-row-fill ${esc(d.status)}" style="width:${esc(pct)}%"></span></span>
  </button>`;
}

// ── Guided walkthrough ────────────────────────────────────────────────────

let _guidedTask: string | null = null;
let _guidedMachineId: string | number | null = null;

export function openGuidedMaint(task: string, machineId: string | number): void {
  const steps = GUIDED_MAINT_STEPS[task];
  const modal = document.getElementById('guidedMaintModal');
  if (!steps || !modal) return;
  // The detail sheet traps keyboard focus, so an open task sheet would keep
  // the checklist unreachable underneath it.
  _closeOpenTaskSheet();
  _guidedTask = task;
  _guidedMachineId = machineId;
  (document.getElementById('guidedMaintTitle') as HTMLElement).textContent = t(MAINT_META[task]?.key || task);
  (document.getElementById('guidedMaintSteps') as HTMLElement).innerHTML = joinHtml(steps.map((key, i) => html`
    <label class="guided-maint-step">
      <input type="checkbox" class="guided-maint-check">
      <span class="guided-maint-step-num">${esc(i + 1)}</span>
      <span>${tHtml(key)}</span>
    </label>`));
  const doneBtn = document.getElementById('guidedMaintDoneBtn') as HTMLButtonElement;
  doneBtn.textContent = t('maint_done_btn');
  doneBtn.disabled = true;
  modal.style.display = 'flex';
}

export function updateGuidedMaintDoneState(): void {
  const boxes = [...document.querySelectorAll<HTMLInputElement>('#guidedMaintSteps .guided-maint-check')];
  const btn   = document.getElementById('guidedMaintDoneBtn') as HTMLButtonElement | null;
  if (btn) btn.disabled = !boxes.length || !boxes.every(b => b.checked);
}

export function closeGuidedMaint(): void {
  _guidedTask = null;
  _guidedMachineId = null;
  const modal = document.getElementById('guidedMaintModal');
  if (modal) modal.style.display = 'none';
}

export async function submitGuidedMaint(): Promise<void> {
  if (!_guidedTask) return;
  await markMaintDone(_guidedTask, _guidedMachineId);
  closeGuidedMaint();
}

// ── Write actions ───────────────────────────────────────────────────────────
// Each accepts an explicit machineId (the tile/button's own concrete target —
// #393) so acting on one tile while viewing 'all' scope, or a different
// machine's tile, never silently writes to the wrong machine. Falls back to
// _writeMachineId()'s resolution only when the caller omits it.

export async function markMaintDone(task: string, machineId?: string | number | null): Promise<void> {
  try {
    const r = await markMaintenanceDone(task, _writeMachineId(machineId));
    if (!r.ok) { window.showToast?.(t('error_generic', r.status)); return; }
    _closeOpenTaskSheet();
    await loadMaintenanceView();
  } catch { /* ignore */ }
}

export async function saveMaintThreshold(task: string, field: string, value: string, machineId?: string | number | null): Promise<void> {
  // empty string → null (clears the threshold)
  const parsed = value === '' || value == null ? null : parseInt(value, 10);
  try {
    const r = await saveMaintenanceThreshold(task, _writeMachineId(machineId), { [field]: parsed });
    if (!r.ok) window.showToast?.(t('error_generic', r.status));
  } catch { /* ignore */ }
}

// Reload the maintenance view while keeping an open task sheet open. Every
// local write goes through here (the live refetch is held back by
// _maintenanceCanRefetch instead): the tile and its card re-render with the
// new state, and the sheet is repainted from them in place, anchored to the
// card's button again. The task is keyed by task+machine because the
// all-machines scope renders one tile per machine.
export async function refreshMaintenanceView(): Promise<void> {
  const open = document.querySelector<HTMLElement>('#detailSheet .maint-sheet[data-task]')?.dataset;
  const task = open?.task;
  const machineId = open?.machineId;
  await loadMaintenanceView();
  if (task == null || machineId == null) return;
  const tile = _lastActiveTiles.find(t => t.task === task && String(t.machineId) === machineId);
  if (!tile) { closeDetailSheet(); return; }
  const anchor = document.querySelector<HTMLElement>(
    `[data-action="open-maint-task"][data-task="${CSS.escape(task)}"][data-machine-id="${CSS.escape(machineId)}"]`);
  openMaintTaskSheet(tile, _lastLogEntries, anchor);
}

export async function setMaintMode(
  task: string,
  mode: string,
  machineId?: string | number | null,
  currentShots?: string,
  currentDays?: string,
  currentG?: string,
): Promise<void> {
  const defShots = parseInt(currentShots ?? '', 10) || 200;
  const defDays  = parseInt(currentDays  ?? '', 10) || 30;
  const defG     = parseInt(currentG     ?? '', 10) || 10000;
  const body = mode === 'shots' ? { threshold_shots: defShots, threshold_days: null, threshold_g: null }
             : mode === 'days'  ? { threshold_shots: null,     threshold_days: defDays, threshold_g: null }
             : mode === 'g'     ? { threshold_shots: null,     threshold_days: null, threshold_g: defG }
             :                    { threshold_shots: defShots, threshold_days: defDays, threshold_g: null };
  try {
    const r = await saveMaintenanceThreshold(task, _writeMachineId(machineId), body);
    if (!r.ok) { window.showToast?.(t('error_generic', r.status)); return; }
    await refreshMaintenanceView();
  } catch { /* ignore */ }
}

export async function toggleMaintDisabled(task: string, machineId?: string | number | null, disabled?: boolean): Promise<void> {
  try {
    const r = await saveMaintenanceThreshold(task, _writeMachineId(machineId), { disabled });
    if (!r.ok) { window.showToast?.(t('error_generic', r.status)); return; }
    _closeOpenTaskSheet();
    await loadMaintenanceView();
  } catch { /* ignore */ }
}

export async function addCustomMaintTask(machineId?: string | number | null): Promise<void> {
  const label = (document.getElementById('customTaskLabel') as HTMLInputElement | null)?.value.trim();
  if (!label) return;
  const shots = (document.getElementById('customTaskShots') as HTMLInputElement | null)?.value;
  const days  = (document.getElementById('customTaskDays') as HTMLInputElement | null)?.value;
  const body = {
    label,
    threshold_shots: shots ? parseInt(shots, 10) : null,
    threshold_days:  days  ? parseInt(days,  10) : null,
  };
  try {
    const r = await addCustomMaintenanceTask(_writeMachineId(machineId), body);
    if (!r.ok) { window.showToast?.(t('error_generic', r.status)); return; }
    await loadMaintenanceView();
  } catch { /* ignore */ }
}

export async function deleteCustomMaintTask(task: string, machineId?: string | number | null): Promise<void> {
  if (!confirm(t('maint_confirm_delete_custom', task.replace('custom_', '')))) return;
  try {
    const r = await deleteCustomMaintenanceTask(task, _writeMachineId(machineId));
    if (!r.ok) { window.showToast?.(t('error_generic', r.status)); return; }
    _closeOpenTaskSheet();
    await loadMaintenanceView();
  } catch { /* ignore */ }
}

export async function renameCustomMaintTask(task: string, newLabel: string, machineId?: string | number | null): Promise<void> {
  const label = newLabel.trim();
  if (!label) return;
  try {
    const r = await saveMaintenanceThreshold(task, _writeMachineId(machineId), { label });
    if (!r.ok) { window.showToast?.(t('error_generic', r.status)); return; }
    await refreshMaintenanceView();
  } catch { /* ignore */ }
}

// ── Maintenance Log ───────────────────────────────────────────────────────

export async function loadMaintLog(): Promise<void> {
  const el = document.getElementById('maintLog');
  if (!el) return;
  try {
    const scope = _effectiveScope();
    const entries = await getMaintenanceLog(scope).then(r => r.json()) as MaintLogEntry[];
    renderMaintLog(entries);
  } catch { el.innerHTML = html``; }
}

export function renderMaintLog(entries: MaintLogEntry[]): void {
  _lastLogEntries = entries;
  const el = document.getElementById('maintLog');
  if (!el) return;

  const countEl = document.getElementById('maintLogCount');
  if (countEl) {
    const thisYear = new Date().getFullYear();
    const n = entries.filter(e => new Date(e.ts * 1000).getFullYear() === thisYear).length;
    countEl.textContent = `${t('maint_summary_log_entries', thisYear)}: ${n}`;
  }

  if (!entries.length) {
    el.innerHTML = html`<p class="empty-note pad-top">${tHtml('maint_log_empty')}</p>`;
    return;
  }

  const locale = localeFor(S.currentLang);
  const rowHtml = (e: MaintLogEntry): Html => {
    const dateStr   = new Date(e.ts * 1000).toLocaleDateString(locale, { day: '2-digit', month: '2-digit', year: 'numeric' });
    const isManual  = e.shotCountAtTime === null;
    const machineTag = isGlobalTask(e.task)
      ? t('maint_shared_tag')
      : ((S.machines || []).find(m => m.id === e.machineId)?.name || e.machine || '');
    const shotsText = e.shotCountAtTime == null
      ? esc('–')
      : html`${esc(e.shotCountAtTime)} ${esc(t('maint_unit_shots'))}`;
    return html`<div class="maint-log-row">
      <span class="maint-log-date num">${esc(dateStr)}</span>
      <span class="maint-log-main">
        <span class="maint-log-task">${esc(taskTitle(e.task, e))}${isManual ? html`<span class="maint-log-manual-badge">${tHtml('maint_log_manual_badge')}</span>` : html``}</span>
        ${machineTag ? html`<span class="shot-machine-badge">${esc(machineTag as string)}</span>` : html``}
        ${e.notes === AUTO_SYNCED_NOTE
          ? html`<span class="maint-auto-synced" title="${tHtml('maint_auto_synced_hint')}">${tHtml('maint_auto_synced')}</span>`
          : e.notes ? html`<span class="maint-log-note">${esc(e.notes)}</span>` : html``}
      </span>
      <span class="maint-log-shots num">${shotsText}</span>
      <button type="button" class="lib-sheet-iconbtn maint-log-del-btn" data-action="delete-maint-log" data-id="${esc(e.id)}" aria-label="${esc(t('maint_log_delete'))}" title="${esc(t('maint_log_confirm_delete'))}">${ICON_TRASH}</button>
    </div>`;
  };

  // #1923: eight rows stay visible; the rest fold behind "Show all".
  const visible = 8;
  const head = entries.slice(0, visible);
  const rest = entries.slice(visible);
  // codeql[js/xss-through-dom] false positive: esc()/escapeHtml() already applied, see #760
  el.innerHTML = html`
    <div class="maint-log-rows">${joinHtml(head.map(rowHtml))}</div>
    ${rest.length ? html`<details class="analytics-more maint-log-more">
      <summary class="analytics-more-summary">${tHtml('analytics_shelf_show_all', entries.length)}</summary>
      <div class="maint-log-rows">${joinHtml(rest.map(rowHtml))}</div>
    </details>` : html``}
  `;
}

// Builds the manual-log-entry task dropdown's options from the dashboard's
// own currently-active tiles — the same set of tasks the cards show, with
// the same resolved names (custom labels, grinder names), and never a
// disabled task (dashboard vs. log-entry-form mismatch bug report).
// Deduped by task key: 'all' scope has one tile per machine per task, but
// a manual log entry only needs to name the task once. Exported (pure, no
// DOM) for testing.
export function _maintLogTaskOptions(tiles: MaintTile[]): { task: string; label: string }[] {
  const seen = new Set<string>();
  const options: { task: string; label: string }[] = [];
  for (const tile of tiles) {
    if (seen.has(tile.task)) continue;
    seen.add(tile.task);
    options.push({ task: tile.task, label: taskTitle(tile.task, tile.d) });
  }
  return options;
}

export function openMaintLogForm(): void {
  const form = document.getElementById('maintLogForm');
  if (!form) return;
  const sel = document.getElementById('maintLogTask') as HTMLSelectElement;
  sel.innerHTML = html``;
  for (const { task, label } of _maintLogTaskOptions(_lastActiveTiles)) {
    const opt = document.createElement('option');
    opt.value = task; opt.textContent = label;
    sel.appendChild(opt);
  }
  // Set date to today (local, not UTC — see todayIsoDate)
  const today = todayIsoDate();
  (document.getElementById('maintLogDate') as HTMLInputElement).value = today;
  (document.getElementById('maintLogDate') as HTMLInputElement).max   = today;
  (document.getElementById('maintLogNotes') as HTMLTextAreaElement).value = '';
  form.style.display = 'flex';
}

export function closeMaintLogForm(): void {
  const form = document.getElementById('maintLogForm');
  if (form) form.style.display = 'none';
}

export async function submitMaintLogEntry(): Promise<void> {
  const task  = (document.getElementById('maintLogTask') as HTMLSelectElement).value;
  const date  = (document.getElementById('maintLogDate') as HTMLInputElement).value;
  const notes = (document.getElementById('maintLogNotes') as HTMLTextAreaElement).value.trim();
  if (!task || !date) return;
  try {
    const r = await addMaintenanceLogEntry(_writeMachineId(), { task, date, notes });
    if (!r.ok) { window.showToast?.(t('error_generic', r.status)); return; }
    closeMaintLogForm();
    void loadMaintLog();
  } catch { /* ignore */ }
}

export async function deleteMaintLogEntry(id: number | string): Promise<void> {
  if (!confirm(t('maint_log_confirm_delete'))) return;
  try {
    const r = await deleteMaintenanceLogEntry(id);
    if (!r.ok) { window.showToast?.(t('error_generic', r.status)); return; }
    void loadMaintLog();
  } catch { /* ignore */ }
}
