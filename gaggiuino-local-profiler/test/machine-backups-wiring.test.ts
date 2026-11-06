// #1878 W: the wiring of the machine backups sheet into Settings → Machines —
// the Backups row action and the "update without a backup" override after a
// failed pre-update backup. The sheet itself is covered by
// machine-backups-sheet.test.ts and is mocked here.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import type { FirmwareProgress, FirmwareVersion } from '../public-src/api/types.js';
import type { TranslationValue } from '../public-src/i18n.js';

// vitest's node environment has no browser globals; stub them through a loose
// view of globalThis (same bridge as the firmware tests).
const g = globalThis as unknown as Record<string, unknown>;
g.localStorage ??= { getItem: () => null, setItem: () => {} };
g.window ??= globalThis;

interface Fake {
  innerHTML: string;
  className: string;
  textContent: string;
  title: string;
  style: Record<string, string>;
  disabled: boolean;
  handlers: Record<string, () => void>;
  children: Fake[];
  addEventListener(type: string, fn: () => void): void;
  querySelector(sel: string): Fake;
  removeAttribute(name: string): void;
  remove(): void;
  setAttribute(name: string, value: string): void;
  appendChild(child: Fake): void;
}

// Every fake keeps its own querySelector cache, so a listener the component
// binds to `.machine-backups-btn` can be found again by the test.
function fake(): Fake {
  const kids: Record<string, Fake> = {};
  const el: Fake = {
    innerHTML: '', className: '', textContent: '', title: '', style: {}, disabled: false,
    handlers: {}, children: [],
    addEventListener(type, fn) { el.handlers[type] = fn; },
    querySelector(sel) { return (kids[sel] ??= fake()); },
    removeAttribute() {}, remove() {}, setAttribute() {}, appendChild(child) { el.children.push(child); },
  };
  return el;
}

const list = fake();
g.document = {
  getElementById: (id: string) => (id === 'machinesList' ? list : undefined),
  createElement: () => fake(),
  querySelectorAll: () => [],
};

const toast = vi.fn<(message: string) => void>();
g.showToast = toast;

const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>();
g.fetch = fetchMock;

const apiMocks = vi.hoisted(() => ({
  getFirmwareProgress: vi.fn<(machineId: string | number) => Promise<FirmwareProgress | null>>(),
  triggerFirmwareUpdate: vi.fn<(machineId: string | number, skipBackup?: boolean) => Promise<Response>>(),
  getFirmwareVersion: vi.fn<(machineId: string | number) => Promise<FirmwareVersion | null>>(),
}));

vi.mock('../public-src/api/machines.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../public-src/api/machines.js')>()),
  getFirmwareProgress: apiMocks.getFirmwareProgress,
  triggerFirmwareUpdate: apiMocks.triggerFirmwareUpdate,
  getFirmwareVersion: apiMocks.getFirmwareVersion,
}));

const sheetMock = vi.hoisted(() => ({
  openMachineBackups: vi.fn<(machineId: number, anchor: HTMLElement | null) => Promise<void>>(),
  confirmUpdateWithoutBackup: vi.fn<() => boolean>(),
}));

// The button markup stays real; only opening the sheet and the confirm dialog
// are replaced.
vi.mock('../public-src/components/machine-backups.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../public-src/components/machine-backups.js')>()),
  openMachineBackups: sheetMock.openMachineBackups,
  confirmUpdateWithoutBackup: sheetMock.confirmUpdateWithoutBackup,
}));

const realApi = await vi.importActual<typeof import('../public-src/api/machines.js')>('../public-src/api/machines.js');
const { S } = await import('../public-src/state/index.js');
const { renderMachinesList, triggerMachineFirmwareUpdate } = await import(
  '../public-src/components/machines-settings.js'
);
const en = (await import('../public-src/i18n/en.js')).default;

function formatter(value: TranslationValue | undefined): (...args: unknown[]) => string {
  if (typeof value !== 'function') throw new TypeError('expected an i18n formatter');
  return value;
}

const failed = (status: number, body: Record<string, unknown>): Response =>
  ({ ok: false, status, json: () => Promise.resolve(body) } as unknown as Response);

