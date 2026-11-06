// The settings-backup sheet of one Gaggiuino machine (#1878, U1). It is opened
// from the "Backups" row action of Settings → Machines (wired in slice W) and
// shows the list, Back up now with an optional note, Upload, Download and
// Delete, plus a fold with the backups of deleted machines (Max decision 4:
// deleting a machine keeps its backups, they stay downloadable and deletable).
// U2 adds restore and the per-machine automatic-backup settings; every async
// continuation checks it still belongs to the open sheet's machine. U3 adds the
// compare view: tick two backups and read their differences in plain words.
import { S } from '../state/index.js';
import { t, tHtml } from '../i18n.js';
import { localeFor } from '../constants.js';
import { esc, html, joinHtml, shareOrDownloadBlob } from '../utils.js';
import type { Html } from '../utils.js';
import { openDetailSheet } from './detail-sheet.js';
import { showToast } from './toast.js';
import {
  backUpMachineNow, deleteMachineBackup, downloadMachineBackup, getMachineBackup, getMachineBackupSettings,
  listMachineBackups, restoreMachineBackup, saveMachineBackupSettings, uploadMachineBackup,
} from '../api/machine-backups.js';
import { diffMachineBackups } from '../shared/machine-backup-diff.js';
import type { BackupChange, KeyPath, LeafChange, ProfileRef, ValueChange } from '../shared/machine-backup-diff.js';
import type { MachineBackupFailure } from '../api/machine-backups.js';
import { getFirmwareVersion } from '../api/machines.js'; // already answers installed: null when unreachable
import type {
  MachineBackup, MachineBackupDocument, MachineBackupErrorCode, MachineBackupKind, MachineBackupSchedule,
  MachineBackupSettings, MachineBusyReason,
} from '../api/types.js';

interface RestoreDraft {
  readonly entryId: number;
  targetId: number | null;
  installed: string | null; // the target's installed core, null until it is read
}

interface CompareView {
  readonly from: MachineBackup; // the older one
  readonly to: MachineBackup; // the newer one
  readonly changes: readonly BackupChange[];
}

interface SheetState {
  readonly machineId: number;
  entries: MachineBackup[] | null; // this machine's backups, newest first; null while loading
  orphans: MachineBackup[]; // backups of deleted machines (decision 4)
  failed: boolean; // the first load failed
  note: string; // the Back up now note field, kept across re-renders
  restore?: RestoreDraft | null; // the open restore confirmation, null for the list
  picked?: number[]; // ids ticked for compare, at most what the user ticked
  compare?: CompareView | null; // the open compare view, null for the list
  comparing?: boolean; // the two detail reads are in flight
}

/** The ticked ids; the field stays optional so the list renders without it. */
function pickedIds(sheet: SheetState): number[] {
  sheet.picked ??= [];
  return sheet.picked;
}

/** One machine's wait for its restart after a restore (#1876 pattern). */
export interface RestoreWait {
  readonly startedAt: number;
  seenDown: boolean; // the poll saw the machine unreachable at least once
  timer?: ReturnType<typeof setTimeout>;
}

let _sheet: SheetState | null = null; // the open sheet; one sheet at a time, but it names its machine
const _busy = new Set<number>(); // machineIds with a running Back up now / Upload / Restore
const _restoreWaits = new Map<number, RestoreWait>(); // target machineId -> its restart wait
const _settings = new Map<number, MachineBackupSettings>(); // machineId -> its schedule/retention
export const MAX_UPLOAD_BYTES = 256 * 1024;
export const RESTORE_POLL_MS = 3000;
export const RESTORE_WAIT_MAX_MS = 3 * 60 * 1000;
export const RESTORE_MIN_BACK_MS = 15000; // before an outage, only a later answer counts as "back"
export type BackupContext = 'backup' | 'upload' | 'download' | 'delete' | 'restore' | 'settings' | 'compare';
const KIND_KEYS: Record<MachineBackupKind, string> = {
  manual: 'mbk_kind_manual', scheduled: 'mbk_kind_scheduled', pre_update: 'mbk_kind_pre_update', uploaded: 'mbk_kind_uploaded',
};
const ERROR_KEYS: Record<MachineBackupErrorCode, string> = {
  unsupported_machine: 'mbk_err_unsupported_machine', unsupported_firmware: 'mbk_err_unsupported_firmware',
  machine_unreachable: 'mbk_err_unreachable', invalid_backup: 'mbk_err_invalid_backup',
  machine_busy: 'mbk_err_busy', operation_running: 'mbk_err_operation_running',
  pre_update_backup_failed: 'mbk_preupdate_failed', pending_profile_changes: 'mbk_err_pending_profiles',
  restore_rejected: 'mbk_err_rejected', no_confirmation: 'mbk_restore_unknown',
  pre_restore_backup_failed: 'mbk_err_pre_restore',
};
const BUSY_KEYS: Record<MachineBusyReason, string> = {
  brew: 'mbk_err_busy_brew', steam: 'mbk_err_busy_steam', descale: 'mbk_err_busy_descale', firmware_update: 'mbk_err_busy_firmware_update',
};
const SCHEDULE_KEYS: Record<MachineBackupSchedule, string> = {
  daily: 'mbk_schedule_daily', weekly: 'mbk_schedule_weekly', off: 'mbk_schedule_off',
};
const SCHEDULE_ORDER: readonly MachineBackupSchedule[] = ['daily', 'weekly', 'off'];

