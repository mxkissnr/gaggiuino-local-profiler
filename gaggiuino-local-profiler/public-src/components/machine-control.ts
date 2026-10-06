// Opt-in GaggiMate machine control (#1324): the idle Live view's flush
// button, the machine's brew-confirmation dialog and the Settings toggle that
// turns the whole feature on. Everything here is a no-op unless the machine
// control snapshot in the live payload is non-null (a connected GaggiMate with
// the opt-in setting on), so Gaggiuino machines and switched-off installs
// render exactly as before.
import {
  cancelBrewConfirm, confirmBrew, getMachineControlSettings,
  saveMachineControlSettings, startFlush, stopFlush,
} from '../api/machines.js';
import type { MachineControlState } from '../api/types.js';
import { t } from '../i18n.js';

// #1409/#1324: a warning key from the machine maps to a machine_warn_<key>
// label; a key we don't know yet (a newer firmware) falls back to the raw key
// so the confirmation still shows something instead of a blank/undefined
// label.
export function machineWarningLabel(k: string): string {
  const key = `machine_warn_${k}`;
  const s = t(key);
  return s === key ? k : s;
}

// Last snapshot off the live payload. The button/dialog handlers run from
// click delegation, outside handleLiveData(), so they read the machine id and
// flushing state off here instead of taking an argument every poll.
// null = no machine control this poll (off/unreachable/no GaggiMate).
let _mc: MachineControlState | null = null;
// A flush request is in flight: keep the button disabled so a second tap can't
// race the first.
let _inFlight = false;
// Last value the settings toggle was loaded/saved with, to revert a failed save.
let _settingEnabled = false;

function _flushBtn(): HTMLButtonElement | null {
  return document.getElementById('liveFlushBtn') as HTMLButtonElement | null;
}

function _renderFlushBtn(): void {
  const btn = _flushBtn();
  if (!btn) return;
  const visible = _mc !== null && (_mc.canFlush || _mc.flushing);
  btn.style.display = visible ? '' : 'none';
  if (!visible) return;
  btn.textContent = _mc!.flushing ? t('live_flush_stop') : t('live_flush_start');
  btn.disabled = _inFlight;
}

function _hideBrewConfirm(): void {
  const modal = document.getElementById('brewConfirmModal');
  if (modal) modal.style.display = 'none';
}

export function renderMachineControl(mc: MachineControlState | null | undefined): void {
  _mc = mc ?? null;
  _renderFlushBtn();

  const modal = document.getElementById('brewConfirmModal');
  if (!modal) return;
  const warnings = _mc?.brewConfirm ?? null;
  const visible = warnings !== null;
  modal.style.display = visible ? 'flex' : 'none';
  if (!visible) return;
  const list = document.getElementById('brewConfirmWarnings');
  if (list) list.textContent = warnings!.map(machineWarningLabel).join(' · ');
}

export async function toggleFlush(): Promise<void> {
  if (!_mc || _inFlight) return;
  const flushing = _mc.flushing;
  _inFlight = true;
  _renderFlushBtn();
  try {
    const r = flushing ? await stopFlush(_mc.machineId) : await startFlush(_mc.machineId);
    if (!r.ok && window.showToast) window.showToast(t('error_generic', r.status));
  } finally {
    _inFlight = false;
    _renderFlushBtn();
  }
}

// Hide the dialog immediately (optimistic) so the tap feels instant, then tell
// the backend. A still-pending confirmation re-appears on the next poll if the
// machine keeps reporting it.
export async function confirmBrewFromDialog(): Promise<void> {
  if (!_mc) return;
  const machineId = _mc.machineId;
  _hideBrewConfirm();
  const r = await confirmBrew(machineId);
  if (!r.ok && window.showToast) window.showToast(t('error_generic', r.status));
}

export async function cancelBrewFromDialog(): Promise<void> {
  if (!_mc) return;
  const machineId = _mc.machineId;
  _hideBrewConfirm();
  const r = await cancelBrewConfirm(machineId);
  if (!r.ok && window.showToast) window.showToast(t('error_generic', r.status));
}

export async function loadMachineControlSetting(): Promise<void> {
  const cb = document.getElementById('machineControlEnabled') as HTMLInputElement | null;
  if (!cb) return;
  const settings = await getMachineControlSettings().catch(() => null);
  if (!settings) return;
  _settingEnabled = settings.enabled === true;
  cb.checked = _settingEnabled;
}

export async function saveMachineControlSetting(): Promise<void> {
  const cb = document.getElementById('machineControlEnabled') as HTMLInputElement | null;
  if (!cb) return;
  const enabled = cb.checked;
  const r = await saveMachineControlSettings(enabled);
  if (!r.ok) {
    cb.checked = _settingEnabled;
    if (window.showToast) window.showToast(t('error_generic', r.status));
    return;
  }
  _settingEnabled = enabled;
}
