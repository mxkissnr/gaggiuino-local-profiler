// The settings-backup sheet of one Gaggiuino machine (#1878, U1). It is opened
// from the "Backups" row action of Settings → Machines (wired in slice W) and
// shows the list, Back up now with an optional note, Upload, Download and
// Delete, plus a fold with the backups of deleted machines (Max decision 4:
// deleting a machine keeps its backups, they stay downloadable and deletable).
// U2 adds restore and the automatic-backup settings, U3 the compare view.
// Every async continuation checks it still belongs to the open sheet's machine:
// in-flight work is keyed by machineId, never by a shared scalar. Notes, names
// and anything from a document reach the DOM only through esc.
import { S } from '../state/index.js';
import { t, tHtml } from '../i18n.js';
import { localeFor } from '../constants.js';
import { esc, html, joinHtml, shareOrDownloadBlob } from '../utils.js';
import type { Html } from '../utils.js';
import { openDetailSheet } from './detail-sheet.js';
import { showToast } from './toast.js';
import { backUpMachineNow, deleteMachineBackup, downloadMachineBackup, listMachineBackups, uploadMachineBackup } from '../api/machine-backups.js';
import type { MachineBackupFailure } from '../api/machine-backups.js';
import type { MachineBackup, MachineBackupDocument, MachineBackupErrorCode, MachineBackupKind } from '../api/types.js';

interface SheetState {
  readonly machineId: number;
  entries: MachineBackup[] | null; // this machine's backups, newest first; null while loading
  orphans: MachineBackup[]; // backups of deleted machines (decision 4)
  failed: boolean; // the first load failed
  note: string; // the Back up now note field, kept across re-renders
}

let _sheet: SheetState | null = null; // the open sheet; one sheet at a time, but it names its machine
const _busy = new Set<number>(); // machineIds with a running Back up now / Upload
export const MAX_UPLOAD_BYTES = 256 * 1024;
export type BackupContext = 'backup' | 'upload' | 'download' | 'delete';
const KIND_KEYS: Record<MachineBackupKind, string> = {
  manual: 'mbk_kind_manual', scheduled: 'mbk_kind_scheduled', pre_update: 'mbk_kind_pre_update', uploaded: 'mbk_kind_uploaded',
};
// U2 turns this into a full Record<MachineBackupErrorCode, string> (busy reasons, restore codes).
const ERROR_KEYS: Partial<Record<MachineBackupErrorCode, string>> = {
  unsupported_machine: 'mbk_err_unsupported_machine', unsupported_firmware: 'mbk_err_unsupported_firmware',
  machine_unreachable: 'mbk_err_unreachable', invalid_backup: 'mbk_err_invalid_backup',
  machine_busy: 'mbk_err_busy', operation_running: 'mbk_err_operation_running',
};

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

/** The translated text for a failed call. The server's own `error` text never reaches here. */
export function backupErrorText(f: MachineBackupFailure, context: BackupContext): string {
  if (context === 'upload') {
    if (f.status === 413) return t('mbk_upload_too_large');
    if (f.code === 'invalid_backup' || (f.code === null && f.status === 400)) return t('mbk_upload_invalid');
  }
  if (f.code !== null) {
    const key = ERROR_KEYS[f.code];
    if (key !== undefined) return t(key);
  }
  if (f.status === 404) return t('mbk_err_not_found');
  if (f.status === 429) return t('mbk_err_rate_limited');
  return t('mbk_err_generic');
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

function renderRow(b: MachineBackup, locale: string, owner: Html | null): Html {
  const meta: string[] = [];
  if (b.firmwareCore !== '') meta.push(t('settings_machine_firmware_badge_current', b.firmwareCore));
  meta.push(t('mbk_profiles', b.profileCount), t('mbk_size_kb', Math.max(1, Math.round(b.sizeBytes / 1024))));
  return html`<div class="mbk-row">
    ${owner === null ? esc('') : html`<div class="mbk-owner">${owner}</div>`}
    <div class="mbk-row-head"><span class="mbk-date">${esc(formatBackupDate(b.createdAt, locale))}</span><span class="mbk-chip mbk-chip-${esc(b.kind)}">${esc(t(KIND_KEYS[b.kind]))}</span></div>
    <div class="mbk-meta">${esc(meta.join(' · '))}</div>
    ${b.note === '' ? esc('') : html`<div class="mbk-note">${esc(b.note)}</div>`}
    <div class="mbk-row-actions">
      <button type="button" class="mbk-btn" data-mbk-action="download" data-id="${esc(b.id)}">${tHtml('mbk_download')}</button>
      <button type="button" class="mbk-btn" data-mbk-action="delete" data-id="${esc(b.id)}">${tHtml('mbk_delete')}</button>
    </div>
  </div>`;
}

export function renderSheetBody(sheet: SheetState, nowMs: number, openFolds: ReadonlySet<string>): Html {
  const locale = localeFor(S.currentLang);
  const busy = _busy.has(sheet.machineId) ? html` disabled` : esc('');
  const parts: Html[] = [html`<div class="mbk-toolbar">
    <label class="mbk-field mbk-note-field"><span>${tHtml('mbk_note_label')}</span><input type="text" class="mbk-input mbk-note-input" maxlength="200" autocomplete="off" placeholder="${esc(t('mbk_note_placeholder'))}" value="${esc(sheet.note)}"></label>
    <button type="button" class="mbk-btn mbk-btn-primary" data-mbk-action="backup"${busy}>${tHtml('mbk_backup_now')}</button>
    <button type="button" class="mbk-btn" data-mbk-action="upload"${busy}>${tHtml('mbk_upload')}</button>
    <input type="file" class="mbk-file" accept=".json,application/json" hidden>
  </div>`];
  if (sheet.entries === null) {
    parts.push(html`<p class="mbk-verdict">${tHtml(sheet.failed ? 'error_load' : 'please_wait')}</p>`);
  } else if (sheet.entries.length === 0) {
    parts.push(html`<p class="mbk-verdict">${tHtml('mbk_empty')}</p>`);
  } else {
    const newest = Math.max(...sheet.entries.map(b => b.createdAt));
    parts.push(html`<p class="mbk-verdict">${esc(t('mbk_verdict', sheet.entries.length, relativeTime(newest, nowMs, locale)))}</p>`);
    parts.push(html`<div class="mbk-list">${joinHtml(sheet.entries.map(b => renderRow(b, locale, null)))}</div>`);
  }
  if (sheet.orphans.length > 0) {
    const open = openFolds.has('deleted') ? html` open` : esc('');
    parts.push(html`<details class="mbk-fold" data-fold="deleted"${open}><summary>${tHtml('mbk_deleted_machines')} <span class="mbk-fold-count">${esc(sheet.orphans.length)}</span></summary><div class="mbk-list">${joinHtml(sheet.orphans.map(b => renderRow(b, locale, esc(t('mbk_deleted_machine', b.machineId)))))}</div></details>`);
  }
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
  const sheet: SheetState = { machineId, entries: null, orphans: [], failed: false, note: '' };
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
  await reload(machineId);
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
  if (id === null) return;
  if (action === 'download') { await downloadBackup(id); return; }
  if (action === 'delete') await deleteBackup(machineId, id);
}

function onSheetChange(e: Event): void {
  const target = e.target as HTMLInputElement | null;
  const sheet = _sheet;
  if (!sheet || target === null || !target.classList.contains('mbk-file')) return;
  const file = target.files?.[0] ?? null;
  target.value = ''; // the same file can be picked again
  if (file) void uploadBackupFile(sheet.machineId, file);
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