const isSchedule = (v: string): v is MachineBackupSchedule => Object.hasOwn(SCHEDULE_KEYS, v);

// Compare view labels (decision 6): the important fields get a translated name
// and a unit, every other key is humanised from its raw English key. Every
// lookup goes through Object.hasOwn: the keys come from documents, so
// __proto__/constructor/toString must never resolve a prototype value.
type Label = readonly [key: string, unit: string];
const SETTING_LABELS: Readonly<Record<string, Label>> = {
  'boiler.steamSetPoint': ['mbk_lbl_steam_temp', '°C'], 'boiler.offsetTemp': ['mbk_lbl_temp_offset', '°C'],
  'system.machineName': ['mbk_lbl_machine_name', ''], 'system.autoFlushDurationSeconds': ['mbk_lbl_auto_flush', 's'],
  'system.minShotDurationSeconds': ['mbk_lbl_min_shot', 's'], 'display.warmupMinutes': ['mbk_lbl_warmup', 'min'],
  'webUi.brewHeaterWatts': ['mbk_lbl_brew_heater', 'W'], 'webUi.steamHeaterWatts': ['mbk_lbl_steam_heater', 'W'],
  'webUi.pumpWatts': ['mbk_lbl_pump_power', 'W'], 'webUi.idleWatts': ['mbk_lbl_idle_power', 'W'],
};
const PROFILE_LABELS: Readonly<Record<string, Label>> = {
  waterTemperature: ['mbk_lbl_water_temp', '°C'], 'recipe.coffeeIn': ['mbk_lbl_dose', 'g'],
  'recipe.coffeeOut': ['mbk_lbl_yield', 'g'], 'globalStopConditions.weight': ['mbk_lbl_stop_weight', 'g'],
};
const CATEGORY_KEYS: Readonly<Record<string, string>> = {
  boiler: 'mbk_cat_boiler', system: 'mbk_cat_system', led: 'mbk_cat_led', scales: 'mbk_cat_scales',
  display: 'mbk_cat_display', theme: 'mbk_cat_theme', webUi: 'mbk_cat_webui',
};
const FIRMWARE_KEYS: Readonly<Record<string, string>> = {
  core: 'settings_machine_firmware_stage_c_fw', frontend: 'settings_machine_firmware_stage_f_fw',
};
const PHASE_KEYS: Record<LeafChange, string> = {
  changed: 'mbk_cmp_phase_changed', added: 'mbk_cmp_phase_added', removed: 'mbk_cmp_phase_removed',
};

const ownEntry = <T>(map: Readonly<Record<string, T>>, key: string): T | undefined =>
  Object.hasOwn(map, key) ? map[key] : undefined;

/** At most `max` code points; a longer string keeps `max - 1` and an ellipsis. */
function clip(s: string, max: number): string {
  const chars = Array.from(s);
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : s;
}

/** A raw document key as plain words: steamSetPoint -> Steam set point, LED -> Led. */
export function humanizeKey(key: string): string {
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[\s_.-]+/g, ' ')
    .trim()
    .split(' ')
    .filter(w => w !== '');
  const first = words[0];
  if (first === undefined) {
    const raw = clip(key, 60);
    return raw === '' ? '?' : raw;
  }
  const head = `${first.charAt(0).toUpperCase()}${first.slice(1).toLowerCase()}`;
  return clip([head, ...words.slice(1).map(w => w.toLowerCase())].join(' '), 60);
}

/** A document value as plain text; null means "no readable value" (object, array, undefined). */
function formatValue(v: unknown, unit: string): string | null {
  if (typeof v === 'boolean') return v ? t('mbk_yes') : t('mbk_no');
  if (v === 'true' || v === 'false') return v === 'true' ? t('mbk_yes') : t('mbk_no');
  if (typeof v === 'number' && Number.isFinite(v)) return unit === '' ? String(v) : `${v} ${unit}`;
  if (v === '') return '""';
  if (typeof v === 'string') return clip(v, 40);
  if (v === null) return '—';
  return null;
}

function valueSentence(label: string, c: ValueChange, unit: string): string {
  if (c.change === 'added') return t('mbk_cmp_added', label, formatValue(c.to, unit) ?? '');
  if (c.change === 'removed') return t('mbk_cmp_removed', label, formatValue(c.from, unit) ?? '');
  const from = formatValue(c.from, unit);
  const to = formatValue(c.to, unit);
  return from !== null && to !== null ? t('mbk_cmp_changed', label, from, to) : t('mbk_cmp_changed_plain', label);
}

function profileName(ref: ProfileRef): string {
  if (ref.name !== null) return clip(ref.name, 40);
  return ref.id !== null ? `#${ref.id}` : '?';
}

function nameOr(name: string | null, ref: ProfileRef): string {
  return name !== null ? clip(name, 40) : profileName(ref);
}

