import { S } from '../state.js';
import { t } from '../i18n.js';
import { apiFetch } from '../api.js';
import { MAINT_META, GUIDED_MAINT_STEPS, LOCALE_MAP } from '../constants.js';
import { esc } from '../utils.js';

// ── Task icons (#393) — plain inline SVG line icons, no emoji, matching the
// Dashboard mockup Max picked. Purely decorative; task identity always comes
// from MAINT_META's translation key (or the grinder's own name), never the
// icon alone, so a missing/unmapped icon never loses information.
const TASK_ICON_PATHS = {
  descaling:   '<path d="M3 6h8v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6zM11 7h1.5a1.5 1.5 0 0 1 0 3H11M5 3.5v1M8 3.5v1"/>',
  backflush:   '<path d="M8 2v6M4.5 5.5 8 8l3.5-2.5M3 11h10M4 11v2h8v-2"/>',
  grouphead:   '<circle cx="8" cy="8" r="5"/><path d="M8 5.5v.01M6.2 8h.01M9.8 8h.01M8 10.5v.01"/>',
  gaskets:     '<circle cx="8" cy="8" r="5"/><circle cx="8" cy="8" r="2"/>',
  waterfilter: '<path d="M8 2.5S4 7 4 9.8a4 4 0 0 0 8 0C12 7 8 2.5 8 2.5z"/>',
  grinder:     '<circle cx="8" cy="8" r="2"/><path d="M8 2v2.5M8 11.5V14M2 8h2.5M11.5 8H14M4 4l1.8 1.8M10.2 10.2 12 12M12 4l-1.8 1.8M5.8 10.2 4 12"/>',
};
function taskIconSvg(task) {
  const key  = task.startsWith('grinder_') ? 'grinder' : task;
  const path = TASK_ICON_PATHS[key] || '';
  return `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5">${path}</svg>`;
}

// Mirrors lib/constants.js's isGlobalMaintenanceTask() — waterfilter and
// grinder_* tasks are shared equipment, never split per machine.
function isGlobalTask(task) {
  return task === 'waterfilter' || task.startsWith('grinder_');
}

function taskTitle(task, d) {
  if (task.startsWith('grinder_')) return d.grinderName || task;
  return t(MAINT_META[task]?.key || task);
}

export function maintStatusLabel(status) {
  return { ok: t('maint_ok'), soon: t('maint_soon'), due: t('maint_due'), never: t('maint_never') }[status] || '';
}

// ── Local view scope (#393) ────────────────────────────────────────────────
// Independent of the global machine switcher (S.activeMachineId) — this view
// gets its own filter so browsing "all machines" here never changes what the
// rest of the app shows. Defaults to 'all' so the dashboard opens on the
// full-fleet overview; the segment control (and this scope) only matters
// once >1 machine is registered — single-machine installs always resolve to
// the (only) active machine.
let _maintScope = 'all';

function _effectiveScope() {
  if ((S.machines || []).length <= 1) return S.activeMachineId === 'all' ? 1 : (S.activeMachineId ?? 1);
  return _maintScope;
}

export function setMaintScope(scope) {
  _maintScope = scope === 'all' ? 'all' : parseInt(scope, 10);
  loadMaintenanceView();
}

