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
  FIRMWARE_ERROR_GRACE_MS,
  FIRMWARE_POLL_MAX_MS,
  firmwareFailedStageKey,
  firmwarePollStep,
  firmwareProgressLabel,
  firmwareProgressPercent,
  isFirmwareBusy,
  renderFirmwareRow,
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
  title = '';
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

// #2229: the migration object a real machine reported after a half-finished
// update AND through the whole successful retry: state "error", not active,
// empty error. Parsed from JSON because the machine sends more fields than the
// schema lists.
const STALE_MIGRATION = JSON.parse('{"layoutVersion":2,"layout":"s3-v2","phase":8,"attempts":0,"retryAllowed":false,"error":"","productionVersion":"8aaf6f0","target":"s3-lcd","headless":false,"runningVersion":"c929939","available":false,"active":false,"state":"error","message":"","operation":"","operationDone":0,"operationTotal":0,"activityAgeMs":16459,"percent":100,"page":"/migration"}') as NonNullable<FirmwareProgress['migration']>;
// The real final progress of the failed run (controller flashed to 7cb0a86,
// frontend left on c929939).
const FAILED_SPLIT: FirmwareProgress = { progress: 0, status: 'ERROR', type: 'F_FW', migration: STALE_MIGRATION };
// The successful retry on the same machine, 5 s polling, changes only
// (type, progress); every step was IN_PROGRESS with STALE_MIGRATION.
const LOGGED_RETRY: Array<[string, number]> = [
  ['C_FW', 95], ['F_FW', 0], ['F_FW', 5], ['F_FW', 62], ['F_FS', 0], ['F_FS', 46], ['F_FS', 100],
];

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

    // #2229: a stale error before the update started waits out the grace
    // period, then ends the run (the trigger never took effect).
    const stale = newPoll();
    expect(firmwarePollStep(stale, { status: 'ERROR' }, 2000)).toEqual({ kind: 'wait' });
    expect(firmwarePollStep(stale, { status: 'ERROR' }, 4000)).toEqual({ kind: 'wait' });
    expect(firmwarePollStep(stale, { status: 'ERROR' }, 6000)).toEqual({ kind: 'wait' });
    expect(firmwarePollStep(stale, { status: 'ERROR' }, FIRMWARE_ERROR_GRACE_MS - 1)).toEqual({ kind: 'wait' });
    expect(firmwarePollStep(stale, { status: 'ERROR' }, FIRMWARE_ERROR_GRACE_MS)).toEqual({ kind: 'done', result: 'error', detail: '' });

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
    // Create the panel, status and update entries the finish path looks for.
    const panel = els['.machine-row-firmware-panel'] ??= new FakeEl();
    const status = els['.machine-row-firmware-status'] ??= new FakeEl();
    const update = els['.machine-row-firmware-update'] ??= new FakeEl();

    await triggerMachineFirmwareUpdate(9103, row);
    await vi.advanceTimersByTimeAsync(10000);

    expect(toast).toHaveBeenCalledWith('Firmware update complete');
    expect(panel.remove).toHaveBeenCalled();
    expect(status.textContent).toBe('Checking firmware version…');
    expect(status.className).toBe('badge machine-row-firmware-status');
    expect(update.style.display).toBe('none');
    // No second-start window: the banner is never shown again before the reload.
    expect(els[banner]?.style.display).toBe('none');
    expect(els[button]?.disabled).toBe(true);
  });

  it('re-enables the banner and toasts once when the post fails', async () => {
    apiMocks.getFirmwareProgress.mockResolvedValue({ status: 'IDLE' });
    apiMocks.triggerFirmwareUpdate.mockResolvedValue({
      ok: false,
      status: 502,
      json: () => Promise.resolve({ error: 'unreachable' }),
    } as unknown as Response);
    const { row, els } = fakeRow();

    await triggerMachineFirmwareUpdate(9102, row);

    expect(apiMocks.triggerFirmwareUpdate).toHaveBeenCalledTimes(1);
    expect(els[banner]?.style.display).toBe('');
    expect(els[button]?.disabled).toBe(false);
    expect(toast).toHaveBeenCalledTimes(1);
  });

  it('toasts the failed stage and keeps it in the row', async () => {
    apiMocks.getFirmwareProgress
      .mockResolvedValueOnce({ status: 'IN_PROGRESS' }) // the pre-check adopts it
      .mockResolvedValue(FAILED_SPLIT);
    const { row, els } = fakeRow();

    await triggerMachineFirmwareUpdate(9104, row);
    await vi.advanceTimersByTimeAsync(0);

    expect(toast).toHaveBeenCalledTimes(1);
    expect(toast).toHaveBeenCalledWith('Firmware update failed: Frontend firmware');
    expect(els['.machine-firmware-update-msg']?.textContent).toBe('Firmware update failed: Frontend firmware');
    expect(els[banner]?.style.display).toBe('');
    expect(els[button]?.disabled).toBe(false);
  });

  it('does not report a retry as failed while the machine still answers the old ERROR', async () => {
    apiMocks.getFirmwareProgress.mockResolvedValue(FAILED_SPLIT);
    apiMocks.triggerFirmwareUpdate.mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ success: true }),
    } as unknown as Response);
    const { row, els } = fakeRow();

    await triggerMachineFirmwareUpdate(9105, row);
    await vi.advanceTimersByTimeAsync(10000);

    expect(apiMocks.triggerFirmwareUpdate).toHaveBeenCalledTimes(1);
    expect(toast).not.toHaveBeenCalled();
    expect(els[banner]?.style.display).toBe('none');
    expect(els[button]?.disabled).toBe(true);
  });
});

