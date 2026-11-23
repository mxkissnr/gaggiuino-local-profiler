import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// library-profile-editor.ts imports state/index.ts/i18n.ts/api/transport.ts, which read
// localStorage/navigator at module load time — stub the minimum browser
// globals needed so the module graph can be imported under vitest's node
// environment (same pattern as test/sidebar-month-toggle.test.ts).
// vitest's node environment has no browser globals; stub them through a loose
// view of globalThis (the same bridge the other typed fixtures use).
const g = globalThis as unknown as Record<string, unknown>;
g.localStorage ??= { getItem: () => null, setItem: () => {} };
g.navigator    ??= { language: 'en-US' };

// sendProfileToMachine confirms through the app dialog; it answers yes here.
const dialogs = vi.hoisted(() => ({ confirmDialog: vi.fn(() => Promise.resolve(true)) }));
vi.mock('../public-src/components/confirm-dialog.js', () => ({ confirmDialog: dialogs.confirmDialog }));

const { S } = await import('../public-src/state/index.js');
const apiModule = await import('../public-src/api/transport.js');
const fetchSpy = vi.spyOn(apiModule, 'apiFetch');
const { _synthesizeSeries, _collectPhases, loadMachineProfileList, duplicateProfile, selectProfilePhase, editProfile, sendProfileToMachine, loadProfileForEditing, renderProfileList } = await import('../public-src/views/library-profile-editor.js');
const { t } = await import('../public-src/i18n.js');

// _collectPhases reads phase rows straight off `document` (DOM-as-state, no
// separate JS array) — this vitest project runs in the 'node' environment
// with no jsdom, so stub the minimum `document` needed: one fake .pp-row
// whose querySelector resolves the handful of input selectors the code
// touches, keyed by class name.
function fakeRow(fields: Record<string, string | boolean>) {
  return {
    querySelector(selector: string) {
      const cls = selector.replace('.', '');
      if (!(cls in fields)) return undefined;
      const v = fields[cls];
      return typeof v === 'boolean' ? { checked: v } : { value: v };
    },
  };
}

// The minimal <input> shape the editor reads/writes off a fetched field.
interface FakeFormField {
  value: string;
  style: Record<string, string>;
  classList: { add(): void; remove(): void };
  focus(): void;
}

// Phase boundaries land on the same x (e.g. phase 1 ends and phase 2 starts
// both at x=1) — pick the point belonging to the given phase's type among
// the points at that x, in array order.
type SeriesPoint = ReturnType<typeof _synthesizeSeries>[number];

// Plain arrays/records, so `arr[i]` / `obj[key]` are `| undefined` under
// noUncheckedIndexedAccess; these narrow them back by throwing on a missing
// element/entry instead of sprinkling non-null assertions.
function at<T>(arr: readonly T[], i: number): T {
  const v = arr[i];
  if (v === undefined) throw new Error(`no element at index ${i}`);
  return v;
}
function entry<T>(obj: Record<string, T>, key: string): T {
  const v = obj[key];
  if (v === undefined) throw new Error(`no entry for ${key}`);
  return v;
}

function pointAt(points: SeriesPoint[], x: number, type: string, occurrence = 0): SeriesPoint {
  const pt = points.filter(pt => pt.x === x && pt.type === type)[occurrence];
  if (pt === undefined) throw new Error(`no ${type} point at x=${x} (#${occurrence})`);
  return pt;
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
    expect(at(points, 0).y).toBe(0);
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
    g.document = { querySelectorAll: (sel: string) => sel === '#profilePhaseList .pp-row' ? [row] : [] };

    const phase = at(_collectPhases(), 0);
    expect(phase.target!.volume).toBe(40);
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
    g.document = { querySelectorAll: (sel: string) => sel === '#profilePhaseList .pp-row' ? [row] : [] };

    const phase = at(_collectPhases(), 0);
    expect(phase.target!.volume).toBeUndefined();
    expect(phase.waterTemperature).toBeUndefined();
  });
});

describe('duplicateProfile', () => {
  it('opens a fresh editor pre-filled from the source profile, with id cleared and name suffixed', async () => {
    fetchSpy.mockReset();
    // A non-null sentinel: startNewProfile() must clear it, not leave it over
    // from a previous edit.
    S.profileEditId = 999;
    const fields: Record<string, FakeFormField> = {};
    g.document = {
      getElementById: (id: string) => {
        // renderProfilePreviewChart bails out on a falsy element — no real
        // canvas/Chart.js needed for this test.
        if (id === 'profilePreviewChart') return undefined;
        return (fields[id] ??= { value: '', style: {}, classList: { add() {}, remove() {} }, focus() {} });
      },
      querySelectorAll: () => [],
    };
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({
        id: 'p1', name: 'Turbo Shot', waterTemperature: 93,
        recipe: { coffeeIn: 18, coffeeOut: 36, ratio: 2 },
        globalStopConditions: { weight: 36 },
        phases: [],
      }),
    } as unknown as Response);

    await duplicateProfile('p1');

    expect(S.profileEditId).toBeNull(); // save must POST a new profile, not PUT over the source
    expect(entry(fields, 'profileFormName').value).toBe('Turbo Shot (Copy)');
    // '93' as a string: the .ts module stringifies input values (`String(profile?.waterTemperature)`),
    // which is what a real <input type="number">.value holds anyway.
    expect(entry(fields, 'profileFormWaterTemp').value).toBe('93');
  });
});

