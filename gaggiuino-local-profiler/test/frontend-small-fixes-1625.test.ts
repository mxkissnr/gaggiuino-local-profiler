import { describe, it, expect, beforeEach, vi } from 'vitest';

// #1625 slice 7: three small frontend fixes with pure, testable entry points —
// the German alias lookup normalisation, the float-noise-free dial-in rounding,
// and the .shot export of a grind setting of 0. The download itself is not under
// test, so shareOrDownloadBlob is captured instead of writing a file (same
// approach as shot-export-grind.test.ts).

const mock = vi.hoisted(() => ({ blob: null as Blob | null }));

vi.mock('../public-src/utils.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../public-src/utils.js')>()),
  shareOrDownloadBlob: vi.fn((blob: Blob) => { mock.blob = blob; return Promise.resolve(); }),
}));

vi.mock('../public-src/shot-curves.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../public-src/shot-curves.js')>()),
  getShotCurve: vi.fn(() => Promise.resolve({ timeInShot: [], pressure: [] })),
}));

const g = globalThis as unknown as Record<string, unknown>;
g.localStorage ??= { getItem: () => null, setItem: () => {} };
g.navigator ??= { language: 'en-US' };

const { matchFlavors } = await import('../public-src/flavor-match.js');
const { suggestPhaseAdjustment } = await import('../public-src/profile-dialin-convergence.js');
const { S } = await import('../public-src/state/index.js');
const { exportShot } = await import('../public-src/views/shots/index.js');

describe('small frontend fixes (#1625, slice 7)', () => {
  it('matches a German alias whose table key keeps its umlaut', () => {
    expect(matchFlavors(['Geröstete Mandel']).matched.has('almond')).toBe(true);
  });

  it('rounds a dial-in adjustment to a clean value (9.1 + 0.1 = 9.2)', () => {
    const profile = {
      name: 'Test',
      waterTemperature: 93,
      recipe: { coffeeIn: 18, coffeeOut: 36, ratio: 2 },
      phases: [
        { name: 'Preinfusion', type: 'FLOW', target: { end: 2, curve: 'INSTANT' }, stopConditions: { time: 15000, pressureAbove: 2 } },
        { name: 'Ramp', type: 'PRESSURE', target: { start: 0, end: 9.1, curve: 'LINEAR', time: 4000 }, restriction: 3, stopConditions: { time: 4000 } },
      ],
    };
    // Preinfusion time is already maxed, so 'sour' falls through to the Ramp
    // pressure. A prior same-field round with a 0.1 step makes the next round
    // add exactly 0.1 — the value that used to round to 9.200000000000001.
    const history = [
      { symptom: 'sour', score: 60, appliedAdjustment: { phaseIndex: 1, field: 'target.end', delta: 0.1 } },
    ];
    const r = suggestPhaseAdjustment('sour', profile, history);
    expect(r.field).toBe('target.end');
    expect(r.newValue).toBe(9.2);
  });

  describe('.shot export with a grind setting of 0', () => {
    beforeEach(() => { mock.blob = null; });

    it('keeps a stored 0 instead of dropping it', async () => {
      S.primaryShotId = 1;
      S.shots = [
        { id: 1, timestamp: 1700000000, profileName: 'Turbo', annotation: { grindSetting: 0 } },
      ];

      await exportShot();

      expect(mock.blob).not.toBeNull();
      expect(await mock.blob!.text()).toContain('grinder_setting {0}');
    });
  });
});