function settingLabel(path: KeyPath): Label {
  const [head, ...rest] = path;
  const known = ownEntry(CATEGORY_KEYS, head);
  const category = known === undefined ? humanizeKey(head) : t(known);
  const curated = ownEntry(SETTING_LABELS, path.join('.'));
  if (curated !== undefined) return [`${category} · ${t(curated[0])}`, curated[1]];
  return [rest.length === 0 ? category : `${category} · ${rest.map(humanizeKey).join(' · ')}`, ''];
}

function profileFieldLabel(path: KeyPath): Label {
  const curated = ownEntry(PROFILE_LABELS, path.join('.'));
  return curated !== undefined ? [t(curated[0]), curated[1]] : [path.map(humanizeKey).join(' · '), ''];
}

function firmwareLabel(path: KeyPath): string {
  for (const segment of path) {
    const key = ownEntry(FIRMWARE_KEYS, segment);
    if (key !== undefined) return t(key);
  }
  return path.map(humanizeKey).join(' · ');
}

/** One change as a plain sentence; it reaches the DOM only through esc(). */
export function describeChange(c: BackupChange): string {
  switch (c.kind) {
    case 'firmware': return valueSentence(firmwareLabel(c.path), c, '');
    case 'setting': {
      const [label, unit] = settingLabel(c.path);
      return valueSentence(label, c, unit);
    }
    case 'defaultProfile': return t('mbk_cmp_default_profile', profileName(c.from), profileName(c.to));
    case 'profileAdded': return t('mbk_cmp_profile_added', profileName(c.profile));
    case 'profileRemoved': return t('mbk_cmp_profile_removed', profileName(c.profile));
    case 'profileRenamed': return t('mbk_cmp_profile_renamed', nameOr(c.from, c.profile), nameOr(c.to, c.profile));
    case 'profilePhase': return t(PHASE_KEYS[c.change], profileName(c.profile), c.phase);
    case 'profileField': {
      const [label, unit] = profileFieldLabel(c.path);
      return valueSentence(`${t('mbk_cmp_profile', profileName(c.profile))} · ${label}`, c, unit);
    }
    case 'pumpCalibration': return t('mbk_cmp_pump');
    case 'other': return valueSentence(humanizeKey(c.key), c, '');
  }
}

function machineName(id: number): string {
  const name = S.machines.find(m => m.id === id)?.name;
  return typeof name === 'string' && name !== '' ? name : `#${id}`;
}

function registeredIds(): ReadonlySet<number> | null {
  if (!S.machines.length) return null;
  return new Set(S.machines.map(m => m.id));
}

/** Own backups of `machineId`, and the ones of machines that no longer exist. `registered`
 *  null means S.machines has not loaded yet: then nothing is called deleted. */
export function splitBackups(
  all: readonly MachineBackup[], machineId: number, registered: ReadonlySet<number> | null,
): { own: MachineBackup[]; orphans: MachineBackup[] } {
  const own = all.filter(b => b.machineId === machineId);
  const orphans = registered === null ? [] : all.filter(b => !registered.has(b.machineId));
  return { own, orphans };
}

function formatBackupDate(ms: number, locale: string): string {
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(ms);
}

export function relativeTime(ms: number, nowMs: number, locale: string): string {
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  const minutes = Math.round((ms - nowMs) / 60000);
  if (Math.abs(minutes) < 60) return rtf.format(minutes, 'minute');
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 48) return rtf.format(hours, 'hour');
  return rtf.format(Math.round(hours / 24), 'day');
}

/** The server's own `error` text never reaches the UI; only a code is translated. */
export function backupErrorText(f: MachineBackupFailure, context: BackupContext): string {
  if (context === 'upload') {
    if (f.status === 413) return t('mbk_upload_too_large');
    if (f.code === 'invalid_backup' || (f.code === null && f.status === 400)) return t('mbk_upload_invalid');
  }
  // The machine's own text (untrusted) only ever reaches a toast, never innerHTML.
  if (f.code === 'restore_rejected') return t('mbk_err_rejected', f.machineError ?? '');
  if (f.code === 'machine_busy' && f.reason !== null) return t(BUSY_KEYS[f.reason]);
  if (f.code !== null) return t(ERROR_KEYS[f.code]);
  if (f.status === 404) return t('mbk_err_not_found');
  if (f.status === 429) return t('mbk_err_rate_limited');
  return t('mbk_err_generic');
}

/** Unknown outcome: never say whether anything was restored (the machine may be restarting). */
export function restoreOutcomeUnknown(f: MachineBackupFailure): boolean {
  return f.code === 'no_confirmation' || f.status === 0 || (f.code === null && f.status >= 500);
}

/** A short and a long form of one hash count as equal. */
export function firmwareDiffers(backupFw: string, installed: string | null): boolean {
  const a = backupFw.trim().toLowerCase();
  const b = (installed ?? '').trim().toLowerCase();
  if (a === '' || b === '') return false;
  return !a.startsWith(b) && !b.startsWith(a);
}

