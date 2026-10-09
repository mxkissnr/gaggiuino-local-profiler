import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// shelf.js's import chain (bags.js -> views/library.js -> state/i18n) reads
// localStorage/navigator at module load time — stub the minimum browser
// globals so the module graph can be imported under vitest's node environment
// (same pattern as test/library-shelf-icicles.test.ts).
const g = globalThis as unknown as Record<string, unknown>;
g.localStorage ??= { getItem: () => null, setItem: () => {} };
g.navigator ??= { language: 'en-US' };

interface SlotModule {
  renderShelfTile: (b: unknown, opts: { muted: boolean }) => string;
}
const { renderShelfTile } =
  (await import('../public-src/views/library/shelf.js')) as unknown as SlotModule;

const { S } = (await import('../public-src/state/index.js')) as unknown as {
  S: { currentLang: string };
};

const __dirname = dirname(fileURLToPath(import.meta.url));
const CSS = readFileSync(join(__dirname, '../public-src/style.css'), 'utf8');

const VOID_TAGS = new Set(['img', 'br', 'hr', 'input', 'meta', 'link', 'source', 'track', 'wbr']);

// Every element that is a direct child of the tile button, in document order.
// Tracking tag depth keeps nested markup (the bag image, the icicle SVG) from
// being counted as tile rows.
function topLevelChildTags(tile: string): string[] {
  const inner = tile.slice(tile.indexOf('>') + 1, tile.lastIndexOf('</button>'));
  const out: string[] = [];
  let depth = 0;
  let i = 0;
  while (i < inner.length) {
    const lt = inner.indexOf('<', i);
    if (lt < 0) break;
    const gt = inner.indexOf('>', lt);
    if (gt < 0) break;
    const tag = inner.slice(lt, gt + 1);
    const name = (tag.match(/^<\/?\s*([a-zA-Z][\w-]*)/)?.[1] ?? '').toLowerCase();
    const selfClosing = tag.endsWith('/>') || VOID_TAGS.has(name);
    if (tag.startsWith('</')) {
      if (depth > 0) depth--;
    } else if (depth === 0) {
      out.push(name);
      if (!selfClosing) depth++;
    } else if (!selfClosing) {
      depth++;
    }
    i = gt + 1;
  }
  return out;
}

function bean(over: Record<string, unknown>): Record<string, unknown> {
  return { id: 1, name: 'Bean', bags: [], ...over };
}

describe('shelf tile subgrid slots (#1460)', () => {
  beforeEach(() => { S.currentLang = 'en'; });

  it('emits six direct children for a bean with roaster, stock and frozen portions', () => {
    const b = bean({
      id: 9,
      name: 'Red Brick',
      roaster: 'Square Mile',
      bags: [{
        id: 1, stock_g: 250, consumedG: 100, remainingG: 100, current: true,
        frozenPortions: [{ id: 1, frozenAt: 1, portionCount: 4, portionWeight_g: 20, remainingCount: 2 }],
      }],
    });
    const kids = topLevelChildTags(renderShelfTile(b, { muted: false }));
    expect(kids).toHaveLength(6);
    expect(kids.every(t => t === 'span')).toBe(true);
    expect(renderShelfTile(b, { muted: false })).not.toContain('lib-shelf-slot');
  });

  it('emits six direct children for a bean without roaster, stock or frozen portions', () => {
    const b = bean({ id: 10, name: 'Plain', bags: [] });
    const tile = renderShelfTile(b, { muted: false });
    const kids = topLevelChildTags(tile);
    expect(kids).toHaveLength(6);
    expect(kids.every(t => t === 'span')).toBe(true);
    // roaster, stock bar, stock line and frozen line become empty placeholders.
    expect((tile.match(/lib-shelf-slot/g) ?? []).length).toBe(4);
  });

  it('keeps the shelf tile on subgrid rows in the stylesheet', () => {
    const tile = CSS.match(/\.lib-shelf-tile\s*\{[^}]*\}/)?.[0] ?? '';
    expect(tile).toContain('grid-template-rows: subgrid');
    expect(CSS).not.toMatch(/\.lib-shelf-view-btn\s*\+\s*\.lib-shelf-view-btn\s*\{[^}]*border-left\s*:\s*none/);
  });
});
