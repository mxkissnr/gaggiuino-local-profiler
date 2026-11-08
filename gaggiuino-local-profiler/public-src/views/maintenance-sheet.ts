// #1923: one maintenance task's details — interval (mode + thresholds),
// rename for custom tasks, the task's own log history and the done /
// disable / delete actions — in the shared desktop popover / phone bottom
// sheet (#1467), instead of expanding inline in the card.
//
// Runtime helpers (taskTitle, maintStatusLabel, isAutoSynced, _maintCountText)
// come from ./maintenance.js and are only read at call time, so this module
// and maintenance.ts may import each other — same pattern as
// library/bean-form-sheet.ts.
import { S } from '../state/index.js';
import { t, tHtml } from '../i18n.js';
import { esc, html, joinHtml } from '../utils.js';
import type { Html } from '../utils.js';
import { CHECK_ICON_SVG } from '../icons.js';
import { localeFor } from '../constants.js';
import { openDetailSheet } from '../components/detail-sheet.js';
import { AUTO_SYNCED_NOTE, _maintCountText, isAutoSynced, maintStatusLabel, taskTitle } from './maintenance.js';
import type { MaintLogEntry, MaintTile } from './maintenance.js';

function _thresholdMode(task: string, d: MaintTile['d']): 'shots' | 'days' | 'both' | 'g' {
  const hasShots = d.threshold_shots != null;
  const hasDays  = d.threshold_days != null;
  const hasG     = task.startsWith('grinder_') && d.threshold_g != null;
  return hasG ? 'g' : hasShots && hasDays ? 'both' : hasShots ? 'shots' : hasDays ? 'days' : 'shots';
}

function _modeButtons(tile: MaintTile, mode: string): Html {
  const { task, d, machineId } = tile;
  const isGrinder = task.startsWith('grinder_');
  const shotsVal = d.threshold_shots ?? '';
  const daysVal  = d.threshold_days ?? '';
  const gVal     = d.threshold_g ?? '';
  const btn = (m: string, label: Html): Html => html`<button type="button" class="analytics-filter-btn${mode === m ? html` active` : esc('')}" data-action="set-maint-mode" data-task="${esc(task)}" data-mode="${esc(m)}" data-machine-id="${esc(machineId)}" data-current-shots="${esc(shotsVal)}" data-current-days="${esc(daysVal)}" data-current-g="${esc(gVal)}" aria-pressed="${mode === m ? esc('true') : esc('false')}">${label}</button>`;
  return html`<div class="analytics-filter-row maint-mode-seg">
    ${btn('shots', tHtml('maint_unit_shots'))}
    ${btn('days', tHtml('maint_by_days'))}
    ${btn('both', tHtml('maint_mode_both'))}
    ${isGrinder ? btn('g', tHtml('maint_unit_grams')) : esc('')}
  </div>`;
}

function _thresholdFields(tile: MaintTile, mode: string): Html {
  const { task, d, machineId } = tile;
  const shotsInput = html`<label class="maint-threshold-field">
    <span>${tHtml('maint_unit_shots')}</span>
    <input type="number" min="1" max="10000" value="${esc(d.threshold_shots ?? '')}" placeholder="–"
        data-action="save-maint-threshold" data-task="${esc(task)}" data-field="threshold_shots" data-machine-id="${esc(machineId)}">
  </label>`;
  const daysInput = html`<label class="maint-threshold-field">
    <span>${tHtml('maint_by_days')}</span>
    <input type="number" min="1" max="3650" value="${esc(d.threshold_days ?? '')}" placeholder="–"
        data-action="save-maint-threshold" data-task="${esc(task)}" data-field="threshold_days" data-machine-id="${esc(machineId)}">
  </label>`;
  const gInput = html`<label class="maint-threshold-field">
    <span>${tHtml('maint_unit_grams')}</span>
    <input type="number" min="1" max="100000" value="${esc(d.threshold_g ?? '')}" placeholder="–"
        data-action="save-maint-threshold" data-task="${esc(task)}" data-field="threshold_g" data-machine-id="${esc(machineId)}">
  </label>`;
  const fields: Html = mode === 'g' ? gInput : mode === 'shots' ? shotsInput : mode === 'days' ? daysInput : joinHtml([shotsInput, daysInput]);
  return html`<div class="maint-threshold-inputs">${fields}</div>`;
}

function _renameField(tile: MaintTile): Html {
  const { task, d, machineId } = tile;
  return html`<label class="maint-threshold-field maint-rename-field">
    <span>${tHtml('maint_rename_label')}</span>
    <input type="text" maxlength="100" value="${esc(d.label || '')}"
        data-action="rename-maint-label" data-task="${esc(task)}" data-machine-id="${esc(machineId)}">
  </label>`;
}

// The entry belongs to this tile when it names the same task and either the
// task is shared equipment (waterfilter, grinder_*) or the entry's machine is
// this tile's machine (entries without a machine count for every machine).
function _entryBelongsToTile(e: MaintLogEntry, tile: MaintTile): boolean {
  if (e.task !== tile.task) return false;
  return tile.isGlobal || e.machineId == null || String(e.machineId) === String(tile.machineId);
}

