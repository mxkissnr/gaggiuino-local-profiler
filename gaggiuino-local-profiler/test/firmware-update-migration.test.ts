// #1876: the firmware progress poller and the update banner. Firmware
// main-8aaf6f0 and later migrates its partition layout after an update and
// reports IDLE while doing it, so "any non-IDLE status is active" closed the
// panel about six minutes early and offered Start update again mid-update.
// The timeline below is the one observed on 2026-11-03.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { FirmwareProgress } from '../public-src/api/types.js';
import type { TranslationValue } from '../public-src/i18n.js';

// vitest's node environment has no browser globals; stub them through a loose
// view of globalThis (same bridge as the #1085 label test).
const g = globalThis as unknown as Record<string, unknown>;
g.localStorage ??= { getItem: () => null, setItem: () => {} };
g.window ??= globalThis;
g.document = { getElementById: () => undefined, querySelectorAll: () => [] };

const toast = vi.fn<(message: string) => void>();
g.showToast = toast;

// Only the two firmware calls the trigger/poll path makes are replaced; the
// rest of the machines API stays real so unrelated imports keep working.
const apiMocks = vi.hoisted(() => ({
  getFirmwareProgress: vi.fn<(machineId: string | number) => Promise<FirmwareProgress | null>>(),
  triggerFirmwareUpdate: vi.fn<(machineId: string | number) => Promise<Response>>(),
}));

vi.mock('../public-src/api/machines.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../public-src/api/machines.js')>()),
  getFirmwareProgress: apiMocks.getFirmwareProgress,
  triggerFirmwareUpdate: apiMocks.triggerFirmwareUpdate,
}));

const { S } = await import('../public-src/state/index.js');
const {
  FIRMWARE_POLL_MAX_MS,
  firmwarePollStep,
  firmwareProgressLabel,
  firmwareProgressPercent,
  isFirmwareBusy,
  setFirmwareUpdateBusy,
  triggerMachineFirmwareUpdate,
} = await import('../public-src/components/machines-settings.js');
const en = (await import('../public-src/i18n/en.js')).default;
const de = (await import('../public-src/i18n/de.js')).default;
const es = (await import('../public-src/i18n/es.js')).default;
const itLang = (await import('../public-src/i18n/it.js')).default;
const fr = (await import('../public-src/i18n/fr.js')).default;
const nl = (await import('../public-src/i18n/nl.js')).default;

const LANGS = { en, de, es, it: itLang, fr, nl };
const NEW_KEYS = [
  'settings_machine_firmware_keep_powered',
  'settings_machine_firmware_restarting',
  'settings_machine_firmware_migration_label',
  'settings_machine_firmware_migration_failed_toast',
];

function formatter(value: TranslationValue | undefined): (...args: unknown[]) => string {
  if (typeof value !== 'function') throw new TypeError('expected an i18n formatter');
  return value;
}

function newPoll(seenActive = false) {
  return { startedAt: 0, failCount: 0, seenActive };
}

// The poll advances two seconds per step, like the real 2 s interval.
function stepper(poll: ReturnType<typeof newPoll>) {
  let now = 0;
  return (progress: FirmwareProgress | null) => {
    now += 2000;
    return firmwarePollStep(poll, progress, now);
  };
}

class FakeEl {
  style: Record<string, string> = {};
  disabled = false;
  textContent = '';
  className = '';
  querySelector = (): FakeEl | null => null;
  removeAttribute = vi.fn<(name: string) => void>();
  remove = vi.fn<() => void>();
}

function fakeRow(): { row: HTMLElement; els: Record<string, FakeEl> } {
  const els: Record<string, FakeEl> = {};
  const row = {
    querySelector: (selector: string) => (els[selector] ??= new FakeEl()),
  } as unknown as HTMLElement;
  return { row, els };
}

const banner = '.machine-firmware-update-banner';
const button = '.machine-firmware-update-btn';