describe('editProfile keeps the profile id (#2167)', () => {
  it('saves an unchanged profile with PUT to the id it was opened with, even when the machine body has no id', async () => {
    fetchSpy.mockReset();
    S.profileEditId = null;
    const fields: Record<string, FakeFormField> = {};
    const row = fakeRow({
      'pp-name': 'Bloom', 'pp-type': 'FLOW',
      'pp-target-start': '0', 'pp-target-end': '4', 'pp-target-curve': 'INSTANT',
      'pp-target-time': '4000', 'pp-skip': false,
    });
    g.document = {
      getElementById: (id: string) => {
        if (id === 'profilePreviewChart') return undefined;
        return (fields[id] ??= { value: '', style: {}, classList: { add() {}, remove() {} }, focus() {} });
      },
      querySelectorAll: (sel: string) => sel === '#profilePhaseList .pp-row' ? [row] : [],
    };
    // The machine's REST export: no `id` key.
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({
        name: 'Sertao Decaf', waterTemperature: 93,
        recipe: { coffeeIn: 18, coffeeOut: 36, ratio: 2 },
        globalStopConditions: { weight: 36 },
        phases: [{ name: 'Bloom', type: 'FLOW', target: { start: 0, end: 4, curve: 'INSTANT', time: 4000 } }],
      }),
    } as unknown as Response);

    await editProfile('13');
    expect(S.profileEditId).toBe('13');

    // The save itself, then the profile list reload.
    fetchSpy.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ id: '13', name: 'Sertao Decaf', syncStatus: 'synced' }) } as unknown as Response);
    fetchSpy.mockResolvedValueOnce({ ok: false, json: () => Promise.resolve(null) } as unknown as Response);
    await sendProfileToMachine();

    const [url, init] = fetchSpy.mock.calls[1] as unknown as [string, RequestInit];
    expect(url).toBe('api/machine/profile/13');
    expect(init.method).toBe('PUT');
    expect((JSON.parse(init.body as string) as { name: string }).name).toBe('Sertao Decaf');
  });
});

describe('editProfile rejects a body without phases (#2162)', () => {
  it('does not open the editor for a body without phases', async () => {
    fetchSpy.mockReset();
    const showToast = vi.fn();
    g.window = { showToast };
    const getElementById = vi.fn(() => undefined);
    g.document = { getElementById, querySelectorAll: () => [] };
    S.profileEditId = 4242;
    fetchSpy.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({}) } as unknown as Response);

    await editProfile('p1');

    expect(showToast).toHaveBeenCalledWith(t('profile_load_error'));
    expect(getElementById).not.toHaveBeenCalledWith('profileEditorModal');
    expect(S.profileEditId).toBe(4242);
  });
});

describe('loadProfileForEditing (#2162)', () => {
  const notStored = { ok: false, status: 503, json: () => Promise.resolve({ error: 'x' }) } as unknown as Response;

  function stubDocument() {
    const fields: Record<string, FakeFormField> = {};
    const getElementById = vi.fn((id: string) => {
      if (id === 'profilePreviewChart') return undefined;
      return (fields[id] ??= { value: '', style: {}, classList: { add() {}, remove() {} }, focus() {} });
    });
    g.document = { getElementById, querySelectorAll: () => [] };
    return { fields, getElementById };
  }

  it('editProfile shows the not-stored toast on a 503 and does not open the editor', async () => {
    fetchSpy.mockReset();
    const showToast = vi.fn();
    g.window = { showToast };
    const { getElementById } = stubDocument();
    fetchSpy.mockResolvedValueOnce(notStored);

    await editProfile('p1');

    expect(showToast).toHaveBeenCalledTimes(1);
    expect(showToast).toHaveBeenCalledWith(t('profile_not_stored_offline'));
    expect(getElementById).not.toHaveBeenCalledWith('profileEditorModal');
  });

  it('duplicateProfile shows the not-stored toast on a 503 and does not open the editor', async () => {
    fetchSpy.mockReset();
    const showToast = vi.fn();
    g.window = { showToast };
    const { getElementById } = stubDocument();
    fetchSpy.mockResolvedValueOnce(notStored);

    await duplicateProfile('p1');

    expect(showToast).toHaveBeenCalledTimes(1);
    expect(showToast).toHaveBeenCalledWith(t('profile_not_stored_offline'));
    expect(getElementById).not.toHaveBeenCalledWith('profileEditorModal');
  });

  it("loadProfileForEditing shows the caller's load-error toast on another failure", async () => {
    fetchSpy.mockReset();
    const showToast = vi.fn();
    g.window = { showToast };
    stubDocument();
    fetchSpy.mockResolvedValueOnce({ ok: false, status: 500, json: () => Promise.resolve({ error: 'x' }) } as unknown as Response);

    await expect(loadProfileForEditing('p1', 1, 'gm_toast_load_error')).resolves.toBeNull();
    expect(showToast).toHaveBeenCalledWith(t('gm_toast_load_error'));
  });

  it('loadProfileForEditing returns a profile with phases without a toast', async () => {
    fetchSpy.mockReset();
    const showToast = vi.fn();
    g.window = { showToast };
    stubDocument();
    const profile = { id: 'p1', name: 'A', phases: [] };
    fetchSpy.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(profile) } as unknown as Response);

    await expect(loadProfileForEditing('p1', 1, 'gm_toast_load_error')).resolves.toEqual(profile);
    expect(showToast).not.toHaveBeenCalled();
  });
});

