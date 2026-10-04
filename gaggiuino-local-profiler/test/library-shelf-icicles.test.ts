import { describe, it, expect, beforeEach } from 'vitest';

// shelf.js's import chain (bags.js -> views/library.js -> state/i18n) reads
// localStorage/navigator at module load time — stub the minimum browser
// globals so the module graph can be imported under vitest's node
// environment (same pattern as test/library-shelf-classify.test.ts).
const g = globalThis as unknown as Record<string, unknown>;
g.localStorage ??= { getItem: () => null, setItem: () => {} };
g.navigator ??= { language: 'en-US' };

interface IcicleModule {
  icicleSvg: (frozenG: number, seed: number) => string;
  renderShelfTile: (b: unknown, opts: { muted: boolean }) => string;
  renderShelfRow: (b: unknown, opts: { muted: boolean }) => string;
}
const { icicleSvg, renderShelfTile, renderShelfRow } =
  (await import('../public-src/views/library/shelf.js')) as unknown as IcicleModule;

const { S } = (await import('../public-src/state/index.js')) as unknown as {
  S: { currentLang: string };
};

// The deepest y across every <path d="..."> in the SVG — the longest icicle
// tip, so it is what grows with the frozen grams.
function maxPathY(svg: string): number {
  let max = 0;
  for (const m of svg.matchAll(/d="([^"]+)"/g)) {
    const tokens = (m[1] ?? '').match(/[A-Za-z]|-?\d+(?:\.\d+)?/g) ?? [];
    let nums: number[] = [];
    const flush = (): void => {
      for (let i = 1; i < nums.length; i += 2) max = Math.max(max, nums[i] ?? 0);
      nums = [];
    };
    for (const tk of tokens) {
      if (/[A-Za-z]/.test(tk)) flush();
      else nums.push(parseFloat(tk));
    }
    flush();
  }
  return max;
}

function bean(over: Record<string, unknown>): Record<string, unknown> {
  return { id: 1, name: 'Bean', bags: [], ...over };
}

describe('icicleSvg (#1350 shelf ice)', () => {
  it('is deterministic for the same bean seed', () => {
    expect(icicleSvg(180, 42)).toBe(icicleSvg(180, 42));
  });

  it('grows longer icicles the more is frozen', () => {
    expect(maxPathY(icicleSvg(250, 7))).toBeGreaterThan(maxPathY(icicleSvg(20, 7)));
  });

  it('names the gradient per seed so tiles never share one', () => {
    const a = icicleSvg(100, 1);
    const b = icicleSvg(100, 2);
    const id = (s: string): string | undefined => s.match(/linearGradient id="([^"]+)"/)?.[1];
    expect(id(a)).toBeTruthy();
    expect(id(a)).not.toBe(id(b));
    expect(a).toContain('url(#' + (id(a) ?? '') + ')');
  });

  it('draws 9-11 tapered icicles, a frost rim and one falling drop', () => {
    const svg = icicleSvg(120, 5);
    const icicles = (svg.match(/fill="url\(#/g) ?? []).length;
    expect(icicles).toBeGreaterThanOrEqual(9);
    expect(icicles).toBeLessThanOrEqual(11);
    expect(svg).toContain('lib-shelf-frost');
    expect(svg).toContain('class="lib-shelf-icicle-drop"');
    expect(svg).toContain('preserveAspectRatio="none"');
  });
});

describe('frozen shelf tile (#1350)', () => {
  beforeEach(() => { S.currentLang = 'en'; });

  it('hangs icicles only on a bean with frozen grams', () => {
    const frozen = bean({
      id: 9,
      bags: [{
        id: 1, stock_g: 250, consumedG: 100, remainingG: 100, current: true,
        frozenPortions: [{ id: 1, frozenAt: 1, portionCount: 4, portionWeight_g: 20, remainingCount: 2 }],
      }],
    });
    const none = bean({ id: 10, bags: [] });
    expect(renderShelfTile(frozen, { muted: false })).toContain('lib-shelf-icicles');
    expect(renderShelfTile(frozen, { muted: false })).toContain('has-icicles');
    expect(renderShelfTile(none, { muted: false })).not.toContain('lib-shelf-icicles');
  });

  it('drops the open badge from the tile but keeps it on the list row', () => {
    const b = bean({
      id: 11,
      name: 'Red Brick',
      roaster: 'Square Mile',
      bags: [{ id: 1, stock_g: 250, consumedG: 100, remainingG: 150, current: true }],
    });
    const tile = renderShelfTile(b, { muted: false });
    expect(tile).not.toContain('lib-shelf-open-badge');
    // The badge's word is preserved in the tile's accessible name.
    expect(tile).toContain('aria-label="Red Brick, Square Mile, open, 150 g"');
    expect(renderShelfRow(b, { muted: false })).toContain('lib-shelf-open-badge');
  });
});
