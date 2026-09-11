import { S } from '../state/index.js';
import { t } from '../i18n.js';
import {
  getMaintenance, markMaintenanceDone, saveMaintenanceThreshold,
  getMaintenanceLog, addMaintenanceLogEntry, deleteMaintenanceLogEntry,
} from '../api/maintenance.js';
import { MAINT_META, GUIDED_MAINT_STEPS, localeFor } from '../constants.js';
import { esc } from '../utils.js';

// One task's status block as GET /api/maintenance serves it (flat for a
// single machine, nested under machines[]/global for the fleet view).
interface MaintTaskData {
  status: string;
  pct: number;
  daysSince?: number | null;
  shotsSince: number;
  threshold_shots?: number | null;
  threshold_days?: number | null;
  threshold_g?: number | null;
  gramsSince?: number | null;
  machineSyncedAt?: string | number | null;
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

interface MaintTile {
  task: string;
  d: MaintTaskData;
  machineId: string | number;
  machineName: string | null;
  isGlobal: boolean;
  showMachineTag: boolean;
}

interface MaintLogEntry {
  id: number;
  task: string;
  ts: number;
  machineId?: number | null;
  machine?: string | null;
  grinderName?: string | null;
  shotCountAtTime?: number | null;
  notes?: string | null;
}

type MaintScope = string | number;

// ── Task icons (#393) — plain inline SVG line icons, no emoji, matching the
// Dashboard mockup Max picked. Purely decorative; task identity always comes
// from MAINT_META's translation key (or the grinder's own name), never the
// icon alone, so a missing/unmapped icon never loses information.
const TASK_ICON_PATHS: Record<string, string> = {
  descaling:   '<path d="M3 6h8v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6zM11 7h1.5a1.5 1.5 0 0 1 0 3H11M5 3.5v1M8 3.5v1"/>',
  backflush:   '<path d="M8 2v6M4.5 5.5 8 8l3.5-2.5M3 11h10M4 11v2h8v-2"/>',
  grouphead:   '<circle cx="8" cy="8" r="5"/><path d="M8 5.5v.01M6.2 8h.01M9.8 8h.01M8 10.5v.01"/>',
  gaskets:     '<circle cx="8" cy="8" r="5"/><circle cx="8" cy="8" r="2"/>',
  waterfilter: '<path d="M8 2.5S4 7 4 9.8a4 4 0 0 0 8 0C12 7 8 2.5 8 2.5z"/>',
  grinder:     '<circle cx="8" cy="8" r="2"/><path d="M8 2v2.5M8 11.5V14M2 8h2.5M11.5 8H14M4 4l1.8 1.8M10.2 10.2 12 12M12 4l-1.8 1.8M5.8 10.2 4 12"/>',
  custom:      '<path d="M10.5 2.5a2 2 0 0 1 2.83 2.83l-7 7L3 13l.67-3.33 7-7z"/>',
};
function taskIconSvg(task: string): string {
  const key = task.startsWith('grinder_') ? 'grinder' : task.startsWith('custom_') ? 'custom' : task;
  const path = TASK_ICON_PATHS[key] || '';
  return `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5">${path}</svg>`;
}

// Mirrors lib/constants.js's isGlobalMaintenanceTask() — waterfilter and
// grinder_* tasks are shared equipment, never split per machine.
function isGlobalTask(task: string): boolean {
  return task === 'waterfilter' || task.startsWith('grinder_');
}

function taskTitle(task: string, d: MaintTaskData): string {
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

function _effectiveScope(): MaintScope {
  if ((S.machines || []).length <= 1) return S.activeMachineId === 'all' ? 1 : (S.activeMachineId ?? 1);
  return _maintScope;
}

export function setMaintScope(scope: string): void {
  _maintScope = scope === 'all' ? 'all' : parseInt(scope, 10);
  void loadMaintenanceView();
}

// Write routes (done/threshold) always need one concrete machine — 'all'
// scope has no single target, so falls back to the first registered machine
// (irrelevant for global tasks anyway: the backend always redirects
// waterfilter/grinder_* writes to the shared sentinel machine regardless of
// which machineId is passed, see isGlobalMaintenanceTask() server-side).
function _writeMachineId(explicit?: string | number | null): string | number {
  if (explicit !== undefined && explicit !== null && explicit !== '') return explicit;
  const scope = _effectiveScope();
  return scope === 'all' ? (S.machines?.[0]?.id ?? 1) : scope;
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
function _partitionTiles(tiles: MaintTile[]): { active: MaintTile[]; disabled: MaintTile[] } {
  const active: MaintTile[] = [], disabled: MaintTile[] = [];
  for (const tile of tiles) {
    (tile.d.disabled ? disabled : active).push(tile);
  }
  return { active, disabled };
}

function _summaryCounts(tiles: MaintTile[]): { due: number; soon: number; ok: number } {
  let due = 0, soon = 0, ok = 0;
  for (const { d } of tiles) {
    if (d.status === 'due' || d.status === 'never') due++;
    else if (d.status === 'soon') soon++;
    else ok++;
  }
  return { due, soon, ok };
}

// How overdue a tile is, in whichever unit its threshold uses — used only to
// rank tiles for the "next up" banner, never shown to the user directly.
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

// ── Rendering ───────────────────────────────────────────────────────────────

export async function loadMaintenanceView(): Promise<void> {
  const container = document.getElementById('maint-cards') as HTMLElement;
  container.innerHTML = `<div class="loading-state">${t('loading')}</div>`;
  try {
    const scope = _effectiveScope();
    const r = await getMaintenance(scope);
    const data = await r.json() as MaintResponse;
    renderMaintenanceDashboard(data, scope);
  } catch {
    container.innerHTML = `<div class="loading-state" style="color:var(--err)">${t('error_load')}</div>`;
  }
  void loadMaintLog();
}

export function renderMaintenanceDashboard(data: MaintResponse, scope: MaintScope): void {
  const container = document.getElementById('maint-cards') as HTMLElement;
  const allTiles   = _normalizeMaintTiles(data, scope);
  const { active, disabled } = _partitionTiles(allTiles);
  const counts     = _summaryCounts(active);
  const nextTile   = _pickNextDueTile(active);
  const hasMachines = (S.machines || []).length > 1;

  container.innerHTML = `
    <div class="maint-summary" id="maintSummary"></div>
    <div class="maint-next-banner" id="maintNextBanner" style="display:none"></div>
    <div class="maint-scope-row" id="maintScopeRow" style="display:${hasMachines ? '' : 'none'}">
      <div class="maint-seg" id="maintScopeSeg" role="group" aria-label="${esc(t('machine_switcher_title') || '')}"></div>
      <span class="maint-scope-hint" id="maintScopeHint">${t('maint_shared_once')}</span>
    </div>
    <div class="maint-grid-compact" id="maintGrid"></div>
    <div class="maint-custom-section" id="maintCustomSection"></div>
    <div class="maint-disabled-section" id="maintDisabledSection" style="display:none"></div>
  `;

  (document.getElementById('maintSummary') as HTMLElement).innerHTML = `
    <div class="maint-tile due"><div class="k num">${counts.due}</div><div class="l">${t('maint_due')}</div></div>
    <div class="maint-tile soon"><div class="k num">${counts.soon}</div><div class="l">${t('maint_soon')}</div></div>
    <div class="maint-tile ok"><div class="k num">${counts.ok}</div><div class="l">${t('maint_ok')}</div></div>
    <div class="maint-tile"><div class="k num" id="maintLogYearCount">–</div><div class="l">${t('maint_summary_log_entries', new Date().getFullYear())}</div></div>
  `;

  _renderNextBanner(document.getElementById('maintNextBanner'), nextTile);

  if (hasMachines) {
    const seg = document.getElementById('maintScopeSeg') as HTMLElement;
    // codeql[js/xss-through-dom] false positive: esc()/escapeHtml() already applied, see #760
    seg.innerHTML = [
      `<button class="${scope === 'all' ? 'on' : ''}" data-action="set-maint-scope" data-scope="all">${esc(t('machine_switcher_all'))}</button>`,
      ...S.machines.map(m => `<button class="${scope === m.id ? 'on' : ''}" data-action="set-maint-scope" data-scope="${m.id}">${esc(m.name as string)}</button>`),
    ].join('');
    const hint = document.getElementById('maintScopeHint');
    if (hint) hint.style.display = active.some(x => x.isGlobal) ? '' : 'none';
  }

  const grid = document.getElementById('maintGrid') as HTMLElement;
  grid.innerHTML = '';
  for (const tile of active) grid.appendChild(_buildMaintMiniTile(tile));

  _renderCustomSection(document.getElementById('maintCustomSection'), scope);

  const disabledSec = document.getElementById('maintDisabledSection');
  if (disabled.length > 0) {
    disabledSec.style.display = '';
    _renderDisabledSection(disabledSec, disabled);
  }

  const badge = document.getElementById('maintBadge');
  if (badge) badge.style.display = counts.due > 0 ? 'inline-block' : 'none';
}

function _renderCustomSection(container: HTMLElement | null, scope: MaintScope): void {
  if (!container) return;
  const writeMid = _writeMachineId(scope === 'all' ? undefined : scope);
  // codeql[js/xss-through-dom] false positive: esc() applied
  container.innerHTML = `
    <details class="maint-custom-add">
      <summary>Eigene Wartung hinzufügen</summary>
      <div class="maint-custom-form">
        <input type="text" id="customTaskLabel" placeholder="Name (z.B. Rückspülen mit Reiniger)" maxlength="100">
        <div class="maint-custom-thresholds">
          <label>Alle <input type="number" id="customTaskShots" min="1" max="10000" placeholder="–"> Bezüge</label>
          <label>Alle <input type="number" id="customTaskDays" min="1" max="3650" placeholder="–"> Tage</label>
        </div>
        <button data-action="add-custom-maint-task" data-machine-id="${writeMid}">Hinzufügen</button>
      </div>
    </details>
  `;
}

function _renderDisabledSection(container: HTMLElement, tiles: MaintTile[]): void {
  const rows = tiles.map(tile => {
    const title = taskTitle(tile.task, tile.d);
    return `<div class="maint-disabled-row">
      <span class="icon">${taskIconSvg(tile.task)}</span>
      <span>${esc(title)}</span>
      <button class="maint-reenable-btn" data-action="toggle-maint-disabled" data-task="${esc(tile.task)}" data-machine-id="${tile.machineId}" data-disabled="false">Aktivieren</button>
    </div>`;
  }).join('');
  // codeql[js/xss-through-dom] false positive: esc() applied
  container.innerHTML = `<details class="maint-disabled-details"><summary>Deaktivierte Wartungen (${tiles.length})</summary>${rows}</details>`;
}

function _renderNextBanner(container: HTMLElement | null, tile: MaintTile | null): void {
  if (!container) return;
  if (!tile) { container.style.display = 'none'; container.innerHTML = ''; return; }
  container.style.display = '';
  const title       = taskTitle(tile.task, tile.d);
  const machinePart = !tile.isGlobal && tile.machineName ? ` · ${esc(tile.machineName)}` : '';

  let detail;
  if (tile.d.status === 'never') detail = t('maint_never_done');
  else if (tile.d.threshold_shots && tile.d.shotsSince > tile.d.threshold_shots) detail = t('maint_next_shots_over', tile.d.shotsSince - tile.d.threshold_shots);
  else if (tile.d.threshold_days && (tile.d.daysSince as number) > tile.d.threshold_days) detail = t('maint_next_days_over', (tile.d.daysSince as number) - tile.d.threshold_days);
  else detail = t('maint_next_due');

  // codeql[js/xss-through-dom] false positive: esc()/escapeHtml() already applied, see #760
  container.innerHTML = `
    <b>${esc(t('maint_next_label'))}</b> ${esc(title)}${machinePart} — ${esc(detail)}
    <span class="spacer"></span>
    <button class="maint-banner-btn" data-action="mark-maint-done" data-task="${esc(tile.task)}" data-machine-id="${tile.machineId}">${esc(t('maint_next_action'))}</button>
  `;
}

function _buildMaintMiniTile(tile: MaintTile): HTMLElement {
  const { task, d, machineName, machineId, isGlobal, showMachineTag } = tile;
  const title = taskTitle(task, d);
  const isCustom = task.startsWith('custom_');
  const isGrinder = task.startsWith('grinder_');

  const machineTagText = isGlobal ? t('maint_shared_tag') : (showMachineTag ? machineName : null);

  // Determine current threshold mode.
  const hasShots = d.threshold_shots != null;
  const hasDays  = d.threshold_days  != null;
  const hasG     = isGrinder && d.threshold_g != null;
  const mode = hasG ? 'g' : hasShots && hasDays ? 'both' : hasShots ? 'shots' : hasDays ? 'days' : 'shots';

  // Count text for the meta row.
  let countText;
  if (d.status === 'never') {
    countText = t('maint_never_done');
  } else if (hasShots && hasDays) {
    countText = `${d.shotsSince}/${d.threshold_shots} ${t('maint_by_shots')} · ${d.daysSince ?? '?'}/${d.threshold_days} ${t('maint_by_days')}`;
  } else if (hasShots) {
    countText = `${d.shotsSince} / ${d.threshold_shots} ${t('maint_by_shots')}`;
  } else if (hasDays) {
    countText = `${d.daysSince ?? '?'} / ${d.threshold_days} ${t('maint_by_days')}`;
  } else if (hasG) {
    countText = `${d.gramsSince ?? 0}g / ${d.threshold_g}g`;
  } else {
    countText = t('maint_never_done');
  }

  // Threshold inputs — shown based on mode.
  const shotsVal = d.threshold_shots ?? '';
  const daysVal  = d.threshold_days  ?? '';
  const gVal     = d.threshold_g ?? '';
  const shotsInput = `<label class="maint-threshold-field">
    <span>Bezüge</span>
    <input type="number" min="1" max="10000" value="${shotsVal}" placeholder="–"
        data-action="save-maint-threshold" data-task="${task}" data-field="threshold_shots" data-machine-id="${machineId}">
  </label>`;
  const daysInput = `<label class="maint-threshold-field">
    <span>Tage</span>
    <input type="number" min="1" max="3650" value="${daysVal}" placeholder="–"
        data-action="save-maint-threshold" data-task="${task}" data-field="threshold_days" data-machine-id="${machineId}">
  </label>`;
  const gInput = `<label class="maint-threshold-field">
    <span>Gramm</span>
    <input type="number" min="1" max="100000" value="${gVal}" placeholder="–"
        data-action="save-maint-threshold" data-task="${task}" data-field="threshold_g" data-machine-id="${machineId}">
  </label>`;
  const thresholdFields = mode === 'g' ? gInput : mode === 'shots' ? shotsInput : mode === 'days' ? daysInput : shotsInput + daysInput;

  const pct = Math.round(d.pct * 100);
  const el = document.createElement('div');
  el.className = `maint-card status-${d.status}`;
  // codeql[js/xss-through-dom] false positive: esc()/escapeHtml() already applied, see #760
  el.innerHTML = `
    <div class="maint-card-indicator"></div>
    <div class="maint-card-body">
      <div class="maint-card-header">
        <span class="maint-card-icon">${taskIconSvg(task)}</span>
        <span class="maint-card-title">${esc(title)}</span>
        <span class="maint-card-chip ${d.status}">${maintStatusLabel(d.status)}</span>
      </div>
      <div class="maint-card-progress"><div class="maint-card-progress-fill ${d.status}" style="width:${pct}%"></div></div>
      <div class="maint-card-meta">
        ${machineTagText ? `<span class="shot-machine-badge">${esc(machineTagText)}</span>` : ''}
        <span class="maint-card-count">${esc(countText)}</span>
        ${d.machineSyncedAt ? `<span class="maint-auto-synced" title="${esc(t('maint_auto_synced_hint'))}">${esc(t('maint_auto_synced'))}</span>` : ''}
      </div>
      <button class="maint-detail-toggle" type="button" data-action="toggle-maint-detail" data-task="${task}">${esc(t('maint_tile_details'))}</button>
      <div class="detail">
        <div class="maint-mode-seg">
          <button class="${mode === 'shots' ? 'active' : ''}" data-action="set-maint-mode" data-task="${task}" data-mode="shots" data-machine-id="${machineId}" data-current-shots="${shotsVal}" data-current-days="${daysVal}" data-current-g="${gVal}">Bezüge</button>
          <button class="${mode === 'days'  ? 'active' : ''}" data-action="set-maint-mode" data-task="${task}" data-mode="days"  data-machine-id="${machineId}" data-current-shots="${shotsVal}" data-current-days="${daysVal}" data-current-g="${gVal}">Tage</button>
          <button class="${mode === 'both'  ? 'active' : ''}" data-action="set-maint-mode" data-task="${task}" data-mode="both"  data-machine-id="${machineId}" data-current-shots="${shotsVal}" data-current-days="${daysVal}" data-current-g="${gVal}">Beides</button>
          ${isGrinder ? `<button class="${mode === 'g' ? 'active' : ''}" data-action="set-maint-mode" data-task="${task}" data-mode="g" data-machine-id="${machineId}" data-current-shots="${shotsVal}" data-current-days="${daysVal}" data-current-g="${gVal}">Gramm</button>` : ''}
        </div>
        <div class="maint-threshold-inputs">${thresholdFields}</div>
        ${isCustom ? `<label class="maint-threshold-field maint-rename-field">
          <span>Name</span>
          <input type="text" maxlength="100" value="${esc(d.label || '')}"
              data-action="rename-maint-label" data-task="${task}" data-machine-id="${machineId}">
        </label>` : ''}
        <div class="maint-card-actions">
          <button class="maint-done-btn" data-action="mark-maint-done" data-task="${task}" data-machine-id="${machineId}">${t('maint_done_btn')}</button>
          ${isCustom
            ? `<button class="maint-delete-btn" data-action="delete-custom-maint-task" data-task="${task}" data-machine-id="${machineId}">Löschen</button>`
            : `<button class="maint-disable-btn" data-action="toggle-maint-disabled" data-task="${task}" data-machine-id="${machineId}" data-disabled="true">Deaktivieren</button>`
          }
        </div>
      </div>
    </div>
  `;
  return el;
}

// ── Guided walkthrough ────────────────────────────────────────────────────

let _guidedTask: string | null = null;
let _guidedMachineId: string | number | null = null;

export function openGuidedMaint(task: string, machineId: string | number): void {
  const steps = GUIDED_MAINT_STEPS[task];
  const modal = document.getElementById('guidedMaintModal');
  if (!steps || !modal) return;
  _guidedTask = task;
  _guidedMachineId = machineId;
  (document.getElementById('guidedMaintTitle') as HTMLElement).textContent = t(MAINT_META[task]?.key || task);
  (document.getElementById('guidedMaintSteps') as HTMLElement).innerHTML = steps.map((key, i) => `
    <label class="guided-maint-step">
      <input type="checkbox" class="guided-maint-check">
      <span class="guided-maint-step-num">${i + 1}</span>
      <span>${esc(t(key))}</span>
    </label>`).join('');
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
    await markMaintenanceDone(task, _writeMachineId(machineId));
    await loadMaintenanceView();
  } catch { /* ignore */ }
}

export async function saveMaintThreshold(task: string, field: string, value: string, machineId?: string | number | null): Promise<void> {
  // empty string → null (clears the threshold)
  const parsed = value === '' || value == null ? null : parseInt(value, 10);
  try {
    await saveMaintenanceThreshold(task, _writeMachineId(machineId), { [field]: parsed });
  } catch { /* ignore */ }
}

export async function setMaintMode(
  task: string,
  mode: string,
  machineId?: string | number | null,
  currentShots?: string,
  currentDays?: string,
  currentG?: string,
): Promise<void> {
  const expandedTask = (document.querySelector('.maint-card.expanded .maint-detail-toggle') as HTMLElement | null)?.dataset?.task;
  const defShots = parseInt(currentShots ?? '', 10) || 200;
  const defDays  = parseInt(currentDays  ?? '', 10) || 30;
  const defG     = parseInt(currentG     ?? '', 10) || 10000;
  const body = mode === 'shots' ? { threshold_shots: defShots, threshold_days: null, threshold_g: null }
             : mode === 'days'  ? { threshold_shots: null,     threshold_days: defDays, threshold_g: null }
             : mode === 'g'     ? { threshold_shots: null,     threshold_days: null, threshold_g: defG }
             :                    { threshold_shots: defShots, threshold_days: defDays, threshold_g: null };
  try {
    await saveMaintenanceThreshold(task, _writeMachineId(machineId), body);
    await loadMaintenanceView();
    if (expandedTask) {
      document.querySelector(`.maint-detail-toggle[data-task="${CSS.escape(expandedTask)}"]`)
        ?.closest('.maint-card')?.classList.add('expanded');
    }
  } catch { /* ignore */ }
}

export async function toggleMaintDisabled(task: string, machineId?: string | number | null, disabled?: boolean): Promise<void> {
  try {
    await saveMaintenanceThreshold(task, _writeMachineId(machineId), { disabled });
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
    await apiFetch(`api/maintenance/custom?machineId=${_writeMachineId(machineId)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    await loadMaintenanceView();
  } catch { /* ignore */ }
}

export async function deleteCustomMaintTask(task: string, machineId?: string | number | null): Promise<void> {
  if (!confirm(`Eigene Wartung "${task.replace('custom_', '')}" wirklich löschen?`)) return;
  try {
    await apiFetch(`api/maintenance/custom/${task}?machineId=${_writeMachineId(machineId)}`, { method: 'DELETE' });
    await loadMaintenanceView();
  } catch { /* ignore */ }
}

export async function renameCustomMaintTask(task: string, newLabel: string, machineId?: string | number | null): Promise<void> {
  const label = newLabel.trim();
  if (!label) return;
  const expandedTask = (document.querySelector('.maint-card.expanded .maint-detail-toggle') as HTMLElement | null)?.dataset?.task;
  try {
    await apiFetch(`api/maintenance/${task}/threshold?machineId=${_writeMachineId(machineId)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label }),
    });
    await loadMaintenanceView();
    if (expandedTask) {
      document.querySelector(`.maint-detail-toggle[data-task="${CSS.escape(expandedTask)}"]`)
        ?.closest('.maint-card')?.classList.add('expanded');
    }
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
  } catch { el.innerHTML = ''; }
}

