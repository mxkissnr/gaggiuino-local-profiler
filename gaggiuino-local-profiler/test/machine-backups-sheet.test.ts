// #1878 U1: the machine backups sheet. Every backup call and the sheet/toast
// modules are mocked; the renderer, split, error mapping and note handling run for real.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { MachineBackup } from '../public-src/api/types.js';
import type { MachineBackupFailure } from '../public-src/api/machine-backups.js';
import type { DetailSheetOptions } from '../public-src/components/detail-sheet.js';
import type { TranslationValue } from '../public-src/i18n.js';
import type { BackupContext } from '../public-src/components/machine-backups.js';
const g = globalThis as unknown as Record<string, unknown>;
g.localStorage ??= { getItem: () => null, setItem: () => {}, removeItem: () => {} };
const handlers: Record<string, (e: unknown) => void> = {};
const el = {
  innerHTML: '', dataset: {} as Record<string, string | undefined>,
  addEventListener: (type: string, fn: (e: unknown) => void): void => { handlers[type] = fn; },
  querySelector: (): null => null, querySelectorAll: (): [] => [],
};
g.document = { getElementById: (id: string) => (id === 'mbkSheet' ? el : null) };
const confirmMock = vi.fn<(msg: string) => boolean>();
g.confirm = confirmMock;

type Api = typeof import('../public-src/api/machine-backups.js');
type Result = Awaited<ReturnType<Api['backUpMachineNow']>>;
const api = vi.hoisted(() => ({
  list: vi.fn<Api['listMachineBackups']>(), backup: vi.fn<Api['backUpMachineNow']>(),
  del: vi.fn<Api['deleteMachineBackup']>(), download: vi.fn<Api['downloadMachineBackup']>(),
  upload: vi.fn<Api['uploadMachineBackup']>(),
}));
const sheetMock = vi.hoisted(() => ({ open: vi.fn<(opts: DetailSheetOptions) => void>() }));
const toast = vi.hoisted(() => ({ show: vi.fn<(msg: string, opts?: unknown) => void>() }));
const share = vi.hoisted(() => ({ fn: vi.fn<(blob: Blob, name: string, opts?: unknown) => Promise<void>>() }));

vi.mock('../public-src/api/machine-backups.js', async (orig) => ({
  ...(await orig<Api>()), listMachineBackups: api.list, backUpMachineNow: api.backup,
  deleteMachineBackup: api.del, downloadMachineBackup: api.download, uploadMachineBackup: api.upload,
}));
vi.mock('../public-src/components/detail-sheet.js', async (orig) => ({
  ...(await orig<typeof import('../public-src/components/detail-sheet.js')>()), openDetailSheet: sheetMock.open,
}));
vi.mock('../public-src/components/toast.js', () => ({ showToast: toast.show }));
vi.mock('../public-src/utils.js', async (orig) => ({
  ...(await orig<typeof import('../public-src/utils.js')>()), shareOrDownloadBlob: share.fn,
}));
const { S } = await import('../public-src/state/index.js');
const {
  MAX_UPLOAD_BYTES, backupErrorText, cleanNote, confirmUpdateWithoutBackup, machineBackupsButtonHtml,
  openMachineBackups, parseBackupFile, relativeTime, renderSheetBody, splitBackups,
} = await import('../public-src/components/machine-backups.js');
const en = (await import('../public-src/i18n/en.js')).default;
const de = (await import('../public-src/i18n/de.js')).default;
const LANGS: Record<string, typeof en> = {
  en, de, it: (await import('../public-src/i18n/it.js')).default,
  fr: (await import('../public-src/i18n/fr.js')).default, es: (await import('../public-src/i18n/es.js')).default,
  nl: (await import('../public-src/i18n/nl.js')).default,
};
const MACHINES = [
  { id: 1, name: 'Gaggia <b>', type: 'gaggiuino' }, { id: 2, name: 'Silvia', type: 'gaggiuino' }, { id: 3, name: 'Mate' },
];
const GOOD = '{"format":"gaggiuino-settings","version":1}';
const GOOD_DOC = { format: 'gaggiuino-settings', version: 1 };
const NO_SECRETS = 'The machine did not answer, so this file has no Wi-Fi or MQTT passwords.';
const NOT_SETTINGS = 'This file is not a Gaggiuino settings backup.';

const entry = (over: Partial<MachineBackup> = {}): MachineBackup => ({
  id: 5, machineId: 1, createdAt: Date.parse('2026-11-06T09:00:00Z'), kind: 'scheduled', firmwareCore: '8aaf6f0',
  firmwareFrontend: '8aaf6f0', profileCount: 10, sizeBytes: 36 * 1024, contentHash: 'h5', note: '', ...over,
});
const failure = (over: Partial<MachineBackupFailure> = {}): MachineBackupFailure =>
  ({ ok: false, status: 0, code: null, reason: null, machineError: null, ...over });
