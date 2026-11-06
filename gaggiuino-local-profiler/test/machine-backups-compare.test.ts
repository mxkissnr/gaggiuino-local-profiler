// #1878 U3: the compare view of two machine backups. Every backup call and the
// sheet/toast modules are mocked; the C1 diff engine, the wording and the
// escaping run for real.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { MachineBackup, MachineBackupDetail } from '../public-src/api/types.js';
import type { MachineBackupFailure } from '../public-src/api/machine-backups.js';
import type { DetailSheetOptions } from '../public-src/components/detail-sheet.js';
import type { TranslationValue } from '../public-src/i18n.js';
import type { BackupChange, KeyPath, LeafChange, ValueChange } from '../public-src/shared/machine-backup-diff.js';
const g = globalThis as unknown as Record<string, unknown>;
g.localStorage ??= { getItem: () => null, setItem: () => {}, removeItem: () => {} };
const handlers: Record<string, (e: unknown) => void> = {};
const el = {
  innerHTML: '', dataset: {} as Record<string, string | undefined>,
  addEventListener: (type: string, fn: (e: unknown) => void): void => { handlers[type] = fn; },
  querySelector: (): null => null, querySelectorAll: (): [] => [],
};
g.document = { getElementById: (id: string) => (id === 'mbkSheet' ? el : null) };

type Api = typeof import('../public-src/api/machine-backups.js');
type MachinesApi = typeof import('../public-src/api/machines.js');
const api = vi.hoisted(() => ({
  list: vi.fn<Api['listMachineBackups']>(), get: vi.fn<Api['getMachineBackup']>(),
  getSettings: vi.fn<Api['getMachineBackupSettings']>(),
}));
const fw = vi.hoisted(() => ({ get: vi.fn<MachinesApi['getFirmwareVersion']>() }));
const sheetMock = vi.hoisted(() => ({ open: vi.fn<(opts: DetailSheetOptions) => void>() }));
const toast = vi.hoisted(() => ({ show: vi.fn<(msg: string, opts?: unknown) => void>() }));

vi.mock('../public-src/api/machine-backups.js', async (orig) => ({
  ...(await orig<Api>()), listMachineBackups: api.list, getMachineBackup: api.get,
  getMachineBackupSettings: api.getSettings,
}));
vi.mock('../public-src/api/machines.js', async (orig) => ({
  ...(await orig<MachinesApi>()), getFirmwareVersion: fw.get,
}));
vi.mock('../public-src/components/detail-sheet.js', async (orig) => ({
  ...(await orig<typeof import('../public-src/components/detail-sheet.js')>()), openDetailSheet: sheetMock.open,
}));
vi.mock('../public-src/components/toast.js', () => ({ showToast: toast.show }));

const { S } = await import('../public-src/state/index.js');
const { describeChange, humanizeKey, openMachineBackups } = await import('../public-src/components/machine-backups.js');
const en = (await import('../public-src/i18n/en.js')).default;
const de = (await import('../public-src/i18n/de.js')).default;
const LANGS: Record<string, typeof en> = {
  en, de, it: (await import('../public-src/i18n/it.js')).default,
  fr: (await import('../public-src/i18n/fr.js')).default, es: (await import('../public-src/i18n/es.js')).default,
  nl: (await import('../public-src/i18n/nl.js')).default,
};
const entry = (over: Partial<MachineBackup> = {}): MachineBackup => ({
  id: 5, machineId: 1, createdAt: Date.parse('2026-11-06T09:00:00Z'), kind: 'scheduled', firmwareCore: '8aaf6f0',
  firmwareFrontend: '8aaf6f0', profileCount: 10, sizeBytes: 36 * 1024, contentHash: 'h5', note: '', ...over,
});
const failure = (over: Partial<MachineBackupFailure> = {}): MachineBackupFailure =>
  ({ ok: false, status: 0, code: null, reason: null, machineError: null, ...over });
const detail = (over: Partial<MachineBackup> = {}, document: Record<string, unknown> = {}): MachineBackupDetail =>
  ({ ...entry(over), document });