const ok = (): Response => ({ ok: true, status: 200, json: () => Promise.resolve({}) } as unknown as Response);

const banner = '.machine-firmware-update-banner';
const button = '.machine-firmware-update-btn';

describe('the firmware update API body (#1878)', () => {
  S.currentLang = 'en';

  it('sends skipBackup only after the override', async () => {
    fetchMock.mockResolvedValue(ok());

    await realApi.triggerFirmwareUpdate(3);
    await realApi.triggerFirmwareUpdate(3, true);
    await realApi.triggerFirmwareUpdate('3', false);

    expect(fetchMock).toHaveBeenCalledTimes(3);
    for (const call of fetchMock.mock.calls) expect(call[0]).toBe('api/machine/firmware/update');
    expect(String(fetchMock.mock.calls[0]?.[1]?.body)).toBe('{"machineId":3}');
    expect(String(fetchMock.mock.calls[1]?.[1]?.body)).toBe('{"machineId":3,"skipBackup":true}');
    expect(String(fetchMock.mock.calls[2]?.[1]?.body)).toBe('{"machineId":3}');
  });
});

describe('triggerMachineFirmwareUpdate with a failed pre-update backup (#1878)', () => {
  S.currentLang = 'en';

  beforeEach(() => {
    vi.useFakeTimers();
    apiMocks.getFirmwareProgress.mockResolvedValue({ status: 'IDLE' });
  });

  afterEach(async () => {
    await vi.advanceTimersByTimeAsync(0);
    vi.clearAllTimers();
    apiMocks.getFirmwareProgress.mockReset();
    apiMocks.triggerFirmwareUpdate.mockReset();
    sheetMock.confirmUpdateWithoutBackup.mockReset();
    toast.mockReset();
  });

  it('offers the override when the backup before the update failed', async () => {
    const row = fake();
    apiMocks.triggerFirmwareUpdate.mockResolvedValue(
      failed(502, { error: 'x', code: 'pre_update_backup_failed' }),
    );
    sheetMock.confirmUpdateWithoutBackup.mockReturnValue(false);

    await triggerMachineFirmwareUpdate(9201, row);

    expect(sheetMock.confirmUpdateWithoutBackup).toHaveBeenCalledTimes(1);
    expect(apiMocks.triggerFirmwareUpdate).toHaveBeenCalledTimes(1);
    expect(apiMocks.triggerFirmwareUpdate).toHaveBeenCalledWith(9201, false);
    expect(toast).not.toHaveBeenCalled();
    expect(row.querySelector(banner).style.display).toBe('');
    expect(row.querySelector(button).disabled).toBe(false);
  });

  it('resends with skipBackup only when the user confirms', async () => {
    const row = fake();
    apiMocks.triggerFirmwareUpdate
      .mockResolvedValueOnce(failed(502, { error: 'x', code: 'pre_update_backup_failed' }))
      .mockResolvedValueOnce(ok());
    sheetMock.confirmUpdateWithoutBackup.mockReturnValue(true);

    await triggerMachineFirmwareUpdate(9201, row);

    expect(apiMocks.triggerFirmwareUpdate).toHaveBeenCalledTimes(2);
    expect(apiMocks.triggerFirmwareUpdate).toHaveBeenNthCalledWith(1, 9201, false);
    expect(apiMocks.triggerFirmwareUpdate).toHaveBeenNthCalledWith(2, 9201, true);
    expect(row.querySelector(button).disabled).toBe(true);
    expect(toast).not.toHaveBeenCalled();
  });

  it('keeps the generic toast for every other failure', async () => {
    const expected = formatter(en.settings_machine_firmware_trigger_failed)('busy');

    for (const [status, code] of [[409, 'operation_running'], [502, 'machine_unreachable']] as const) {
      apiMocks.triggerFirmwareUpdate.mockResolvedValueOnce(failed(status, { error: 'busy', code }));
      const row = fake();

      await triggerMachineFirmwareUpdate(9203, row);

      expect(sheetMock.confirmUpdateWithoutBackup).not.toHaveBeenCalled();
      expect(toast).toHaveBeenCalledTimes(1);
      expect(toast).toHaveBeenCalledWith(expected);
      toast.mockReset();
    }
  });

  it('never offers the override on a post that already skipped the backup', async () => {
    apiMocks.triggerFirmwareUpdate.mockResolvedValueOnce(
      failed(502, { error: 'busy', code: 'pre_update_backup_failed' }),
    );
    const row = fake();

    await triggerMachineFirmwareUpdate(9202, row, true);

    expect(sheetMock.confirmUpdateWithoutBackup).not.toHaveBeenCalled();
    expect(apiMocks.triggerFirmwareUpdate).toHaveBeenCalledTimes(1);
    expect(toast).toHaveBeenCalledTimes(1);
    expect(toast).toHaveBeenCalledWith(formatter(en.settings_machine_firmware_trigger_failed)('busy'));
  });
});

