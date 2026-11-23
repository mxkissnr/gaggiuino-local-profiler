// Per-profile extraction-time window (#1504): the sheet behind the Library →
// Profiles row's "Target time" entry, the row badge that shows a stored
// window, and the per-machine cache both read from. The server owns the
// windows (GET/PUT /api/profile-time-targets); this module mirrors them so the
// row renders without a request per profile.
//
// The cache is keyed by machine id: the sheet captures the machine id when it
// opens and saves to that machine, so switching the active machine while the
// sheet is open cannot move the write.
import { t, tHtml } from '../../i18n.js';
import { esc, html } from '../../utils.js';
import type { Html } from '../../utils.js';
import { concreteActiveMachineId } from '../../state/index.js';
import { openDetailSheet, requestCloseDetailSheet } from '../../components/detail-sheet.js';
import { markFieldInvalid } from '../../components/field-error.js';
import { CLOCK_ICON_SVG, CHECK_ICON_SVG } from '../../icons.js';
import { getProfileTimeTargets, putProfileTimeTarget } from '../../api/shots.js';
import type { ProfileTimeTarget } from '../../api/shots.js';

const MIN_S = 5;
const MAX_S = 300;
const WHOLE_SECONDS = /^\s*\d+\s*$/;

// TS twin of the Go NormalizeProfileName: matching is trimmed and
// case-insensitive.
export function normalizeProfileName(name: string): string {
  return name.trim().toLowerCase();
}

export function formatTimeWindow(minS: number, maxS: number): string {
  return `${minS}–${maxS} s`;
}

const _byMachine = new Map<number, ProfileTimeTarget[]>();
let _open: { machineId: number; profileName: string } | null = null;
let _onChange: (() => void) | null = null;

// Slice 7 passes the profile-list re-render; a save or a removal calls it.
export function setProfileTimeTargetsChanged(fn: (() => void) | null): void {
  _onChange = fn;
}

export async function loadProfileTimeTargets(machineId: number | null): Promise<void> {
  if (machineId === null) return;
  const list = await getProfileTimeTargets(machineId);
  if (list) _byMachine.set(machineId, list);
}

export function profileTimeTargetFor(machineId: number | null, profileName: string): ProfileTimeTarget | null {
  if (machineId === null) return null;
  const wanted = normalizeProfileName(profileName);
  if (!wanted) return null;
  const rows = _byMachine.get(machineId);
  return rows?.find(r => normalizeProfileName(r.profileName) === wanted) ?? null;
}

function _profileName(p: { name?: unknown }): string {
  return typeof p.name === 'string' ? p.name.trim() : '';
}

// Utility profiles have no extraction of their own, and "all machines" mode has
// no single machine to store a window for.
export function profileTimeTargetMenuItem(p: { name?: unknown; utility?: unknown }): Html {
  const name = _profileName(p);
  if (p.utility || concreteActiveMachineId() === null || !name) return html``;
  return html`<button type="button" class="lib-sheet-menu-item" data-action="profile-time-target" data-name="${esc(name)}">${CLOCK_ICON_SVG} ${tHtml('profile_time_target_title')}</button>`;
}

export function profileTimeTargetBadge(p: { name?: unknown; utility?: unknown }): Html {
  if (p.utility) return html``;
  const w = profileTimeTargetFor(concreteActiveMachineId(), _profileName(p));
  if (!w) return html``;
  return html`<span class="badge">${esc(formatTimeWindow(w.minS, w.maxS))}</span>`;
}

function _numberRow(id: string, label: Html, value: number | null): Html {
  return html`<div class="settings-row settings-row-static">
        <label class="settings-row-title" for="${esc(id)}">${label}</label>
        <input type="number" id="${esc(id)}" class="lib-input" inputmode="numeric" min="5" max="300" step="1" value="${esc(value === null ? '' : String(value))}">
      </div>`;
}

