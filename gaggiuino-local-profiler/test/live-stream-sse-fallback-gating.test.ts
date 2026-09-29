// #736 review: connectLiveStream() used to check S.sseActive exactly once,
// at the moment the Live tab opened, to decide whether to start the 1s/10s
// REST-polling fallback intervals at all. EventSource can take up to
// public-src/sse.js's WATCHDOG_MS (8s, longer still over HA Ingress per
// #738/#740's history) to actually open -- so S.sseActive was still
// null/false at that one-time check even on a session where SSE goes on to
// connect moments later, permanently locking in the (now redundant) REST
// polling for the rest of the session. Fixed by always starting the
// intervals, but having their own callbacks re-check S.sseActive fresh on
// every tick -- same self-correcting convention as status.js's
// updateStatus()/pollSyncProgressFallback() (a 30s interval that always
// fires, gating only its fallback-only *work* behind a fresh check).
//
// Chart.js needs a real <canvas> context this test harness doesn't provide,
// and isn't what's under test here -- stubbed out with a minimal fake, same
// reasoning test/shot-defaults-grinder-autocomplete.test.js uses for
// attachAutocomplete().
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// vitest's node environment has no browser globals; stub them through a loose
// view of globalThis (the same bridge the sibling live tests use).
const g = globalThis as unknown as Record<string, unknown>;
g.localStorage ??= { getItem: () => null, setItem: () => {} };
g.navigator ??= { language: 'en-US' };

const apiFetchMock = vi.fn(() => Promise.resolve({ ok: false, status: 500 }));
vi.mock('../public-src/api/transport.js', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args) as unknown,
  // #913: fetchLiveData()'s !r.ok branch calls the real isApiPortBlocked() --
  // omitting it here made it undefined, which threw and (only visibly once
  // handleLiveData()'s catch-block fallback started calling
  // syncMachineIcon()) surfaced as an unhandled rejection.
  isApiPortBlocked: () => false,
}));

class FakeChart {
  static getChart() { return null; }
  destroy() {}
}
vi.mock('chart.js/auto', () => ({ default: FakeChart }));

vi.mock('../public-src/components/machines-settings.js', () => ({
  getDefaultMachineId: () => null,
}));

// The live-shot-setup panel's bean/basket/puckscreen/recipe selects are
// real <select>-population logic (new Option(), replaceChildren()) with no
// bearing on the SSE/REST-fallback gating this file tests — stubbed to
// no-ops rather than teaching the fake document below a second DOM API
// surface it doesn't otherwise need. grind.js's suggestion heuristic reads
// S.shots/S.coffeeLibrary directly and isn't wired to anything here either.
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
const { connectLiveStream, disconnectLiveStream } = await import('../public-src/views/live.js');

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

describe('connectLiveStream() REST-polling fallback self-corrects on S.sseActive (#736 review)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    apiFetchMock.mockClear();
    g.document = makeFakeDocument();
    S.activeMachineId = null;
    S.currentLang = 'en';
    S.refShotId = null;
    S.sseActive = null; // SSE hasn't opened yet -- exactly the race window in question
  });

  afterEach(() => {
    disconnectLiveStream();
    vi.useRealTimers();
  });

  it('starts the fallback intervals even while S.sseActive is still null (not yet decided)', async () => {
    connectLiveStream();
    await vi.advanceTimersByTimeAsync(0); // flush connectLiveStream()'s own immediate fetchLiveData()/fetchPreheatData() calls
    apiFetchMock.mockClear();

    await vi.advanceTimersByTimeAsync(1000);
    expect(apiFetchMock).toHaveBeenCalledWith('api/live/data');
  });

  it('stops actually fetching once S.sseActive flips true mid-session, without needing to reconnect the Live tab', async () => {
    connectLiveStream();
    await vi.advanceTimersByTimeAsync(0);

    // EventSource finally opens, moments after the tab was already showing
    // (the exact race #736 review flagged) -- S.sseActive was still
    // null/false at connectLiveStream()'s one-time check.
    S.sseActive = true;
    apiFetchMock.mockClear();

    await vi.advanceTimersByTimeAsync(10000); // covers both the 1s and 10s intervals
    expect(apiFetchMock).not.toHaveBeenCalledWith('api/live/data');
    expect(apiFetchMock).not.toHaveBeenCalledWith('api/preheat');
  });

  it('resumes fetching again if S.sseActive later flips back to false (falls back correctly, not just once)', async () => {
    connectLiveStream();
    await vi.advanceTimersByTimeAsync(0);

    S.sseActive = true;
    await vi.advanceTimersByTimeAsync(1000);
    apiFetchMock.mockClear();

    S.sseActive = false;
    await vi.advanceTimersByTimeAsync(1000);
    expect(apiFetchMock).toHaveBeenCalledWith('api/live/data');
  });
});