describe('firmwarePollStep (#1876)', () => {
  S.currentLang = 'en';

  it('keeps the update running through the whole 2026-11-03 timeline', () => {
    const poll = newPoll();
    const step = stepper(poll);

    for (const type of ['C_FW', 'F_FW', 'F_FS']) {
      expect(step({ status: 'IN_PROGRESS', progress: 12, type }).kind).toBe('show');
    }
    // Reboot: the proxy answers 502, so the API helper returns null. Five
    // misses, well past the old three-failure cut-off.
    for (let i = 0; i < 5; i++) expect(step(null).kind).toBe('restarting');

    // Migration started while the update status still says IDLE.
    expect(step({ status: 'IDLE', migration: { active: true } }).kind).toBe('show');
    expect(step({
      status: 'IN_PROGRESS',
      type: 'F_FW',
      migration: { active: true, operation: 'Installing update', percent: 30 },
    }).kind).toBe('show');

    // About four minutes unreachable.
    for (let i = 0; i < 120; i++) expect(step(null).kind).toBe('restarting');

    expect(step({ status: 'IN_PROGRESS', migration: { active: true, phase: 8, operation: 'Verifying update' } }).kind)
      .toBe('show');
    expect(step({ status: 'SUCCESS', migration: { active: false, state: 'complete', error: '' } }))
      .toEqual({ kind: 'done', result: 'success' });
  });

  it('treats an active migration as busy whatever the status says', () => {
    expect(isFirmwareBusy({ status: 'IDLE', migration: { active: true } })).toBe(true);
    expect(isFirmwareBusy({ status: 'IDLE', migration: { state: 'working' } })).toBe(true);
    expect(isFirmwareBusy({ status: 'in_progress' })).toBe(true);
    expect(isFirmwareBusy({ status: 'IDLE' })).toBe(false);
    expect(isFirmwareBusy({ status: 'SUCCESS', migration: { state: 'complete', active: false } })).toBe(false);
  });

  it('finishes old firmware without a migration object as before', () => {
    const direct = newPoll();
    const first = stepper(direct);
    expect(first({ status: 'IN_PROGRESS', progress: 50 }).kind).toBe('show');
    expect(first({ status: 'IDLE' })).toEqual({ kind: 'done', result: 'success' });

    const reboot = newPoll();
    const second = stepper(reboot);
    expect(second({ status: 'IN_PROGRESS', progress: 50 }).kind).toBe('show');
    for (let i = 0; i < 4; i++) expect(second(null).kind).toBe('restarting');
    expect(second({ status: 'IDLE' })).toEqual({ kind: 'done', result: 'success' });

    const success = newPoll();
    const third = stepper(success);
    expect(third({ status: 'IN_PROGRESS' }).kind).toBe('show');
    expect(third({ status: 'SUCCESS' })).toEqual({ kind: 'done', result: 'success' });
  });

  it('fails an update that never starts, but an idle answer resets the run', () => {
    const never = newPoll();
    const step = stepper(never);
    expect(step(null)).toEqual({ kind: 'wait' });
    expect(step(null)).toEqual({ kind: 'wait' });
    expect(step(null)).toEqual({ kind: 'done', result: 'failed' });

    const reset = newPoll();
    const other = stepper(reset);
    expect(other(null).kind).toBe('wait');
    expect(other(null).kind).toBe('wait');
    expect(other({ status: 'IDLE' })).toEqual({ kind: 'wait' });
    expect(other(null)).toEqual({ kind: 'wait' });
  });

  it('ends the poll with an error when the machine or the migration reports one', () => {
    const errorStatus = newPoll();
    const first = stepper(errorStatus);
    expect(first({ status: 'IN_PROGRESS' }).kind).toBe('show');
    expect(first({ status: 'ERROR' })).toEqual({ kind: 'done', result: 'error', detail: '' });

    const migrationError = newPoll();
    const second = stepper(migrationError);
    expect(second({ status: 'IN_PROGRESS' }).kind).toBe('show');
    expect(second({ status: 'ERROR', migration: { active: false, error: 'Partition write failed' } }))
      .toEqual({ kind: 'done', result: 'error', detail: 'Partition write failed' });

    // Busy wins over the error field.
    const busy = newPoll();
    expect(stepper(busy)({ status: 'IN_PROGRESS', migration: { active: true, error: 'x' } }).kind).toBe('show');

    // A stale error before the update started must persist for three polls.
    const stale = newPoll();
    const third = stepper(stale);
    expect(third({ status: 'ERROR' })).toEqual({ kind: 'wait' });
    expect(third({ status: 'ERROR' })).toEqual({ kind: 'wait' });
    expect(third({ status: 'ERROR' })).toEqual({ kind: 'done', result: 'error', detail: '' });

    const long = newPoll();
    const fourth = stepper(long);
    expect(fourth({ status: 'IN_PROGRESS' }).kind).toBe('show');
    const capped = fourth({ status: 'ERROR', migration: { active: false, error: 'x'.repeat(300) } });
    expect(capped.kind === 'done' ? capped.detail : null).toBe('x'.repeat(120));
  });

  it('times out on wall clock, including the unreachable stretches', () => {
    const poll = newPoll();
    poll.seenActive = true;
    expect(firmwarePollStep(poll, null, FIRMWARE_POLL_MAX_MS - 1).kind).toBe('restarting');
    expect(firmwarePollStep(poll, null, FIRMWARE_POLL_MAX_MS)).toEqual({ kind: 'done', result: 'timeout' });
  });
});

