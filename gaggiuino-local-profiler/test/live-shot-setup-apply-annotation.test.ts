// Covers _applyLiveSetupToShot's three review-driven fixes (live-shot-setup
// PR): (1) the post-brew shot is picked by machine + id watermark, not
// S.shots[length-1] (the multi-machine scalar-bug class), (2) the annotate
// payload only carries fields the draft actually set, and (3) a shot that
// already has an annotation (e.g. #654 shot-defaults auto-fill, which can
// land before this 4s-delayed apply runs) is left alone instead of
// clobbered. Driven end-to-end through the exported fetchLiveData(), the
// only path that reaches the private _applyLiveSetupToShot — same
// apiFetch-mocking/fake-document harness as
// test/live-stream-sse-fallback-gating.test.ts.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { ShotMeta } from '../public-src/state/index.js';

// vitest's node environment has no browser globals; stub them through a loose
// view of globalThis (the same bridge the sibling live tests use).
const g = globalThis as unknown as Record<string, unknown>;
g.localStorage ??= { getItem: () => null, setItem: () => {} };
g.navigator ??= { language: 'en-US' };
g.window ??= globalThis;

const getLiveDataMock = vi.fn();
vi.mock('../public-src/api/system.js', () => ({
  getLiveData: (...args: unknown[]) => getLiveDataMock(...args) as unknown,
  getPreheat: () => Promise.resolve({ ok: false, status: 500, json: async () => ({}) }),
}));