function taskLabel(entry: MaintLogEntry): string {
  const task = entry.task;
  if (MAINT_META[task]) return t(MAINT_META[task].key);
  if (task.startsWith('grinder_')) return entry.grinderName || task.replace('grinder_', 'Grinder ');
  return task;
}

export function renderMaintLog(entries: MaintLogEntry[]): void {
  const el = document.getElementById('maintLog');
  if (!el) return;

  const yearEl = document.getElementById('maintLogYearCount');
  if (yearEl) {
    const thisYear = new Date().getFullYear();
    yearEl.textContent = String(entries.filter(e => new Date(e.ts * 1000).getFullYear() === thisYear).length);
  }

  if (!entries.length) {
    el.innerHTML = `<p class="empty-note pad-top">${t('maint_log_empty')}</p>`;
    return;
  }

  const locale = localeFor(S.currentLang);
  const rows = entries.map(e => {
    const dateStr   = new Date(e.ts * 1000).toLocaleDateString(locale, { day: '2-digit', month: '2-digit', year: 'numeric' });
    const isManual  = e.shotCountAtTime === null;
    const machineTag = isGlobalTask(e.task)
      ? t('maint_shared_tag')
      : ((S.machines || []).find(m => m.id === e.machineId)?.name || e.machine || '');
    return `<tr>
      <td>${dateStr}</td>
      <td>${esc(taskLabel(e))}${isManual ? `<span class="maint-log-manual-badge">${t('maint_log_manual_badge')}</span>` : ''}</td>
      <td>${machineTag ? `<span class="shot-machine-badge">${esc(machineTag as string)}</span>` : ''}</td>
      <td class="num">${e.shotCountAtTime ?? '–'}</td>
      <td>${e.notes ? esc(e.notes) : ''}
        <button class="maint-log-del-btn" data-action="delete-maint-log" data-id="${e.id}" title="${t('maint_log_confirm_delete')}">${t('maint_log_delete')}</button>
      </td>
    </tr>`;
  }).join('');

  el.innerHTML = `<div class="maint-log-tablewrap"><table class="maint-log-table">
    <thead><tr>
      <th>${t('maint_log_col_date')}</th><th>${t('maint_log_col_task')}</th>
      <th>${t('maint_log_machine')}</th><th>${t('maint_by_shots')}</th><th>${t('maint_log_col_notes')}</th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table></div>`;
}

export function openMaintLogForm(): void {
  const form = document.getElementById('maintLogForm');
  if (!form) return;
  // Populate task dropdown
  const sel = document.getElementById('maintLogTask') as HTMLSelectElement;
  sel.innerHTML = '';
  for (const [task, meta] of Object.entries(MAINT_META)) {
    const opt = document.createElement('option');
    opt.value = task; opt.textContent = t(meta.key);
    sel.appendChild(opt);
  }
  // Set date to today
  const today = new Date().toISOString().split('T')[0];
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
    await addMaintenanceLogEntry(_writeMachineId(), { task, date, notes });
    closeMaintLogForm();
    void loadMaintLog();
  } catch { /* ignore */ }
}

export async function deleteMaintLogEntry(id: number | string): Promise<void> {
  if (!confirm(t('maint_log_confirm_delete'))) return;
  try {
    await deleteMaintenanceLogEntry(id);
    void loadMaintLog();
  } catch { /* ignore */ }
}