describe('firmwareProgressLabel / firmwareProgressPercent (#1876)', () => {
  S.currentLang = 'en';

  const migrating = {
    status: 'IN_PROGRESS',
    progress: 10,
    migration: { active: true, operation: 'Downloading update', percent: 95 },
  } satisfies FirmwareProgress;

  it('uses the migration step and percent while the migration runs', () => {
    expect(firmwareProgressPercent(migrating)).toBe(95);
    expect(firmwareProgressLabel(migrating, 95)).toBe('Finishing update: Downloading update… 95%');
  });

  it('drops the step when the machine sends none', () => {
    const noOp = { status: 'IN_PROGRESS', migration: { active: true, percent: 40 } } satisfies FirmwareProgress;
    expect(firmwareProgressLabel(noOp, 40)).toBe('Finishing update… 40%');
  });

  it('falls back to the stage label once the migration is complete', () => {
    const done = {
      status: 'SUCCESS',
      type: 'F_FW',
      progress: 100,
      migration: { active: false, state: 'complete' },
    } satisfies FirmwareProgress;
    expect(firmwareProgressPercent(done)).toBe(100);
    expect(firmwareProgressLabel(done, 100)).toBe('Frontend firmware… 100%');
  });

  it('leaves firmware without a migration unchanged', () => {
    expect(firmwareProgressLabel({ type: 'F_FS', progress: 12 }, 12)).toBe('Frontend filesystem… 12%');
    expect(firmwareProgressLabel({ progress: 12 }, 12)).toBe('Updating firmware… 12%');
    expect(firmwareProgressPercent({ progress: 140 })).toBe(100);
  });

  it('treats a working migration state as busy even without active', () => {
    const working = {
      status: 'IDLE', progress: 4,
      migration: { state: 'working', operation: 'Verifying update', percent: 60 },
    } satisfies FirmwareProgress;
    expect(firmwareProgressPercent(working)).toBe(60);
    expect(firmwareProgressLabel(working, 60)).toBe('Finishing update: Verifying update… 60%');
  });

  it('caps a long machine-provided step at 80 characters', () => {
    const long = 'x'.repeat(81);
    const label = firmwareProgressLabel(
      { status: 'IN_PROGRESS', migration: { active: true, operation: long, percent: 5 } }, 5);
    expect(label).toContain('x'.repeat(80));
    expect(label).not.toContain('x'.repeat(81));
  });
});

describe('new firmware strings (#1876)', () => {
  S.currentLang = 'en';

  it('every language has the four new keys', () => {
    for (const [name, dict] of Object.entries(LANGS)) {
      for (const key of NEW_KEYS) {
        expect(dict[key], `${name}.js missing ${key}`).toBeTruthy();
      }
    }
  });

  it('the migration label formatter keeps the percentage and the step', () => {
    for (const [name, dict] of Object.entries(LANGS)) {
      const label = formatter(dict.settings_machine_firmware_migration_label);
      const withOp = label('Downloading update', 95);
      const withoutOp = label('', 95);
      expect(withOp, `${name}.js with op`).toContain('95');
      expect(withOp, `${name}.js with op`).toContain('Downloading update');
      expect(withoutOp, `${name}.js without op`).toContain('95');
      for (const rendered of [withOp, withoutOp]) {
        expect(rendered, `${name}.js undefined`).not.toContain('undefined');
      }
    }
  });

  it('the migration failure toast keeps the machine message', () => {
    for (const [name, dict] of Object.entries(LANGS)) {
      const rendered = formatter(dict.settings_machine_firmware_migration_failed_toast)('Partition write failed');
      expect(rendered, `${name}.js`).toContain('Partition write failed');
      expect(rendered, `${name}.js undefined`).not.toContain('undefined');
    }
  });
});