const okDetail = (d: MachineBackupDetail): { ok: true; value: MachineBackupDetail } => ({ ok: true, value: d });
const flush = (): Promise<void> => new Promise(resolve => { setTimeout(() => { setTimeout(resolve, 0); }, 0); });
/** A promise plus its resolver, for a call the test releases by hand. */
const deferred = (): { promise: Promise<void>; resolve: () => void } => {
  const gate = { release: (): void => {} };
  const promise = new Promise<void>(resolve => { gate.release = () => { resolve(); }; });
  return { promise, resolve: () => { gate.release(); } };
};
const click = (action: string): void => {
  handlers.click?.({ target: { closest: () => ({ dataset: { mbkAction: action } }) } });
};
const setPick = (id: string, checked: boolean): void => {
  handlers.change?.({ target: { classList: { contains: (c: string) => c === 'mbk-pick' }, dataset: { id }, checked } });
};
const formatter = (v: TranslationValue | undefined): ((...args: unknown[]) => string) => {
  if (typeof v !== 'function') throw new TypeError('expected an i18n formatter');
  return v;
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-06T12:00:00Z'));
  S.currentLang = 'en';
  S.machines = [{ id: 1, name: 'Gaggia', type: 'gaggiuino' }];
  el.innerHTML = '';
  el.dataset.machineId = '1';
  api.list.mockResolvedValue({ ok: true, value: [] });
  api.getSettings.mockResolvedValue(failure({ status: 501 }));
  fw.get.mockResolvedValue(null);
});

const older = entry({ id: 7, createdAt: Date.parse('2026-11-05T09:00:00Z'), contentHash: 'h7' });
const newer = entry({ id: 5, createdAt: Date.parse('2026-11-06T09:00:00Z') });
const setting = (path: KeyPath, c: ValueChange): BackupChange => ({ kind: 'setting', path, ...c });
const firmware = (path: KeyPath, c: ValueChange): BackupChange => ({ kind: 'firmware', path, ...c });

