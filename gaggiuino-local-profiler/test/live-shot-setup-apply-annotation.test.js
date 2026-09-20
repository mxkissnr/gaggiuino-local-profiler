// Covers _applyLiveSetupToShot's three review-driven fixes (live-shot-setup
// PR): (1) the post-brew shot is picked by machine + id watermark, not
// S.shots[length-1] (the multi-machine scalar-bug class), (2) the annotate
// payload only carries fields the draft actually set, and (3) a shot that
// already has an annotation (e.g. #654 shot-defaults auto-fill, which can
// land before this 4s-delayed apply runs) is left alone instead of
// clobbered. Driven end-to-end through the exported fetchLiveData(), the
// only path that reaches the private _applyLiveSetupToShot — same
// apiFetch-mocking/fake-document harness as
// test/live-stream-sse-fallback-gating.test.js.
import { describe, it, expect, beforeEach, vi } from 'vitest';

globalThis.localStorage ??= { getItem: () => null, setItem: () => {} };
globalThis.navigator ??= { language: 'en-US' };
globalThis.window ??= globalThis;

const getLiveDataMock = vi.fn();
vi.mock('../public-src/api/system.js', () => ({
  getLiveData: (...args) => getLiveDataMock(...args),
  getPreheat: () => Promise.resolve({ ok: false, status: 500, json: async () => ({}) }),
}));

const annotateShotMock = vi.fn(() => Promise.resolve({ ok: true }));
vi.mock('../public-src/api/shots.js', () => ({
  annotateShot: (...args) => annotateShotMock(...args),
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

function makeFakeDocument() {
  const registry = new Map();
  function makeElement() {
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
    getElementById: id => {
      if (!registry.has(id)) registry.set(id, makeElement());
      return registry.get(id);
    },
  };
}

function liveDataResponse(body) {
  return Promise.resolve({ ok: true, json: async () => body });
}

function draftKey(machineId) {
  return `glp_live_shot_setup_${machineId ?? 'default'}`;
}

describe('_applyLiveSetupToShot (via fetchLiveData brew-end transition)', () => {
  let draftStore;

  beforeEach(() => {
    vi.useFakeTimers();
    getLiveDataMock.mockReset();
    annotateShotMock.mockClear();
    globalThis.document = makeFakeDocument();

    draftStore = {};
    globalThis.localStorage = {
      getItem: key => (key in draftStore ? draftStore[key] : null),
      setItem: (key, value) => { draftStore[key] = value; },
      removeItem: key => { delete draftStore[key]; },
    };

    S.activeMachineId = 1;
    S.currentLang = 'en';
    S.liveWasLive = true; // simulate a brew already in progress
    S.liveLastSeq = 0;
    S.shots = [
      { id: 10, machineId: 1, annotation: {} },
      { id: 11, machineId: 2, annotation: {} }, // other machine, higher id — must never be picked for machine 1
    ];
  });

  async function triggerBrewEnd({ newShotsAfterSync }) {
    globalThis.window.loadData = () => { S.shots = newShotsAfterSync; return Promise.resolve(); };
    getLiveDataMock.mockReturnValue(liveDataResponse({ isLive: false, seq: 1, profileName: null }));
    await fetchLiveData();
    await vi.advanceTimersByTimeAsync(4000);
  }

  it('picks the newest shot for the active machine by id watermark, not the array-last shot overall', async () => {
    draftStore[draftKey(1)] = JSON.stringify({ grinder: 'Niche Zero' });

    await triggerBrewEnd({
      newShotsAfterSync: [
        { id: 10, machineId: 1, annotation: {} },
        { id: 11, machineId: 2, annotation: {} },
        { id: 12, machineId: 1, annotation: {} }, // the real new brew shot, machine 1
        { id: 13, machineId: 2, annotation: {} }, // synced after it, but a different machine — must be ignored
      ],
    });

    expect(annotateShotMock).toHaveBeenCalledTimes(1);
    expect(annotateShotMock.mock.calls[0][0]).toBe(12);
  });

  it('sends only the fields the draft actually set, not every field with empty/null defaults', async () => {
    draftStore[draftKey(1)] = JSON.stringify({ grinder: 'Niche Zero', grindSetting: '4.2' });

    await triggerBrewEnd({
      newShotsAfterSync: [
        { id: 10, machineId: 1, annotation: {} },
        { id: 12, machineId: 1, annotation: {} },
      ],
    });

    expect(annotateShotMock).toHaveBeenCalledTimes(1);
    const payload = annotateShotMock.mock.calls[0][1];
    expect(payload).toEqual({ grinder: 'Niche Zero', grindSetting: '4.2' });
    expect(payload).not.toHaveProperty('coffee');
    expect(payload).not.toHaveProperty('dose');
    expect(payload).not.toHaveProperty('beanId');
  });

  it('does not overwrite a shot that already has an annotation (e.g. #654 shot-defaults)', async () => {
    draftStore[draftKey(1)] = JSON.stringify({ grinder: 'Niche Zero' });

    await triggerBrewEnd({
      newShotsAfterSync: [
        { id: 10, machineId: 1, annotation: {} },
        { id: 12, machineId: 1, annotation: { coffee: 'Already set by shot defaults' } },
      ],
    });

    expect(annotateShotMock).not.toHaveBeenCalled();
  });

  it('sends nothing when the draft is empty', async () => {
    // No draft written to draftStore at all for this machine.
    await triggerBrewEnd({
      newShotsAfterSync: [
        { id: 10, machineId: 1, annotation: {} },
        { id: 12, machineId: 1, annotation: {} },
      ],
    });

    expect(annotateShotMock).not.toHaveBeenCalled();
  });
});
