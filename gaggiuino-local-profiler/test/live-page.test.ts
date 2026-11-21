import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// #2153: the Live tab in the Home Assistant page pattern. Covers the running
// and idle states (verdict, figures, chart area), the phase bar taken from
// the reference shot, the next-shot rows and the warm-up countdown without
// the old "ready to brew" badge. Same minimal fake document as the other
// live tests (there is no jsdom in this repo).
const g = globalThis as unknown as Record<string, unknown>;
g.localStorage ??= { getItem: () => null, setItem: () => {}, removeItem: () => {} };
g.navigator ??= { language: 'en-US' };

vi.mock('../public-src/machine-icon.js', () => ({
  machineIconAnimatedSvg: () => '',
  setMachineIconMode: () => {},
  updateMachineIconBrewReadout: () => {},
  resolveMachineIconState: () => ({ mode: 'hot', heatFraction: 1 }),
  MACHINE_ICON_LIVE_CLASS: 'machine-icon-live',
}));

interface SheetOptions {
  title: string;
  body: string;
  dialog?: boolean;
  content?: unknown;
  anchor?: unknown;
  onClose?: () => void;
}
const sheet = vi.hoisted(() => ({
  openDetailSheet: vi.fn<(opts: SheetOptions) => void>(),
  requestCloseDetailSheet: vi.fn<() => void>(),
}));
vi.mock('../public-src/components/detail-sheet.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../public-src/components/detail-sheet.js')>()),
  ...sheet,
}));

// The reference shot's curve comes through the curve cache; the tests hand
// it over directly.
const curve = vi.hoisted(() => ({
  getShotCurve: vi.fn((_id: number | null | undefined): Promise<Record<string, unknown>> => Promise.resolve({})),
}));
vi.mock('../public-src/shot-curves.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../public-src/shot-curves.js')>()),
  ...curve,
}));

const { S } = await import('../public-src/state/index.js');
const { t } = await import('../public-src/i18n.js');
const live = await import('../public-src/views/live.js');

// The DOM stand-in: only the members the live view reads or writes.
interface FakeElement {
  className: string;
  textContent: string;
  innerHTML: string;
  hidden: boolean;
  style: Record<string, string>;
  firstChild: null;
  attrs: Record<string, string>;
  classList: { add: () => void; remove: () => void; contains: () => boolean; toggle: () => void };
  querySelector: () => null;
  setAttribute: (name: string, value: string) => void;
}

function makeFakeDocument() {
  const registry = new Map<string, FakeElement>();
  function makeElement(): FakeElement {
    const el: FakeElement = {
      className: '', textContent: '', innerHTML: '', hidden: false, style: {}, firstChild: null, attrs: {},
      classList: { add() {}, remove() {}, contains: () => false, toggle() {} },
      querySelector: () => null,
      setAttribute: (name: string, value: string) => { el.attrs[name] = value; },
    };
    return el;
  }
  return {
    getElementById: (id: string): FakeElement => {
      if (!registry.has(id)) registry.set(id, makeElement());
      return registry.get(id)!;
    },
  };
}

const PHASES = [
  { name: 'Bloom', t0: 0, t1: 8 },
  { name: 'Brew', t0: 8, t1: 30 },
];

// A brew at the last sample: 9.1 bar, 2.1 ml/s, 21.3 g, 92.9 °C (tenths, as
// the machine sends them); timeInShot in tenths of a second.
function brew(timeInShot: number[] = [0, 100]) {
  const n = timeInShot.length;
  return {
    machineReachable: true, isLive: true, profileName: 'Adaptive 9 bar', seq: 1,
    datapoints: {
      timeInShot,
      pressure: Array<number>(n).fill(91),
      pumpFlow: Array<number>(n).fill(21),
      shotWeight: Array<number>(n).fill(213),
      temperature: Array<number>(n).fill(929),
    },
  };
}
const IDLE = { machineReachable: true, isLive: false, datapoints: {} };
const STEAM = {
  machineReachable: true, isLive: false, isSteaming: true,
  steamDatapoints: { timeInMode: [0, 50], pressure: [0, 12], temperature: [1400, 1450] },
};

let doc: ReturnType<typeof makeFakeDocument>;
const el = (id: string): FakeElement => doc.getElementById(id);

