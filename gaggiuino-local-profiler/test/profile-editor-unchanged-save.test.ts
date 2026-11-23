// #2154: the profile editors get a new layout (chart first, a phase
// timeline, one phase's fields at a time). The layout must never change what
// reaches the machine: opening a profile and sending it back without an edit
// sends exactly the bytes it sent before the layout change. This pins the
// request body of both editors as dev sent it before #2154.
import { describe, it, expect, beforeEach, vi } from 'vitest';

// The editors' import chain reads localStorage/navigator at module load time.
const g = globalThis as unknown as Record<string, unknown>;
g.localStorage ??= { getItem: () => null, setItem: () => {}, removeItem: () => {} };
g.navigator ??= { language: 'en-US' };
g.window ??= { showToast: () => {} };
// The Gaggiuino send confirms through the app dialog; it answers yes here.
const dialogs = vi.hoisted(() => ({ confirmDialog: vi.fn(() => Promise.resolve(true)) }));
vi.mock('../public-src/components/confirm-dialog.js', () => ({ confirmDialog: dialogs.confirmDialog }));

const { S } = await import('../public-src/state/index.js');
const apiModule = await import('../public-src/api/transport.js');
const fetchSpy = vi.spyOn(apiModule, 'apiFetch');
const { openProfileForm, sendProfileToMachine } = await import('../public-src/views/library-profile-editor.js');
const { openGaggiMateProfileEditor, saveGaggiMateProfile, handleGmEditorAction } = await import('../public-src/views/gaggimate-profile-editor.js');

// ── Fixtures ────────────────────────────────────────────────────────────

// A Gaggiuino profile as the machine API returns it: one phase with string
// enums, one with numeric enums (type 1 = PRESSURE, curve 3 = LINEAR), a
// quote in a name, blank and set optional fields, a skipped phase.
const GAGGIUINO_PROFILE = {
  id: 7, name: 'Adaptive "9" bar', waterTemperature: 93,
  recipe: { coffeeIn: 18, coffeeOut: 36, ratio: 2 },
  globalStopConditions: { weight: 36 },
  phases: [
    { name: 'Bloom "soft"', type: 'FLOW', target: { start: 0, end: 4, curve: 'INSTANT', time: 4000 }, restriction: 3,
      stopConditions: { time: 4000, pressureAbove: 2 }, skip: false },
    { name: 'Brew', type: 1, target: { start: 9, end: 6, curve: 3, time: 18000, volume: 40 }, restriction: 3.5,
      waterTemperature: 92.5, stopConditions: { weight: 36 }, skip: true },
  ],
};

// What dev sent for it before #2154, key order included.
const GAGGIUINO_SENT = {
  name: 'Adaptive "9" bar',
  waterTemperature: 93,
  recipe: { coffeeIn: 18, coffeeOut: 36, ratio: 2 },
  globalStopConditions: { weight: 36 },
  phases: [
    { name: 'Bloom "soft"', type: 'FLOW', target: { start: 0, end: 4, curve: 'INSTANT', time: 4000 }, restriction: 3,
      stopConditions: { time: 4000, pressureAbove: 2, pressureBelow: 0, flowAbove: 0, flowBelow: 0, weight: 0, waterPumpedInPhase: 0 },
      skip: false },
    { name: 'Brew', type: 'PRESSURE', target: { start: 9, end: 6, curve: 'LINEAR', time: 18000, volume: 40 }, restriction: 3.5,
      waterTemperature: 92.5,
      stopConditions: { time: 0, pressureAbove: 0, pressureBelow: 0, flowAbove: 0, flowBelow: 0, weight: 36, waterPumpedInPhase: 0 },
      skip: true },
  ],
  machineId: 2,
};

// The fields both GaggiMate fixtures carry. `_profile` is echoed back whole, so
// the test needs no editor type; `version` is a field the editor does not
// know and must pass through untouched.
interface GmFixture {
  id: string;
  label: string;
  description: string;
  temperature: number;
  type: 'standard' | 'pro';
  utility: boolean;
  favorite: boolean;
  version?: number;
  phases: Record<string, unknown>[];
}