// Write routes (done/threshold) always need one concrete machine — 'all'
// scope has no single target, so falls back to the first registered machine
// (irrelevant for global tasks anyway: the backend always redirects
// waterfilter/grinder_* writes to the shared sentinel machine regardless of
// which machineId is passed, see isGlobalMaintenanceTask() server-side).
function _writeMachineId(explicit) {
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
export function _normalizeMaintTiles(data, scope) {
  const tiles = [];
  if (scope === 'all') {
    for (const m of data.machines || []) {
      for (const [task, d] of Object.entries(m.tasks || {})) {
        if (!d) continue;
        tiles.push({ task, d, machineId: m.machineId, machineName: m.machineName, isGlobal: false, showMachineTag: true });
      }
    }
    const writeMachineId = data.machines?.[0]?.machineId ?? 1;
    for (const [task, d] of Object.entries(data.global || {})) {
      if (!d) continue;
      tiles.push({ task, d, machineId: writeMachineId, machineName: null, isGlobal: true, showMachineTag: true });
    }
  } else {
    for (const [task, d] of Object.entries(data || {})) {
      if (!d || typeof d !== 'object') continue;
      tiles.push({ task, d, machineId: scope, machineName: null, isGlobal: isGlobalTask(task), showMachineTag: false });
    }
  }
  return tiles;
}

function _summaryCounts(tiles) {
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
function _urgency(d) {
  if (d.status !== 'due' && d.status !== 'never') return -Infinity;
  let overage = 0;
  if (d.threshold_shots) overage = Math.max(overage, d.shotsSince - d.threshold_shots);
  if (d.threshold_days && d.daysSince != null) overage = Math.max(overage, d.daysSince - d.threshold_days);
  if (d.status === 'never') overage = Math.max(overage, d.shotsSince || 0);
  return overage;
}

export function _pickNextDueTile(tiles) {
  let best = null, bestScore = -Infinity;
  for (const tile of tiles) {
    const score = _urgency(tile.d);
    if (score > bestScore) { bestScore = score; best = tile; }
  }
  return bestScore > -Infinity ? best : null;
}

// ── Rendering ───────────────────────────────────────────────────────────────

export async function loadMaintenanceView() {
  const container = document.getElementById('maint-cards');
  container.innerHTML = `<div class="loading-state">${t('loading')}</div>`;
  try {
    const scope = _effectiveScope();
    const r = await apiFetch(`api/maintenance?machineId=${scope}`);
    const data = await r.json();
    renderMaintenanceDashboard(data, scope);
  } catch (e) {
    container.innerHTML = `<div class="loading-state" style="color:var(--err)">${t('error_load')}</div>`;
  }
  loadMaintLog();
}

export function renderMaintenanceDashboard(data, scope) {
  const container = document.getElementById('maint-cards');
  const tiles      = _normalizeMaintTiles(data, scope);
  const counts     = _summaryCounts(tiles);
  const nextTile   = _pickNextDueTile(tiles);
  const hasMachines = (S.machines || []).length > 1;

  container.innerHTML = `
    <div class="maint-summary" id="maintSummary"></div>
    <div class="maint-next-banner" id="maintNextBanner" style="display:none"></div>
    <div class="maint-scope-row" id="maintScopeRow" style="display:${hasMachines ? '' : 'none'}">
      <div class="maint-seg" id="maintScopeSeg" role="group" aria-label="${esc(t('machine_switcher_title') || '')}"></div>
      <span class="maint-scope-hint" id="maintScopeHint">${t('maint_shared_once')}</span>
    </div>
    <div class="maint-grid-compact" id="maintGrid"></div>
  `;

  document.getElementById('maintSummary').innerHTML = `
    <div class="maint-tile due"><div class="k num">${counts.due}</div><div class="l">${t('maint_due')}</div></div>
    <div class="maint-tile soon"><div class="k num">${counts.soon}</div><div class="l">${t('maint_soon')}</div></div>
    <div class="maint-tile ok"><div class="k num">${counts.ok}</div><div class="l">${t('maint_ok')}</div></div>
    <div class="maint-tile"><div class="k num" id="maintLogYearCount">–</div><div class="l">${t('maint_summary_log_entries', new Date().getFullYear())}</div></div>
  `;

  _renderNextBanner(document.getElementById('maintNextBanner'), nextTile);

  if (hasMachines) {
    const seg = document.getElementById('maintScopeSeg');
    seg.innerHTML = [
      `<button class="${scope === 'all' ? 'on' : ''}" data-action="set-maint-scope" data-scope="all">${esc(t('machine_switcher_all'))}</button>`,
      ...S.machines.map(m => `<button class="${scope === m.id ? 'on' : ''}" data-action="set-maint-scope" data-scope="${m.id}">${esc(m.name)}</button>`),
    ].join('');
    const hint = document.getElementById('maintScopeHint');
    if (hint) hint.style.display = tiles.some(x => x.isGlobal) ? '' : 'none';
  }

  const grid = document.getElementById('maintGrid');
  grid.innerHTML = '';
  for (const tile of tiles) grid.appendChild(_buildMaintMiniTile(tile));

  const badge = document.getElementById('maintBadge');
  if (badge) badge.style.display = counts.due > 0 ? 'inline-block' : 'none';
}

function _renderNextBanner(container, tile) {
  if (!container) return;
  if (!tile) { container.style.display = 'none'; container.innerHTML = ''; return; }
  container.style.display = '';
  const title       = taskTitle(tile.task, tile.d);
  const machinePart = !tile.isGlobal && tile.machineName ? ` · ${esc(tile.machineName)}` : '';

  let detail;
  if (tile.d.status === 'never') detail = t('maint_never_done');
  else if (tile.d.threshold_shots && tile.d.shotsSince > tile.d.threshold_shots) detail = t('maint_next_shots_over', tile.d.shotsSince - tile.d.threshold_shots);
  else if (tile.d.threshold_days && tile.d.daysSince > tile.d.threshold_days) detail = t('maint_next_days_over', tile.d.daysSince - tile.d.threshold_days);
  else detail = t('maint_next_due');

  container.innerHTML = `
    <b>${esc(t('maint_next_label'))}</b> ${esc(title)}${machinePart} — ${esc(detail)}
    <span class="spacer"></span>
    <button class="maint-banner-btn" data-action="mark-maint-done" data-task="${esc(tile.task)}" data-machine-id="${tile.machineId}">${esc(t('maint_next_action'))}</button>
  `;
}

function _buildMaintMiniTile(tile) {
  const { task, d, machineName, machineId, isGlobal, showMachineTag } = tile;
  const title = taskTitle(task, d);

  const machineTagText = isGlobal ? t('maint_shared_tag') : (showMachineTag ? machineName : null);

  const countText = d.status === 'never'
    ? t('maint_never_done')
    : d.threshold_shots != null
      ? `${d.shotsSince} / ${d.threshold_shots} ${t('maint_by_shots')}`
      : d.threshold_days != null
        ? `${d.daysSince} / ${d.threshold_days} ${t('maint_by_days')}`
        : t('maint_never_done');

  const mode = d.threshold_shots !== null ? 'shots' : 'days';
  const val  = mode === 'shots' ? d.threshold_shots : d.threshold_days;

  const el = document.createElement('div');
  el.className = `maint-mini status-${d.status}`;
  el.innerHTML = `
    <div class="top">
      <span><span class="icon">${taskIconSvg(task)}</span>${esc(title)}</span>
      <span class="maint-status-pill ${d.status}">${maintStatusLabel(d.status)}</span>
    </div>
    <div class="maint-bar-track"><div class="maint-bar-fill ${d.status}" style="width:${Math.round(d.pct * 100)}%"></div></div>
    <div class="n">
      ${machineTagText ? `<span class="shot-machine-badge">${esc(machineTagText)}</span>` : ''}
      <span class="num">${esc(countText)}</span>
    </div>
    <button class="maint-detail-toggle" type="button" data-action="toggle-maint-detail">${esc(t('maint_tile_details'))}</button>
    <div class="detail">
      <div class="maint-mode-toggle">
        <button class="maint-mode-btn${mode === 'shots' ? ' active' : ''}"
            data-action="set-maint-mode" data-task="${task}" data-mode="shots" data-machine-id="${machineId}">${t('maint_by_shots')}</button>
        <button class="maint-mode-btn${mode === 'days' ? ' active' : ''}"
            data-action="set-maint-mode" data-task="${task}" data-mode="days" data-machine-id="${machineId}">${t('maint_by_days')}</button>
      </div>
      <label class="maint-threshold-field">
        <input type="number" min="1" max="9999" value="${val}"
            data-action="save-maint-threshold" data-task="${task}" data-field="${mode === 'shots' ? 'threshold_shots' : 'threshold_days'}" data-machine-id="${machineId}">
      </label>
      <div class="actions">
        <button class="maint-done-btn" data-action="mark-maint-done" data-task="${task}" data-machine-id="${machineId}">${t('maint_done_btn')}</button>
        ${GUIDED_MAINT_STEPS[task] ? `<button class="maint-guide-btn" data-action="open-guided-maint" data-task="${task}" data-machine-id="${machineId}">${t('guided_open')}</button>` : ''}
      </div>
    </div>
  `;
  return el;
}

// ── Guided walkthrough ────────────────────────────────────────────────────

let _guidedTask = null;
let _guidedMachineId = null;

export function openGuidedMaint(task, machineId) {
  const steps = GUIDED_MAINT_STEPS[task];
  const modal = document.getElementById('guidedMaintModal');
  if (!steps || !modal) return;
  _guidedTask = task;
  _guidedMachineId = machineId;
  document.getElementById('guidedMaintTitle').textContent = t(MAINT_META[task]?.key || task);
  document.getElementById('guidedMaintSteps').innerHTML = steps.map((key, i) => `
    <label class="guided-maint-step">
      <input type="checkbox" class="guided-maint-check">
      <span class="guided-maint-step-num">${i + 1}</span>
      <span>${esc(t(key))}</span>
    </label>`).join('');
  const doneBtn = document.getElementById('guidedMaintDoneBtn');
  doneBtn.textContent = t('maint_done_btn');
  doneBtn.disabled = true;
  modal.style.display = 'flex';
}

export function updateGuidedMaintDoneState() {
  const boxes = [...document.querySelectorAll('#guidedMaintSteps .guided-maint-check')];
  const btn   = document.getElementById('guidedMaintDoneBtn');
  if (btn) btn.disabled = !boxes.length || !boxes.every(b => b.checked);
}

export function closeGuidedMaint() {
  _guidedTask = null;
  _guidedMachineId = null;
  const modal = document.getElementById('guidedMaintModal');
  if (modal) modal.style.display = 'none';
}

export async function submitGuidedMaint() {
  if (!_guidedTask) return;
  await markMaintDone(_guidedTask, _guidedMachineId);
  closeGuidedMaint();
}

// ── Write actions ───────────────────────────────────────────────────────────
// Each accepts an explicit machineId (the tile/button's own concrete target —
// #393) so acting on one tile while viewing 'all' scope, or a different
// machine's tile, never silently writes to the wrong machine. Falls back to
// _writeMachineId()'s resolution only when the caller omits it.

export async function markMaintDone(task, machineId) {
  try {
    await apiFetch(`api/maintenance/${task}/done?machineId=${_writeMachineId(machineId)}`, { method: 'POST' });
    await loadMaintenanceView();
  } catch (e) {}
}

export async function saveMaintThreshold(task, field, value, machineId) {
  try {
    await apiFetch(`api/maintenance/${task}/threshold?machineId=${_writeMachineId(machineId)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ [field]: parseInt(value) }),
    });
  } catch (e) {}
}

export async function setMaintMode(task, mode, machineId) {
  const defaults = { shots: 200, days: 30 };
  const body = mode === 'shots'
    ? { threshold_shots: defaults.shots, threshold_days: null }
    : { threshold_shots: null, threshold_days: defaults.days };
  try {
    await apiFetch(`api/maintenance/${task}/threshold?machineId=${_writeMachineId(machineId)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    await loadMaintenanceView();
  } catch (e) {}
}

// ── Maintenance Log ───────────────────────────────────────────────────────

const _logEsc = s => s == null ? '' : String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');

export async function loadMaintLog() {
  const el = document.getElementById('maintLog');
  if (!el) return;
  try {
    const scope = _effectiveScope();
    const entries = await apiFetch(`api/maintenance/log?machineId=${scope}`).then(r => r.json());
    renderMaintLog(entries);
  } catch { el.innerHTML = ''; }
}

function taskLabel(entry) {
  const task = entry.task;
  if (MAINT_META[task]) return t(MAINT_META[task].key);
  if (task.startsWith('grinder_')) return entry.grinderName || task.replace('grinder_', 'Grinder ');
  return task;
}

export function renderMaintLog(entries) {
  const el = document.getElementById('maintLog');
  if (!el) return;

  const yearEl = document.getElementById('maintLogYearCount');
  if (yearEl) {
    const thisYear = new Date().getFullYear();
    yearEl.textContent = entries.filter(e => new Date(e.ts * 1000).getFullYear() === thisYear).length;
  }

  if (!entries.length) {
    el.innerHTML = `<p style="color:var(--gray-600);font-size:.82rem;padding:8px 0">${t('maint_log_empty')}</p>`;
    return;
  }

  const locale = LOCALE_MAP[S.currentLang] || 'de-DE';
  const rows = entries.map(e => {
    const dateStr   = new Date(e.ts * 1000).toLocaleDateString(locale, { day: '2-digit', month: '2-digit', year: 'numeric' });
    const isManual  = e.shotCountAtTime === null;
    const machineTag = isGlobalTask(e.task)
      ? t('maint_shared_tag')
      : ((S.machines || []).find(m => m.id === e.machineId)?.name || e.machine || '');
    return `<tr>
      <td>${dateStr}</td>
      <td>${_logEsc(taskLabel(e))}${isManual ? `<span class="maint-log-manual-badge">${t('maint_log_manual_badge')}</span>` : ''}</td>
      <td>${machineTag ? `<span class="shot-machine-badge">${_logEsc(machineTag)}</span>` : ''}</td>
      <td class="num">${e.shotCountAtTime ?? '–'}</td>
      <td>${e.notes ? _logEsc(e.notes) : ''}
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

export function openMaintLogForm() {
  const form = document.getElementById('maintLogForm');
  if (!form) return;
  // Populate task dropdown
  const sel = document.getElementById('maintLogTask');
  sel.innerHTML = '';
  for (const [task, meta] of Object.entries(MAINT_META)) {
    const opt = document.createElement('option');
    opt.value = task; opt.textContent = t(meta.key);
    sel.appendChild(opt);
  }
  // Set date to today
  const today = new Date().toISOString().split('T')[0];
  document.getElementById('maintLogDate').value = today;
  document.getElementById('maintLogDate').max   = today;
  document.getElementById('maintLogNotes').value = '';
  form.style.display = 'flex';
}

export function closeMaintLogForm() {
  const form = document.getElementById('maintLogForm');
  if (form) form.style.display = 'none';
}

export async function submitMaintLogEntry() {
  const task  = document.getElementById('maintLogTask').value;
  const date  = document.getElementById('maintLogDate').value;
  const notes = document.getElementById('maintLogNotes').value.trim();
  if (!task || !date) return;
  try {
    await apiFetch(`api/maintenance/log?machineId=${_writeMachineId()}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ task, date, notes }),
    });
    closeMaintLogForm();
    loadMaintLog();
  } catch {}
}

export async function deleteMaintLogEntry(id) {
  if (!confirm(t('maint_log_confirm_delete'))) return;
  try {
    await apiFetch(`api/maintenance/log/${id}`, { method: 'DELETE' });
    loadMaintLog();
  } catch {}
}
