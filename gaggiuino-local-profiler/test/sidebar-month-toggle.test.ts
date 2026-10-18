import { describe, it, expect, beforeEach, vi } from 'vitest';

// sidebar.ts's import chain touches state/index.ts/i18n.ts, which read
// localStorage/navigator at module load time — stub the minimum browser
// globals so the module graph can be imported under vitest's node
// environment (same pattern as test/library-profile-editor.test.ts).
// vitest's node environment has no browser globals; stub them through a loose
// view of globalThis (the same bridge the other typed fixtures use).
const g = globalThis as unknown as Record<string, unknown>;
g.localStorage ??= { getItem: () => null, setItem: () => {} };
g.navigator    ??= { language: 'en-US' };

const { S } = await import('../public-src/state/index.js');
const { toggleMonthGroup } = await import('../public-src/components/sidebar.js');

// toggleMonthGroup() reads/writes exactly two DOM nodes by id/selector —
// stub only those, same "fake minimal document" approach as
// test/library-profile-editor.test.ts's fakeRow(), rather than pulling in
// a full jsdom/happy-dom dependency this repo doesn't otherwise use.
function fakeMonthGroup(key: string, label: string, expanded: boolean) {
  const body = { id: `monthGroup-${key}`, style: { display: expanded ? '' : 'none' } };
  const header = {
    dataset: { action: 'toggle-month-group', id: key },
    textContent: `${expanded ? '▾' : '▸'} ${label}`,
  };
  g.document = {
    getElementById: (id: string) => (id === body.id ? body : undefined),
    querySelector: (sel: string) => (sel === `[data-action="toggle-month-group"][data-id="${key}"]` ? header : undefined),
  };
  return { body, header };
}

describe('toggleMonthGroup (#439 month-accordion restore)', () => {
  beforeEach(() => { S._expandedMonths = new Set(); });

  it('expands a collapsed group: shows the body, flips the chevron, tracks the key', () => {
    const { body, header } = fakeMonthGroup('2026-06', 'Juni 2026', false);
    toggleMonthGroup('2026-06');
    expect(body.style.display).toBe('');
    expect(header.textContent).toBe('▾ Juni 2026');
    expect(S._expandedMonths.has('2026-06')).toBe(true);
  });

  it('collapses an expanded group back: hides the body, flips the chevron back, drops the key', () => {
    const { body, header } = fakeMonthGroup('2026-06', 'Juni 2026', true);
    S._expandedMonths.add('2026-06');
    toggleMonthGroup('2026-06');
    expect(body.style.display).toBe('none');
    expect(header.textContent).toBe('▸ Juni 2026');
    expect(S._expandedMonths.has('2026-06')).toBe(false);
  });

  it('two clicks return to the original collapsed state', () => {
    const { body } = fakeMonthGroup('2026-05', 'Mai 2026', false);
    toggleMonthGroup('2026-05');
    toggleMonthGroup('2026-05');
    expect(body.style.display).toBe('none');
    expect(S._expandedMonths.has('2026-05')).toBe(false);
  });

  it('is a defensive no-op when the body element is missing', () => {
    g.document = { getElementById: () => undefined, querySelector: () => undefined };
    expect(() => toggleMonthGroup('2099-01')).not.toThrow();
    expect(S._expandedMonths.has('2099-01')).toBe(false);
  });

  it('keeps expanded state in S._expandedMonths for the session, but a fresh module load starts empty', async () => {
    fakeMonthGroup('2026-04', 'April 2026', false);
    toggleMonthGroup('2026-04');
    // A subsequent renderSidebar() call reads S._expandedMonths.has(key) to
    // decide the initial collapse state — this simulates that check after
    // the shot list re-renders within the same session.
    expect(S._expandedMonths.has('2026-04')).toBe(true);

    // A fresh page load re-imports state/index.ts from scratch. The accordion
    // set is in-memory only, so the new instance must start empty even though
    // the previous one had the key. Point localStorage at a value a naive
    // "restore from storage" implementation would pick up, so this exercises
    // the not-restored behaviour instead of constructing an empty Set inline.
    g.localStorage = {
      getItem: (k: string) => (k === 'glp_expandedMonths' ? JSON.stringify(['2026-04']) : null),
      setItem: () => {},
    };
    vi.resetModules();
    const fresh = await import('../public-src/state/index.js');
    expect(fresh.S._expandedMonths.has('2026-04')).toBe(false);
  });
});