describe('loadMachineProfileList (#521 race)', () => {
  beforeEach(() => {
    fetchSpy.mockReset();
    S.machineProfiles = [];
    g.document = { getElementById: () => undefined, querySelectorAll: () => [] };
  });

  it('the later-fired call wins even when its response resolves before the earlier call\'s', async () => {
    let resolveA!: (value: Response) => void;
    let resolveB!: (value: Response) => void;
    const pA = new Promise<Response>(res => { resolveA = res; });
    const pB = new Promise<Response>(res => { resolveB = res; });
    fetchSpy.mockImplementationOnce(() => pA); // call A — fired first
    fetchSpy.mockImplementationOnce(() => pB); // call B — fired second, while A is still pending

    const callA = loadMachineProfileList();
    const callB = loadMachineProfileList();

    // B (the later-fired call) resolves first...
    resolveB({ ok: true, json: () => Promise.resolve({ optionsRaw: [{ id: 'b', name: 'B' }] }) } as unknown as Response);
    await callB;
    // ...and A's stale response arrives after — it must not clobber B's data.
    resolveA({ ok: true, json: () => Promise.resolve({ optionsRaw: [{ id: 'a', name: 'A' }] }) } as unknown as Response);
    await callA;

    expect(S.machineProfiles).toEqual([{ id: 'b', name: 'B' }]);
  });
});

// #2154: the phase timeline and the one visible phase. The rows are the same
// fake .pp-row the collect tests use, plus the hidden flag the editor sets.
function phaseRows(times: string[], skipLast = false) {
  return times.map((time, i) => Object.assign(
    fakeRow({ 'pp-name': `P${i + 1}`, 'pp-target-time': time, 'pp-skip': skipLast && i === times.length - 1 }),
    { hidden: false },
  ));
}

function navDocument(rows: unknown[]): Record<string, { innerHTML: string }> {
  const els: Record<string, { innerHTML: string }> = {};
  g.document = {
    getElementById: (id: string) => (els[id] ??= { innerHTML: '' }),
    querySelectorAll: (sel: string) => (sel === '#profilePhaseList .pp-row' ? rows : []),
  };
  return els;
}

const sharesOf = (markup: string): string[] => [...markup.matchAll(/--phase-share:([\d.]+)/g)].map(m => m[1] ?? '');

describe('phase timeline and selection (#2154)', () => {
  beforeEach(() => { S.currentLang = 'en'; });

  it('shows only the selected phase and marks it in the timeline', () => {
    const rows = phaseRows(['4000', '6000', '10000']);
    const els = navDocument(rows);
    selectProfilePhase(1);
    expect(rows.map(r => r.hidden)).toEqual([true, false, true]);
    const timeline = els.profilePhaseTimeline?.innerHTML ?? '';
    expect(timeline.match(/aria-pressed="true"/g)?.length).toBe(1);
    expect(timeline).toContain('aria-pressed="true" data-action="select-profile-phase" data-idx="1"');
    expect(els.profilePhaseHead?.innerHTML).toContain(t('pe_phase_of', 2, 3));
  });

  it('sizes each chip by its share of the total time', () => {
    const els = navDocument(phaseRows(['4000', '6000', '10000']));
    selectProfilePhase(0);
    const timeline = els.profilePhaseTimeline?.innerHTML ?? '';
    expect(sharesOf(timeline)).toEqual(['0.2', '0.3', '0.5']);
    expect(timeline).toContain('>4 s<');
    expect(timeline).toContain('>10 s<');
  });

  it('gives a skipped phase no width and says it is skipped', () => {
    const els = navDocument(phaseRows(['4000', '6000', '10000'], true));
    selectProfilePhase(0);
    const timeline = els.profilePhaseTimeline?.innerHTML ?? '';
    expect(sharesOf(timeline)).toEqual(['0.4', '0.6', '0']);
    expect(timeline).toContain(`>${t('profile_phase_skip')}<`);
  });

  it('keeps the selection inside the phase list', () => {
    const rows = phaseRows(['4000', '6000']);
    navDocument(rows);
    selectProfilePhase(9);
    expect(rows.map(r => r.hidden)).toEqual([true, false]);
  });

  it('offers adding a phase when there is none', () => {
    const els = navDocument([]);
    selectProfilePhase(0);
    expect(els.profilePhaseTimeline?.innerHTML).toContain('data-action="add-profile-phase"');
    expect(els.profilePhaseTimeline?.innerHTML).toContain(t('gm_no_phases_add'));
    expect(els.profilePhaseHead?.innerHTML).toBe('');
  });
});

