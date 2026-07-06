import { describe, it, expect } from 'vitest';
import { FLAVOR_WHEEL, FLAVOR_ALIASES } from '../public-src/flavor-data.js';
import { matchFlavors, normalizeFlavor } from '../public-src/flavor-match.js';

function collectIds(nodes, seen = new Set()) {
  for (const n of nodes) {
    seen.add(n.id);
    if (n.children) collectIds(n.children, seen);
  }
  return seen;
}

describe('FLAVOR_WHEEL structure', () => {
  const ids = collectIds(FLAVOR_WHEEL);

  it('has unique ids across the whole hierarchy', () => {
    const all = [];
    (function walk(nodes) { for (const n of nodes) { all.push(n.id); if (n.children) walk(n.children); } })(FLAVOR_WHEEL);
    expect(new Set(all).size).toBe(all.length);
  });

  it('every node has both de and en labels', () => {
    (function walk(nodes) {
      for (const n of nodes) {
        expect(n.de, `de label for ${n.id}`).toBeTruthy();
        expect(n.en, `en label for ${n.id}`).toBeTruthy();
        if (n.children) walk(n.children);
      }
    })(FLAVOR_WHEEL);
  });

  it('every alias points at an existing node id', () => {
    for (const [alias, target] of Object.entries(FLAVOR_ALIASES)) {
      expect(ids.has(target), `alias "${alias}" -> "${target}"`).toBe(true);
    }
  });

  it('has 9 top-level categories', () => {
    expect(FLAVOR_WHEEL).toHaveLength(9);
  });
});

describe('normalizeFlavor', () => {
  it('lowercases and strips diacritics', () => {
    expect(normalizeFlavor('Äthiopien')).toBe('athiopien');
    expect(normalizeFlavor('  Aprikose  ')).toBe('aprikose');
  });
});

describe('matchFlavors', () => {
  it('matches an exact German label', () => {
    const { matched, unmatched } = matchFlavors(['Kirsche']);
    expect(matched.has('cherry')).toBe(true);
    expect(unmatched).toEqual([]);
  });

  it('matches an exact English label', () => {
    const { matched } = matchFlavors(['Hazelnut']);
    expect(matched.has('hazelnut')).toBe(true);
  });

  it('matches via the alias table (compound/colloquial German terms)', () => {
    expect(matchFlavors(['Zartbitterschokolade']).matched.has('dark_chocolate')).toBe(true);
    expect(matchFlavors(['Vollmilchschokolade']).matched.has('chocolate')).toBe(true);
    expect(matchFlavors(['Nougat']).matched.has('hazelnut')).toBe(true);
  });

  it('matches via word-boundary containment ("getrocknete Aprikose" → apricot)', () => {
    const { matched } = matchFlavors(['getrocknete Aprikose']);
    expect(matched.has('apricot')).toBe(true);
  });

  it('does not falsely match short substrings across word boundaries', () => {
    // "tee" should not match inside an unrelated compound word
    const { matched, unmatched } = matchFlavors(['Steamed Milk']);
    expect(matched.has('black_tea')).toBe(false);
    expect(unmatched).toEqual(['Steamed Milk']);
  });

  it('is diacritics-insensitive (ASCII-typed "Zitronensaure" still matches "Zitronensäure")', () => {
    expect(matchFlavors(['Zitronensaure']).matched.has('citric_acid')).toBe(true);
    expect(matchFlavors(['Karamell']).matched.has('caramelized')).toBe(true);
  });

  it('lists genuinely unmatched flavors', () => {
    const { matched, unmatched } = matchFlavors(['Mondgestein', 'Kirsche']);
    expect(unmatched).toEqual(['Mondgestein']);
    expect(matched.has('cherry')).toBe(true);
  });

  it('handles empty input', () => {
    expect(matchFlavors([])).toEqual({ matched: new Set(), unmatched: [] });
    expect(matchFlavors(undefined).matched.size).toBe(0);
  });
});