/** The Gaggiuino machines a deleted machine's backup may be restored onto. */
function gaggiuinoMachines(): { id: number; name: string }[] {
  return S.machines.filter(m => m.type === 'gaggiuino').map(m => ({ id: m.id, name: machineName(m.id) }));
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Quick local check of a picked file; the server validates format, version and size again. */
export function parseBackupFile(text: string): MachineBackupDocument | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return null;
  }
  if (!isPlainObject(parsed) || !Object.hasOwn(parsed, 'format')) return null;
  return parsed.format === 'gaggiuino-settings' ? parsed : null;
}

/** The row action slice W adds to every Gaggiuino machine row. */
export function machineBackupsButtonHtml(): Html {
  return html`<button type="button" class="machine-backups-btn">${tHtml('mbk_row_action')}</button>`;
}

/** The update did not start because the backup before it failed. True is the user's
 *  deliberate "update without a backup" (Max decision 1); slice W resends with skipBackup.
 *  A native confirm (like deleteMachine) wraps on every width; a toast with an action
 *  cannot, toast.ts pins white-space:nowrap. */
export function confirmUpdateWithoutBackup(): boolean {
  return confirm(`${t('mbk_preupdate_failed')}\n\n${t('mbk_preupdate_confirm')}`);
}

/** Trimmed note, or undefined when the user typed nothing (then no note is sent). 200 code points. */
export function cleanNote(raw: string): string | undefined {
  const s = raw.trim();
  return s === '' ? undefined : Array.from(s).slice(0, 200).join('');
}

function renderRow(b: MachineBackup, locale: string, owner: Html | null, restoreDisabled: boolean, picked = false): Html {
  const date = formatBackupDate(b.createdAt, locale);
  const meta: string[] = [];
  if (b.firmwareCore !== '') meta.push(t('settings_machine_firmware_badge_current', b.firmwareCore));
  meta.push(t('mbk_profiles', b.profileCount), t('mbk_size_kb', Math.max(1, Math.round(b.sizeBytes / 1024))));
  const noRestore = restoreDisabled ? html` disabled` : esc('');
  return html`<div class="mbk-row">
    ${owner === null ? esc('') : html`<div class="mbk-owner">${owner}</div>`}
    <div class="mbk-row-head"><label class="mbk-pick-wrap"><input type="checkbox" class="mbk-pick" data-id="${esc(b.id)}" aria-label="${esc(t('mbk_pick', date))}"${picked ? html` checked` : esc('')}></label><span class="mbk-date">${esc(date)}</span><span class="mbk-chip mbk-chip-${esc(b.kind)}">${esc(t(KIND_KEYS[b.kind]))}</span></div>
    <div class="mbk-meta">${esc(meta.join(' · '))}</div>
    ${b.note === '' ? esc('') : html`<div class="mbk-note">${esc(b.note)}</div>`}
    <div class="mbk-row-actions">
      <button type="button" class="mbk-btn" data-mbk-action="download" data-id="${esc(b.id)}">${tHtml('mbk_download')}</button>
      <button type="button" class="mbk-btn" data-mbk-action="restore" data-id="${esc(b.id)}"${noRestore}>${tHtml('mbk_restore')}</button>
      <button type="button" class="mbk-btn" data-mbk-action="delete" data-id="${esc(b.id)}">${tHtml('mbk_delete')}</button>
    </div>
  </div>`;
}

const optionHtml = (value: string, label: Html, selected: boolean): Html =>
  html`<option value="${esc(value)}"${selected ? html` selected` : esc('')}>${label}</option>`;

function renderRestore(sheet: SheetState, draft: RestoreDraft, entry: MachineBackup, locale: string): Html {
  const orphan = sheet.orphans.some(b => b.id === entry.id);
  const targetId = draft.targetId;
  const blocked = targetId === null || _busy.has(targetId) || _restoreWaits.has(targetId);
  const noConfirm = blocked ? html` disabled` : esc('');
  const parts: Html[] = [html`<section class="mbk-restore">
    <h3 class="mbk-restore-title">${esc(t('mbk_restore_title', formatBackupDate(entry.createdAt, locale)))}</h3>
    <p>${tHtml('mbk_restore_body')}</p>
    <p class="mbk-hint">${tHtml('mbk_restore_before')}</p>`];
  if (firmwareDiffers(entry.firmwareCore, draft.installed)) {
    parts.push(html`<p class="mbk-warn" role="note">${esc(t('mbk_restore_fw_mismatch', entry.firmwareCore, draft.installed ?? ''))}</p>`);
  }
  if (orphan) {
    const options = gaggiuinoMachines().map(m => optionHtml(String(m.id), esc(m.name), m.id === draft.targetId));
    parts.push(html`<label class="mbk-field"><span>${tHtml('mbk_restore_target')}</span><select class="mbk-select mbk-target">${joinHtml(options)}</select></label>`);
  }
  parts.push(html`<div class="mbk-actions">
      <button type="button" class="mbk-btn" data-mbk-action="restore-cancel">${tHtml('settings_machine_cancel')}</button>
      <button type="button" class="mbk-btn mbk-btn-danger" data-mbk-action="restore-confirm"${noConfirm}>${tHtml('mbk_restore_confirm')}</button>
    </div>
  </section>`);
  return joinHtml(parts);
}