beforeEach(() => {
  vi.useFakeTimers();
  doc = makeFakeDocument();
  g.document = doc;
  S.currentLang = 'en';
  S.activeMachineId = null;
  S.shots = [];
  S.refShotId = null;
  S.liveWasLive = false;
  S.liveLastSeq = -1;
  live._setRefPhases([]);
  sheet.openDetailSheet.mockClear();
  sheet.requestCloseDetailSheet.mockClear();
  curve.getShotCurve.mockClear();
});

afterEach(() => {
  live.disconnectLiveStream();
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe('running and idle states (#2153)', () => {
  it('a brew shows the verdict, the figures and the chart area and hides the idle panel', () => {
    live.handleLiveData(brew());
    expect(el('live-content').style.display).toBe('block');
    expect(el('liveChartArea').style.display).toBe('');
    expect(el('liveFigures').style.display).toBe('');
    expect(el('live-idle').style.display).toBe('none');
    expect(el('live-meta').textContent).toBe('Adaptive 9 bar');
    expect(el('livePressure').textContent).toBe('9.1');
    expect(el('liveFlow').textContent).toBe('2.1');
    expect(el('liveWeight').textContent).toBe('21.3');
    expect(el('liveTemp').textContent).toBe('92.9');
  });

  it('the idle state hides the figures and the chart area', () => {
    live.handleLiveData(brew());
    live.handleLiveData(IDLE);
    expect(el('live-content').style.display).toBe('none');
    expect(el('liveChartArea').style.display).toBe('none');
    expect(el('liveFigures').style.display).toBe('none');
    expect(el('live-idle').style.display).toBe('flex');
  });

  it('an unreachable machine hides them as well', () => {
    live.handleLiveData(brew());
    live.handleLiveData({ machineReachable: false, datapoints: {} });
    expect(el('liveChartArea').style.display).toBe('none');
    expect(el('liveFigures').style.display).toBe('none');
    expect(el('live-idle').style.display).toBe('flex');
  });
});

describe('phase bar from the reference shot (#2153)', () => {
  it('takes the phase changes the machine recorded', () => {
    expect(live.refPhaseRanges({
      timeInShot: [0, 100, 200, 300], pressure: [0, 90, 90, 90],
      phaseTransitions: [{ t: 0, phase: 0, name: 'Bloom' }, { t: 80, phase: 1, name: 'Brew' }],
    })).toEqual(PHASES);
  });

  it('falls back to the preinfusion and extraction split of the pressure curve', () => {
    expect(live.refPhaseRanges({
      timeInShot: [0, 10, 20, 30, 40, 50, 60, 70, 80, 90],
      pressure: [5, 10, 15, 20, 20, 40, 90, 90, 90, 90],
    })).toEqual([
      { name: t('phase_preinfusion'), t0: 0, t1: 5 },
      { name: t('phase_extraction'), t0: 5, t1: 9 },
    ]);
  });

  it('has no phases without a curve', () => {
    expect(live.refPhaseRanges({})).toEqual([]);
  });

  it('picks the phase the elapsed time falls into, the last one once past its end', () => {
    expect(live.currentPhaseIndex(PHASES, 3)).toBe(0);
    expect(live.currentPhaseIndex(PHASES, 8)).toBe(1);
    expect(live.currentPhaseIndex(PHASES, 45)).toBe(1);
    expect(live.currentPhaseIndex([], 3)).toBe(-1);
  });

  it('paints the bar and the phase line during a brew, and again only when the phase changes', () => {
    live._setRefPhases(PHASES);
    live.handleLiveData(brew([0, 100]));
    expect(el('livePhases').hidden).toBe(false);
    expect(el('livePhases').innerHTML).toBe(
      '<span class="live-phase is-done" style="flex-grow: 8"></span><span class="live-phase is-current" style="flex-grow: 22"></span>');
    expect(el('livePhaseText').textContent).toBe('2/2 · Brew');
    expect(el('livePhaseText').hidden).toBe(false);

    // The next sample in the same phase must not repaint the bar.
    el('livePhases').innerHTML = 'unchanged';
    live.handleLiveData(brew([0, 100, 110]));
    expect(el('livePhases').innerHTML).toBe('unchanged');
  });

  it('shows no bar without a reference, and none while steaming', () => {
    live.handleLiveData(brew());
    expect(el('livePhases').hidden).toBe(true);
    expect(el('livePhaseText').hidden).toBe(true);

    live._setRefPhases(PHASES);
    live.handleLiveData(brew());
    expect(el('livePhases').hidden).toBe(false);
    live.handleLiveData(STEAM);
    expect(el('livePhases').hidden).toBe(true);
    expect(el('livePhaseText').textContent).toBe('');
  });

  it('takes the phases from the reference shot once it is applied, and drops them on clear', async () => {
    // A different profile, so the brew start below does not auto-apply it.
    S.shots = [{ id: 7, timestamp: 1700000000, hasChartData: true, profileName: 'Turbo', annotation: {} }] as typeof S.shots;
    curve.getShotCurve.mockResolvedValueOnce({
      timeInShot: [0, 100, 200, 300], pressure: [0, 90, 90, 90],
      phaseTransitions: [{ t: 0, phase: 0, name: 'Bloom' }, { t: 80, phase: 1, name: 'Brew' }],
    });
    live.onRefShotChange('7');
    await vi.advanceTimersByTimeAsync(0);
    expect(curve.getShotCurve).toHaveBeenCalledWith(7);
    live.handleLiveData(brew());
    expect(el('livePhaseText').textContent).toBe('2/2 · Brew');

    live.clearReferenceShot();
    live.handleLiveData(brew());
    expect(el('livePhases').hidden).toBe(true);
  });
});

describe('next shot rows (#2153)', () => {
  it('shows the draft as the rows\' values', () => {
    S.coffeeLibrary = { beans: [], grinders: [], baskets: [{ id: 2, name: '18 g VST' }], puckScreens: [], recipes: [] } as unknown as typeof S.coffeeLibrary;
    live.renderLiveSetupSummary({ coffee: 'Guji Hambela', grinder: 'Niche Zero', grindSetting: '13', dose: 18, basketId: 2 });
    expect(el('liveSetupBean').textContent).toBe('Guji Hambela');
    expect(el('liveSetupGrinder').textContent).toBe('Niche Zero · 13');
    expect(el('liveSetupDose').textContent).toBe('18');
    expect(el('liveSetupBasket').textContent).toBe('18 g VST');
    expect(el('liveSetupPuckScreen').textContent).toBe('–');
    expect(el('liveSetupRecipe').textContent).toBe('–');
    expect(el('liveSetupRecipeRow').hidden).toBe(true);
  });

  it('shows a dash for an empty draft and the recipe row once the library has recipes', () => {
    S.coffeeLibrary = { beans: [], grinders: [], recipes: [{ id: 5, name: 'Morning' }] } as unknown as typeof S.coffeeLibrary;
    live.renderLiveSetupSummary({ recipeId: 5 });
    expect(el('liveSetupBean').textContent).toBe('–');
    expect(el('liveSetupGrinder').textContent).toBe('–');
    expect(el('liveSetupDose').textContent).toBe('–');
    expect(el('liveSetupRecipe').textContent).toBe('Morning');
    expect(el('liveSetupRecipeRow').hidden).toBe(false);
  });

  it('opens the fields in the detail sheet and refreshes the rows when it closes', () => {
    S.coffeeLibrary = { beans: [], grinders: [] };
    live.openLiveSetupSheet();
    expect(sheet.openDetailSheet).toHaveBeenCalledTimes(1);
    const opts = sheet.openDetailSheet.mock.calls[0]?.[0];
    expect(opts?.title).toBe(t('live_setup_toggle'));
    expect(opts?.dialog).toBe(true);
    expect(opts?.content).toBe(el('lsFields'));

    el('liveSetupBean').textContent = 'stale';
    opts?.onClose?.();
    expect(el('liveSetupBean').textContent).toBe('–');
  });
});

describe('warm-up countdown (#2153)', () => {
  it('shows only the countdown while warming, no ready badge', () => {
    live.handleLiveData(IDLE);
    live.updatePreheatWidget({ ready: false, remaining: 90, pct: 0.5 });
    expect(el('preheat-warming-wrap').style.display).toBe('');
    expect(el('preheat-bar-fill').style.width).toBe('50%');
    expect(el('preheat-countdown').textContent).toBe(t('preheat_remain', 1, 30));

    live.updatePreheatWidget({ ready: true, remaining: 0, pct: 1 });
    expect(el('preheat-warming-wrap').style.display).toBe('none');
    expect(el('preheat-ready-badge').style.display).toBeUndefined();
  });
});