describe('one sheet header and chart first (#2154)', () => {
  const SRC = join(import.meta.dirname, '..', 'public-src');
  const index = readFileSync(join(SRC, 'index.html'), 'utf8');
  const block = (from: string, to: string): string => {
    const start = index.indexOf(from);
    return start < 0 ? '' : index.slice(start, index.indexOf(to, start));
  };
  const gaggiuino = block('id="profileEditorModal"', '<!-- GaggiMate profile editor modal');
  const gaggimate = block('id="gmProfileEditorModal"', '<!-- ── Barcode scan modal ── -->');

  it.each([['Gaggiuino', gaggiuino], ['GaggiMate', gaggimate]])('%s editor: one primary action, in the header, no Cancel', (_name, markup) => {
    expect(markup.length).toBeGreaterThan(0);
    expect(markup.match(/btn--primary/g)?.length).toBe(1);
    const bar = markup.slice(markup.indexOf('<div class="lib-sheet-bar">'), markup.indexOf('<div class="pe-scroll"'));
    expect(bar).toContain('<div class="lib-sheet-bar-actions">');
    expect(bar).toContain('btn--primary');
    expect(markup).not.toContain('lib-form-actions');
    expect(markup).not.toContain('cancelProfileFormBtn');
  });

  it('puts the chart first, then the timeline, the phase and the recipe', () => {
    const order = ['id="profilePreviewChart"', 'id="profilePhaseTimeline"', 'id="profilePhaseList"', 'data-i18n="pe_recipe"'].map(s => gaggiuino.indexOf(s));
    expect(order.every(i => i > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it('sits outside #main like the GaggiMate editor', () => {
    expect(index.indexOf('id="profileEditorModal"')).toBeGreaterThan(index.indexOf('</div><!-- /main -->'));
  });

  it('routes the timeline actions through the click delegation', () => {
    const delegation = readFileSync(join(SRC, 'boot', 'delegation.ts'), 'utf8');
    expect(delegation).toContain("case 'select-profile-phase':");
    expect(delegation).toContain("case 'add-profile-phase':");
  });
});

describe('profile list rows (#2165)', () => {
  const el = { innerHTML: '' };

  const render = (): string => {
    el.innerHTML = '';
    g.document = { getElementById: (id: string) => (id === 'profileListUI' ? el : undefined), querySelectorAll: () => [] };
    S.machineProfiles = [{ id: 7, name: 'Turbo' }];
    S.machineProfilesStale = false;
    renderProfileList();
    return el.innerHTML;
  };

  it('opens the editor on a row tap and keeps the rest in a ⋯ menu', () => {
    const markup = render();
    expect(markup).toContain('<button type="button" class="lib-item-open" data-action="edit-profile" data-id="7">');
    expect(markup.split('data-action="edit-profile"').length - 1).toBe(1);
    expect(markup).toContain('<details class="lib-sheet-more">');
    expect(markup).toContain('<summary aria-label="' + t('lib_sheet_more') + '">');
    const positions = [
      'data-action="start-profile-dialin"',
      'data-action="duplicate-profile"',
      'class="lib-sheet-menu-sep"',
      'class="lib-sheet-menu-item del" data-action="delete-profile" data-id="7"',
    ].map(part => markup.indexOf(part));
    expect(positions.every(i => i > 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    expect(markup).not.toContain('btn--icon');
    expect(markup).not.toContain('lib-item-actions');
  });

  it('gives every menu entry an icon and a label', () => {
    const markup = render();
    expect(markup).toContain('</svg> ' + t('profile_dialin_start') + '</button>');
    expect(markup).toContain('</svg> ' + t('profile_btn_duplicate') + '</button>');
    expect(markup).toContain('</svg> ' + t('lib_btn_delete') + '</button>');
  });
});