describe('half-finished update (#2229)', () => {
  S.currentLang = 'en';

  it('names the frontend firmware stage for the real failed-update payload', () => {
    expect(firmwarePollStep(newPoll(true), FAILED_SPLIT, 2000)).toEqual({
      kind: 'done', result: 'error', detail: '', stage: 'settings_machine_firmware_stage_f_fw',
    });
    expect(firmwareFailedStageKey({ status: 'ERROR' })).toBeNull();
    expect(firmwareFailedStageKey({ status: 'ERROR', type: 'X_FW', migration: STALE_MIGRATION })).toBeNull();
  });

  it('a stale migration error does not fail a successful update', () => {
    for (const finalStatus of ['SUCCESS', 'IDLE']) {
      const step = stepper(newPoll());
      LOGGED_RETRY.forEach(([type, progress], i) => {
        const p: FirmwareProgress = { status: 'IN_PROGRESS', type, progress, migration: STALE_MIGRATION };
        const s = step(p);
        expect(s.kind).toBe('show');
        if (i === 0) expect(firmwareProgressLabel(p, firmwareProgressPercent(p))).toBe('Controller firmware… 95%');
      });
      expect(step(null)).toEqual({ kind: 'restarting' });
      expect(step({ status: finalStatus, progress: 100, type: 'F_FS', migration: STALE_MIGRATION }))
        .toEqual({ kind: 'done', result: 'success' });
    }
  });

  it('a stale ERROR from the failed run does not fail the retry', () => {
    const step = stepper(newPoll());
    // The machine still answers the old failed run's status after the trigger.
    for (let i = 0; i < 5; i++) expect(step(FAILED_SPLIT)).toEqual({ kind: 'wait' });
    for (const [type, progress] of LOGGED_RETRY) {
      expect(step({ status: 'IN_PROGRESS', type, progress, migration: STALE_MIGRATION }).kind).toBe('show');
    }
    expect(step(null)).toEqual({ kind: 'restarting' });
    expect(step({ status: 'SUCCESS', progress: 100, type: 'F_FS', migration: STALE_MIGRATION }))
      .toEqual({ kind: 'done', result: 'success' });
  });

  it('an ERROR answer restarts the unreachable count before the run is given up', () => {
    const step = stepper(newPoll());
    // The machine answered, so only the polls after it count as unreachable.
    expect(step({ status: 'ERROR' })).toEqual({ kind: 'wait' });
    expect(step(null)).toEqual({ kind: 'wait' });
    expect(step(null)).toEqual({ kind: 'wait' });
    expect(step(null)).toEqual({ kind: 'done', result: 'failed' });
  });

  it('warns on the row and offers the update for a split machine', () => {
    const { row, els } = fakeRow();
    const panel = els['.machine-row-firmware-panel'] ??= new FakeEl();
    const msg = new FakeEl();
    panel.querySelector = () => msg;
    renderFirmwareRow(1, row, {
      installed: '7cb0a86', installedFrontend: 'c929939', latest: '7cb0a86',
      updateAvailable: true, partial: true, releaseUrl: 'https://example.com/rel',
    });
    const text = 'Controller 7cb0a86, frontend c929939: the last update did not finish.';
    const status = els['.machine-row-firmware-status'];
    const update = els['.machine-row-firmware-update'];
    expect(status?.textContent).toBe('Update incomplete');
    expect(status?.className).toBe('badge badge--warn machine-row-firmware-status');
    expect(status?.title).toBe(text);
    expect(status?.style.display).toBe('');
    expect(update?.style.display).toBe('');
    expect(update?.textContent).toBe('Update: 7cb0a86');
    expect(msg.textContent).toBe(text);
  });

  it('keeps the old row for a machine without a frontend version', () => {
    const { row, els } = fakeRow();
    renderFirmwareRow(1, row, { installed: '7cb0a86', latest: '7cb0a86', updateAvailable: false, releaseUrl: null });
    expect(els['.machine-row-firmware-status']?.className).toBe('badge badge--ok machine-row-firmware-status');
    expect(els['.machine-row-firmware-status']?.textContent).toBe('FW 7cb0a86');
    expect(els['.machine-row-firmware-update']?.style.display).toBe('none');
  });

  it('shows the split warning without a button when the latest release is unknown', () => {
    const { row, els } = fakeRow();
    const panel = els['.machine-row-firmware-panel'] ??= new FakeEl();
    renderFirmwareRow(1, row, {
      installed: '7cb0a86', installedFrontend: 'c929939', latest: null,
      updateAvailable: false, partial: true, releaseUrl: null,
    });
    expect(els['.machine-row-firmware-status']?.className).toBe('badge badge--warn machine-row-firmware-status');
    expect(els['.machine-row-firmware-update']?.style.display).toBe('none');
    expect(panel.remove).toHaveBeenCalled();
  });

  it('every language has the #2229 strings', () => {
    for (const [lang, dict] of Object.entries(LANGS)) {
      expect(typeof dict.settings_machine_firmware_badge_partial, lang).toBe('string');
      expect(String(dict.settings_machine_firmware_badge_partial).length, lang).toBeGreaterThan(0);
      const partial = formatter(dict.settings_machine_firmware_partial)('7cb0a86', 'c929939');
      expect(partial, lang).toContain('7cb0a86');
      expect(partial, lang).toContain('c929939');
      expect(formatter(dict.settings_machine_firmware_stage_failed_toast)('STAGE'), lang).toContain('STAGE');
    }
  });
});
