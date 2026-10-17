import { describe, it, expect, beforeEach, vi } from 'vitest';

// #1626: every href built from stored or fetched data goes through
// safeHttpUrl, so a javascript:/data: value never becomes a clickable link.
// One case per sink: the recipe source link, the machine firmware changelog
// link and the app update banner's changelog link. No DOM library is used,
// so each sink gets the few fake elements it touches.

const mock = vi.hoisted(() => ({ version: {} }));

vi.mock('../public-src/api/system.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../public-src/api/system.js')>()),
  getVersion: vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve(mock.version) })),
}));

interface FakeEl {
  id?: string;
  innerHTML: string;
  textContent: string;
  className: string;
  title: string;
  href: string;
  style: Record<string, string>;
  children: FakeEl[];
  append: (...els: FakeEl[]) => void;
  addEventListener: () => void;
  removeAttribute: () => void;
  insertAdjacentElement: (_pos: string, el: FakeEl) => void;
  querySelector: (sel: string) => FakeEl | null;
  remove: () => void;
}

function fakeEl(): FakeEl {
  const el: FakeEl = {
    innerHTML: '', textContent: '', className: '', title: '', href: '', style: {}, children: [],
    append: (...els) => { el.children.push(...els); },
    addEventListener: () => {},
    removeAttribute: () => {},
    insertAdjacentElement: (_pos, child) => { el.children.push(child); },
    querySelector: () => null,
    remove: () => {},
  };
  return el;
}

let recipeTarget = fakeEl();
let body = fakeEl();
const g = globalThis as unknown as Record<string, unknown>;
g.localStorage ??= { getItem: () => null, setItem: () => {} };
g.document = {
  getElementById: (id: string): FakeEl | null => (id === 'recipeListUI' ? recipeTarget : null),
  createElement: (): FakeEl => fakeEl(),
  get body(): FakeEl { return body; },
};

const { S } = await import('../public-src/state/index.js');
const { renderRecipeList } = await import('../public-src/views/library/recipes.js');
const { renderFirmwareRow } = await import('../public-src/components/machines-settings.js');
const { checkForUpdate } = await import('../public-src/components/update-check.js');

describe('safeHttpUrl on every link sink (#1626)', () => {
  describe('recipe source link', () => {
    beforeEach(() => { recipeTarget = fakeEl(); S.shots = []; });

    it('links an http(s) source', () => {
      S.coffeeLibrary = { beans: [], grinders: [], recipes: [{ id: 1, name: 'R', sourceUrl: 'https://example.com/r' }] };
      renderRecipeList();
      expect(recipeTarget.innerHTML).toContain('href="https://example.com/r"');
    });

    it('renders no link for a javascript: source', () => {
      S.coffeeLibrary = { beans: [], grinders: [], recipes: [{ id: 1, name: 'R', sourceUrl: 'javascript:alert(1)' }] };
      renderRecipeList();
      expect(recipeTarget.innerHTML).not.toContain('javascript:');
      expect(recipeTarget.innerHTML).not.toContain('lib-item-source');
    });
  });

  describe('firmware changelog link', () => {
    function row(): { row: FakeEl; link: FakeEl } {
      const badge = fakeEl();
      const msg = fakeEl();
      const link = fakeEl();
      const panel = fakeEl();
      panel.querySelector = (sel) => (sel === '.machine-firmware-changelog-link' ? link : sel === '.machine-firmware-update-msg' ? msg : null);
      const r = fakeEl();
      r.querySelector = (sel) => (sel === '.machine-row-firmware-badge' ? badge : sel === '.machine-row-firmware-panel' ? panel : null);
      return { row: r, link };
    }

    it('keeps an https release URL', () => {
      const { row: r, link } = row();
      renderFirmwareRow(1, r as unknown as HTMLElement, { installed: '1.0', latest: '1.1', updateAvailable: true, releaseUrl: 'https://example.com/rel' });
      expect(link.href).toBe('https://example.com/rel');
    });

    it('falls back to # for a javascript: release URL', () => {
      const { row: r, link } = row();
      renderFirmwareRow(1, r as unknown as HTMLElement, { installed: '1.0', latest: '1.1', updateAvailable: true, releaseUrl: 'javascript:alert(1)' });
      expect(link.href).toBe('#');
    });
  });

  describe('update banner changelog link', () => {
    beforeEach(() => { body = fakeEl(); });

    function banner(): FakeEl {
      expect(body.children).toHaveLength(1);
      return body.children[0]!;
    }

    it('links an https release URL', async () => {
      mock.version = { update_available: true, current: '1', latest: '2', release_url: 'https://example.com/rel' };
      await checkForUpdate();
      expect(banner().children.some(c => c.href === 'https://example.com/rel')).toBe(true);
    });

    it('shows no changelog link for a javascript: release URL', async () => {
      mock.version = { update_available: true, current: '1', latest: '2', release_url: 'javascript:alert(1)' };
      await checkForUpdate();
      expect(banner().children).toHaveLength(2);
      // Neither remaining child (message, close button) carries any href.
      expect(banner().children.every(c => c.href === '')).toBe(true);
    });
  });
});