function _historyRow(e: MaintLogEntry, locale: string): Html {
  const dateStr = new Date(e.ts * 1000).toLocaleDateString(locale, { day: '2-digit', month: '2-digit', year: 'numeric' });
  const isManual = e.shotCountAtTime === null;
  const note = e.notes === AUTO_SYNCED_NOTE
    ? html`<span class="maint-auto-synced" title="${tHtml('maint_auto_synced_hint')}">${tHtml('maint_auto_synced')}</span>`
    : e.notes ? esc(e.notes) : html``;
  return html`<div class="maint-hist-row">
    <span class="maint-hist-date">${esc(dateStr)}</span>
    <span class="maint-hist-side">
      <span class="maint-hist-count">${esc(e.shotCountAtTime ?? '–')}</span>
      ${isManual ? html`<span class="maint-log-manual-badge">${tHtml('maint_log_manual_badge')}</span>` : html``}
    </span>
    ${note ? html`<div class="maint-hist-note">${note}</div>` : html``}
  </div>`;
}

function _history(tile: MaintTile, history: MaintLogEntry[]): Html {
  const locale = localeFor(S.currentLang);
  const rows = history.filter(e => _entryBelongsToTile(e, tile));
  return html`<div class="maint-hist">
    <h3 class="analytics-section-title">${tHtml('maint_log_title')}</h3>
    ${rows.length ? joinHtml(rows.map(e => _historyRow(e, locale))) : html`<p class="empty-note">${tHtml('maint_log_empty')}</p>`}
  </div>`;
}

function _footer(tile: MaintTile): Html {
  const { task, machineId } = tile;
  return html`<div class="maint-sheet-footer">
    ${task.startsWith('custom_')
      ? html`<button class="maint-delete-btn" data-action="delete-custom-maint-task" data-task="${esc(task)}" data-machine-id="${esc(machineId)}">${tHtml('maint_log_delete')}</button>`
      : html`<button class="maint-disable-btn" data-action="toggle-maint-disabled" data-task="${esc(task)}" data-machine-id="${esc(machineId)}" data-disabled="true">${tHtml('maint_disable_btn')}</button>`
    }
  </div>`;
}

// Pure: the whole sheet body for one tile, filtered to that tile's own
// history entries in the order the API returned them.
export function maintTaskSheetBody(tile: MaintTile, history: MaintLogEntry[]): Html {
  const mode = _thresholdMode(tile.task, tile.d);
  return html`<div class="maint-sheet" data-task="${esc(tile.task)}" data-machine-id="${esc(tile.machineId)}">
    <div class="maint-sheet-interval">
      ${_modeButtons(tile, mode)}
      ${_thresholdFields(tile, mode)}
      ${tile.task.startsWith('custom_') ? _renameField(tile) : esc('')}
    </div>
    ${_history(tile, history)}
    ${_footer(tile)}
  </div>`;
}

// Pure: the manual log entry form as a sheet body. Interim "Cancel" button
// (#1923) until plan-1923e removes it together with its key.
export function maintLogFormBody(options: { task: string; label: string }[], today: string): Html {
  return html`<div id="maintLogForm" class="maint-sheet maint-form">
    <select id="maintLogTask" aria-label="${tHtml('maint_log_col_task')}">
      ${joinHtml(options.map(o => html`<option value="${esc(o.task)}">${esc(o.label)}</option>`))}
    </select>
    <input type="date" id="maintLogDate" value="${esc(today)}" max="${esc(today)}" aria-label="${tHtml('maint_log_col_date')}">
    <input type="text" id="maintLogNotes" placeholder="${tHtml('maint_log_notes_ph')}" aria-label="${tHtml('maint_log_col_notes')}">
    <button type="button" class="maint-log-cancel-btn" id="maintLogCancelBtn">${tHtml('maint_log_cancel')}</button>
  </div>`;
}

// Pure: the "add custom task" form as a sheet body.
export function maintCustomFormBody(): Html {
  return html`<div class="maint-sheet maint-form">
    <input type="text" aria-label="${tHtml('maint_custom_label_ph')}" id="customTaskLabel" placeholder="${tHtml('maint_custom_label_ph')}" maxlength="100">
    <div class="maint-form-intervals">
      <label>${tHtml('maint_custom_every')} <input type="number" id="customTaskShots" min="1" max="10000" placeholder="–"> ${tHtml('maint_unit_shots')}</label>
      <label>${tHtml('maint_custom_every')} <input type="number" id="customTaskDays" min="1" max="3650" placeholder="–"> ${tHtml('maint_by_days')}</label>
    </div>
  </div>`;
}

// The sheet bar's main action: one 44px icon button, "Mark as done".
export function maintTaskSheetActions(tile: MaintTile): Html {
  return html`<button type="button" class="lib-sheet-iconbtn" data-action="mark-maint-done" data-task="${esc(tile.task)}" data-machine-id="${esc(tile.machineId)}" aria-label="${tHtml('maint_done_btn')}" title="${tHtml('maint_done_btn')}">${CHECK_ICON_SVG}</button>`;
}

export function openMaintTaskSheet(tile: MaintTile, history: MaintLogEntry[], anchor: HTMLElement | null): void {
  const status = maintStatusLabel(tile.d.status);
  const count = _maintCountText(tile.task, tile.d);
  const machineTag = tile.isGlobal ? t('maint_shared_tag') : (tile.showMachineTag ? tile.machineName : null);
  const parts: string[] = [status, count];
  if (machineTag) parts.push(machineTag);
  if (isAutoSynced(tile.d)) parts.push(t('maint_auto_synced'));
  openDetailSheet({
    title: taskTitle(tile.task, tile.d),
    sub: parts.filter(Boolean).join(' · '),
    body: maintTaskSheetBody(tile, history),
    actions: maintTaskSheetActions(tile),
    anchor,
  });
}
