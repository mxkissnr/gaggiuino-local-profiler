// #2154: the GaggiMate editor in the layout both profile editors share: chart
// first, the phase timeline (chip width = share of the time), one phase's
// fields at a time with its stop conditions folded, recipe rows; ramp fields
// only on a Pro profile.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// The editor's import chain reads localStorage/navigator at module load time.
const g = globalThis as unknown as Record<string, unknown>;
g.localStorage ??= { getItem: () => null, setItem: () => {} };
g.navigator ??= { language: 'en-US' };

const { S } = await import('../public-src/state/index.js');
const { t } = await import('../public-src/i18n.js');
const apiModule = await import('../public-src/api/transport.js');
const fetchSpy = vi.spyOn(apiModule, 'apiFetch');
const { openGaggiMateProfileEditor, handleGmEditorAction, buildGmChartData, gmTimeAxisStep, gmTimeTickLabel } =
  await import('../public-src/views/gaggimate-profile-editor.js');

interface FakeEl {
  innerHTML: string;
  style: Record<string, string>;
  textContent: string;
  addEventListener(): void;
}

let els: Record<string, FakeEl> = {};

// #gmProfileChart is absent so the Chart.js branch bails before it touches a canvas.
function installDocument(): void {
  els = {};
  g.document = {
    getElementById: (id: string) => (id === 'gmProfileChart'
      ? undefined
      : (els[id] ??= { innerHTML: '', style: {}, textContent: '', addEventListener() {} })),
    querySelectorAll: () => [],
  };
}

const STANDARD = {
  id: 'gm-1', label: 'Turbo', description: '', temperature: 93, type: 'standard', utility: false, favorite: false,
  phases: [
    { name: 'Pre', phase: 'preinfusion', valve: 1, pump: 30, duration: 6, targets: [] },
    { name: 'Brew', phase: 'brew', valve: 1, pump: 100, duration: 24, targets: [{ type: 'volumetric', operator: 'gte', value: 36 }] },
  ],
};

const PRO = {
  id: 'gm-2', label: 'Bloom', description: '', temperature: 93, type: 'pro', utility: false, favorite: false,
  phases: [
    { name: 'Fill', phase: 'preinfusion', valve: 1, pump: { target: 'flow', pressure: 3, flow: 4 }, duration: 5, temperature: 0,
      targets: [], transition: { type: 'linear', duration: 2, adaptive: true, target: 'time' } },
  ],
};

// #2163: the simulator's "Cremina Lever": a standard profile with pressure pumps.
const CREMINA = {
  id: 'gm-3', label: 'Cremina Lever', description: '', temperature: 93, type: 'standard', utility: false, favorite: false,
  phases: [
    { name: 'Fill', phase: 'preinfusion', valve: 1, pump: { flow: 0, pressure: 1.1, target: 'pressure' }, duration: 10, targets: [] },
    { name: 'Lever', phase: 'brew', valve: 1, pump: { flow: 0, pressure: 9, target: 'pressure' }, duration: 30, targets: [{ type: 'volumetric', operator: 'gte', value: 36 }] },
  ],
};

const body = (): string => els.gmEditorBody?.innerHTML ?? '';

async function open(profile: unknown): Promise<string> {
  installDocument();
  fetchSpy.mockReset();
  fetchSpy.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(structuredClone(profile)) } as unknown as Response);
  await openGaggiMateProfileEditor('p');
  return body();
}

function act(action: string, idx?: number): string {
  handleGmEditorAction(action, { dataset: idx === undefined ? {} : { idx: String(idx) } } as unknown as HTMLElement);
  return body();
}

const sharesOf = (markup: string): string[] => [...markup.matchAll(/--phase-share:([\d.]+)/g)].map(m => m[1] ?? '');
const chips = (markup: string): number => markup.match(/data-action="gm-select-phase"/g)?.length ?? 0;

beforeEach(() => { S.currentLang = 'en'; });

