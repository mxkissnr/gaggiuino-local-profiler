// #1878 U2: restoring a machine backup and the per-machine automatic-backup
// settings. Every backup/firmware call and the sheet/toast modules are mocked;
// the renderer, the error mapping and the restart wait run for real.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { MachineBackup } from '../public-src/api/types.js';
import type { MachineBackupFailure } from '../public-src/api/machine-backups.js';
import type { DetailSheetOptions } from '../public-src/components/detail-sheet.js';
import type { TranslationValue } from '../public-src/i18n.js';
const g = globalThis as unknown as Record<string, unknown>;
g.localStorage ??= { getItem: () => null, setItem: () => {}, removeItem: () => {} };
const handlers: Record<string, (e: unknown) => void> = {};
const el = {
  innerHTML: '', dataset: {} as Record<string, string | undefined>,
  addEventListener: (type: string, fn: (e: unknown) => void): void => { handlers[type] = fn; },
  querySelector: (): null => null, querySelectorAll: (): [] => [],
};
g.document = { getElementById: (id: string) => (id === 'mbkSheet' ? el : null) };

const settings = (machineId: number, over: Partial<{ schedule: 'off' | 'daily' | 'weekly'; keepAutomatic: number }> = {}) =>
  ({ machineId, schedule: 'daily' as const, keepAutomatic: 10, ...over });

type Api = typeof import('../public-src/api/machine-backups.js');
type MachinesApi = typeof import('../public-src/api/machines.js');

const api = vi.hoisted(() => ({
  list: vi.fn<Api['listMachineBackups']>(), restore: vi.fn<Api['restoreMachineBackup']>(),
  getSettings: vi.fn<Api['getMachineBackupSettings']>(), saveSettings: vi.fn<Api['saveMachineBackupSettings']>(),
  backup: vi.fn<Api['backUpMachineNow']>(), del: vi.fn<Api['deleteMachineBackup']>(),
  download: vi.fn<Api['downloadMachineBackup']>(), upload: vi.fn<Api['uploadMachineBackup']>(),
}));
const fw = vi.hoisted(() => ({ get: vi.fn<MachinesApi['getFirmwareVersion']>() }));
const sheetMock = vi.hoisted(() => ({ open: vi.fn<(opts: DetailSheetOptions) => void>() }));
const toast = vi.hoisted(() => ({ show: vi.fn<(msg: string, opts?: unknown) => void>() }));

vi.mock('../public-src/api/machine-backups.js', async (orig) => ({
  ...(await orig<Api>()), listMachineBackups: api.list, restoreMachineBackup: api.restore,
  getMachineBackupSettings: api.getSettings, saveMachineBackupSettings: api.saveSettings,
  backUpMachineNow: api.backup, deleteMachineBackup: api.del, downloadMachineBackup: api.download,
  uploadMachineBackup: api.upload,
}));
vi.mock('../public-src/api/machines.js', async (orig) => ({
  ...(await orig<MachinesApi>()), getFirmwareVersion: fw.get,
}));
vi.mock('../public-src/components/detail-sheet.js', async (orig) => ({
  ...(await orig<typeof import('../public-src/components/detail-sheet.js')>()), openDetailSheet: sheetMock.open,
}));
vi.mock('../public-src/components/toast.js', () => ({ showToast: toast.show }));

const { S } = await import('../public-src/state/index.js');
const {
  RESTORE_MIN_BACK_MS, RESTORE_WAIT_MAX_MS, backupErrorText, firmwareDiffers, openMachineBackups,
  restoreOutcomeUnknown, restoreWaitStep,
} = await import('../public-src/components/machine-backups.js');
const en = (await import('../public-src/i18n/en.js')).default;
const de = (await import('../public-src/i18n/de.js')).default;
const LANGS: Record<string, typeof en> = {
  en, de, it: (await import('../public-src/i18n/it.js')).default,
  fr: (await import('../public-src/i18n/fr.js')).default, es: (await import('../public-src/i18n/es.js')).default,
  nl: (await import('../public-src/i18n/nl.js')).default,
};
const MACHINES = [
  { id: 1, name: 'Gaggia', type: 'gaggiuino' }, { id: 2, name: 'Silvia', type: 'gaggiuino' },
  { id: 3, name: 'Mate', type: 'gaggimate' },
];