const formatter = (v: TranslationValue | undefined): ((...args: unknown[]) => string) => {
  if (typeof v !== 'function') throw new TypeError('expected an i18n formatter');
  return v;
};
const flush = (): Promise<void> => new Promise(resolve => { setTimeout(() => { setTimeout(resolve, 0); }, 0); });
const click = (action: string, id?: number): void => {
  handlers.click?.({ target: { closest: () => ({ dataset: id === undefined ? { mbkAction: action } : { mbkAction: action, id: String(id) } }) } });
};
const pick = (files: Blob[], value = 'C:\\fakepath\\x.json') => {
  const target = { classList: { contains: (c: string) => c === 'mbk-file' }, files, value };
  handlers.change?.({ target });
  return target;
};
const typeNote = (value: string): void => {
  handlers.input?.({ target: { classList: { contains: (c: string) => c === 'mbk-note-input' }, value } });
};
const notice = (msg: string): void => { expect(toast.show).toHaveBeenLastCalledWith(msg, 6000); };
const open = (): Promise<void> => openMachineBackups(1, null);

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-06T12:00:00Z'));
  S.currentLang = 'en';
  S.machines = [...MACHINES];
  el.innerHTML = '';
  el.dataset.machineId = '1';
  confirmMock.mockReturnValue(true);
  api.list.mockResolvedValue({ ok: true, value: [] });
  api.backup.mockResolvedValue({ ok: true, value: entry() });
  api.del.mockResolvedValue({ ok: true, value: { ok: true } });
  api.upload.mockResolvedValue({ ok: true, value: entry({ kind: 'uploaded' }) });
  const blob = new Blob(['{}']);
  api.download.mockResolvedValue({ ok: true, value: { blob, filename: 'gaggiuino-backup.json', secrets: 'merged' } });
});

