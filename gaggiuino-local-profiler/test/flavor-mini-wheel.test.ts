import { describe, it, expect } from 'vitest';
import { FLAVOR_WHEEL } from '../public-src/flavor-data.js';
import type { FlavorNode } from '../public-src/flavor-data.js';
import { miniWheelSegments, miniWheelSvg, flavorChipsHtml } from '../public-src/components/flavor-mini-wheel.js';

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