describe('GaggiMate editor layout (#2154)', () => {
  it('puts the chart first, then the timeline, the phase and the recipe', async () => {
    const markup = await open(STANDARD);
    const order = ['class="pe-preview"', 'class="phase-timeline"', 'class="pe-phase"', 'class="pe-recipe"'].map(s => markup.indexOf(s));
    expect(order.every(i => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(markup).toContain('<div class="pe-layout">');
  });

  it('sizes the timeline chips by the phase durations and marks the first', async () => {
    const markup = await open(STANDARD);
    expect(chips(markup)).toBe(2);
    expect(sharesOf(markup)).toEqual(['0.2', '0.8']);
    expect(markup).toContain('aria-pressed="true" data-action="gm-select-phase" data-idx="0"');
    expect(markup).toContain(`<span>${t('gm_phases_header')}</span>`);
  });

  it('shows only the selected phase and switches on a chip', async () => {
    let markup = await open(STANDARD);
    expect(markup).toContain('data-action="gm-std-phase-name" data-idx="0"');
    expect(markup).not.toContain('data-action="gm-std-phase-name" data-idx="1"');
    expect(markup).toContain(t('pe_phase_of', 1, 2));

    markup = act('gm-select-phase', 1);
    expect(markup).toContain('data-action="gm-std-phase-name" data-idx="1"');
    expect(markup).not.toContain('data-action="gm-std-phase-name" data-idx="0"');
    expect(markup).toContain('aria-pressed="true" data-action="gm-select-phase" data-idx="1"');
    expect(markup).toContain(t('pe_phase_of', 2, 2));
  });

  it('folds the stop conditions', async () => {
    const markup = await open(STANDARD);
    const fold = markup.indexOf('<details class="pe-stops">');
    expect(fold).toBeGreaterThan(-1);
    expect(markup).not.toContain('<details class="pe-stops" open>');
    expect(markup.indexOf('id="gm-std-vol-0"')).toBeGreaterThan(fold);
    expect(markup).toContain(t('gm_stop_conditions'));
  });

  it('adds a phase and selects it; removing keeps a phase selected', async () => {
    await open(STANDARD);
    let markup = act('gm-add-phase');
    expect(chips(markup)).toBe(3);
    expect(markup).toContain('aria-pressed="true" data-action="gm-select-phase" data-idx="2"');

    markup = act('gm-remove-phase', 2);
    expect(chips(markup)).toBe(2);
    expect(markup).toContain('aria-pressed="true" data-action="gm-select-phase" data-idx="1"');
    expect(markup).toContain('class="btn btn--danger pe-remove-phase" data-action="gm-remove-phase" data-idx="1"');
  });

  it('keeps the ramp fields to the Pro type and drops the arrows', async () => {
    const standard = await open(STANDARD);
    expect(standard).not.toContain('data-action="gm-pro-ramp-type"');
    const pro = await open(PRO);
    expect(pro).toContain('data-action="gm-pro-ramp-type"');
    expect(pro).toContain(`<span>${t('gm_phases_pro_header')}</span>`);
    for (const markup of [standard, pro]) {
      expect(markup).not.toContain('gm-phase-prev');
      expect(markup).not.toContain('gm-phase-next');
      expect(markup).not.toContain('gm-phase-sep');
    }
  });

  it('shows the profile values as grouped recipe rows', async () => {
    const markup = await open(STANDARD);
    const recipe = markup.slice(markup.indexOf('class="pe-recipe"'));
    expect(recipe).toContain(`<h4 class="section-title">${t('pe_recipe')}</h4>`);
    expect(recipe.match(/<div class="settings-group">/g)?.length).toBe(2);
    for (const id of ['gmLabel', 'gmTemperature', 'gmFavorite', 'gmUtility', 'gmDescription']) {
      expect(recipe).toContain(`id="${id}"`);
    }
    expect(recipe).toContain('data-action="gm-type"');
  });

  it('shows the empty text and the add button without phases', async () => {
    const markup = await open({ ...STANDARD, phases: [] });
    expect(chips(markup)).toBe(0);
    expect(markup).toContain(t('gm_no_phases'));
    expect(markup).toContain('data-action="gm-add-phase"');
    expect(markup).not.toContain('pe-remove-phase');
  });

  it('steps the time axis in whole seconds (#2163)', () => {
    expect(gmTimeAxisStep(30)).toBe(5);
    expect(gmTimeAxisStep(65)).toBe(10);
    expect(gmTimeAxisStep(200)).toBe(30);
    expect(gmTimeAxisStep(600)).toBe(120);
    expect(gmTimeAxisStep(5000)).toBe(120);
    expect(gmTimeTickLabel(9.428571428571429)).toBe('9');
    expect(gmTimeTickLabel(65)).toBe('65');
  });

  it('shows the pump target of a standard profile with pressure pumps (#2163)', async () => {
    const cremina = await open(CREMINA);
    expect(cremina).toContain('aria-pressed="true" data-action="gm-std-pump-mode" data-idx="0" data-val="pressure"');
    expect(cremina).toContain('data-val="flow"');
    expect(cremina).toContain('data-action="gm-std-pressure" data-idx="0"');
    expect(cremina).toContain('value="1.1"');
    expect(cremina).not.toContain('data-action="gm-pro-ramp-type"');

    const standard = await open(STANDARD);
    expect(standard).not.toContain('data-val="pressure"');
    expect(standard).toContain('aria-pressed="true" data-action="gm-std-pump-mode" data-idx="0" data-val="power"');
  });

  it('keeps the target values when the standard pump mode switches (#2163)', async () => {
    await open(CREMINA);
    handleGmEditorAction('gm-std-pump-mode', { dataset: { idx: '0', val: 'flow' } } as unknown as HTMLElement);
    const markup = body();
    expect(markup).toContain('aria-pressed="true" data-action="gm-std-pump-mode" data-idx="0" data-val="flow"');
    expect(markup).toContain('data-action="gm-std-pressure" data-idx="0"');
    expect(markup).toContain('value="1.1"');
  });

  it('draws the pump target curve of a standard profile with pressure pumps (#2163)', () => {
    const cremina = buildGmChartData(CREMINA)!;
    expect(cremina.pumpChart).toBe(true);
    expect(cremina.powerData).toEqual([]);
    expect(Math.max(...cremina.pressureData.map(p => p.y))).toBeGreaterThan(8);

    const standard = buildGmChartData(STANDARD)!;
    expect(standard.pumpChart).toBe(false);
    expect(standard.pressureData).toEqual([]);
    expect(standard.powerData.map(p => p.y)).toEqual([30, 100, 100]);
  });

  it('offers the stop conditions in the shared menu (#2165)', async () => {
    const markup = await open(PRO);
    expect(markup).toContain('<details class="lib-sheet-more gm-stop-add">');
    expect(markup).toContain(`<summary class="btn btn--tonal">${t('gm_add_condition')}</summary>`);
    expect(markup.match(/class="lib-sheet-menu-item" data-action="gm-pro-add-target"/g)).toHaveLength(6);
    expect(markup).not.toContain('gm-dropdown');
    expect(markup).not.toContain('gm-pro-target-menu');
  });

  it('adds a picked stop condition and drops it from the menu (#2165)', async () => {
    await open(PRO);
    handleGmEditorAction('gm-pro-add-target', { dataset: { idx: '0', type: 'flow', op: 'lte' } } as unknown as HTMLElement);
    const markup = body();
    expect(markup).toContain('data-action="gm-pro-target-value" data-idx="0" data-tidx="0"');
    expect(markup.match(/data-action="gm-pro-add-target"/g)).toHaveLength(5);
    expect(markup).not.toContain('data-type="flow" data-op="lte"');
  });

  it('leaves no style for the retired GaggiMate editor parts', () => {
    const css = readFileSync(join(import.meta.dirname, '..', 'public-src', 'style.css'), 'utf8');
    for (const cls of ['.gm-chart-container', '.gm-phase-nav', '.gm-phase-sep', '.gm-empty', '.gm-dropdown']) {
      expect(css).not.toContain(cls);
    }
  });
});
