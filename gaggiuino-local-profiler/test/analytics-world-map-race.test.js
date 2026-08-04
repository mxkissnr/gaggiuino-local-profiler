import { describe, it, expect } from 'vitest';

// analytics.js pulls in state.js (localStorage/navigator at module load) —
// same minimal stub other analytics test files use (analytics-new-charts.test.js,
// world-map-antimeridian.test.js, library-load-render-race.test.js).
globalThis.localStorage ??= { getItem: () => null, setItem: () => {} };
globalThis.navigator    ??= { language: 'en-US' };

const { S } = await import('../public-src/state.js');
const { buildWorldMap } = await import('../public-src/views/analytics.js');

// #648: buildWorldMap()'s countries-110m.json fetch had no request-generation-
// token guard, unlike library-profile-editor.js's loadMachineProfileList() or
// shots/index.js's loadData() (#644). This exercises the fetch *rejects*
// branch deliberately, not the success branch: it needs no echarts/topojson/
// canvas setup, and it's the branch that actually writes to the DOM
// (wrap.innerHTML) on the "no cached topology yet" path, which is what the
// token guard protects. The success branch's DOM write goes through a full
// echarts.setOption() chart render that isn't practical to unit-test
// headlessly (no jsdom/canvas in this suite) — verified manually instead
// (see PR description) that the same token-capture/check placement guards
// it too, mirroring loadData()'s already-tested pattern (#644,
// test/shots-load-data-race.test.js).
function fakeWrap() {
  let html = '';
  return {
    get innerHTML() { return html; },
    set innerHTML(v) { html = v; },
    querySelector: () => null,
  };
}

describe('buildWorldMap (#648 fetch race guard)', () => {
  it('a stale (earlier-fired, later-resolving) call\'s rejection does not overwrite a newer call\'s completed result', async () => {
    const wrap = fakeWrap();
    globalThis.document = { getElementById: id => (id === 'worldMapWrap' ? wrap : null) };

    S.coffeeLibrary = { beans: [{ id: 1, name: 'Test Bean', origin: 'ET' }], grinders: [] };
    S.shots = [];

    let rejectA, rejectB;
    const pA = new Promise((_res, rej) => { rejectA = rej; });
    const pB = new Promise((_res, rej) => { rejectB = rej; });
    let callCount = 0;
    globalThis.fetch = () => {
      callCount++;
      return callCount === 1 ? pA : pB;
    };

    const callA = buildWorldMap(); // fired first (token N)
    const callB = buildWorldMap(); // fired second, while A is still pending (token N+1, now current)

    rejectB(new Error('network error B')); // the later-fired call settles first
    await callB;
    const afterB = wrap.innerHTML;
    expect(afterB.length).toBeGreaterThan(0); // empty-state markup was written

    wrap.innerHTML = '__sentinel__'; // simulate a newer render having since replaced the DOM
    rejectA(new Error('network error A')); // A's stale rejection arrives after
    await callA;

    // Before the fix, A's catch block would unconditionally overwrite
    // wrap.innerHTML with its own empty-state markup, clobbering whatever
    // the newer generation (B, or anything after it) had rendered. The
    // token guard makes A's stale completion a no-op instead.
    expect(wrap.innerHTML).toBe('__sentinel__');
  });
});
