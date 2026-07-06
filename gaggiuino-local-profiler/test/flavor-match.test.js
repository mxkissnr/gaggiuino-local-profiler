import { describe, it, expect } from 'vitest';
import { FLAVOR_WHEEL, FLAVOR_ALIASES } from '../public-src/flavor-data.js';
import { matchFlavors, normalizeFlavor, hslFor, labelColorFor, markLit, parentIdOf, nodeById, pathToNode, findAutoZoomTarget } from '../public-src/flavor-match.js';

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

  it('every node has a non-empty label in all 6 UI languages', () => {
    (function walk(nodes) {
      for (const n of nodes) {
        for (const lang of ['de', 'en', 'it', 'fr', 'es', 'nl']) {
          expect(n[lang], `${lang} label for ${n.id}`).toBeTruthy();
        }
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

  it('matches exact labels in the 4 newly-translated languages regardless of wheel display language', () => {
    expect(matchFlavors(['Nocciola']).matched.has('hazelnut')).toBe(true); // Italian
    expect(matchFlavors(['Cerise']).matched.has('cherry')).toBe(true); // French
    expect(matchFlavors(['Miel']).matched.has('honey')).toBe(true); // Spanish (and French — same word)
    expect(matchFlavors(['Kaneel']).matched.has('cinnamon')).toBe(true); // Dutch
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

describe('labelColorFor', () => {
  it('picks dark text once the segment background gets light enough to need it, regardless of match state', () => {
    // depth 1: hslFor lightness = 52% -> white still reads fine
    expect(labelColorFor(1)).toBe('#fff');
    // depth 3: hslFor lightness capped at 72% -> light pastel needs dark text
    expect(labelColorFor(3)).toBe('#18181b');
  });
});

describe('hslFor', () => {
  it('caps lightness at 72% regardless of depth', () => {
    expect(hslFor(0, 1)).toBe('hsl(0, 62%, 52%)');
    expect(hslFor(0, 3)).toBe('hsl(0, 62%, 72%)');
    expect(hslFor(0, 10)).toBe('hsl(0, 62%, 72%)'); // would be 142% uncapped
  });

  it('stays fully saturated regardless of match state — the wheel no longer grays out unmatched segments', () => {
    expect(hslFor(120, 2)).toBe('hsl(120, 62%, 62%)');
  });
});

describe('parentIdOf / pathToNode / nodeById', () => {
  it('resolves a leaf\'s ancestor chain', () => {
    expect(parentIdOf('cherry')).toBe('other_fruit');
    expect(parentIdOf('other_fruit')).toBe('fruity');
    expect(pathToNode('cherry')).toEqual(['fruity', 'other_fruit', 'cherry']);
  });

  it('has no parent for a top-level category', () => {
    expect(parentIdOf('fruity')).toBe(null);
    expect(pathToNode('fruity')).toEqual(['fruity']);
  });

  it('looks up a node by id regardless of depth', () => {
    expect(nodeById('cherry').en).toBe('Cherry');
    expect(nodeById('fruity').en).toBe('Fruity');
    expect(nodeById('does_not_exist')).toBe(null);
  });
});

describe('findAutoZoomTarget', () => {
  // markLit mutates FLAVOR_WHEEL's own nodes; each call fully re-derives
  // _lit from the matched set passed in, so tests don't need manual reset.
  function litCategories(flavors) {
    const { matched } = matchFlavors(flavors);
    FLAVOR_WHEEL.forEach(cat => markLit(cat, matched));
    return FLAVOR_WHEEL;
  }

  it('zooms to the deepest node that still has children (not the leaf itself — a sunburst can\'t zoom into an empty leaf)', () => {
    expect(findAutoZoomTarget(litCategories(['Kirsche']))).toBe('other_fruit');
  });

  it('stops at the lowest branch containing every match (two leaves, same subcategory chain diverges)', () => {
    // cherry -> fruity>other_fruit>cherry, raspberry -> fruity>berry>raspberry:
    // both under "fruity" but in different depth-2 branches.
    expect(findAutoZoomTarget(litCategories(['Kirsche', 'Himbeere']))).toBe('fruity');
  });

  it('returns null when matches span more than one top-level category', () => {
    // cherry -> fruity, hazelnut -> nutty_cocoa
    expect(findAutoZoomTarget(litCategories(['Kirsche', 'Haselnuss']))).toBe(null);
  });

  it('returns null when nothing matched', () => {
    expect(findAutoZoomTarget(litCategories([]))).toBe(null);
  });
});
