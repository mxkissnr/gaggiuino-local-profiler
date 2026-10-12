import { describe, it, expect, beforeEach, vi } from 'vitest';

// The editors' import chain (state/i18n/api/chart.js) reads localStorage/
// navigator at module load time — stub the minimum browser globals needed so
// the module graph can be imported under vitest's node environment (same
// pattern as test/library-profile-editor.test.ts).
const g = globalThis as unknown as Record<string, unknown>;
g.localStorage ??= { getItem: () => null, setItem: () => {}, removeItem: () => {} };
g.navigator    ??= { language: 'en-US' };
g.window       ??= { showToast: () => {} };
g.confirm       = () => true; // sendProfileToMachine() gates the write behind confirm()

const { S } = await import('../public-src/state/index.js');
const apiModule = await import('../public-src/api/transport.js');
const fetchSpy = vi.spyOn(apiModule, 'apiFetch');
const { openProfileForm, sendProfileToMachine, closeProfileForm }
  = await import('../public-src/views/library-profile-editor.js');
const { openGaggiMateProfileEditor, saveGaggiMateProfile }
  = await import('../public-src/views/gaggimate-profile-editor.js');

// A DOM-as-state harness: everything the two editors read or render into comes
// off `document`, so one cached fake element per id serves both the library
// form fields (value/focus) and the GaggiMate render targets (innerHTML).
interface FakeEl {
  value: string;
  innerHTML: string;
  textContent: string;
  style: Record<string, string>;
  classList: { add(): void; remove(): void };
  focus(): void;
  addEventListener(): void;
}

// The library form reads phase rows straight off the DOM; one row is enough to
// make the submitted profile carry a phase (sendProfileToMachine() bails on an
// empty phase list).
function fakePhaseRow() {
  const fields: Record<string, string | boolean> = {
    'pp-name': 'Bloom', 'pp-type': 'FLOW',
    'pp-target-start': '0', 'pp-target-end': '4', 'pp-target-curve': 'LINEAR',
    'pp-target-time': '5000', 'pp-target-volume': '',
    'pp-restriction': '', 'pp-water-temp': '',
    'pp-stop-time': '', 'pp-stop-pressure-above': '', 'pp-stop-pressure-below': '',
    'pp-stop-flow-above': '', 'pp-stop-flow-below': '', 'pp-stop-weight': '',
    'pp-stop-water-pumped': '', 'pp-skip': false,
  };
  return {
    querySelector(selector: string) {
      const cls = selector.replace('.', '');
      if (!(cls in fields)) return undefined;
      const v = fields[cls];
      return typeof v === 'boolean' ? { checked: v } : { value: v };
    },
  };
}

function fakeDocument(phaseRows: unknown[]): Record<string, unknown> {
  const els: Record<string, FakeEl> = {};
  return {
    getElementById: (id: string) => {
      // Both Chart.js branches bail on a falsy canvas, so no real canvas/Chart
      // is needed here.
      if (id === 'profilePreviewChart' || id === 'gmProfileChart') return undefined;
      return (els[id] ??= {
        value: '', innerHTML: '', textContent: '', style: {},
        classList: { add() {}, remove() {} }, focus() {}, addEventListener() {},
      });
    },
    querySelectorAll: (sel: string) => (sel === '#profilePhaseList .pp-row' ? phaseRows : []),
  };
}

function response(body: unknown): Response {
  return { ok: true, json: () => Promise.resolve(body) } as unknown as Response;
}

function putBody(): Record<string, unknown> {
  const puts = (fetchSpy.mock.calls as unknown as [string, RequestInit][])
    .filter(c => c[1]?.method === 'PUT');
  expect(puts).toHaveLength(1);
  return JSON.parse(puts[0]!.body as string) as Record<string, unknown>;
}

describe('profile editors capture the machine they were opened for (#1605)', () => {
  beforeEach(() => {
    fetchSpy.mockReset();
    S.activeMachineId = 2;
  });

  it('the library profile form saves to the machine it was opened on, not the one active at save time', async () => {
    g.document = fakeDocument([fakePhaseRow()]);
    openProfileForm({
      id: 'p1', name: 'Turbo', waterTemperature: 93,
      recipe: { coffeeIn: 18, coffeeOut: 36, ratio: 2 },
      globalStopConditions: { weight: 36 },
      phases: [],
    });

    // Swap the active machine while the form stays open...
    S.activeMachineId = 3;
    fetchSpy.mockResolvedValueOnce(response({ syncStatus: 'synced' })); // the PUT
    fetchSpy.mockResolvedValueOnce(response({ optionsRaw: [] }));      // loadMachineProfileList() after close
    await sendProfileToMachine();

    expect(putBody().machineId).toBe(2); // ...the save still targets machine 2
    closeProfileForm();
  });

  it('the GaggiMate profile editor saves to the machine it was opened on, not the one active at save time', async () => {
    g.document = fakeDocument([]);
    fetchSpy.mockResolvedValueOnce(response({
      id: 'p1', label: 'Turbo', description: '', type: 'standard', utility: false, favorite: false,
      temperature: 93,
      phases: [{ name: 'Brew', phase: 'brew', valve: 1, pump: 100, duration: 25000, targets: [{ type: 'volumetric', operator: 'gte', value: 36 }] }],
    }));
    await openGaggiMateProfileEditor('p1');

    S.activeMachineId = 3;
    fetchSpy.mockResolvedValueOnce(response({ syncStatus: 'synced' })); // the PUT
    fetchSpy.mockResolvedValueOnce(response({ optionsRaw: [] }));      // loadMachineProfileList() after close
    await saveGaggiMateProfile();

    expect(putBody().machineId).toBe(2);
  });
});