/** Schedule and retention of one machine (11-03 item 1/3). */
function renderSettings(settings: MachineBackupSettings, open: boolean): Html {
  const options = SCHEDULE_ORDER.map(v => optionHtml(v, tHtml(SCHEDULE_KEYS[v]), v === settings.schedule));
  return html`<details class="mbk-fold" data-fold="auto"${open ? html` open` : esc('')}><summary>${tHtml('mbk_auto_title')}</summary>
    <label class="mbk-field"><span>${tHtml('mbk_schedule')}</span><select class="mbk-select mbk-schedule">${joinHtml(options)}</select></label>
    <label class="mbk-field"><span>${tHtml('mbk_keep')}</span><input class="mbk-input mbk-keep" type="number" min="1" max="100" step="1" inputmode="numeric" value="${esc(settings.keepAutomatic)}"></label>
    <p class="mbk-hint">${esc(t('mbk_keep_hint', settings.keepAutomatic))}</p>
  </details>`;
}

/** The compare view of two backups: one sentence per change, oldest first. */
function renderCompare(view: CompareView, locale: string): Html {
  const n = view.changes.length;
  const parts: Html[] = [html`<section class="mbk-cmp">
    <div class="mbk-actions"><button type="button" class="mbk-btn" data-mbk-action="cmp-back">${tHtml('mbk_cmp_back')}</button></div>
    <p class="mbk-verdict">${esc(`${formatBackupDate(view.from.createdAt, locale)} → ${formatBackupDate(view.to.createdAt, locale)}`)}${n > 0 ? esc(` · ${t('mbk_cmp_count', n)}`) : esc('')}</p>`];
  if (n > 0) {
    parts.push(html`<ul class="mbk-cmp-list">${joinHtml(view.changes.map(c => html`<li>${esc(describeChange(c))}</li>`))}</ul>`);
  } else if (view.from.contentHash === view.to.contentHash) {
    parts.push(html`<p class="mbk-cmp-empty">${tHtml('mbk_cmp_identical')}</p>`);
    parts.push(html`<p class="mbk-cmp-egg">${tHtml('mbk_cmp_identical_egg')}</p>`);
  } else {
    // Same content hash would have meant identical; a different hash with no
    // reported change is profile order or formatting only (C1 decision 11-05).
    parts.push(html`<p class="mbk-cmp-empty">${tHtml('mbk_cmp_order_only')}</p>`);
  }
  parts.push(html`</section>`);
  return joinHtml(parts);
}

export function renderSheetBody(sheet: SheetState, nowMs: number, openFolds: ReadonlySet<string>): Html {
  const locale = localeFor(S.currentLang);
  const draft = sheet.restore ?? null;
  if (draft !== null) {
    const entry = sheet.entries?.find(b => b.id === draft.entryId) ?? sheet.orphans.find(b => b.id === draft.entryId) ?? null;
    if (entry !== null) return renderRestore(sheet, draft, entry, locale);
  }
  if (sheet.compare) return renderCompare(sheet.compare, locale);
  const picked = pickedIds(sheet);
  const waiting = _busy.has(sheet.machineId) || _restoreWaits.has(sheet.machineId);
  const busy = waiting ? html` disabled` : esc('');
  const comparable = (sheet.entries?.length ?? 0) + sheet.orphans.length >= 2;
  const compareDisabled = picked.length === 2 && !sheet.comparing ? esc('') : html` disabled`;
  const parts: Html[] = [html`<div class="mbk-toolbar">
    <label class="mbk-field mbk-note-field"><span>${tHtml('mbk_note_label')}</span><input type="text" class="mbk-input mbk-note-input" maxlength="200" autocomplete="off" placeholder="${esc(t('mbk_note_placeholder'))}" value="${esc(sheet.note)}"></label>
    <button type="button" class="mbk-btn mbk-btn-primary" data-mbk-action="backup"${busy}>${tHtml('mbk_backup_now')}</button>
    <button type="button" class="mbk-btn" data-mbk-action="upload"${busy}>${tHtml('mbk_upload')}</button>
    ${comparable ? html`<button type="button" class="mbk-btn" data-mbk-action="compare"${compareDisabled}>${tHtml('mbk_compare')}</button>` : esc('')}
    <input type="file" class="mbk-file" accept=".json,application/json" hidden>
  </div>`];
  if (picked.length > 0 && picked.length !== 2) parts.push(html`<p class="mbk-hint">${tHtml('mbk_compare_hint')}</p>`);
  if (_restoreWaits.has(sheet.machineId)) {
    parts.push(html`<p class="mbk-status" role="status">${tHtml('settings_machine_firmware_restarting')}</p>`);
  }
  if (sheet.entries === null) {
    parts.push(html`<p class="mbk-verdict">${tHtml(sheet.failed ? 'error_load' : 'please_wait')}</p>`);
  } else if (sheet.entries.length === 0) {
    parts.push(html`<p class="mbk-verdict">${tHtml('mbk_empty')}</p>`);
  } else {
    const newest = Math.max(...sheet.entries.map(b => b.createdAt));
    parts.push(html`<p class="mbk-verdict">${esc(t('mbk_verdict', sheet.entries.length, relativeTime(newest, nowMs, locale)))}</p>`);
    parts.push(html`<div class="mbk-list">${joinHtml(sheet.entries.map(b => renderRow(b, locale, null, waiting, picked.includes(b.id))))}</div>`);
  }
  if (sheet.orphans.length > 0) {
    const open = openFolds.has('deleted') ? html` open` : esc('');
    parts.push(html`<details class="mbk-fold" data-fold="deleted"${open}><summary>${tHtml('mbk_deleted_machines')} <span class="mbk-fold-count">${esc(sheet.orphans.length)}</span></summary><div class="mbk-list">${joinHtml(sheet.orphans.map(b => renderRow(b, locale, esc(t('mbk_deleted_machine', b.machineId)), waiting, picked.includes(b.id))))}</div></details>`);
  }
  const settings = _settings.get(sheet.machineId);
  if (settings !== undefined) parts.push(renderSettings(settings, openFolds.has('auto')));
  return joinHtml(parts);
}