describe('machine backup compare (#1878)', () => {
  it('humanizes raw keys', () => {
    expect(humanizeKey('steamSetPoint')).toBe('Steam set point');
    expect(humanizeKey('hwScalesF1')).toBe('Hw scales f1');
    expect(humanizeKey('mqtt_host')).toBe('Mqtt host');
    expect(humanizeKey('LED')).toBe('Led');
    expect(humanizeKey('__proto__')).toBe('Proto');
    expect(humanizeKey('')).toBe('?');
    const long = humanizeKey('a'.repeat(100));
    expect(Array.from(long)).toHaveLength(60);
    expect(long.endsWith('…')).toBe(true);
  });

  it('describes every change kind in plain words', () => {
    const prof = { id: 3, name: 'Adaptive' };
    const phase = (n: number, change: LeafChange): BackupChange =>
      ({ kind: 'profilePhase', profile: prof, phase: n, change });
    const field = (path: KeyPath, c: ValueChange): BackupChange =>
      ({ kind: 'profileField', profile: prof, path, ...c });
    const cases: [BackupChange, string][] = [
      [setting(['boiler', 'steamSetPoint'], { change: 'changed', from: 155, to: 156 }), 'Boiler · Steam temperature: 155 °C → 156 °C'],
      [setting(['display', 'lcdBrightness'], { change: 'changed', from: 70, to: 80 }), 'Display · Lcd brightness: 70 → 80'],
      [setting(['fooBar', 'x'], { change: 'changed', from: 1, to: 2 }), 'Foo bar · X: 1 → 2'],
      [setting(['boiler', 'dreamSteamState'], { change: 'changed', from: true, to: false }), 'Boiler · Dream steam state: yes → no'],
      [setting(['led', 'state'], { change: 'changed', from: 'true', to: 'false' }), 'LED · State: yes → no'],
      [setting(['system', 'machineName'], { change: 'changed', from: 'A', to: 'B' }), 'System · Machine name: A → B'],
      [setting(['webUi', 'dashboardLayout'], { change: 'changed', from: 'x'.repeat(60), to: 'y' }),
        `Web interface · Dashboard layout: ${'x'.repeat(39)}… → y`],
      [setting(['webUi', 'foo'], { change: 'changed', from: { a: 1 }, to: { a: 2 } }), 'Web interface · Foo changed'],
      [setting(['webUi', 'idleWatts'], { change: 'added', to: 4 }), 'Web interface · Idle power added: 4 W'],
      [setting(['webUi', 'idleWatts'], { change: 'removed', from: 4 }), 'Web interface · Idle power removed (was 4 W)'],
      [setting(['webUi', 'foo'], { change: 'added', to: { a: 1 } }), 'Web interface · Foo added'],
      [setting(['constructor', 'toString'], { change: 'changed', from: 1, to: 2 }), 'Constructor · To string: 1 → 2'],
      [firmware(['core'], { change: 'changed', from: 'a1', to: 'b2' }), 'Controller firmware: a1 → b2'],
      [firmware(['frontend'], { change: 'changed', from: 'a1', to: 'b2' }), 'Frontend firmware: a1 → b2'],
      [{ kind: 'defaultProfile', from: { id: 4, name: 'Adaptive' }, to: { id: 5, name: null } }, 'Default profile: Adaptive → #5'],
      [{ kind: 'profileAdded', profile: { id: 7, name: 'Turbo' } }, 'Profile “Turbo” added'],
      [{ kind: 'profileRemoved', profile: { id: 7, name: 'Turbo' } }, 'Profile “Turbo” removed'],
      [{ kind: 'profileRenamed', profile: prof, from: 'A', to: 'B' }, 'Profile “A” renamed to “B”'],
      [phase(2, 'changed'), 'Profile “Adaptive”: phase 2 changed'],
      [phase(3, 'added'), 'Profile “Adaptive”: phase 3 added'],
      [phase(4, 'removed'), 'Profile “Adaptive”: phase 4 removed'],
      [field(['waterTemperature'], { change: 'changed', from: 93, to: 94 }),
        'Profile “Adaptive” · Water temperature: 93 °C → 94 °C'],
      [field(['recipe', 'coffeeIn'], { change: 'changed', from: 15, to: 16 }),
        'Profile “Adaptive” · Dose: 15 g → 16 g'],
      [field(['globalStopConditions', 'weight'], { change: 'changed', from: 37, to: 38 }),
        'Profile “Adaptive” · Stop at weight: 37 g → 38 g'],
      [{ kind: 'pumpCalibration', change: 'changed' }, 'Pump calibration changed'],
      [{ kind: 'other', key: 'newThing', change: 'changed', from: 1, to: 2 }, 'New thing: 1 → 2'],
    ];
    for (const [change, text] of cases) expect(describeChange(change), text).toBe(text);
  });

  it('speaks German too', () => {
    S.currentLang = 'de';
    expect(describeChange(setting(['boiler', 'steamSetPoint'], { change: 'changed', from: 155, to: 156 })))
      .toBe('Boiler · Dampftemperatur: 155 °C → 156 °C');
    expect(describeChange({ kind: 'profileAdded', profile: { id: 7, name: 'Turbo' } })).toBe('Profil „Turbo“ hinzugefügt');
    expect(describeChange(setting(['boiler', 'dreamSteamState'], { change: 'changed', from: true, to: false })))
      .toBe('Boiler · Dream steam state: ja → nein');
    S.currentLang = 'en';
  });

  it('enables Compare for exactly two picked backups', async () => {
    api.list.mockResolvedValue({ ok: true, value: [newer, older, entry({ id: 6, createdAt: Date.parse('2026-11-05T20:00:00Z') })] });
    await openMachineBackups(1, null);
    await flush();
    expect((el.innerHTML.match(/class="mbk-pick"/g) ?? []).length).toBe(3);
    expect(el.innerHTML).toContain('aria-label="Select the backup from ');
    expect(el.innerHTML).toContain('data-mbk-action="compare" disabled');
    setPick('5', true);
    expect(el.innerHTML).toContain('Pick two backups to compare them.');
    expect(el.innerHTML).toContain('data-mbk-action="compare" disabled');
    setPick('7', true);
    expect(el.innerHTML).toContain('data-mbk-action="compare">');
    expect(el.innerHTML).not.toContain('Pick two backups to compare them.');
    setPick('6', true);
    expect(el.innerHTML).toContain('data-mbk-action="compare" disabled');
    expect(el.innerHTML).toContain('Pick two backups to compare them.');
    setPick('6', false);
    expect(el.innerHTML).toContain('data-mbk-action="compare">');
    setPick('99', true); // not on this list
    expect(el.innerHTML).toContain('data-mbk-action="compare">');
    expect(api.get).not.toHaveBeenCalled();
  });

  it('compares older to newer whatever the pick order', async () => {
    api.list.mockResolvedValue({ ok: true, value: [newer, older] });
    api.get.mockImplementation((id: number) => Promise.resolve(id === 7
      ? okDetail(detail({ id: 7, createdAt: older.createdAt, contentHash: 'h7' }, {
        format: 'gaggiuino-settings', version: 1, settings: { boiler: { steamSetPoint: 155 } },
      }))
      : okDetail(detail({ id: 5, contentHash: 'h5' }, {
        format: 'gaggiuino-settings', version: 1, settings: { boiler: { steamSetPoint: 156 } },
      }))));
    await openMachineBackups(1, null);
    await flush();
    setPick('5', true); // newer first: the order must not matter
    setPick('7', true);
    click('compare');
    await flush();
    expect(api.get.mock.calls).toEqual([[5], [7]]);
    expect(el.innerHTML).toContain('class="mbk-cmp"');
    expect(el.innerHTML).toContain('<li>Boiler · Steam temperature: 155 °C → 156 °C</li>');
    expect(el.innerHTML).toContain('1 change');
    click('cmp-back');
    expect(el.innerHTML).not.toContain('class="mbk-cmp"');
    expect((el.innerHTML.match(/checked/g) ?? []).length).toBe(2);
  });

  it('says when two backups are identical or differ only in order', async () => {
    api.list.mockResolvedValue({ ok: true, value: [newer, older] });
    const doc = (): Record<string, unknown> =>
      ({ format: 'gaggiuino-settings', version: 1, profiles: [{ id: 1, name: 'A' }, { id: 2, name: 'B' }] });
    api.get.mockImplementation((id: number) => Promise.resolve(okDetail(detail({
      id, createdAt: id === 7 ? older.createdAt : newer.createdAt, contentHash: 'same',
    }, doc()))));
    await openMachineBackups(1, null);
    await flush();
    setPick('5', true);
    setPick('7', true);
    click('compare');
    await flush();
    expect(el.innerHTML).toContain('These two backups are identical.');
    expect(el.innerHTML).toContain('class="mbk-cmp-egg"');
    expect(el.innerHTML).not.toContain('<ul');
    click('cmp-back');
    // Different hashes, same content: only the profile order differs.
    api.get.mockImplementation((id: number) => Promise.resolve(okDetail(detail({
      id, createdAt: id === 7 ? older.createdAt : newer.createdAt, contentHash: id === 7 ? 'h7' : 'h5',
    }, id === 7
      ? { format: 'gaggiuino-settings', version: 1, profiles: [{ id: 1, name: 'A' }, { id: 2, name: 'B' }] }
      : { format: 'gaggiuino-settings', version: 1, profiles: [{ id: 2, name: 'B' }, { id: 1, name: 'A' }] }))));
    click('compare');
    await flush();
    expect(el.innerHTML).toContain('These backups differ only in order or format.');
    expect(el.innerHTML).not.toContain('mbk-cmp-egg');
  });

  it('escapes everything from the documents', async () => {
    api.list.mockResolvedValue({ ok: true, value: [newer, older] });
    api.get.mockImplementation((id: number) => Promise.resolve(okDetail(detail({
      id, createdAt: id === 7 ? older.createdAt : newer.createdAt, contentHash: id === 7 ? 'h7' : 'h5',
    }, id === 7
      ? { format: 'gaggiuino-settings', version: 1, profiles: [] }
      : { format: 'gaggiuino-settings', version: 1, profiles: [{ id: 9, name: '<img src=x onerror=alert(1)>' }] }))));
    await openMachineBackups(1, null);
    await flush();
    setPick('5', true);
    setPick('7', true);
    click('compare');
    await flush();
    expect(el.innerHTML).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(el.innerHTML).not.toContain('<img');
  });

  it('stays on the list when a backup cannot be read', async () => {
    api.list.mockResolvedValue({ ok: true, value: [newer, older] });
    const f = failure({ status: 404 });
    api.get.mockImplementation((id: number) => Promise.resolve(id === 7
      ? okDetail(detail({ id: 7, createdAt: older.createdAt }))
      : f));
    await openMachineBackups(1, null);
    await flush();
    setPick('5', true);
    setPick('7', true);
    click('compare');
    await flush();
    expect(toast.show).toHaveBeenLastCalledWith('This backup or machine no longer exists.', 6000);
    expect(el.innerHTML).not.toContain('mbk-cmp');
  });

  it('drops a compare answer for a sheet that is no longer open', async () => {
    api.list.mockResolvedValue({ ok: true, value: [newer, older] });
    const gate = deferred();
    api.get.mockImplementation(async (_id: number) => {
      await gate.promise;
      return failure({ status: 404 }); // would toast if it reached the old sheet
    });
    await openMachineBackups(1, null);
    await flush();
    setPick('5', true);
    setPick('7', true);
    click('compare');
    await openMachineBackups(2, null); // another sheet opened meanwhile
    el.dataset.machineId = '2'; // the fresh #mbkSheet names machine 2
    el.innerHTML = '';
    await flush();
    gate.resolve();
    await flush();
    expect(el.innerHTML).not.toContain('mbk-cmp');
    expect(toast.show).not.toHaveBeenCalled();
  });

  it("compares a deleted machine's backup with an own one", async () => {
    const orphan = entry({ id: 9, machineId: 7, createdAt: Date.parse('2026-11-04T09:00:00Z'), contentHash: 'h9' });
    S.machines = [{ id: 1, name: 'Gaggia', type: 'gaggiuino' }];
    api.list.mockResolvedValue({ ok: true, value: [newer, orphan] });
    api.get.mockImplementation((id: number) => Promise.resolve(id === 9
      ? okDetail(detail({ id: 9, machineId: 7, createdAt: orphan.createdAt, contentHash: 'h9' }, {
        format: 'gaggiuino-settings', version: 1, settings: { boiler: { steamSetPoint: 150 } },
      }))
      : okDetail(detail({ id: 5 }, { format: 'gaggiuino-settings', version: 1, settings: { boiler: { steamSetPoint: 155 } } }))));
    await openMachineBackups(1, null);
    await flush();
    expect(el.innerHTML).toContain('class="mbk-pick" data-id="9"');
    setPick('9', true);
    setPick('5', true);
    expect(el.innerHTML).toContain('data-mbk-action="compare">');
    click('compare');
    await flush();
    expect(el.innerHTML).toContain('<li>Boiler · Steam temperature: 150 °C → 155 °C</li>');
  });

  it('has the new strings in all six languages', () => {
    const keys = [
      'mbk_compare', 'mbk_compare_hint', 'mbk_pick', 'mbk_cmp_back', 'mbk_cmp_count', 'mbk_yes', 'mbk_no',
      'mbk_cmp_changed', 'mbk_cmp_changed_plain', 'mbk_cmp_added', 'mbk_cmp_removed', 'mbk_cmp_default_profile',
      'mbk_cmp_profile', 'mbk_cmp_profile_added', 'mbk_cmp_profile_removed', 'mbk_cmp_profile_renamed',
      'mbk_cmp_phase_changed', 'mbk_cmp_phase_added', 'mbk_cmp_phase_removed', 'mbk_cmp_pump',
      'mbk_cmp_identical', 'mbk_cmp_identical_egg', 'mbk_cmp_order_only', 'mbk_cat_boiler', 'mbk_cat_system',
      'mbk_cat_led', 'mbk_cat_scales', 'mbk_cat_display', 'mbk_cat_theme', 'mbk_cat_webui',
      'mbk_lbl_steam_temp', 'mbk_lbl_temp_offset', 'mbk_lbl_auto_flush', 'mbk_lbl_min_shot', 'mbk_lbl_warmup',
      'mbk_lbl_brew_heater', 'mbk_lbl_steam_heater', 'mbk_lbl_pump_power', 'mbk_lbl_idle_power',
      'mbk_lbl_machine_name', 'mbk_lbl_water_temp', 'mbk_lbl_dose', 'mbk_lbl_yield', 'mbk_lbl_stop_weight',
    ];
    for (const key of keys) {
      const ref = en[key];
      for (const [name, dict] of Object.entries(LANGS)) {
        const value = dict[key];
        expect(typeof value, `${name}:${key}`).toBe(typeof ref);
        if (typeof ref === 'function' && typeof value === 'function') expect(value.length, `${name}:${key}`).toBe(ref.length);
        expect(value, `${name}:${key} empty`).toBeTruthy();
      }
    }
    expect(formatter(en.mbk_cmp_count)(1)).toBe('1 change');
    expect(formatter(de.mbk_cmp_count)(2)).toBe('2 Änderungen');
    expect(formatter(en.mbk_cmp_added)('Idle power', '')).toBe('Idle power added');
  });
});