const annotateShotMock = vi.fn(() => Promise.resolve({ ok: true }));
vi.mock('../public-src/api/shots.js', () => ({
  annotateShot: (...args: unknown[]) => annotateShotMock(...args) as unknown,
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

const { S } = await import('../public-src/state/index.js');
const { fetchLiveData } = await import('../public-src/views/live.js');

// The DOM stand-in these tests touch: only the members the live view reads
// off each element.
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

interface LiveBody {
  isLive?: boolean;
  seq?: number;
  profileName?: string | null;
  isSteaming?: boolean;
  steamSeq?: number;
  isFlushing?: boolean;
  flushSeq?: number;
}

function liveDataResponse(body: LiveBody) {
  return Promise.resolve({ ok: true, json: async () => body });
}

function draftKey(machineId: number | null): string {
  return `glp_live_shot_setup_${machineId ?? 'default'}`;
}

describe('_applyLiveSetupToShot (via fetchLiveData brew-end transition)', () => {
  let draftStore: Record<string, string>;

  beforeEach(() => {
    vi.useFakeTimers();
    getLiveDataMock.mockReset();
    annotateShotMock.mockClear();
    g.document = makeFakeDocument();

    draftStore = {};
    g.localStorage = {
      getItem: (key: string) => (key in draftStore ? draftStore[key] : null),
      setItem: (key: string, value: string) => { draftStore[key] = value; },
      removeItem: (key: string) => { delete draftStore[key]; },
    };

    S.activeMachineId = 1;
    S.currentLang = 'en';
    S.liveWasLive = true; // simulate a brew already in progress
    S.liveLastSeq = 0;
    S.shots = [
      { id: 10, machineId: 1, timestamp: 0, annotation: {} },
      { id: 11, machineId: 2, timestamp: 0, annotation: {} }, // other machine, higher id — must never be picked for machine 1
    ];
  });

  async function triggerBrewEnd({ newShotsAfterSync }: { newShotsAfterSync: ShotMeta[] }) {
    window.loadData = () => { S.shots = newShotsAfterSync; return Promise.resolve(); };
    getLiveDataMock.mockReturnValue(liveDataResponse({ isLive: false, seq: 1, profileName: null }));
    await fetchLiveData();
    await vi.advanceTimersByTimeAsync(4000);
  }

  it('picks the newest shot for the active machine by id watermark, not the array-last shot overall', async () => {
    draftStore[draftKey(1)] = JSON.stringify({ grinder: 'Niche Zero' });

    await triggerBrewEnd({
      newShotsAfterSync: [
        { id: 10, machineId: 1, timestamp: 0, annotation: {} },
        { id: 11, machineId: 2, timestamp: 0, annotation: {} },
        { id: 12, machineId: 1, timestamp: 0, annotation: {} }, // the real new brew shot, machine 1
        { id: 13, machineId: 2, timestamp: 0, annotation: {} }, // synced after it, but a different machine — must be ignored
      ],
    });

    expect(annotateShotMock).toHaveBeenCalledTimes(1);
    expect(annotateShotMock.mock.calls[0][0]).toBe(12);
  });

  it('sends only the fields the draft actually set, not every field with empty/null defaults', async () => {
    draftStore[draftKey(1)] = JSON.stringify({ grinder: 'Niche Zero', grindSetting: '4.2' });

    await triggerBrewEnd({
      newShotsAfterSync: [
        { id: 10, machineId: 1, timestamp: 0, annotation: {} },
        { id: 12, machineId: 1, timestamp: 0, annotation: {} },
      ],
    });

    expect(annotateShotMock).toHaveBeenCalledTimes(1);
    const payload = annotateShotMock.mock.calls[0][1] as Record<string, unknown>;
    expect(payload).toEqual({ grinder: 'Niche Zero', grindSetting: '4.2' });
    expect(payload).not.toHaveProperty('coffee');
    expect(payload).not.toHaveProperty('dose');
    expect(payload).not.toHaveProperty('beanId');
  });

  it('does not overwrite a shot that already has an annotation (e.g. #654 shot-defaults)', async () => {
    draftStore[draftKey(1)] = JSON.stringify({ grinder: 'Niche Zero' });

    await triggerBrewEnd({
      newShotsAfterSync: [
        { id: 10, machineId: 1, timestamp: 0, annotation: {} },
        { id: 12, machineId: 1, timestamp: 0, annotation: { coffee: 'Already set by shot defaults' } },
      ],
    });

    expect(annotateShotMock).not.toHaveBeenCalled();
  });

  it('sends nothing when the draft is empty', async () => {
    // No draft written to draftStore at all for this machine.
    await triggerBrewEnd({
      newShotsAfterSync: [
        { id: 10, machineId: 1, timestamp: 0, annotation: {} },
        { id: 12, machineId: 1, timestamp: 0, annotation: {} },
      ],
    });

    expect(annotateShotMock).not.toHaveBeenCalled();
  });

  // #1120 review: the draft only applies to a finished BREW. A steam/flush
  // session shares the "was live, now idle" shape but is a different mode
  // (isSteaming/isFlushing, not isLive), so its finish must never annotate.
  it('does not send an annotation when a steam session — not a brew — finishes', async () => {
    draftStore[draftKey(1)] = JSON.stringify({ grinder: 'Niche Zero' });

    // Steam session live: msg.isLive (brew) stays false, msg.isSteaming set.
    getLiveDataMock.mockReturnValue(liveDataResponse({ isLive: false, isSteaming: true, steamSeq: 0, seq: 0 }));
    await fetchLiveData();

    // It finishes: the brew seq advances and a session was on screen, but the
    // brew-only gate must keep the draft from being applied.
    S.liveWasLive = true;
    window.loadData = () => {
      S.shots = [
        { id: 10, machineId: 1, timestamp: 0, annotation: {} },
        { id: 12, machineId: 1, timestamp: 0, annotation: {} },
      ];
      return Promise.resolve();
    };
    getLiveDataMock.mockReturnValue(liveDataResponse({ isLive: false, isSteaming: false, steamSeq: 1, seq: 1 }));
    await fetchLiveData();
    await vi.advanceTimersByTimeAsync(4000);

    expect(annotateShotMock).not.toHaveBeenCalled();
  });

  it('does not send an annotation when a flush session — not a brew — finishes', async () => {
    draftStore[draftKey(1)] = JSON.stringify({ grinder: 'Niche Zero' });

    getLiveDataMock.mockReturnValue(liveDataResponse({ isLive: false, isFlushing: true, flushSeq: 0, seq: 0 }));
    await fetchLiveData();

    S.liveWasLive = true;
    window.loadData = () => {
      S.shots = [
        { id: 10, machineId: 1, timestamp: 0, annotation: {} },
        { id: 12, machineId: 1, timestamp: 0, annotation: {} },
      ];
      return Promise.resolve();
    };
    getLiveDataMock.mockReturnValue(liveDataResponse({ isLive: false, isFlushing: false, flushSeq: 1, seq: 1 }));
    await fetchLiveData();
    await vi.advanceTimersByTimeAsync(4000);

    expect(annotateShotMock).not.toHaveBeenCalled();
  });
});