describe('the update banner while an update runs (#1876)', () => {
  S.currentLang = 'en';

  it('hides the banner and disables the button, and restores both', () => {
    const { row, els } = fakeRow();
    setFirmwareUpdateBusy(row, true);
    expect(els[banner]?.style.display).toBe('none');
    expect(els[button]?.disabled).toBe(true);

    setFirmwareUpdateBusy(row, false);
    expect(els[banner]?.style.display).toBe('');
    expect(els[button]?.disabled).toBe(false);
  });

  it('is null-safe on a row without the banner', () => {
    const row = { querySelector: () => null } as unknown as HTMLElement;
    expect(() => setFirmwareUpdateBusy(row, true)).not.toThrow();
  });
});

describe('triggerMachineFirmwareUpdate (#1876)', () => {
  S.currentLang = 'en';

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(async () => {
    // Let an in-flight poll tick finish before the mocks and timers go away.
    await vi.advanceTimersByTimeAsync(0);
    vi.clearAllTimers();
    vi.useRealTimers();
    apiMocks.getFirmwareProgress.mockReset();
    apiMocks.triggerFirmwareUpdate.mockReset();
    toast.mockReset();
  });

  it('adopts an update the machine already reports instead of starting a second one', async () => {
    apiMocks.getFirmwareProgress.mockResolvedValue({ status: 'IN_PROGRESS' });
    const { row, els } = fakeRow();

    await triggerMachineFirmwareUpdate(9101, row);

    expect(apiMocks.triggerFirmwareUpdate).not.toHaveBeenCalled();
    expect(els[banner]?.style.display).toBe('none');
    expect(els[button]?.disabled).toBe(true);
    expect(toast).not.toHaveBeenCalled();
  });

  it('keeps Start update hidden from success until the delayed status reload', async () => {
    apiMocks.getFirmwareProgress
      .mockResolvedValueOnce({ status: 'IN_PROGRESS' }) // the pre-check adopts it
      .mockResolvedValue({ status: 'SUCCESS', migration: { active: false, state: 'complete' } });
    const { row, els } = fakeRow();
    // Create the panel/badge entries the finish path looks for.
    const panel = els['.machine-row-firmware-panel'] ??= new FakeEl();
    const badge = els['.machine-row-firmware-badge'] ??= new FakeEl();

    await triggerMachineFirmwareUpdate(9103, row);
    await vi.advanceTimersByTimeAsync(10000);

    expect(toast).toHaveBeenCalledWith('Firmware update complete');
    expect(panel.remove).toHaveBeenCalled();
    expect(badge.textContent).toBe('Checking firmware version…');
    // No second-start window: the banner is never shown again before the reload.
    expect(els[banner]?.style.display).toBe('none');
    expect(els[button]?.disabled).toBe(true);
  });

  it('re-enables the banner and toasts once when the post fails', async () => {
    apiMocks.getFirmwareProgress.mockResolvedValue({ status: 'IDLE' });
    apiMocks.triggerFirmwareUpdate.mockResolvedValue({
      ok: false,
      status: 502,
      json: async () => ({ error: 'unreachable' }),
    } as unknown as Response);
    const { row, els } = fakeRow();

    await triggerMachineFirmwareUpdate(9102, row);

    expect(apiMocks.triggerFirmwareUpdate).toHaveBeenCalledTimes(1);
    expect(els[banner]?.style.display).toBe('');
    expect(els[button]?.disabled).toBe(false);
    expect(toast).toHaveBeenCalledTimes(1);
  });
});
