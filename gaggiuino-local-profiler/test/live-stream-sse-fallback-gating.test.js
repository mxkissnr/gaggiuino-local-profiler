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

globalThis.localStorage ??= { getItem: () => null, setItem: () => {} };
globalThis.navigator ??= { language: 'en-US' };

const apiFetchMock = vi.fn(() => Promise.resolve({ ok: false, status: 500 }));
vi.mock('../public-src/api.js', () => ({
  apiFetch: (...args) => apiFetchMock(...args),
}));

class FakeChart {
  static getChart() { return null; }
  destroy() {}
}
vi.mock('chart.js/auto', () => ({ default: FakeChart }));

vi.mock('../public-src/components/machines-settings.js', () => ({
  getDefaultMachineId: () => null,
}));

const { S } = await import('../public-src/state.js');
const { connectLiveStream, disconnectLiveStream } = await import('../public-src/views/live.js');

function makeFakeDocument() {
  const registry = new Map();
  function makeElement() {
    return { className: '', textContent: '', style: {}, classList: { add() {}, remove() {}, contains: () => false } };
  }
  return {
    getElementById: id => {
      if (!registry.has(id)) registry.set(id, makeElement());
      return registry.get(id);
    },
  };
}

describe('connectLiveStream() REST-polling fallback self-corrects on S.sseActive (#736 review)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    apiFetchMock.mockClear();
    globalThis.document = makeFakeDocument();
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
