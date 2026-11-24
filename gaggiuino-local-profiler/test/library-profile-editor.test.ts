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
const { renderRecipeList } = await import('../public-src/views/library/recipes.js');
const { renderBasketList } = await import('../public-src/views/library/baskets.js');
const { renderPuckScreenList } = await import('../public-src/views/library/puck-screens.js');
const { renderGrinderList } = await import('../public-src/views/library/grinders.js');
const {
  normalizeProfileName, formatTimeWindow, loadProfileTimeTargets, profileTimeTargetFor,
  profileTimeTargetMenuItem, profileTimeTargetBadge, parseTimeWindowInputs,
  openProfileTimeTargetSheet, saveProfileTimeTargetFromSheet, clearProfileTimeTarget,
  setProfileTimeTargetsChanged,
} = await import('../public-src/views/library/profile-time-target.js');

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
    // Each list load also reads the machine's target times; only the profile
    // list request itself is raced here.
    const lists = [pA, pB];
    fetchSpy.mockImplementation((url: string) => (
      url.startsWith('api/machine/profiles')
        ? (lists.shift() ?? Promise.resolve({ ok: true, json: () => Promise.resolve({ optionsRaw: [] }) } as unknown as Response))
        : Promise.resolve({ ok: true, json: () => Promise.resolve([]) } as unknown as Response)
    )); // call A fired first, call B fired second, while A is still pending

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