function rerender(): void {
  const sheet = _sheet;
  if (!sheet) return;
  const el = document.getElementById('mbkSheet');
  if (!el || el.dataset.machineId !== String(sheet.machineId)) return;
  const open = new Set<string>();
  for (const d of el.querySelectorAll<HTMLDetailsElement>('details[data-fold]')) {
    const fold = d.dataset.fold;
    if (d.open && fold !== undefined) open.add(fold);
  }
  el.innerHTML = renderSheetBody(sheet, Date.now(), open);
}

export async function openMachineBackups(machineId: number, anchor: HTMLElement | null): Promise<void> {
  const sheet: SheetState = {
    machineId, entries: null, orphans: [], failed: false, note: '', restore: null, picked: [], compare: null, comparing: false,
  };
  _sheet = sheet;
  openDetailSheet({
    title: t('mbk_title', machineName(machineId)),
    body: html`<div class="mbk-sheet" id="mbkSheet" data-machine-id="${esc(machineId)}">${renderSheetBody(sheet, Date.now(), new Set())}</div>`,
    anchor,
  });
  // A fresh #mbkSheet on every open, so the listeners never stack.
  const el = document.getElementById('mbkSheet');
  el?.addEventListener('click', onSheetClick);
  el?.addEventListener('change', onSheetChange);
  el?.addEventListener('input', onSheetInput);
  await Promise.all([reload(machineId), loadSettings(machineId)]);
}

/** This machine's schedule and retention; a failure (e.g. 501 for GaggiMate) hides the fold. */
async function loadSettings(machineId: number): Promise<void> {
  const r = await getMachineBackupSettings(machineId);
  if (r.ok) _settings.set(machineId, r.value);
  else _settings.delete(machineId);
  if (_sheet?.machineId === machineId) rerender();
}

async function reload(machineId: number): Promise<void> {
  // One call gives this machine's backups and the deleted machines' (decision 4).
  const r = await listMachineBackups(null);
  const sheet = _sheet;
  if (!sheet || sheet.machineId !== machineId) return;
  if (r.ok) {
    const split = splitBackups(r.value, machineId, registeredIds());
    sheet.entries = split.own;
    sheet.orphans = split.orphans;
    sheet.failed = false;
    const live = new Set([...split.own, ...split.orphans].map(b => b.id));
    sheet.picked = pickedIds(sheet).filter(id => live.has(id));
  } else if (sheet.entries === null) {
    sheet.failed = true; // an already shown list stays
  }
  rerender();
}

function onSheetClick(e: Event): void {
  const btn = (e.target as Element | null)?.closest<HTMLElement>('[data-mbk-action]') ?? null;
  if (btn === null) return;
  const raw = btn.dataset.id;
  const id = raw === undefined ? null : Number(raw);
  void runAction(btn.dataset.mbkAction ?? '', id !== null && Number.isInteger(id) && id > 0 ? id : null);
}

async function runAction(action: string, id: number | null): Promise<void> {
  const sheet = _sheet;
  if (!sheet) return;
  const machineId = sheet.machineId;
  if (action === 'backup') { await backUpNow(machineId, cleanNote(sheet.note)); return; }
  if (action === 'upload') { document.getElementById('mbkSheet')?.querySelector<HTMLInputElement>('.mbk-file')?.click(); return; }
  if (action === 'restore-cancel') { sheet.restore = null; rerender(); return; }
  if (action === 'compare') { void compareSelected(); return; }
  if (action === 'cmp-back') { sheet.compare = null; rerender(); return; } // the picks stay
  if (action === 'restore-confirm') { void confirmRestore(); return; }
  if (id === null) return;
  if (action === 'restore') { openRestore(id); return; }
  if (action === 'download') { await downloadBackup(id); return; }
  if (action === 'delete') await deleteBackup(machineId, id);
}

/** Only a deleted machine's backup offers a target choice (Max 11-05 item 2). */
function openRestore(id: number): void {
  const sheet = _sheet;
  if (!sheet || sheet.entries === null) return;
  const entry = sheet.entries.find(b => b.id === id) ?? sheet.orphans.find(b => b.id === id) ?? null;
  if (entry === null) return;
  const orphan = sheet.orphans.some(b => b.id === id);
  const targets = gaggiuinoMachines();
  const targetId = orphan
    ? (targets.some(m => m.id === sheet.machineId) ? sheet.machineId : targets[0]?.id ?? null)
    : entry.machineId;
  sheet.restore = { entryId: id, targetId, installed: null };
  rerender();
  if (targetId !== null) void loadTargetFirmware(sheet.machineId, id, targetId);
}

