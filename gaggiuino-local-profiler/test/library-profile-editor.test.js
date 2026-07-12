import { describe, it, expect } from 'vitest';

// library-profile-editor.js imports state.js/i18n.js/api.js, which read
// localStorage/navigator at module load time — stub the minimum browser
// globals needed so the module graph can be imported under vitest's node
// environment (same pattern as test/milk-deduct-gate.test.js).
globalThis.localStorage ??= { getItem: () => null, setItem: () => {} };
globalThis.navigator    ??= { language: 'en-US' };

const { _synthesizeSeries, _collectPhases } = await import('../public-src/views/library-profile-editor.js');

// _collectPhases reads phase rows straight off `document` (DOM-as-state, no
// separate JS array) — this vitest project runs in the 'node' environment
// with no jsdom, so stub the minimum `document` needed: one fake .pp-row
// whose querySelector resolves the handful of input selectors the code
// touches, keyed by class name.
function fakeRow(fields) {
  return {
    querySelector(selector) {
      const cls = selector.replace('.', '');
      if (!(cls in fields)) return undefined;
      const v = fields[cls];
      return typeof v === 'boolean' ? { checked: v } : { value: v };
    },
  };
}

// Phase boundaries land on the same x (e.g. phase 1 ends and phase 2 starts
// both at x=1) — pick the point belonging to the given phase's type among
// the points at that x, in array order.
function pointAt(points, x, type, occurrence = 0) {
  return points.filter(pt => pt.x === x && pt.type === type)[occurrence];
}

describe('_synthesizeSeries', () => {
  it('carries a blank target.start over from the previous same-type phase\'s resolved end', () => {
    const points = _synthesizeSeries([
      { type: 'PRESSURE', target: { start: 0, end: 7, curve: 'LINEAR', time: 1000 } },
      { type: 'PRESSURE', target: { end: 3, curve: 'LINEAR', time: 1000 } }, // blank start
    ]);
    // Second occurrence at x=1: the first is phase 1's last point, the
    // second is phase 2's first point.
    expect(pointAt(points, 1, 'PRESSURE', 1).y).toBe(7); // carried over from phase 1's end
  });

  it('falls back to 0 when the previous phase has a different type', () => {
    const points = _synthesizeSeries([
      { type: 'FLOW', target: { start: 0, end: 4, curve: 'LINEAR', time: 1000 } },
      { type: 'PRESSURE', target: { end: 7, curve: 'LINEAR', time: 1000 } }, // blank start, type change
    ]);
    expect(pointAt(points, 1, 'PRESSURE', 0).y).toBe(0);
  });

  it('falls back to 0 for the first phase when target.start is blank', () => {
    const points = _synthesizeSeries([
      { type: 'PRESSURE', target: { end: 6, curve: 'LINEAR', time: 1000 } },
    ]);
    expect(points[0].y).toBe(0);
  });

  it('an explicit target.start always wins over carry-over', () => {
    const points = _synthesizeSeries([
      { type: 'PRESSURE', target: { start: 0, end: 7, curve: 'LINEAR', time: 1000 } },
      { type: 'PRESSURE', target: { start: 1, end: 3, curve: 'LINEAR', time: 1000 } },
    ]);
    expect(pointAt(points, 1, 'PRESSURE', 1).y).toBe(1);
  });

  it('skips skipped phases entirely, including for carry-over purposes', () => {
    const points = _synthesizeSeries([
      { type: 'PRESSURE', target: { start: 0, end: 7, curve: 'LINEAR', time: 1000 } },
      { type: 'PRESSURE', skip: true, target: { start: 0, end: 9, curve: 'LINEAR', time: 1000 } },
      { type: 'PRESSURE', target: { end: 2, curve: 'LINEAR', time: 1000 } }, // blank start
    ]);
    // Skipped phase contributes no time and is not the carry-over source.
    expect(pointAt(points, 1, 'PRESSURE', 1).y).toBe(7);
  });
});

describe('_collectPhases', () => {
  it('round-trips target.volume and phase-level waterTemperature when set', () => {
    const row = fakeRow({
      'pp-name': 'Bloom', 'pp-type': 'FLOW',
      'pp-target-start': '0', 'pp-target-end': '4', 'pp-target-curve': 'LINEAR',
      'pp-target-time': '5000', 'pp-target-volume': '40',
      'pp-restriction': '', 'pp-water-temp': '93.5',
      'pp-stop-time': '', 'pp-stop-pressure-above': '', 'pp-stop-pressure-below': '',
      'pp-stop-flow-above': '', 'pp-stop-flow-below': '', 'pp-stop-weight': '',
      'pp-stop-water-pumped': '', 'pp-skip': false,
    });
    globalThis.document = { querySelectorAll: sel => sel === '#profilePhaseList .pp-row' ? [row] : [] };

    const [phase] = _collectPhases();
    expect(phase.target.volume).toBe(40);
    expect(phase.waterTemperature).toBe(93.5);
  });

  it('leaves target.volume and waterTemperature undefined (not 0) when blank', () => {
    const row = fakeRow({
      'pp-name': '', 'pp-type': 'FLOW',
      'pp-target-start': '', 'pp-target-end': '', 'pp-target-curve': 'LINEAR',
      'pp-target-time': '', 'pp-target-volume': '',
      'pp-restriction': '', 'pp-water-temp': '',
      'pp-stop-time': '', 'pp-stop-pressure-above': '', 'pp-stop-pressure-below': '',
      'pp-stop-flow-above': '', 'pp-stop-flow-below': '', 'pp-stop-weight': '',
      'pp-stop-water-pumped': '', 'pp-skip': false,
    });
    globalThis.document = { querySelectorAll: sel => sel === '#profilePhaseList .pp-row' ? [row] : [] };

    const [phase] = _collectPhases();
    expect(phase.target.volume).toBeUndefined();
    expect(phase.waterTemperature).toBeUndefined();
  });
});
