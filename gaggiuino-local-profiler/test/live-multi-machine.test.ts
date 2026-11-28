// #2247: the Live tab follows the selected machine. A non-default machine is
// requested with ?machineId and watched on the SSE stream while the tab is
// open; SSE payloads of any other machine are dropped; the default machine
// (also for "All machines") keeps the plain URLs and no watch. Replaces the
// #1449 "not available for this machine" gating tests.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';

// vitest's node environment has no browser globals; stub them through a loose
// view of globalThis (the same bridge the sibling live tests use).
const g = globalThis as unknown as Record<string, unknown>;
g.localStorage ??= { getItem: () => null, setItem: () => {} };
g.navigator ??= { language: 'en-US' };

const apiFetchMock = vi.fn((..._args: unknown[]) => Promise.resolve({ ok: false, status: 500 }));
vi.mock('../public-src/api/transport.js', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args) as unknown,
  isApiPortBlocked: () => false,
}));

// Every setWatchedMachine() call the live view makes, in order.
const watchCalls: (number | null)[] = [];
vi.mock('../public-src/sse.js', () => ({
  setWatchedMachine: (id: number | null) => { watchCalls.push(id); },
}));

class FakeChart {
  static getChart() { return null; }
  destroy() {}
}
vi.mock('chart.js/auto', () => ({ default: FakeChart }));

// The default machine id the live view compares against, set per case.
vi.mock('../public-src/components/machines-settings.js', () => ({
  getDefaultMachineId: () => (globalThis as unknown as { __defaultMachineId?: number }).__defaultMachineId ?? null,
}));

vi.mock('../public-src/machine-icon.js', () => ({
  machineIconAnimatedSvg: () => '',
  setMachineIconMode: () => {},
  updateMachineIconBrewReadout: () => {},
  resolveMachineIconState: () => ({ mode: 'hot', heatFraction: 1 }),
  MACHINE_ICON_LIVE_CLASS: 'machine-icon-live',
}));

vi.mock('../public-src/views/shots/annotation.js', () => ({
  renderGrinderField: () => {},
  getGrinderFieldValue: () => '',
  handleGrinderFieldChange: () => {},
  _renderBeanSelect: () => {},
  _renderBasketSelect: () => {},
  _renderPuckScreenSelect: () => {},
  _renderRecipeSelect: () => {},
}));
vi.mock('../public-src/views/shots/grind.js', () => ({
  suggestGrindForBeanGrinder: () => null,
}));

const { S } = await import('../public-src/state/index.js');
const { t } = await import('../public-src/i18n.js');
const { connectLiveStream, disconnectLiveStream, handleLiveSnapshotEvent } = await import('../public-src/views/live.js');

interface FakeElement {
  className: string;
  textContent: string;
  innerHTML: string;
  style: Record<string, string>;
  value: string;
  classList: { add: () => void; remove: () => void; contains: () => boolean; toggle: () => void };
  querySelector: () => null;
  addEventListener: () => void;
  removeEventListener: () => void;
  selectedOptions: { dataset: Record<string, string> }[];
}

function makeFakeDocument() {
  const registry = new Map<string, FakeElement>();
  function makeElement(): FakeElement {
    return {
      className: '', textContent: '', innerHTML: '', style: {}, value: '',
      classList: { add() {}, remove() {}, contains: () => false, toggle() {} },
      querySelector: () => null,
      addEventListener() {},
      removeEventListener() {},
      selectedOptions: [],
    };
  }
  return {
    getElementById: (id: string): FakeElement => {
      if (!registry.has(id)) registry.set(id, makeElement());
      return registry.get(id)!;
    },
  };
}

function requestedUrls(): string[] {
  return apiFetchMock.mock.calls.map(c => String(c[0]));
}

describe('Live tab follows the selected machine (#2247)', () => {
  let doc: ReturnType<typeof makeFakeDocument>;

  beforeEach(() => {
    vi.useFakeTimers();
    apiFetchMock.mockClear();
    watchCalls.length = 0;
    doc = makeFakeDocument();
    g.document = doc;
    g.__defaultMachineId = 1;
    S.currentLang = 'en';
    S.refShotId = null;
    S.sseActive = null;
    S.shots = [];
  });

  afterEach(() => {
    disconnectLiveStream();
    vi.useRealTimers();
  });

  it('a non-default machine requests and watches its own live data', async () => {
    S.activeMachineId = 2;
    connectLiveStream();
    await vi.advanceTimersByTimeAsync(0);
    expect(requestedUrls()).toContain('api/live/data?machineId=2');
    expect(requestedUrls()).toContain('api/preheat?machineId=2');
    expect(watchCalls.at(-1)).toBe(2);
  });

  it('the default machine keeps the plain URLs and no watch', async () => {
    for (const active of [1, 'all'] as const) {
      apiFetchMock.mockClear();
      S.activeMachineId = active;
      connectLiveStream();
      await vi.advanceTimersByTimeAsync(0);
      expect(requestedUrls()).toEqual(expect.arrayContaining(['api/live/data', 'api/preheat']));
      expect(requestedUrls().some(u => u.includes('machineId'))).toBe(false);
      expect(watchCalls.at(-1)).toBeNull();
    }
  });

  it('switching the selected machine switches the request', async () => {
    S.activeMachineId = 1;
    connectLiveStream();
    await vi.advanceTimersByTimeAsync(0);
    apiFetchMock.mockClear();
    S.activeMachineId = 2;
    connectLiveStream();
    await vi.advanceTimersByTimeAsync(0);
    expect(requestedUrls()).toContain('api/live/data?machineId=2');
    expect(requestedUrls()).not.toContain('api/live/data');
  });

  it('SSE payloads of another machine are dropped', async () => {
    S.activeMachineId = 2;
    connectLiveStream();
    await vi.advanceTimersByTimeAsync(0);
    const status = doc.getElementById('live-status-text');
    status.textContent = 'sentinel';
    handleLiveSnapshotEvent({ machineId: 1, machineReachable: false });
    expect(status.textContent).toBe('sentinel');
    handleLiveSnapshotEvent({ machineId: 2, machineReachable: false });
    expect(status.textContent).toBe(t('live_unreachable_status'));
  });

  it("a payload without machineId is the default machine's", async () => {
    S.activeMachineId = 1;
    connectLiveStream();
    await vi.advanceTimersByTimeAsync(0);
    const status = doc.getElementById('live-status-text');
    status.textContent = 'sentinel';
    handleLiveSnapshotEvent({ machineReachable: false });
    expect(status.textContent).toBe(t('live_unreachable_status'));

    S.activeMachineId = 2;
    connectLiveStream();
    await vi.advanceTimersByTimeAsync(0);
    status.textContent = 'sentinel';
    handleLiveSnapshotEvent({ machineReachable: false });
    expect(status.textContent).toBe('sentinel');
  });

  it('no banner and no set-default action remain', () => {
    const live = readFileSync(new URL('../public-src/views/live.ts', import.meta.url), 'utf8');
    const delegation = readFileSync(new URL('../public-src/boot/delegation.ts', import.meta.url), 'utf8');
    expect(live).not.toContain('_isActiveMachineLiveCapable');
    expect(live).not.toContain('liveMachineUnavailableBanner');
    expect(delegation).not.toContain('live-set-default-machine');
  });

  it('disconnecting the Live tab ends the watch', () => {
    S.activeMachineId = 2;
    connectLiveStream();
    disconnectLiveStream();
    expect(watchCalls.at(-1)).toBeNull();
  });
});