const GM_STANDARD: GmFixture = {
  id: 'gm-1', label: 'Turbo', description: 'Short & "fast"', temperature: 93.5, type: 'standard', utility: false, favorite: true,
  phases: [
    { name: 'Pre', phase: 'preinfusion', valve: 1, pump: 30, duration: 6, targets: [] },
    { name: 'Brew', phase: 'brew', valve: 1, pump: 100, duration: 24, targets: [{ type: 'volumetric', operator: 'gte', value: 36 }] },
  ],
};

const GM_PRO: GmFixture = {
  id: 'gm-2', label: 'Bloom Pro', description: '', temperature: 92, type: 'pro', utility: false, favorite: false, version: 2,
  phases: [
    { name: 'Fill', phase: 'preinfusion', valve: 1, pump: { target: 'flow', pressure: 3, flow: 4 }, duration: 5, temperature: 0,
      targets: [{ type: 'pressure', operator: 'gte', value: 2 }],
      transition: { type: 'instant', duration: 0, adaptive: true, target: 'time' } },
    { name: 'Hold', phase: 'brew', valve: 1, pump: { target: 'pressure', pressure: -1, flow: 3 }, duration: 25, temperature: 93,
      targets: [{ type: 'volumetric', operator: 'gte', value: 40 }, { type: 'pumped', operator: 'gte', value: 80 }],
      transition: { type: 'ease-out', duration: 4, adaptive: false, target: 'time' } },
  ],
};

// #2163: a standard profile with pressure pumps, like the simulator's
// "Cremina Lever" — GaggiMate runs an object pump whatever the type.
const GM_STANDARD_TARGETS: GmFixture = {
  id: 'gm-3', label: 'Cremina Lever', description: '', temperature: 93, type: 'standard', utility: false, favorite: false,
  phases: [
    { name: 'Fill', phase: 'preinfusion', valve: 1, pump: { flow: 0, pressure: 1.1, target: 'pressure' }, duration: 10, targets: [] },
    { name: 'Lever', phase: 'brew', valve: 1, pump: { flow: 0, pressure: 9, target: 'pressure' }, duration: 30, targets: [{ type: 'volumetric', operator: 'gte', value: 36 }] },
  ],
};

// ── Harness ─────────────────────────────────────────────────────────────

const unescapeAttr = (s: string): string => s
  .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

// One .pp-row read back from the markup the editor rendered: a class
// selector resolves to the control carrying that class and returns what a
// browser would hold for it.
function rowFromHtml(rowHtml: string) {
  return {
    hidden: false,
    querySelector(selector: string): { value: string } | { checked: boolean } | undefined {
      const cls = selector.replace(/^\./, '');
      const open = new RegExp(`<(input|select)\\b[^>]*\\bclass="(?:[^"]*\\s)?${cls}(?:\\s[^"]*)?"[^>]*>`).exec(rowHtml);
      if (!open) return undefined;
      const tag = open[0];
      if (open[1] === 'select') {
        const options = rowHtml.slice(open.index + tag.length, rowHtml.indexOf('</select>', open.index));
        const chosen = /<option value="([^"]*)"\s*selected/.exec(options) ?? /<option value="([^"]*)"/.exec(options);
        return { value: unescapeAttr(chosen?.[1] ?? '') };
      }
      if (/\btype="checkbox"/.test(tag)) return { checked: /\schecked\b/.test(tag) };
      return { value: unescapeAttr(/\bvalue="([^"]*)"/.exec(tag)?.[1] ?? '') };
    },
  };
}

function rowsFrom(listHtml: string): ReturnType<typeof rowFromHtml>[] {
  return listHtml.split(/(?=<div class="pp-row")/).filter(part => part.startsWith('<div class="pp-row"')).map(rowFromHtml);
}

interface FakeEl {
  value: string;
  innerHTML: string;
  textContent: string;
  hidden: boolean;
  style: Record<string, string>;
  classList: { add(): void; remove(): void };
  focus(): void;
  addEventListener(): void;
  setAttribute(): void;
  removeAttribute(): void;
}

