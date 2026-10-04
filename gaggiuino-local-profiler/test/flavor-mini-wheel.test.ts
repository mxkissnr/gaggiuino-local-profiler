import { describe, it, expect, vi, beforeEach } from 'vitest';
import { FLAVOR_WHEEL } from '../public-src/flavor-data.js';
import type { FlavorNode } from '../public-src/flavor-data.js';
import {
  miniWheelSegments,
  miniWheelSvg,
  flavorChipsHtml,
  applySheetFlavorHighlight,
  highlightSheetFlavor,
  resetSheetFlavorHighlight,
} from '../public-src/components/flavor-mini-wheel.js';

function walkAll(nodes: FlavorNode[], visit: (node: FlavorNode) => void): void {
  for (const node of nodes) {
    visit(node);
    if (node.children) walkAll(node.children, visit);
  }
}

describe('miniWheelSegments', () => {
  it('covers the full circle on every ring', () => {
    const segments = miniWheelSegments(['Kirsche']);
    for (const depth of [1, 2, 3] as const) {
      const covered = segments
        .filter(s => s.depth === depth)
        .reduce((sum, s) => sum + (s.a1 - s.a0), 0);
      expect(covered, `depth ${depth} coverage`).toBeCloseTo(360, 6);
    }
  });

  it('lights a matched leaf and its ancestors, and nothing else', () => {
    const segments = miniWheelSegments(['Kirsche']);
    const lit = new Set(segments.filter(s => s.lit).map(s => s.id));
    expect(lit).toEqual(new Set(['fruity', 'other_fruit', 'cherry']));
  });

  it('leaves no _lit flags behind on FLAVOR_WHEEL', () => {
    miniWheelSegments(['Kirsche', 'Haselnuss']);
    walkAll(FLAVOR_WHEEL, node => expect(node._lit, node.id).toBeUndefined());
  });

  it('mutes the unmatched segments but keeps the lit ones in their real colour', () => {
    const segments = miniWheelSegments(['Kirsche']);
    const typed = segments as unknown as { id: string; color: string; lit: boolean }[];
    // The same node can back one segment per ring (a childless node extends to
    // the outer edge); every copy must agree.
    for (const id of new Set(typed.map(s => s.id))) {
      const copies = typed.filter(s => s.id === id);
      expect(new Set(copies.map(c => c.color)).size).toBe(1);
      expect(new Set(copies.map(c => c.lit)).size).toBe(1);
    }
  });
});

describe('miniWheelSvg', () => {
  it('renders one path per segment and sizes from the argument', () => {
    const flavors = ['Kirsche'];
    const segments = miniWheelSegments(flavors);
    const svg = miniWheelSvg(flavors, 168) as unknown as string;
    expect((svg.match(/<path /g) || []).length).toBe(segments.length);
    expect(svg).toContain('viewBox="-100 -100 200 200"');
    expect(svg).toContain('width="168"');
    expect(svg).toContain('data-node-id="cherry"');
  });

  // #1372: the lit segments get the large wheel's white outline, and must be
  // painted after the unlit ones so a neighbour sharing the ring edge cannot
  // cover that outline.
  it('marks lit paths with is-lit and draws them after the unlit paths', () => {
    const flavors = ['Kirsche'];
    const svg = miniWheelSvg(flavors, 168) as unknown as string;
    const flags = [...svg.matchAll(/class="lib-aroma-seg( is-lit)?"/g)].map(m => Boolean(m[1]));
    expect(flags.filter(Boolean).length).toBeGreaterThan(0);
    expect(flags.filter(f => !f).length).toBeGreaterThan(0);
    expect(flags.indexOf(true)).toBeGreaterThan(flags.lastIndexOf(false));
  });
});

describe('flavorChipsHtml', () => {
  it('turns a matched flavour into a highlight button and keeps unmatched ones static', () => {
    const markup = flavorChipsHtml(['Kirsche', 'Mondgestein']) as unknown as string;
    expect(markup).toContain('data-action="highlight-flavor"');
    expect(markup).toContain('data-flavor-node="cherry"');
    expect(markup).toContain('lib-aroma-chip');
    expect(markup).toContain('Mondgestein');
    expect(markup).toContain('flavor-chip-static');
    // The unmatched chip must not be a highlight button.
    expect(markup).not.toContain('data-flavor-node=""');
  });

  it('handles empty and non-array input', () => {
    expect(flavorChipsHtml([]) as unknown as string).toBe('');
    expect(flavorChipsHtml(undefined) as unknown as string).toBe('');
  });
});

// #1372: the pulse animation is applied only on a fresh tap, not when the
// stored highlight is re-applied after the sheet rebuilds its SVG.
class FakeClassList {
  private names = new Set<string>();
  add(name: string): void { this.names.add(name); }
  remove(name: string): void { this.names.delete(name); }
  toggle(name: string, on?: boolean): void { if (on) this.names.add(name); else this.names.delete(name); }
  contains(name: string): boolean { return this.names.has(name); }
}

class FakePath {
  classList = new FakeClassList();
  constructor(private readonly id: string) {}
  getAttribute(name: string): string | null { return name === 'data-node-id' ? this.id : null; }
}

class FakeSvg {
  classList = new FakeClassList();
  constructor(private readonly paths: FakePath[]) {}
  querySelectorAll(selector: string): FakePath[] { return selector === '.lib-aroma-seg' ? this.paths : []; }
}

class FakeRoot {
  constructor(private readonly svg: FakeSvg) {}
  querySelector(selector: string): FakeSvg | null { return selector === '.lib-aroma-svg' ? this.svg : null; }
}

function chipIn(root: FakeRoot): Element {
  return { closest: () => root } as unknown as Element;
}

describe('sheet highlight pulse (#1372)', () => {
  beforeEach(() => resetSheetFlavorHighlight());

  it('pulses only the tapped leaf path and clears it after the animation', () => {
    vi.useFakeTimers();
    const leaf = new FakePath('cherry');
    const ancestor = new FakePath('fruity');
    const root = new FakeRoot(new FakeSvg([ancestor, leaf]));
    highlightSheetFlavor('cherry', chipIn(root));
    expect(leaf.classList.contains('is-pulse')).toBe(true);
    expect(ancestor.classList.contains('is-pulse')).toBe(false);
    vi.advanceTimersByTime(500);
    expect(leaf.classList.contains('is-pulse')).toBe(false);
    vi.useRealTimers();
  });

  it('re-applying the highlight after a rebuild sets is-hl but not is-pulse', () => {
    vi.useFakeTimers();
    const first = new FakeRoot(new FakeSvg([new FakePath('cherry')]));
    highlightSheetFlavor('cherry', chipIn(first)); // establish the stored highlight
    vi.advanceTimersByTime(500);
    const leaf = new FakePath('cherry');
    const rebuilt = new FakeRoot(new FakeSvg([leaf]));
    applySheetFlavorHighlight(rebuilt as unknown as ParentNode);
    expect(leaf.classList.contains('is-hl')).toBe(true);
    expect(leaf.classList.contains('is-pulse')).toBe(false);
    vi.useRealTimers();
  });
});