const entry = (over: Partial<MachineBackup> = {}): MachineBackup => ({
  id: 5, machineId: 1, createdAt: Date.parse('2026-11-06T09:00:00Z'), kind: 'scheduled', firmwareCore: '8aaf6f0',
  firmwareFrontend: '8aaf6f0', profileCount: 10, sizeBytes: 36 * 1024, contentHash: 'h5', note: '', ...over,
});
const fail = (
  status: number, code: MachineBackupFailure['code'] = null, reason: MachineBackupFailure['reason'] = null,
  machineError: string | null = null,
): MachineBackupFailure => ({ ok: false, status, code, reason, machineError });
const fwInfo = (installed: string | null) => ({ installed, latest: null, updateAvailable: false, releaseUrl: null });
const formatter = (v: TranslationValue | undefined): ((...args: unknown[]) => string) => {
  if (typeof v !== 'function') throw new TypeError('expected an i18n formatter');
  return v;
};
// Flushes pending microtasks (the mocked calls resolve immediately, but the
// sheet chains several awaits) without moving the clock forward.
const settle = async (): Promise<void> => {
  for (let i = 0; i < 4; i++) await vi.advanceTimersByTimeAsync(0);
};
const click = (action: string, id?: number): void => {
  handlers.click?.({ target: { closest: () => ({ dataset: id === undefined ? { mbkAction: action } : { mbkAction: action, id: String(id) } }) } });
};
const change = (cls: string, value: string): void => {
  handlers.change?.({ target: { classList: { contains: (c: string) => c === cls }, value } });
};
const open = async (machineId = 1): Promise<void> => {
  el.dataset.machineId = String(machineId);
  await openMachineBackups(machineId, null);
  await settle();
};
const restorePanel = async (id = 5): Promise<void> => { click('restore', id); await settle(); };
const confirms = (): number => api.restore.mock.calls.length;

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-06T12:00:00Z'));
  S.currentLang = 'en';
  S.machines = [...MACHINES];
  el.innerHTML = '';
  el.dataset.machineId = '1';
  api.list.mockResolvedValue({ ok: true, value: [] });
  api.restore.mockResolvedValue({ ok: true, value: { ok: true, restarting: true } });
  api.getSettings.mockImplementation((machineId: number) => Promise.resolve({ ok: true, value: settings(machineId) }));
  api.saveSettings.mockImplementation(s => Promise.resolve({ ok: true, value: s }));
  fw.get.mockResolvedValue(fwInfo('8aaf6f0'));
});

afterEach(async () => {
  // Drain any restart wait a test left behind, so its 3 s loop cannot leak on.
  await vi.advanceTimersByTimeAsync(RESTORE_WAIT_MAX_MS + 6000);
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.resetAllMocks();
});