let els: Record<string, FakeEl> = {};

function installDocument(): void {
  els = {};
  g.document = {
    getElementById: (id: string) => {
      // Both Chart.js branches bail on a missing canvas.
      if (id === 'profilePreviewChart' || id === 'gmProfileChart') return undefined;
      return (els[id] ??= {
        value: '', innerHTML: '', textContent: '', hidden: false, style: {},
        classList: { add() {}, remove() {} }, focus() {}, addEventListener() {}, setAttribute() {}, removeAttribute() {},
      });
    },
    querySelectorAll: (sel: string) => (sel === '#profilePhaseList .pp-row' ? rowsFrom(els.profilePhaseList?.innerHTML ?? '') : []),
  };
}

function response(body: unknown): Response {
  return { ok: true, json: () => Promise.resolve(body) } as unknown as Response;
}

// The one write request (PUT for an existing profile) and its raw body.
function sentBody(): string {
  const writes = (fetchSpy.mock.calls as unknown as [string, RequestInit | undefined][])
    .filter(c => c[1]?.method === 'PUT' || c[1]?.method === 'POST');
  expect(writes).toHaveLength(1);
  return writes[0]?.[1]?.body as string;
}

// ── Tests ───────────────────────────────────────────────────────────────

describe('an unchanged profile is sent exactly as before (#2154)', () => {
  beforeEach(() => {
    fetchSpy.mockReset();
    dialogs.confirmDialog.mockClear();
    S.activeMachineId = 2;
    // The list reload after a save also reads that machine's target times, a
    // GLP-only read (#1504); these tests pin the machine request, so the
    // fallback answers the window read with none.
    fetchSpy.mockImplementation(() => Promise.resolve(response([])));
  });

  it('Gaggiuino: open, then send without an edit', async () => {
    installDocument();
    openProfileForm(structuredClone(GAGGIUINO_PROFILE));
    fetchSpy.mockResolvedValueOnce(response({ syncStatus: 'synced' })); // the PUT
    fetchSpy.mockResolvedValueOnce(response({ optionsRaw: [] }));      // the list reload after close
    await sendProfileToMachine();

    expect(dialogs.confirmDialog).toHaveBeenCalledTimes(1);
    expect(sentBody()).toBe(JSON.stringify(GAGGIUINO_SENT));
  });

  it.each([['standard', GM_STANDARD], ['pro', GM_PRO], ['standard with a pump target', GM_STANDARD_TARGETS]] as Array<[string, GmFixture]>)(
    'GaggiMate %s: open, then save without an edit',
    async (_type, profile) => {
      installDocument();
      fetchSpy.mockResolvedValueOnce(response(structuredClone(profile))); // the GET
      await openGaggiMateProfileEditor(profile.id);
      fetchSpy.mockResolvedValueOnce(response({ syncStatus: 'synced' })); // the PUT
      fetchSpy.mockResolvedValueOnce(response({ optionsRaw: [] }));      // the list reload after close
      await saveGaggiMateProfile();

      expect(sentBody()).toBe(JSON.stringify({ ...profile, machineId: 2 }));
    },
  );

  it('GaggiMate: browsing the phases and the stop conditions writes nothing', async () => {
    installDocument();
    fetchSpy.mockResolvedValueOnce(response(structuredClone(GM_PRO))); // the GET
    await openGaggiMateProfileEditor(GM_PRO.id);
    const pick = (idx: number): HTMLElement => ({ dataset: { idx: String(idx) } }) as unknown as HTMLElement;
    handleGmEditorAction('gm-select-phase', pick(1));
    handleGmEditorAction('gm-select-phase', pick(0));
    fetchSpy.mockResolvedValueOnce(response({ syncStatus: 'synced' })); // the PUT
    fetchSpy.mockResolvedValueOnce(response({ optionsRaw: [] }));      // the list reload after close
    await saveGaggiMateProfile();

    expect(sentBody()).toBe(JSON.stringify({ ...GM_PRO, machineId: 2 }));
  });
});