function _sheetBody(existing: ProfileTimeTarget | null): Html {
  return html`<p class="settings-card-desc">${tHtml('profile_time_target_hint')}</p>
    <div class="settings-group">
      ${_numberRow('pttMin', tHtml('profile_time_target_min'), existing?.minS ?? null)}
      ${_numberRow('pttMax', tHtml('profile_time_target_max'), existing?.maxS ?? null)}
    </div>
    ${existing ? html`<button type="button" class="btn btn--quiet" data-action="clear-profile-time-target">${tHtml('profile_time_target_clear')}</button>` : html``}`;
}

export function openProfileTimeTargetSheet(profileName: string, anchor: HTMLElement | null): void {
  const machineId = concreteActiveMachineId();
  const name = profileName.trim();
  if (machineId === null || !name) return;
  const mine = { machineId, profileName: name };
  _open = mine;
  const existing = profileTimeTargetFor(machineId, name);
  openDetailSheet({
    title: t('profile_time_target_title'),
    sub: name,
    body: _sheetBody(existing),
    actions: html`<button type="button" class="lib-sheet-iconbtn" data-action="save-profile-time-target" aria-label="${tHtml('profile_time_target_save')}" title="${tHtml('profile_time_target_save')}">${CHECK_ICON_SVG}</button>`,
    anchor,
    // A stale close (the sheet was replaced by another open) must not clear
    // the handle of the sheet that replaced it.
    onClose: () => { if (_open === mine) _open = null; },
  });
}

export function parseTimeWindowInputs(minRaw: string, maxRaw: string): { minS: number; maxS: number } | null {
  if (!WHOLE_SECONDS.test(minRaw) || !WHOLE_SECONDS.test(maxRaw)) return null;
  const minS = Number(minRaw);
  const maxS = Number(maxRaw);
  if (!(minS >= MIN_S && minS < maxS && maxS <= MAX_S)) return null;
  return { minS, maxS };
}

function _input(id: string): HTMLInputElement | null {
  return document.getElementById(id) as HTMLInputElement | null;
}

function _wholeOrNull(raw: string): number | null {
  return WHOLE_SECONDS.test(raw) ? Number(raw) : null;
}

// The first failing field: min when it is not a whole number in range or not
// below max, else max.
function _firstInvalidField(minInput: HTMLInputElement | null, maxInput: HTMLInputElement | null): HTMLInputElement | null {
  const minS = _wholeOrNull(minInput?.value ?? '');
  const maxS = _wholeOrNull(maxInput?.value ?? '');
  if (minS === null || minS < MIN_S || minS > MAX_S) return minInput;
  if (maxS === null || maxS < MIN_S || maxS > MAX_S || minS >= maxS) return maxInput;
  return minInput;
}

export async function saveProfileTimeTargetFromSheet(): Promise<void> {
  const sheet = _open;
  if (!sheet) return;
  const minInput = _input('pttMin');
  const maxInput = _input('pttMax');
  const parsed = parseTimeWindowInputs(minInput?.value ?? '', maxInput?.value ?? '');
  if (!parsed) {
    markFieldInvalid(_firstInvalidField(minInput, maxInput));
    window.showToast?.(t('profile_time_target_invalid'));
    return;
  }
  const r = await putProfileTimeTarget({
    machineId: sheet.machineId,
    profileName: sheet.profileName,
    minS: parsed.minS,
    maxS: parsed.maxS,
  });
  if (r.ok) {
    _byMachine.set(sheet.machineId, (await r.json()) as ProfileTimeTarget[]);
    requestCloseDetailSheet();
    window.showToast?.(t('profile_time_target_saved'));
    _onChange?.();
  } else if (r.status === 400) {
    window.showToast?.(t('profile_time_target_invalid'));
  } else {
    window.showToast?.(t('error_generic', r.status));
  }
}

export async function clearProfileTimeTarget(): Promise<void> {
  const sheet = _open;
  if (!sheet) return;
  const r = await putProfileTimeTarget({
    machineId: sheet.machineId,
    profileName: sheet.profileName,
    minS: null,
    maxS: null,
  });
  if (!r.ok) {
    window.showToast?.(t('error_generic', r.status));
    return;
  }
  _byMachine.set(sheet.machineId, (await r.json()) as ProfileTimeTarget[]);
  requestCloseDetailSheet();
  _onChange?.();
}