describe('library list rows (#2172)', () => {
  const LISTS = [
    { action: 'recipe', host: 'recipeListUI', render: renderRecipeList },
    { action: 'basket', host: 'basketListUI', render: renderBasketList },
    { action: 'puckscreen', host: 'puckScreenListUI', render: renderPuckScreenList },
    { action: 'grinder', host: 'grinderListUI', render: renderGrinderList },
  ] as const;

  const render = (list: (typeof LISTS)[number], extra: Record<string, unknown> = {}): string => {
    const el = { innerHTML: '' };
    g.document = { getElementById: (id: string) => (id === list.host ? el : undefined), querySelectorAll: () => [] };
    const row = { id: 7, name: 'Row', ...extra };
    S.shots = [];
    S.coffeeLibrary = { beans: [], recipes: [row], baskets: [row], puckScreens: [row], grinders: [row] };
    list.render();
    return el.innerHTML;
  };
  const buttonPart = (markup: string): string => {
    const start = markup.indexOf('class="lib-item-open"');
    return markup.slice(start, markup.indexOf('</button>', start));
  };

  it('opens a recipe, basket, puck screen and grinder on a row tap', () => {
    for (const list of LISTS) {
      const markup = render(list);
      expect(markup).toContain(`<button type="button" class="lib-item-open" data-action="edit-${list.action}" data-id="7">`);
      expect(markup.split(`data-action="edit-${list.action}"`).length - 1).toBe(1);
      expect(markup).toContain('<details class="lib-sheet-more">');
      expect(markup).toContain('<summary aria-label="' + t('lib_sheet_more') + '">⋯</summary>');
      expect(buttonPart(markup)).not.toContain('<div');
      expect(buttonPart(markup)).not.toContain('<a ');
      expect(markup).not.toContain('btn--icon');
      expect(markup).not.toContain('lib-item-actions');
      expect(markup).not.toContain('lib-item-info');
    }
  });

  it("keeps Delete last and red in each row's ⋯ menu", () => {
    for (const list of LISTS) {
      const markup = render(list);
      expect(markup).toContain(`<button type="button" class="lib-sheet-menu-item del" data-action="delete-${list.action}" data-id="7">`);
      expect(markup).toContain('</svg> ' + t('lib_btn_delete') + '</button>');
      expect(markup.indexOf(`data-action="delete-${list.action}"`)).toBeGreaterThan(markup.indexOf('<details class="lib-sheet-more">'));
      expect(markup).not.toContain('lib-sheet-menu-sep');
    }
  });

  it("moves Burrs replaced into the grinder's ⋯ menu, above Delete", () => {
    const markup = render(LISTS[3], { wear: { shotsSinceBurrs: 3, gramsSinceBurrs: 54 } });
    const positions = [
      '<details class="lib-sheet-more">',
      '<button type="button" class="lib-sheet-menu-item" data-action="reset-grinder-burrs" data-id="7">',
      'class="lib-sheet-menu-sep"',
      'data-action="delete-grinder"',
    ].map(part => markup.indexOf(part));
    expect(positions.every(i => i >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    expect(markup).toContain('</svg> ' + t('lib_grinder_reset_burrs') + '</button>');
    expect(markup).not.toContain('btn btn--quiet');
    expect(markup.indexOf('lib-grinder-wear')).toBeLessThan(markup.indexOf('<details'));
  });

  it("keeps a recipe's source link outside the row's button", () => {
    const markup = render(LISTS[0], { sourceUrl: 'https://example.com/r' });
    expect(markup).toContain('href="https://example.com/r"');
    expect(markup.indexOf('<div class="lib-item-source">')).toBeGreaterThan(markup.indexOf('</details>'));
  });

  it('leaves no style or markup for the old row action bar', () => {
    const SRC = join(import.meta.dirname, '..', 'public-src');
    const style = readFileSync(join(SRC, 'style.css'), 'utf8');
    expect(style).not.toContain('.lib-item-actions');
    expect(style).toContain('.lib-item > .lib-item-source { flex-basis: 100%; }');
    for (const file of ['recipes.ts', 'baskets.ts', 'puck-screens.ts', 'grinders.ts']) {
      const source = readFileSync(join(SRC, 'views', 'library', file), 'utf8');
      expect(source).not.toContain('lib-item-actions');
      expect(source).not.toContain('ICON_PENCIL');
    }
  });
});

describe('profile target time (#1504)', () => {
  const showToast = vi.fn();

  // The sheet reads its two inputs and the host element off `document`; a fake
  // host and the two input fields are all the open/save/clear paths touch.
  interface StubField extends FakeFormField {
    attrs: Record<string, string>;
    setAttribute(name: string, value: string): void;
    removeAttribute(name: string): void;
    addEventListener(): void;
  }

  function stubSheet(values: Record<string, string>): Record<string, StubField> {
    const fields: Record<string, StubField> = {};
    const field = (id: string): StubField => {
      const existing = fields[id];
      if (existing) return existing;
      const attrs: Record<string, string> = {};
      const created: StubField = {
        value: values[id] ?? '', style: {}, classList: { add() {}, remove() {} },
        focus() {}, attrs,
        setAttribute(name: string, value: string) { attrs[name] = value; },
        removeAttribute(name: string) { Reflect.deleteProperty(attrs, name); },
        addEventListener() {},
      };
      fields[id] = created;
      return created;
    };
    const host = {
      innerHTML: '',
      classList: { add() {}, remove() {} },
      querySelector: () => null,
      querySelectorAll: () => [],
      focus() {},
    };
    g.document = {
      getElementById: (id: string) => (id === 'detailSheet' ? host : field(id)),
      querySelectorAll: () => [],
    };
    return fields;
  }

  const changed = vi.fn();

  beforeEach(() => {
    fetchSpy.mockReset();
    showToast.mockReset();
    changed.mockReset();
    setProfileTimeTargetsChanged(changed);
    g.window = { showToast };
    S.activeMachineId = 1;
  });

  it('normalizeProfileName trims and lowercases', () => {
    expect(normalizeProfileName('  Adaptive V2 ')).toBe('adaptive v2');
  });

  it('formatTimeWindow renders the en dash window', () => {
    expect(formatTimeWindow(40, 48)).toBe('40–48 s');
  });

  it('profileTimeTargetFor matches per machine, ignoring case and spaces', async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve([{ profileName: 'Adaptive v2', minS: 40, maxS: 48 }]),
    } as unknown as Response);

    await loadProfileTimeTargets(1);

    const [url] = fetchSpy.mock.calls[0] as unknown as [string];
    expect(url).toBe('api/profile-time-targets?machineId=1');
    expect(profileTimeTargetFor(1, ' ADAPTIVE V2 ')).toEqual({ profileName: 'Adaptive v2', minS: 40, maxS: 48 });
    expect(profileTimeTargetFor(2, 'Adaptive v2')).toBeNull();
  });

  it('profileTimeTargetBadge shows the stored window of the active machine', async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve([{ profileName: 'Adaptive v2', minS: 40, maxS: 48 }]),
    } as unknown as Response);
    await loadProfileTimeTargets(1);

    expect(profileTimeTargetBadge({ name: 'Adaptive v2' })).toBe('<span class="badge">40–48 s</span>');
    expect(profileTimeTargetBadge({ name: 'Flush', utility: true })).toBe('');
    expect(profileTimeTargetBadge({ name: 'Other' })).toBe('');
  });

  it('the target time menu item is hidden on utility profiles', () => {
    expect(profileTimeTargetMenuItem({ name: 'Flush', utility: true })).toBe('');

    S.activeMachineId = 1;
    const item = profileTimeTargetMenuItem({ name: 'Adaptive v2' });
    expect(item).toContain('data-action="profile-time-target"');
    expect(item).toContain('data-name="Adaptive v2"');

    S.activeMachineId = 'all';
    expect(profileTimeTargetMenuItem({ name: 'Adaptive v2' })).toBe('');
    expect(profileTimeTargetMenuItem({ name: '  ' })).toBe('');
  });

  it('parseTimeWindowInputs enforces whole seconds 5..300 with min below max', () => {
    expect(parseTimeWindowInputs('40', '48')).toEqual({ minS: 40, maxS: 48 });
    expect(parseTimeWindowInputs('4', '48')).toBeNull();
    expect(parseTimeWindowInputs('40', '301')).toBeNull();
    expect(parseTimeWindowInputs('40', '40')).toBeNull();
    expect(parseTimeWindowInputs('40.5', '48')).toBeNull();
    expect(parseTimeWindowInputs('', '48')).toBeNull();
  });

  it('saving sends the window for the machine the sheet was opened on', async () => {
    const fields = stubSheet({ pttMin: '40', pttMax: '48' });
    openProfileTimeTargetSheet('Adaptive v2', null);

    // The active machine moves while the sheet is open; the write must stay
    // on the machine it was opened against.
    S.activeMachineId = 2;

    fetchSpy.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve([{ profileName: 'Adaptive v2', minS: 40, maxS: 48 }]),
    } as unknown as Response);

    await saveProfileTimeTargetFromSheet();

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('api/profile-time-targets');
    expect(init.method).toBe('PUT');
    expect(JSON.parse(init.body as string) as Record<string, unknown>).toEqual({ machineId: 1, profileName: 'Adaptive v2', minS: 40, maxS: 48 });
    expect(showToast).toHaveBeenCalledWith(t('profile_time_target_saved'));
    // The response repopulates the cache of the machine the sheet was opened
    // on, not the one that became active meanwhile.
    expect(profileTimeTargetFor(1, 'Adaptive v2')).toEqual({ profileName: 'Adaptive v2', minS: 40, maxS: 48 });
    expect(profileTimeTargetFor(2, 'Adaptive v2')).toBeNull();
    expect(entry(fields, 'pttMin').attrs['aria-invalid']).toBeUndefined();
    expect(changed).toHaveBeenCalledTimes(1);
  });

  it('an invalid window sends no request', async () => {
    const fields = stubSheet({ pttMin: '48', pttMax: '40' });
    openProfileTimeTargetSheet('Adaptive v2', null);

    await saveProfileTimeTargetFromSheet();

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(showToast).toHaveBeenCalledWith(t('profile_time_target_invalid'));
    // Min is a whole number in range but not below max: the min field is the
    // one marked, and max stays clean.
    expect(entry(fields, 'pttMin').attrs['aria-invalid']).toBe('true');
    expect(entry(fields, 'pttMax').attrs['aria-invalid']).toBeUndefined();
    expect(changed).not.toHaveBeenCalled();
  });

  it('removing sends null bounds', async () => {
    stubSheet({ pttMin: '40', pttMax: '48' });
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve([{ profileName: 'Adaptive v2', minS: 40, maxS: 48 }]),
    } as unknown as Response);
    await loadProfileTimeTargets(1);
    expect(profileTimeTargetFor(1, 'Adaptive v2')).toEqual({ profileName: 'Adaptive v2', minS: 40, maxS: 48 });

    openProfileTimeTargetSheet('Adaptive v2', null);

    fetchSpy.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve([]),
    } as unknown as Response);

    await clearProfileTimeTarget();

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const [url, init] = fetchSpy.mock.calls[1] as unknown as [string, RequestInit];
    expect(url).toBe('api/profile-time-targets');
    expect(init.method).toBe('PUT');
    expect(JSON.parse(init.body as string) as Record<string, unknown>).toEqual({ machineId: 1, profileName: 'Adaptive v2', minS: null, maxS: null });
    expect(profileTimeTargetFor(1, 'Adaptive v2')).toBeNull();
    expect(changed).toHaveBeenCalledTimes(1);
  });

  it("a profile row offers Target time and shows its window", async () => {
    fetchSpy.mockImplementation((url: string) => Promise.resolve(
      url.startsWith('api/machine/profiles')
        ? ({ ok: true, json: () => Promise.resolve({
            optionsRaw: [{ id: 1, name: 'Adaptive v2' }, { id: 2, name: 'Flush', utility: true }],
          }) } as unknown as Response)
        : ({ ok: true, json: () => Promise.resolve([
            { profileName: 'adaptive v2', minS: 40, maxS: 48 },
          ]) } as unknown as Response),
    ));
    const el = { innerHTML: '' };
    g.document = {
      getElementById: (id: string) => (id === 'profileListUI' ? el : undefined),
      querySelectorAll: () => [],
    };
    S.activeMachineId = 1;

    await loadMachineProfileList();

    // One markup block per profile row: the ⋯ menu entry and the badge must be
    // in the row of the profile the window belongs to (case-insensitively),
    // and nowhere near the utility row.
    const rows = el.innerHTML.split('<div class="lib-item').slice(1);
    expect(rows).toHaveLength(2);
    const adaptive = rows.find(r => r.includes('Adaptive v2')) ?? '';
    const utility = rows.find(r => r.includes('Flush')) ?? '';

    expect(adaptive).toContain('data-action="profile-time-target"');
    expect(adaptive).toContain('40–48 s');
    expect(adaptive).toContain('<span class="lib-item-name">Adaptive v2</span>');
    expect(utility).toContain('lib-item-utility');
    expect(utility).not.toContain('data-action="profile-time-target"');
    expect(utility).not.toContain('40–48 s');

    // Exactly once overall: one entry, one badge, for the one real profile.
    expect(el.innerHTML.split('data-action="profile-time-target"').length - 1).toBe(1);
    expect(el.innerHTML.split('40–48 s').length - 1).toBe(1);
  });

  it("loading the profile list also loads that machine's target times", async () => {
    const urls: string[] = [];
    fetchSpy.mockImplementation((url: string) => {
      urls.push(url);
      return Promise.resolve(
        url.startsWith('api/machine/profiles')
          ? ({ ok: true, json: () => Promise.resolve({ optionsRaw: [] }) } as unknown as Response)
          : ({ ok: true, json: () => Promise.resolve([
              { profileName: 'Window probe', minS: 40, maxS: 48 },
            ]) } as unknown as Response),
      );
    });
    g.document = { getElementById: () => undefined, querySelectorAll: () => [] };
    S.activeMachineId = 1;

    await loadMachineProfileList();

    expect(urls).toContain('api/profile-time-targets?machineId=1');
    // The response is cached for the row entry and badge of that machine.
    expect(profileTimeTargetFor(1, 'window probe')).toEqual({ profileName: 'Window probe', minS: 40, maxS: 48 });
  });

  // The window read is an enhancement next to the profile list, not part of
  // it: an older backend, an offline GLP or a relative-URL test stub that
  // fails here must not empty the Profiles tab.
  it('a failing target-time read still loads the profile list', async () => {
    fetchSpy.mockImplementation((url: string) => Promise.resolve(
      url.startsWith('api/machine/profiles')
        ? ({ ok: true, json: () => Promise.resolve({ optionsRaw: [{ id: 1, name: 'Adaptive v2' }] }) } as unknown as Response)
        : Promise.reject(new TypeError('Failed to parse URL from api/profile-time-targets')),
    ));
    const el = { innerHTML: '' };
    g.document = {
      getElementById: (id: string) => (id === 'profileListUI' ? el : undefined),
      querySelectorAll: () => [],
    };
    S.activeMachineId = 1;

    await expect(loadMachineProfileList()).resolves.toBeUndefined();

    expect(S.machineProfiles).toEqual([{ id: 1, name: 'Adaptive v2' }]);
    expect(el.innerHTML).toContain('Adaptive v2');
  });

  it('a rejected save keeps the sheet data and reports the status', async () => {
    const fields = stubSheet({ pttMin: '40', pttMax: '48' });
    openProfileTimeTargetSheet('Adaptive v2', null);
    fetchSpy.mockResolvedValueOnce({ ok: false, status: 500 } as unknown as Response);

    await saveProfileTimeTargetFromSheet();

    expect(showToast).toHaveBeenCalledWith(t('error_generic', 500));
    expect(entry(fields, 'pttMin').value).toBe('40');
    expect(changed).not.toHaveBeenCalled();
  });
});
