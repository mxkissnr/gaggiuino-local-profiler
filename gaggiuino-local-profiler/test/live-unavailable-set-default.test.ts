// #1449: when the topbar switcher selects a machine that is not the default,
// the backend's live payload still covers the default machine only, so
// connectLiveStream() keeps `#liveMachineUnavailableBanner` visible. The idle
// panel and reference bar used to stay on screen regardless, and the
// SSE-driven handleLiveData() kept filling the idle stats with the default
// machine's readings. These tests pin the gating: the not-capable branch hides
// all three panels and handleLiveData() bails out early, while a
// default-machine selection is unaffected. Same minimal-fake-document pattern
// as test/live-stream-sse-fallback-gating.test.ts.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

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

class FakeChart {
  static getChart() { return null; }
  destroy() {}
}
vi.mock('chart.js/auto', () => ({ default: FakeChart }));

// getDefaultMachineId() is what _isActiveMachineLiveCapable() compares the
// selected machine against -- read it from a global the tests set per case.
vi.mock('../public-src/components/machines-settings.js', () => ({
  getDefaultMachineId: () => (globalThis as unknown as { __defaultMachineId?: number }).__defaultMachineId ?? null,
}));

// handleLiveData() drives the animated machine icon; mocked out so this file
// stays focused on the panel gating (same as test/live-steam-flush-idle-stats-view.test.ts).
vi.mock('../public-src/machine-icon.js', () => ({
  machineIconAnimatedSvg: () => '',
  setMachineIconMode: () => {},
  updateMachineIconBrewReadout: () => {},
  resolveMachineIconState: () => ({ mode: 'hot', heatFraction: 1 }),
  MACHINE_ICON_LIVE_CLASS: 'machine-icon-live',
}));

// The live-shot-setup panel's real <select>-population logic has no bearing on
// the gating under test -- stubbed to no-ops, same as the sibling live tests.
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
const { connectLiveStream, disconnectLiveStream, handleLiveData } = await import('../public-src/views/live.js');

// The DOM stand-in these tests touch: only the members the live view reads off
// each element.
interface FakeElement {
  className: string;
  textContent: string;
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
      className: '', textContent: '', style: {}, value: '',
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

describe('Live tab gating for a non-default selected machine (#1449)', () => {
  let doc: ReturnType<typeof makeFakeDocument>;

  beforeEach(() => {
    vi.useFakeTimers();
    apiFetchMock.mockClear();
    doc = makeFakeDocument();
    g.document = doc;
    S.currentLang = 'en';
    S.refShotId = null;
    S.sseActive = null;
  });

  afterEach(() => {
    disconnectLiveStream();
    vi.useRealTimers();
  });

  it('hides the idle panel and reference bar and keeps default-machine readings out of the idle stats', () => {
    g.__defaultMachineId = 1;
    S.activeMachineId = 2; // selected machine is not the default

    connectLiveStream();

    expect(doc.getElementById('liveMachineUnavailableBanner').style.display).toBe('');
    expect(doc.getElementById('live-content').style.display).toBe('none');
    expect(doc.getElementById('live-idle').style.display).toBe('none');
    expect(doc.getElementById('live-ref-bar').style.display).toBe('none');

    // The SSE-driven payload still belongs to the default machine, so
    // handleLiveData() must not paint it under the banner.
    doc.getElementById('liveIdleTemp').textContent = 'sentinel';
    handleLiveData({
      machineReachable: true, isLive: false, isSteaming: false, isFlushing: false,
      datapoints: null, temperature: 91.5, targetTemperature: 93, pressure: 0.1, waterLevel: 64,
    });
    expect(doc.getElementById('liveIdleTemp').textContent).toBe('sentinel');
  });

  it('keeps the existing live behaviour when the selected machine is the default', () => {
    g.__defaultMachineId = 1;
    S.activeMachineId = 1;

    connectLiveStream();

    expect(doc.getElementById('liveMachineUnavailableBanner').style.display).toBe('none');
    expect(doc.getElementById('live-content').style.display).toBe('');
    expect(doc.getElementById('live-ref-bar').style.display).toBe('');

    handleLiveData({
      machineReachable: true, isLive: false, isSteaming: false, isFlushing: false,
      datapoints: null, temperature: 91.5, targetTemperature: 93, pressure: 0.1, waterLevel: 64,
    });
    expect(doc.getElementById('liveIdleTemp').textContent).toBe('91.5°');
  });
});
