// #1324: components/machine-control.ts — the opt-in GaggiMate flush button,
// brew-confirmation dialog and Settings toggle. The machines API client is
// mocked so the tests assert the exact calls the component makes; the DOM is
// the same minimal fake document the sibling Live-view tests use (vitest runs
// in a node environment, so globalThis.document is stubbed manually).
import { describe, it, expect, beforeEach, vi } from 'vitest';

const g = globalThis as unknown as Record<string, unknown>;
g.localStorage ??= { getItem: () => null, setItem: () => {} };

const api = vi.hoisted(() => ({
  startFlush: vi.fn(),
  stopFlush: vi.fn(),
  confirmBrew: vi.fn(),
  cancelBrewConfirm: vi.fn(),
  getMachineControlSettings: vi.fn(),
  saveMachineControlSettings: vi.fn(),
  showToast: vi.fn(),
}));
vi.mock('../public-src/api/machines.js', () => ({
  startFlush: api.startFlush,
  stopFlush: api.stopFlush,
  confirmBrew: api.confirmBrew,
  cancelBrewConfirm: api.cancelBrewConfirm,
  getMachineControlSettings: api.getMachineControlSettings,
  saveMachineControlSettings: api.saveMachineControlSettings,
}));

const { S } = await import('../public-src/state/index.js');
const {
  renderMachineControl, toggleFlush, confirmBrewFromDialog, cancelBrewFromDialog,
  loadMachineControlSetting, saveMachineControlSetting,
} = await import('../public-src/components/machine-control.js');

interface FakeElement {
  className: string;
  textContent: string;
  style: Record<string, string>;
  disabled: boolean;
  checked: boolean;
}

function makeFakeDocument() {
  const registry = new Map<string, FakeElement>();
  function makeElement(): FakeElement {
    return { className: '', textContent: '', style: {}, disabled: false, checked: false };
  }
  return {
    getElementById: (id: string): FakeElement => {
      if (!registry.has(id)) registry.set(id, makeElement());
      return registry.get(id)!;
    },
  };
}

const ok = { ok: true, status: 200 } as Response;

describe('machine-control flush button (#1324)', () => {
  let doc: ReturnType<typeof makeFakeDocument>;

  beforeEach(() => {
    doc = makeFakeDocument();
    g.document = doc;
    g.window = { showToast: api.showToast };
    S.currentLang = 'en';
    vi.clearAllMocks();
  });

  it('hides the button and the dialog when the snapshot is null', () => {
    renderMachineControl(null);
    expect(doc.getElementById('liveFlushBtn').style.display).toBe('none');
    expect(doc.getElementById('brewConfirmModal').style.display).toBe('none');
  });

  it('shows a Start button when a flush may be started and calls startFlush on click', async () => {
    api.startFlush.mockResolvedValue(ok);
    renderMachineControl({ machineId: 7, canFlush: true, flushing: false, brewConfirm: null });

    expect(doc.getElementById('liveFlushBtn').style.display).toBe('');
    expect(doc.getElementById('liveFlushBtn').textContent).toBe('Flush');

    await toggleFlush();
    expect(api.startFlush).toHaveBeenCalledWith(7);
  });

  it('shows a Stop button while flushing and calls stopFlush on click', async () => {
    api.stopFlush.mockResolvedValue(ok);
    renderMachineControl({ machineId: 7, canFlush: false, flushing: true, brewConfirm: null });

    expect(doc.getElementById('liveFlushBtn').textContent).toBe('Stop flush');

    await toggleFlush();
    expect(api.stopFlush).toHaveBeenCalledWith(7);
  });

  it('shows the brew-confirmation dialog with translated labels and a raw-key fallback', () => {
    renderMachineControl({ machineId: 7, canFlush: false, flushing: false, brewConfirm: ['water', 'futureKey'] });

    expect(doc.getElementById('brewConfirmModal').style.display).toBe('flex');
    expect(doc.getElementById('brewConfirmWarnings').textContent).toBe('Water tank low · futureKey');
  });

  it('confirms the brew and hides the dialog immediately (optimistic)', async () => {
    api.confirmBrew.mockResolvedValue(ok);
    renderMachineControl({ machineId: 7, canFlush: false, flushing: false, brewConfirm: ['water'] });

    const pending = confirmBrewFromDialog();
    expect(doc.getElementById('brewConfirmModal').style.display).toBe('none');
    await pending;
    expect(api.confirmBrew).toHaveBeenCalledWith(7);
  });

  it('cancels the brew confirmation', async () => {
    api.cancelBrewConfirm.mockResolvedValue(ok);
    renderMachineControl({ machineId: 7, canFlush: false, flushing: false, brewConfirm: ['water'] });

    await cancelBrewFromDialog();
    expect(api.cancelBrewConfirm).toHaveBeenCalledWith(7);
  });

  it('hides the dialog once a later snapshot reports no pending confirmation', () => {
    renderMachineControl({ machineId: 7, canFlush: false, flushing: false, brewConfirm: ['water'] });
    expect(doc.getElementById('brewConfirmModal').style.display).toBe('flex');

    renderMachineControl({ machineId: 7, canFlush: false, flushing: false, brewConfirm: null });
    expect(doc.getElementById('brewConfirmModal').style.display).toBe('none');
  });
});

describe('machine-control settings toggle (#1324)', () => {
  let doc: ReturnType<typeof makeFakeDocument>;

  beforeEach(() => {
    doc = makeFakeDocument();
    g.document = doc;
    g.window = { showToast: api.showToast };
    S.currentLang = 'en';
    vi.clearAllMocks();
  });

  it('loads the stored value into the checkbox and saves the new one', async () => {
    api.getMachineControlSettings.mockResolvedValue({ enabled: true });
    await loadMachineControlSetting();
    expect(doc.getElementById('machineControlEnabled').checked).toBe(true);

    const cb = doc.getElementById('machineControlEnabled');
    cb.checked = false;
    api.saveMachineControlSettings.mockResolvedValue(ok);
    await saveMachineControlSetting();
    expect(api.saveMachineControlSettings).toHaveBeenCalledWith(false);
  });

  it('reverts the checkbox and shows a toast when the save fails', async () => {
    api.getMachineControlSettings.mockResolvedValue({ enabled: true });
    await loadMachineControlSetting();

    const cb = doc.getElementById('machineControlEnabled');
    cb.checked = false;
    api.saveMachineControlSettings.mockResolvedValue({ ok: false, status: 500 });
    await saveMachineControlSetting();

    expect(cb.checked).toBe(true);
    expect(api.showToast).toHaveBeenCalled();
  });
});