describe('the Backups row action (#1878)', () => {
  S.currentLang = 'en';

  beforeEach(() => {
    list.children.length = 0;
    list.innerHTML = '';
    apiMocks.getFirmwareVersion.mockResolvedValue(null);
    apiMocks.getFirmwareProgress.mockResolvedValue({ status: 'IDLE' });
    sheetMock.openMachineBackups.mockReset();
    S.machines = [
      { id: 1, name: 'Gaggia', type: 'gaggiuino', isDefault: true },
      { id: 2, name: 'Mate', type: 'gaggimate' },
    ] as unknown as typeof S.machines;
    S.allShots = [] as unknown as typeof S.allShots;
  });

  it('adds the Backups action to Gaggiuino rows only', () => {
    renderMachinesList();

    const gaggiuino = list.children[0];
    const gaggimate = list.children[1];
    if (!gaggiuino || !gaggimate) throw new Error('expected two machine rows');

    const markup = gaggiuino.innerHTML;
    const edit = markup.indexOf('machine-edit-btn');
    const backups = markup.indexOf('class="machine-backups-btn">Backups</button>');
    const del = markup.indexOf('machine-delete-btn');
    expect(edit).toBeGreaterThanOrEqual(0);
    expect(backups).toBeGreaterThan(edit);
    expect(del).toBeGreaterThan(backups);
    expect(gaggimate.innerHTML).not.toContain('machine-backups-btn');

    const btn = gaggiuino.querySelector('.machine-backups-btn');
    btn.handlers.click?.();
    expect(sheetMock.openMachineBackups).toHaveBeenCalledWith(1, btn);
  });
});

describe('the shipped docs, styles and changelog (#1878)', () => {
  const read = (path: string): string => readFileSync(new URL(path, import.meta.url), 'utf8');

  it('ships the changelog fragment', () => {
    const fragment = read('../changelog.d/1878.added.md');
    expect(fragment).toBe(
      '- **Gaggiuino machines now keep a history of their settings and profiles.** GLP backs them up daily, '
      + 'before firmware updates and on demand, without storing Wi-Fi or MQTT passwords, and can download, '
      + 'upload, compare and restore any version. Part of #1878\n',
    );
    expect(fragment).toContain('Part of #1878');
    expect(fragment).not.toContain('Closes');
  });

  it('documents the feature in both languages, before the HA theme section', () => {
    const docs = read('../DOCS.md');
    const docsDe = read('../DOCS.de.md');
    expect(docs).toContain('### Machine settings backups (Gaggiuino)');
    expect(docs.indexOf('### Machine settings backups (Gaggiuino)')).toBeLessThan(docs.indexOf('### HA theme'));
    expect(docsDe).toContain('### Maschinen-Backups (Gaggiuino)');
    expect(docsDe.indexOf('### Maschinen-Backups (Gaggiuino)')).toBeLessThan(docsDe.indexOf('### HA-Theme'));
    expect(read('../../README.md')).toContain('- **Machine settings backups** - ');
  });

  it('styles the sheet with 44 px targets and theme tokens', () => {
    const css = read('../public-src/style.css');
    expect(css).toContain('.mbk-sheet {');
    expect(css).toContain('.mbk-btn { min-height:44px;');
    const pickWrap = css.slice(css.indexOf('.mbk-pick-wrap {'));
    expect(pickWrap.slice(0, pickWrap.indexOf('}'))).toContain('min-height:44px');
  });
});