describe('machine backup restore (#1878 U2)', () => {
  it('restoreWaitStep needs an outage or 15 s before calling the machine back', () => {
    const fresh = () => ({ startedAt: 0, seenDown: false });
    let w = fresh();
    expect(restoreWaitStep(w, true, 3000)).toBe('wait');
    w = fresh();
    expect(restoreWaitStep(w, true, RESTORE_MIN_BACK_MS)).toBe('back');
    w = fresh();
    expect(restoreWaitStep(w, false, 6000)).toBe('wait');
    expect(w.seenDown).toBe(true);
    expect(restoreWaitStep(w, true, 9000)).toBe('back');
    w = fresh();
    expect(restoreWaitStep(w, false, RESTORE_WAIT_MAX_MS)).toBe('timeout');
    w = fresh();
    expect(restoreWaitStep(w, true, RESTORE_WAIT_MAX_MS)).toBe('back');
  });

  it('firmwareDiffers ignores empty and short/long forms of one hash', () => {
    expect(firmwareDiffers('8aaf6f0', '8aaf6f0')).toBe(false);
    expect(firmwareDiffers('8aaf6f0', '8AAF6F0d2')).toBe(false);
    expect(firmwareDiffers('8aaf6f0', '9bbbbbb')).toBe(true);
    expect(firmwareDiffers('', '9bbbbbb')).toBe(false);
    expect(firmwareDiffers('8aaf6f0', null)).toBe(false);
  });

  it('asks before restoring an own backup and never offers another machine', async () => {
    api.list.mockResolvedValue({ ok: true, value: [entry()] });
    fw.get.mockResolvedValue(fwInfo('9bbbbbb'));
    await open();
    await restorePanel();
    expect(el.innerHTML).toContain('Restore the backup from ');
    expect(el.innerHTML).toContain('settings and profiles and then restarts.');
    expect(el.innerHTML).toContain('current state as a new backup.');
    expect(el.innerHTML).toContain('This backup comes from firmware 8aaf6f0, the machine runs 9bbbbbb.');
    expect(el.innerHTML).not.toContain('mbk-target');
    expect(fw.get).toHaveBeenCalledWith(1);
    fw.get.mockResolvedValue(fwInfo('8aaf6f0'));
    await restorePanel();
    expect(el.innerHTML).not.toContain('mbk-warn');
    click('restore-cancel');
    await settle();
    expect(el.innerHTML).toContain('data-mbk-action="backup"');
  });

  it('restores, waits for the restart and says so once', async () => {
    api.list.mockResolvedValue({ ok: true, value: [entry()] });
    fw.get.mockReset();
    fw.get.mockResolvedValueOnce(fwInfo('8aaf6f0')).mockResolvedValueOnce(fwInfo('8aaf6f0'))
      .mockResolvedValueOnce(null).mockResolvedValueOnce(fwInfo('8aaf6f0'));
    await open();
    await restorePanel();
    click('restore-confirm');
    await settle();
    expect(api.restore.mock.calls).toEqual([[5, 1]]);
    expect(toast.show).toHaveBeenCalledWith('Machine is restarting…');
    expect(api.list).toHaveBeenCalledTimes(2);
    expect(el.innerHTML).toContain('class="mbk-status" role="status">Machine is restarting…');
    expect(el.innerHTML).toContain('data-mbk-action="backup" disabled');
    const polls = fw.get.mock.calls.length;
    await vi.advanceTimersByTimeAsync(3000);
    expect(fw.get.mock.calls.length).toBe(polls + 1);
    expect(toast.show).not.toHaveBeenCalledWith('Gaggia is back with the restored settings.', 8000);
    await vi.advanceTimersByTimeAsync(6000);
    expect(toast.show).toHaveBeenCalledWith('Gaggia is back with the restored settings.', 8000);
    expect(toast.show.mock.calls.filter(c => String(c[0]).includes('is back with'))).toHaveLength(1);
    const after = fw.get.mock.calls.length;
    await vi.advanceTimersByTimeAsync(30000);
    expect(fw.get.mock.calls.length).toBe(after);
    expect(el.innerHTML).not.toContain('mbk-status');
  });

  it('ends a long restart with a neutral hint', async () => {
    api.list.mockResolvedValue({ ok: true, value: [entry()] });
    fw.get.mockResolvedValue(null);
    await open();
    await restorePanel();
    expect(el.innerHTML).not.toContain('mbk-warn');
    click('restore-confirm');
    await settle();
    await vi.advanceTimersByTimeAsync(RESTORE_WAIT_MAX_MS);
    expect(toast.show).toHaveBeenCalledWith('Gaggia is still restarting. Check it again in a minute.', 8000);
    expect(toast.show.mock.calls.filter(c => String(c[0]).includes('still restarting'))).toHaveLength(1);
    for (const call of toast.show.mock.calls) {
      expect(String(call[0])).not.toMatch(/failed|error|refused/i);
    }
    const after = fw.get.mock.calls.length;
    await vi.advanceTimersByTimeAsync(30000);
    expect(fw.get.mock.calls.length).toBe(after);
  });

  it("restores a deleted machine's backup onto the machine the user picks", async () => {
    api.list.mockResolvedValue({ ok: true, value: [entry({ id: 9, machineId: 7 })] });
    api.restore.mockResolvedValue(fail(409, 'machine_busy', 'brew'));
    await open();
    await restorePanel(9);
    expect(el.innerHTML).toContain('class="mbk-select mbk-target"');
    expect(el.innerHTML).toContain('value="1" selected');
    expect(el.innerHTML).toContain('value="2"');
    expect(el.innerHTML).not.toContain('value="3"');
    expect(fw.get.mock.calls).toEqual([[1]]);
    change('mbk-target', '2');
    await settle();
    expect(fw.get.mock.calls).toEqual([[1], [2]]);
    change('mbk-target', '3');
    change('mbk-target', '99');
    await settle();
    expect(fw.get.mock.calls.some(c => c[0] === 3)).toBe(false);
    click('restore-confirm');
    await settle();
    expect(api.restore.mock.calls).toEqual([[9, 2]]);
  });

  it('maps every restore answer to a translated text', () => {
    const cases: [MachineBackupFailure, string][] = [
      [fail(409, 'machine_busy', 'brew'), 'The machine is brewing. Try again when it is idle.'],
      [fail(409, 'machine_busy', 'steam'), 'The machine is steaming. Try again when it is idle.'],
      [fail(409, 'machine_busy', 'descale'), 'The machine is descaling. Try again when it has finished.'],
      [fail(409, 'machine_busy', 'firmware_update'), 'The machine is updating its firmware. Try again when it has finished.'],
      [fail(409, 'machine_busy'), 'The machine is busy. Try again when it is idle.'],
      [fail(409, 'pending_profile_changes'), 'GLP still has profile changes for this machine that have not reached it. Try again once they are sent.'],
      [fail(409, 'operation_running'), 'Another backup or restore of this machine is running. Try again in a moment.'],
      [fail(409, 'pre_restore_backup_failed'), 'GLP could not save the machine\'s current state first, so nothing was restored.'],
      [fail(409, 'invalid_backup'), 'GLP could not process this backup. Nothing was changed.'],
      [fail(502, 'machine_unreachable'), 'The machine did not answer. Is it switched on?'],
      [fail(501, 'unsupported_machine'), 'Only Gaggiuino machines have settings backups.'],
      [fail(409, 'unsupported_firmware'), 'This machine\'s firmware cannot back up its settings yet. Update the firmware first.'],
      [fail(409, 'restore_rejected', null, 'Invalid backup'), 'The machine refused the backup (Invalid backup). Nothing was changed.'],
      [fail(409, 'restore_rejected'), 'The machine refused the backup. Nothing was changed.'],
      [fail(404), 'This backup or machine no longer exists.'],
      [fail(429), 'Too many requests. Wait a minute and try again.'],
    ];
    for (const [f, text] of cases) expect(backupErrorText(f, 'restore')).toBe(text);
    for (const f of [fail(409, 'no_confirmation'), fail(0), fail(502)]) expect(restoreOutcomeUnknown(f)).toBe(true);
    for (const f of [fail(409, 'machine_busy', 'brew'), fail(404), fail(400, 'invalid_backup'), fail(429)]) {
      expect(restoreOutcomeUnknown(f)).toBe(false);
    }
  });

  it('never claims nothing was restored when the outcome is unknown', async () => {
    api.list.mockResolvedValue({ ok: true, value: [entry()] });
    const unknown = 'The machine did not confirm the restore. It may be restarting; check it again in a minute.';
    for (const f of [fail(409, 'no_confirmation'), fail(0), fail(502)]) {
      api.restore.mockResolvedValue(f);
      await open();
      await restorePanel();
      const before = api.list.mock.calls.length;
      const fwBefore = fw.get.mock.calls.length;
      click('restore-confirm');
      await settle();
      expect(toast.show).toHaveBeenLastCalledWith(unknown, 8000);
      expect(api.list.mock.calls.length).toBe(before + 1);
      await vi.advanceTimersByTimeAsync(6000);
      expect(fw.get.mock.calls.length).toBe(fwBefore);
    }
  });

  it('keeps restores per machine', async () => {
    api.list.mockResolvedValue({ ok: true, value: [entry(), entry({ id: 6, machineId: 2 })] });
    fw.get.mockResolvedValue(null);
    await open(1);
    await restorePanel();
    click('restore-confirm');
    await settle();
    expect(confirms()).toBe(1);
    expect(el.innerHTML).toContain('data-mbk-action="restore" data-id="5" disabled');
    expect(el.innerHTML).toContain('data-mbk-action="backup" disabled');
    // Reopening the confirmation on the waiting machine shows a blocked Confirm.
    await restorePanel();
    expect(el.innerHTML).toContain('data-mbk-action="restore-confirm" disabled');
    click('restore-confirm');
    await settle();
    expect(confirms()).toBe(1);
    await open(2);
    expect(el.innerHTML).not.toContain('data-mbk-action="backup" disabled');
    expect(el.innerHTML).toContain('data-mbk-action="restore" data-id="6">');
  });

  it('shows and saves the automatic backups per machine', async () => {
    api.list.mockResolvedValue({ ok: true, value: [entry()] });
    await open(1);
    expect(el.innerHTML).toContain('data-fold="auto"');
    expect(el.innerHTML).toContain('<option value="daily" selected>');
    expect(el.innerHTML).toContain('value="10"');
    expect(el.innerHTML).toContain('GLP keeps the last 10 automatic backups. After you lower the number, older automatic backups are removed with the next automatic backup.');
    change('mbk-schedule', 'weekly');
    await settle();
    expect(api.saveSettings.mock.calls).toEqual([[{ machineId: 1, schedule: 'weekly', keepAutomatic: 10 }]]);
    expect(el.innerHTML).toContain('<option value="weekly" selected>');
    expect(toast.show).toHaveBeenLastCalledWith('Saved');
    change('mbk-keep', '5');
    await settle();
    expect(api.saveSettings.mock.calls[1]).toEqual([{ machineId: 1, schedule: 'weekly', keepAutomatic: 5 }]);
    expect(el.innerHTML).toContain('GLP keeps the last 5 automatic backups.');
    const calls = api.saveSettings.mock.calls.length;
    for (const bad of ['0', '101', '2.5', 'abc', '']) {
      change('mbk-keep', bad);
      await settle();
      expect(toast.show).toHaveBeenLastCalledWith('Enter a number from 1 to 100.');
    }
    change('mbk-schedule', 'hourly');
    await settle();
    expect(api.saveSettings.mock.calls.length).toBe(calls);
    api.saveSettings.mockResolvedValue(fail(501, 'unsupported_machine'));
    change('mbk-keep', '7');
    await settle();
    expect(toast.show).toHaveBeenLastCalledWith('Only Gaggiuino machines have settings backups.', 6000);
    expect(el.innerHTML).toContain('<option value="weekly" selected>');
    api.getSettings.mockImplementation((machineId: number) => Promise.resolve({
      ok: true, value: machineId === 2 ? settings(2, { schedule: 'off', keepAutomatic: 3 }) : settings(1, { schedule: 'weekly', keepAutomatic: 5 }),
    }));
    api.saveSettings.mockImplementation(s => Promise.resolve({ ok: true, value: s }));
    await open(2);
    change('mbk-keep', '4');
    await settle();
    expect(api.saveSettings.mock.calls.at(-1)).toEqual([{ machineId: 2, schedule: 'off', keepAutomatic: 4 }]);
  });

  it('hides the settings when the machine has none', async () => {
    api.getSettings.mockResolvedValue(fail(501, 'unsupported_machine'));
    await open(1);
    expect(el.innerHTML).not.toContain('data-fold="auto"');
  });

  it('has the new strings in all six languages', () => {
    const keys = [
      'mbk_restore', 'mbk_restore_title', 'mbk_restore_body', 'mbk_restore_before', 'mbk_restore_fw_mismatch',
      'mbk_restore_target', 'mbk_restore_confirm', 'mbk_restore_done', 'mbk_restore_still_restarting',
      'mbk_restore_unknown', 'mbk_err_busy_brew', 'mbk_err_busy_steam', 'mbk_err_busy_descale',
      'mbk_err_busy_firmware_update', 'mbk_err_pending_profiles', 'mbk_err_pre_restore', 'mbk_err_rejected',
      'mbk_auto_title', 'mbk_schedule', 'mbk_schedule_off', 'mbk_schedule_daily', 'mbk_schedule_weekly',
      'mbk_keep', 'mbk_keep_range', 'mbk_keep_hint',
    ];
    for (const key of keys) {
      const ref = en[key];
      expect(ref, `en missing ${key}`).toBeTruthy();
      for (const [name, dict] of Object.entries(LANGS)) {
        const value = dict[key];
        expect(typeof value, `${name}:${key}`).toBe(typeof ref);
        if (typeof ref === 'function' && typeof value === 'function') expect(value.length, `${name}:${key}`).toBe(ref.length);
        expect(value, `${name}:${key} empty`).toBeTruthy();
      }
    }
    expect(formatter(de.mbk_restore_title)('5. Nov.')).toBe('Backup vom 5. Nov. wiederherstellen?');
    expect(formatter(en.mbk_err_rejected)('x')).toContain('(x)');
    expect(formatter(en.mbk_err_rejected)('')).not.toContain('(');
  });
});