/** Applies only while the sheet still shows the same machine and the same draft. */
async function loadTargetFirmware(sheetMachineId: number, entryId: number, targetId: number): Promise<void> {
  let installed: string | null = null;
  try {
    installed = (await getFirmwareVersion(targetId))?.installed ?? null;
  } catch {
    // A throw is "no answer": no mismatch warning, exactly like a null.
  }
  const sheet = _sheet;
  if (!sheet || sheet.machineId !== sheetMachineId) return;
  const draft = sheet.restore;
  if (!draft || draft.entryId !== entryId || draft.targetId !== targetId) return;
  draft.installed = installed;
  rerender();
}

export function restoreWaitStep(w: RestoreWait, reachable: boolean, now: number): 'wait' | 'back' | 'timeout' {
  const elapsed = now - w.startedAt;
  if (reachable && (w.seenDown || elapsed >= RESTORE_MIN_BACK_MS)) return 'back';
  if (!reachable) w.seenDown = true;
  return elapsed >= RESTORE_WAIT_MAX_MS ? 'timeout' : 'wait';
}

/** The #1876 pattern, keyed by target machineId; it outlives the sheet. */
function startRestoreWait(machineId: number): void {
  const w: RestoreWait = { startedAt: Date.now(), seenDown: false };
  _restoreWaits.set(machineId, w);
  w.timer = setTimeout(() => { void restoreWaitTick(machineId, w); }, RESTORE_POLL_MS);
}

/** Every step returns once a newer wait replaced this one. */
async function restoreWaitTick(machineId: number, w: RestoreWait): Promise<void> {
  if (_restoreWaits.get(machineId) !== w) return;
  let reachable = false;
  try {
    reachable = !!(await getFirmwareVersion(machineId))?.installed;
  } catch {
    // A throw is unreachable; it just keeps `false`.
  }
  if (_restoreWaits.get(machineId) !== w) return;
  const step = restoreWaitStep(w, reachable, Date.now());
  if (step === 'wait') {
    w.timer = setTimeout(() => { void restoreWaitTick(machineId, w); }, RESTORE_POLL_MS);
    return;
  }
  _restoreWaits.delete(machineId);
  showToast(step === 'back'
    ? t('mbk_restore_done', machineName(machineId))
    : t('mbk_restore_still_restarting', machineName(machineId)), 8000);
  rerender();
}

async function confirmRestore(): Promise<void> {
  const sheet = _sheet;
  const draft = sheet?.restore ?? null;
  if (!sheet || draft === null) return;
  const targetId = draft.targetId;
  if (targetId === null || _busy.has(targetId) || _restoreWaits.has(targetId)) return;
  _busy.add(targetId);
  rerender();
  try {
    const r = await restoreMachineBackup(draft.entryId, targetId);
    if (r.ok) {
      startRestoreWait(targetId);
      showToast(t('settings_machine_firmware_restarting'));
    } else {
      showToast(restoreOutcomeUnknown(r) ? t('mbk_restore_unknown') : backupErrorText(r, 'restore'), 8000);
    }
  } finally {
    _busy.delete(targetId);
    if (_sheet === sheet && sheet.restore?.entryId === draft.entryId) sheet.restore = null;
    rerender();
  }
  // The pre-restore backup row appears; also after an unknown outcome.
  if (_sheet === sheet) await reload(sheet.machineId);
}

function onSheetChange(e: Event): void {
  const target = e.target as HTMLInputElement | HTMLSelectElement | null;
  const sheet = _sheet;
  if (!sheet || target === null) return;
  if (target.classList.contains('mbk-file')) {
    const file = (target as HTMLInputElement).files?.[0] ?? null;
    target.value = ''; // the same file can be picked again
    if (file) void uploadBackupFile(sheet.machineId, file);
    return;
  }
  if (target.classList.contains('mbk-target')) { onTargetChange(sheet, target.value); return; }
  if (target.classList.contains('mbk-schedule')) { onScheduleChange(sheet, target.value); return; }
  if (target.classList.contains('mbk-pick')) { onPickChange(sheet, target); return; }
  if (target.classList.contains('mbk-keep')) onKeepChange(sheet, target.value);
}

function onPickChange(sheet: SheetState, target: HTMLInputElement | HTMLSelectElement): void {
  if (!('checked' in target)) return; // only a checkbox ticks a backup
  const id = Number(target.dataset.id);
  const known = sheet.entries?.some(b => b.id === id) ?? false;
  if (!Number.isInteger(id) || id <= 0 || (!known && !sheet.orphans.some(b => b.id === id))) return;
  const picked = pickedIds(sheet);
  sheet.picked = target.checked
    ? (picked.includes(id) ? picked : [...picked, id])
    : picked.filter(p => p !== id);
  rerender();
}