describe('machine backups sheet (#1878)', () => {
  it('opens the sheet for one machine and loads all backups once', async () => {
    const older = entry({ id: 6, kind: 'manual', createdAt: Date.parse('2026-11-06T07:00:00Z') });
    api.list.mockResolvedValue({ ok: true, value: [entry(), older] });
    await open();
    expect(sheetMock.open).toHaveBeenCalledTimes(1);
    const opts = sheetMock.open.mock.calls[0]?.[0];
    expect(opts?.title).toBe('Machine backups · Gaggia <b>');
    expect(opts?.body).toContain('id="mbkSheet"');
    expect(opts?.body).toContain('data-machine-id="1"');
    expect(api.list.mock.calls).toEqual([[null]]);
    for (const text of [
      '2 backups · newest 3 hours ago', 'Automatic', 'Manual', 'FW 8aaf6f0', '10 profiles', '36 KB',
      'data-mbk-action="download" data-id="5"', 'data-mbk-action="delete" data-id="5"',
    ]) expect(el.innerHTML).toContain(text);
  });
  it('escapes notes and keeps backups of other machines out', async () => {
    const hostile = entry({ note: '<img src=x onerror=alert(1)>' });
    api.list.mockResolvedValue({ ok: true, value: [hostile, entry({ id: 20, machineId: 2 }), entry({ id: 30, machineId: 7 })] });
    await open();
    expect(el.innerHTML).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(el.innerHTML).not.toContain('<img');
    expect(el.innerHTML).toContain('Backups of deleted machines');
    expect(el.innerHTML).toContain('Deleted machine 7');
    expect(el.innerHTML).toContain('data-id="30"');
    expect(el.innerHTML).not.toContain('data-id="20"');
    S.machines = [];
    await open();
    expect(el.innerHTML).not.toContain('Backups of deleted machines');
  });
  it('shows the empty state and a failed load', async () => {
    await open();
    expect(el.innerHTML).toContain('No backups yet.');
    api.list.mockResolvedValue(failure({ status: 0 }));
    await open();
    expect(el.innerHTML).toContain('Error loading data');
  });
  it('splitBackups keeps own, deleted and other machines apart', () => {
    const all = [entry(), entry({ id: 6 }), entry({ id: 20, machineId: 2 }), entry({ id: 30, machineId: 7 })];
    const split = splitBackups(all, 1, new Set([1, 2, 3]));
    expect([split.own.map(b => b.id), split.orphans.map(b => b.id)]).toEqual([[5, 6], [30]]);
    expect(splitBackups(all, 1, null).orphans).toEqual([]);
    expect(splitBackups(all, 1, new Set([1])).orphans.map(b => b.id)).toEqual([20, 30]);
  });
  it('Back up now stores a backup for this machine and reloads', async () => {
    await open();
    click('backup');
    await flush();
    expect(api.backup.mock.calls[0]).toEqual([1]);
    expect(toast.show).toHaveBeenCalledWith('Backup saved');
    expect(api.list).toHaveBeenCalledTimes(2);
  });
  it('keeps a running backup per machine', async () => {
    let resolveOne: (v: Result) => void = () => {};
    api.backup.mockReturnValueOnce(new Promise<Result>(resolve => { resolveOne = resolve; }));
    await open();
    click('backup');
    await flush();
    expect(el.innerHTML).toContain('data-mbk-action="backup" disabled');
    click('backup');
    await flush();
    expect(api.backup).toHaveBeenCalledTimes(1);
    el.dataset.machineId = '2';
    await openMachineBackups(2, null);
    click('backup');
    await flush();
    expect(api.backup.mock.calls[1]).toEqual([2]);
    expect(el.innerHTML).not.toContain('data-mbk-action="backup" disabled');
    api.list.mockResolvedValue({ ok: true, value: [entry({ note: 'machine one only' })] });
    resolveOne({ ok: true, value: entry() });
    await flush();
    expect(el.innerHTML).not.toContain('machine one only');
  });
  it('maps errors to translated texts', () => {
    const generic = 'That did not work. Try again.';
    const cases: [Partial<MachineBackupFailure>, BackupContext, string][] = [
      [{ code: 'unsupported_machine', status: 409 }, 'backup', 'Only Gaggiuino machines have settings backups.'],
      [{ code: 'unsupported_firmware', status: 409 }, 'backup', 'This machine\'s firmware cannot back up its settings yet. Update the firmware first.'],
      [{ code: 'machine_unreachable', status: 409 }, 'backup', 'The machine did not answer. Is it switched on?'],
      [{ code: 'invalid_backup', status: 409 }, 'backup', 'GLP could not process this backup. Nothing was changed.'],
      [{ code: 'machine_busy', status: 409 }, 'backup', 'The machine is busy. Try again when it is idle.'],
      [{ code: 'operation_running', status: 409 }, 'backup', 'Another backup or restore of this machine is running. Try again in a moment.'],
      [{ status: 404 }, 'backup', 'This backup or machine no longer exists.'],
      [{ status: 429 }, 'backup', 'Too many requests. Wait a minute and try again.'],
      [{ status: 0 }, 'backup', generic], [{ status: 502 }, 'backup', generic],
      [{ status: 413 }, 'upload', 'This file is too large for a settings backup.'],
      [{ code: 'invalid_backup', status: 400 }, 'upload', NOT_SETTINGS], [{ status: 400 }, 'upload', NOT_SETTINGS],
    ];
    for (const [f, context, text] of cases) expect(backupErrorText(failure(f), context)).toBe(text);
  });
  it('deletes only after the confirmation', async () => {
    await open();
    confirmMock.mockReturnValue(false);
    click('delete', 5);
    await flush();
    expect(api.del).not.toHaveBeenCalled();
    confirmMock.mockReturnValue(true);
    click('delete', 5);
    await flush();
    expect(api.del).toHaveBeenCalledWith(5);
    expect(toast.show).toHaveBeenCalledWith('Backup deleted');
    expect(api.list).toHaveBeenCalledTimes(2);
    api.del.mockResolvedValue(failure({ status: 404 }));
    click('delete', 5);
    await flush();
    notice('This backup or machine no longer exists.');
    expect(api.list).toHaveBeenCalledTimes(3);
  });
  it('warns before saving a file with secrets', async () => {
    const blob = new Blob(['{}']), filename = 'gaggiuino-backup-m1-2026-11-06_0900.json';
    api.download.mockResolvedValue({ ok: true, value: { blob, filename, secrets: 'merged' } });
    await open();
    confirmMock.mockReturnValue(false);
    click('download', 5);
    await flush();
    expect(share.fn).not.toHaveBeenCalled();
    expect(confirmMock).toHaveBeenLastCalledWith('This file contains the machine\'s Wi-Fi password and MQTT login in plain text. Keep it somewhere private. Save it now?');
    confirmMock.mockReturnValue(true);
    click('download', 5);
    await flush();
    expect(share.fn).toHaveBeenCalledWith(blob, filename, { title: filename });
    api.download.mockResolvedValue({ ok: true, value: { blob, filename, secrets: 'missing' } });
    confirmMock.mockClear();
    click('download', 5);
    await flush();
    expect(confirmMock).not.toHaveBeenCalled();
    expect(share.fn).toHaveBeenCalledTimes(2);
    notice(NO_SECRETS);
    api.download.mockResolvedValue(failure({ code: 'machine_unreachable', status: 502 }));
    click('download', 5);
    await flush();
    notice('The machine did not answer. Is it switched on?');
    expect(share.fn).toHaveBeenCalledTimes(2);
  });
  it('parses an uploaded file before sending it', () => {
    expect(parseBackupFile(GOOD)).toEqual(GOOD_DOC);
    for (const bad of ['not json', '[]', 'null', '"x"', '{"format":"other"}', '{"version":1}']) {
      expect(parseBackupFile(bad)).toBeNull();
    }
  });
  it('uploads a valid file for this machine only', async () => {
    await open();
    const target = pick([new Blob([GOOD])]);
    await flush();
    expect(api.upload).toHaveBeenCalledWith(1, GOOD_DOC);
    expect(target.value).toBe('');
    expect(toast.show).toHaveBeenCalledWith('Backup uploaded. Wi-Fi and MQTT passwords from the file were not stored.', 6000);
    pick([new Blob([new Uint8Array(MAX_UPLOAD_BYTES + 1)])]);
    await flush();
    notice('This file is too large for a settings backup.');
    expect(api.upload).toHaveBeenCalledTimes(1);
    pick([new Blob(['not json'])]);
    await flush();
    notice(NOT_SETTINGS);
    expect(api.upload).toHaveBeenCalledTimes(1);
    api.upload.mockResolvedValue(failure({ status: 400 }));
    pick([new Blob([GOOD])]);
    await flush();
    notice(NOT_SETTINGS);
  });
  it('relativeTime picks minutes, hours and days', () => {
    const cases: [number, string][] = [[0, 'this minute'], [-5 * 60000, '5 minutes ago'], [-3 * 3600000, '3 hours ago'],
      [-47 * 3600000, '47 hours ago'], [-3 * 86400000, '3 days ago']];
    for (const [ms, text] of cases) expect(relativeTime(ms, 0, 'en-US')).toBe(text);
  });
  it('offers the row action and the firmware override', () => {
    expect(machineBackupsButtonHtml()).toBe('<button type="button" class="machine-backups-btn">Backups</button>');
    const message = 'The backup before the update failed, so the update did not start.\n\nUpdate the firmware without a backup now?';
    confirmMock.mockReturnValue(true);
    expect(confirmUpdateWithoutBackup()).toBe(true);
    expect(confirmMock).toHaveBeenLastCalledWith(message);
    confirmMock.mockReturnValue(false);
    expect(confirmUpdateWithoutBackup()).toBe(false);
    expect(toast.show).not.toHaveBeenCalled();
  });
  it('sends an optional, trimmed note with Back up now', async () => {
    await open();
    expect(el.innerHTML).toContain('class="mbk-input mbk-note-input" maxlength="200"');
    expect(el.innerHTML).toContain('Note for this backup (optional)');
    typeNote('  before descaling  ');
    click('backup');
    await flush();
    expect(api.backup.mock.calls[0]).toEqual([1, 'before descaling']);
    expect(el.innerHTML).toContain('value=""');
    typeNote('   ');
    click('backup');
    await flush();
    expect(api.backup.mock.calls[1]?.length).toBe(1);
    typeNote('𝄞'.repeat(250));
    click('backup');
    await flush();
    expect(Array.from(api.backup.mock.calls[2]?.[1] ?? '').length).toBe(200);
    typeNote('"><script>alert(1)</script>');
    api.backup.mockResolvedValueOnce(failure({ status: 502 }));
    click('backup');
    await flush();
    expect(el.innerHTML).toContain('value="&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;"');
    expect(el.innerHTML).not.toContain('<script>');
    el.dataset.machineId = '2';
    await openMachineBackups(2, null);
    click('backup');
    await flush();
    expect(api.backup.mock.calls.at(-1)).toEqual([2]);
    expect([cleanNote('  x '), cleanNote(''), cleanNote('\n\t ')]).toEqual(['x', undefined, undefined]);
  });
  it('has the new strings in all six languages', () => {
    const keys = Object.keys(en).filter(k => k.startsWith('mbk_'));
    expect(keys.length).toBe(37);
    for (const key of keys) {
      const ref = en[key];
      for (const [name, dict] of Object.entries(LANGS)) {
        const value = dict[key];
        expect(typeof value, `${name}:${key}`).toBe(typeof ref);
        if (typeof ref === 'function' && typeof value === 'function') expect(value.length, `${name}:${key}`).toBe(ref.length);
        expect(value, `${name}:${key} empty`).toBeTruthy();
      }
    }
    expect(formatter(de.mbk_verdict)(1, 'vor 3 Stunden')).toBe('1 Backup · neuestes vor 3 Stunden');
  });
  it('renders the note value escaped and keeps an opened fold open', () => {
    const state = { machineId: 1, entries: [], orphans: [entry({ id: 30, machineId: 7 })], failed: false, note: '"x' };
    const body = renderSheetBody(state, 0, new Set(['deleted']));
    expect(body).toContain('value="&quot;x"');
    expect(body).toContain('<details class="mbk-fold" data-fold="deleted" open>');
  });
});
