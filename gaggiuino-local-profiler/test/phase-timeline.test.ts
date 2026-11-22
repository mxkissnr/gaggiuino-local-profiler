import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// #2154: the pieces both profile editors share. The i18n chain reads
// localStorage/navigator at module load time.
const g = globalThis as unknown as Record<string, unknown>;
g.localStorage ??= { getItem: () => null, setItem: () => {} };
g.navigator ??= { language: 'en-US' };

const { S } = await import('../public-src/state/index.js');
const { t } = await import('../public-src/i18n.js');
const tl = await import('../public-src/components/phase-timeline.js');

const OPTS = { title: 'Phases', selectAction: 'pick-phase', addAction: 'add-phase', addLabel: 'Add', emptyText: 'None yet' };
const shares = (markup: string): string[] => [...markup.matchAll(/--phase-share:([\d.]+)/g)].map(m => m[1] ?? '');

beforeAll(() => { S.currentLang = 'en'; });

describe('phase shares (#2154)', () => {
  it('gives each phase its share of the total time', () => {
    expect(tl.phaseShares([4, 6, 14, 6])).toEqual([0.1333, 0.2, 0.4667, 0.2]);
  });

  it('gives a phase without time no share', () => {
    expect(tl.phaseShares([10, 0, Number.NaN, 10, -3])).toEqual([0.5, 0, 0, 0.5, 0]);
  });

  it('splits evenly when no phase has any time', () => {
    expect(tl.phaseShares([0, 0])).toEqual([0.5, 0.5]);
    expect(tl.phaseShares([])).toEqual([]);
  });

  it('writes the length in seconds', () => {
    expect(tl.phaseSecondsText(4)).toBe('4 s');
    expect(tl.phaseSecondsText(2.54)).toBe('2.5 s');
    expect(tl.phaseSecondsText(18.4)).toBe('18 s');
    expect(tl.phaseSecondsText(0)).toBe('0 s');
    expect(tl.phaseSecondsText(Number.NaN)).toBe('0 s');
  });
});

describe('phase timeline (#2154)', () => {
  it('renders one shared chip per phase, sized by its share, with one pressed', () => {
    const markup = tl.phaseTimelineHtml([
      { name: 'Fill', seconds: 4 }, { name: 'Brew', seconds: 12 }, { name: 'Taper', seconds: 4 },
    ], 1, OPTS);
    expect(markup.match(/<button type="button" class="chip phase-timeline-item"/g)?.length).toBe(3);
    expect(markup.match(/aria-pressed="true"/g)?.length).toBe(1);
    expect(markup).toContain('aria-pressed="true" data-action="pick-phase" data-idx="1"');
    expect(shares(markup)).toEqual(['0.2', '0.6', '0.2']);
    expect(markup).toContain('>Brew</span><span class="phase-timeline-sub">12 s</span>');
    expect(markup).toContain('<div class="section-title"><span>Phases</span></div>');
    expect(markup).toContain('role="group" aria-label="Phases"');
    expect(markup).toContain('class="btn btn--quiet btn--icon phase-timeline-add" data-action="add-phase" aria-label="Add"');
    expect(markup).not.toContain('section-title__count');
  });

  it('names an unnamed phase by its position and shows a replacement text', () => {
    const markup = tl.phaseTimelineHtml([{ name: '  ', seconds: 5 }, { name: 'Skipped', seconds: 0, sub: 'Skip' }], 0, OPTS);
    expect(markup).toContain(`>${t('pe_phase_fallback', 1)}</span>`);
    expect(t('pe_phase_fallback', 1)).toBe('Phase 1');
    expect(markup).toContain('>Skip</span>');
    expect(shares(markup)).toEqual(['1', '0']);
  });

  it('offers only the add button and the empty text without phases', () => {
    const markup = tl.phaseTimelineHtml([], 0, OPTS);
    expect(markup).not.toContain('phase-timeline-item');
    expect(markup).toContain('<span class="phase-timeline-empty">None yet</span>');
    expect(markup).toContain('data-action="add-phase"');
  });

  it('escapes phase names', () => {
    const markup = tl.phaseTimelineHtml([{ name: '<b>"x"</b>', seconds: 5 }], 0, OPTS);
    expect(markup).toContain('&lt;b&gt;&quot;x&quot;&lt;/b&gt;');
    expect(markup).not.toContain('<b>');
  });

  it('names every chip in full for tooltips and screen readers (#2163)', () => {
    const markup = tl.phaseTimelineHtml([
      { name: 'Ramp up', seconds: 4 }, { name: '', seconds: 12 },
      { name: 'Brew', seconds: 0, sub: 'Skip' },
    ], 0, OPTS);
    expect(markup).toContain('title="1. Ramp up, 4 s" aria-label="1. Ramp up, 4 s"');
    expect(markup).toContain('title="Phase 2, 12 s" aria-label="Phase 2, 12 s"');
    expect(markup).toContain('title="3. Brew, Skip"');
    expect(tl.phaseTimelineHtml([{ name: '"x"', seconds: 5 }], 0, OPTS)).toContain('title="1. &quot;x&quot;, 5 s"');
  });

  it('shows the phase number when the chip is too narrow for the name (#2163)', () => {
    const markup = tl.phaseTimelineHtml([{ name: 'Ramp up', seconds: 4 }], 0, OPTS);
    expect(markup).toContain('<span class="phase-timeline-num" aria-hidden="true">1</span><span class="phase-timeline-name">Ramp up</span>');
    const css = readFileSync(join(import.meta.dirname, '..', 'public-src', 'style.css'), 'utf8');
    expect(css).toContain('overflow:hidden; container-type: inline-size; }');
    expect(css).toContain('.phase-timeline-num { display:none; }');
    expect(css).toContain('@container (max-width: 80px) { .phase-timeline-num { display:block; } .phase-timeline-name { display:none; } }');
  });
});

describe('phase panel pieces (#2154)', () => {
  it('heads the selected phase with its position', () => {
    expect(tl.phaseHeadHtml(2, 4)).toBe(`<h4 class="section-title pe-phase-head">${t('pe_phase_of', 3, 4)}</h4>`);
    expect(t('pe_phase_of', 3, 4)).toBe('Phase 3 of 4');
  });

  it('folds the stop conditions, open only when asked', () => {
    const closed = tl.stopsFoldHtml('<p>x</p>' as Parameters<typeof tl.stopsFoldHtml>[0], false);
    expect(closed).toContain('<details class="pe-stops"><summary class="section-title pe-stops-summary">');
    expect(closed).toContain(t('gm_stop_conditions'));
    expect(closed).toContain('<p>x</p></details>');
    expect(tl.stopsFoldHtml('' as Parameters<typeof tl.stopsFoldHtml>[0], true)).toContain('<details class="pe-stops" open>');
  });

  it('gives the remove button the danger variant and the editor action', () => {
    const button = tl.removePhaseButtonHtml('drop-phase', 2);
    expect(button).toContain('class="btn btn--danger pe-remove-phase" data-action="drop-phase" data-idx="2"');
    expect(button).toContain(t('gm_remove_phase_title'));
  });

  it('titles the recipe rows', () => {
    expect(tl.recipeTitleHtml()).toBe(`<h4 class="section-title">${t('pe_recipe')}</h4>`);
    expect(t('pe_recipe')).toBe('Recipe');
  });
});