/** Reads both documents and fills the compare view; older backup first, whatever was picked first. */
async function compareSelected(): Promise<void> {
  const sheet = _sheet;
  if (!sheet || sheet.comparing) return;
  const picked = pickedIds(sheet);
  const [p, q] = picked;
  if (picked.length !== 2 || p === undefined || q === undefined) return;
  sheet.comparing = true;
  rerender();
  const [a, b] = await Promise.all([getMachineBackup(p), getMachineBackup(q)]);
  if (_sheet !== sheet) return; // another sheet opened meanwhile
  sheet.comparing = false;
  // Stay on the list; each failure carries its own status/code for the toast.
  if (!a.ok) { showToast(backupErrorText(a, 'compare'), 6000); rerender(); return; }
  if (!b.ok) { showToast(backupErrorText(b, 'compare'), 6000); rerender(); return; }
  const aFirst = a.value.createdAt !== b.value.createdAt
    ? a.value.createdAt < b.value.createdAt
    : a.value.id <= b.value.id;
  const from = aFirst ? a.value : b.value;
  const to = aFirst ? b.value : a.value;
  sheet.compare = { from, to, changes: diffMachineBackups(from.document, to.document) };
  rerender();
}

function onTargetChange(sheet: SheetState, value: string): void {
  const draft = sheet.restore;
  if (!draft || !sheet.orphans.some(b => b.id === draft.entryId)) return;
  const id = Number(value);
  if (!gaggiuinoMachines().some(m => m.id === id)) return;
  draft.targetId = id;
  draft.installed = null;
  rerender();
  void loadTargetFirmware(sheet.machineId, draft.entryId, id);
}

function onScheduleChange(sheet: SheetState, value: string): void {
  const current = _settings.get(sheet.machineId);
  if (!current || !isSchedule(value)) return;
  void saveSettings(sheet.machineId, { machineId: sheet.machineId, schedule: value, keepAutomatic: current.keepAutomatic });
}

function onKeepChange(sheet: SheetState, value: string): void {
  const current = _settings.get(sheet.machineId);
  if (!current) return;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 100) {
    showToast(t('mbk_keep_range'));
    rerender(); // the field snaps back to the stored value
    return;
  }
  if (n === current.keepAutomatic) return;
  void saveSettings(sheet.machineId, { machineId: sheet.machineId, schedule: current.schedule, keepAutomatic: n });
}

async function saveSettings(machineId: number, next: MachineBackupSettings): Promise<void> {
  const r = await saveMachineBackupSettings(next);
  if (r.ok) {
    _settings.set(machineId, r.value);
    showToast(t('autosave_saved'));
  } else {
    showToast(backupErrorText(r, 'settings'), 6000); // the stored value stays
  }
  if (_sheet?.machineId === machineId) rerender();
}

function onSheetInput(e: Event): void {
  const target = e.target as HTMLInputElement | null;
  const sheet = _sheet;
  if (!sheet || target === null || !target.classList.contains('mbk-note-input')) return;
  sheet.note = target.value; // no re-render while typing; the state keeps it
}

async function backUpNow(machineId: number, note: string | undefined): Promise<void> {
  if (_busy.has(machineId)) return;
  _busy.add(machineId);
  rerender();
  try {
    const r = note === undefined ? await backUpMachineNow(machineId) : await backUpMachineNow(machineId, note);
    if (r.ok) {
      showToast(t('mbk_saved'));
      const sheet = _sheet;
      if (sheet?.machineId === machineId) sheet.note = '';
      await reload(machineId);
    } else {
      showToast(backupErrorText(r, 'backup'), 6000);
    }
  } finally {
    _busy.delete(machineId);
    rerender();
  }
}

async function deleteBackup(machineId: number, id: number): Promise<void> {
  if (!confirm(t('mbk_delete_confirm'))) return;
  const r = await deleteMachineBackup(id);
  if (r.ok) showToast(t('mbk_deleted'));
  else showToast(backupErrorText(r, 'delete'), 6000);
  await reload(machineId); // also refreshes after a 404
}

async function downloadBackup(id: number): Promise<void> {
  const r = await downloadMachineBackup(id);
  if (!r.ok) { showToast(backupErrorText(r, 'download'), 6000); return; }
  // The plain-text warning comes before anything is saved.
  if (r.value.secrets === 'merged' && !confirm(t('mbk_download_secrets_confirm'))) return;
  await shareOrDownloadBlob(r.value.blob, r.value.filename, { title: r.value.filename });
  if (r.value.secrets === 'missing') showToast(t('mbk_download_no_secrets'), 6000);
}

async function uploadBackupFile(machineId: number, file: Blob): Promise<void> {
  if (file.size > MAX_UPLOAD_BYTES) { showToast(t('mbk_upload_too_large'), 6000); return; }
  if (_busy.has(machineId)) return;
  _busy.add(machineId);
  rerender();
  try {
    const doc = parseBackupFile(await file.text());
    if (doc === null) { showToast(t('mbk_upload_invalid'), 6000); return; }
    const r = await uploadMachineBackup(machineId, doc);
    if (r.ok) {
      showToast(t('mbk_uploaded'), 6000);
      await reload(machineId);
    } else {
      showToast(backupErrorText(r, 'upload'), 6000);
    }
  } finally {
    _busy.delete(machineId);
    rerender();
  }
}
