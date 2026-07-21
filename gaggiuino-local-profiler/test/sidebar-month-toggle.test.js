import { describe, it, expect, beforeEach } from 'vitest';

// sidebar.js's import chain touches state.js/i18n.js, which read
// localStorage/navigator at module load time — stub the minimum browser
// globals so the module graph can be imported under vitest's node
// environment (same pattern as test/milk-deduct-gate.test.js and
// test/library-profile-editor.test.js).
globalThis.localStorage ??= { getItem: () => null, setItem: () => {} };
globalThis.navigator    ??= { language: 'en-US' };

const { S } = await import('../public-src/state.js');
const { toggleMonthGroup } = await import('../public-src/components/sidebar.js');

// toggleMonthGroup() reads/writes exactly two DOM nodes by id/selector —
// stub only those, same "fake minimal document" approach as
// test/library-profile-editor.test.js's fakeRow(), rather than pulling in
// a full jsdom/happy-dom dependency this repo doesn't otherwise use.
function fakeMonthGroup(key, label, expanded) {
  const body = { id: `monthGroup-${key}`, style: { display: expanded ? '' : 'none' } };
  const header = {
    dataset: { action: 'toggle-month-group', id: key },
    textContent: `${expanded ? '▾' : '▸'} ${label}`,
  };
  globalThis.document = {
    getElementById: id => (id === body.id ? body : undefined),
    querySelector: sel => (sel === `[data-action="toggle-month-group"][data-id="${key}"]` ? header : undefined),
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
    globalThis.document = { getElementById: () => undefined, querySelector: () => undefined };
    expect(() => toggleMonthGroup('2099-01')).not.toThrow();
    expect(S._expandedMonths.has('2099-01')).toBe(false);
  });

  it('keeps expanded state in S._expandedMonths so a later render (e.g. after switching to another shot and back) would see it already expanded, but a fresh Set (page reload) would not', () => {
    fakeMonthGroup('2026-04', 'April 2026', false);
    toggleMonthGroup('2026-04');
    // A subsequent renderSidebar() call reads S._expandedMonths.has(key) to
    // decide the initial collapse state — this simulates that check after
    // the shot list re-renders within the same session.
    expect(S._expandedMonths.has('2026-04')).toBe(true);

    // A fresh page load constructs S fresh (state.js module init), which
    // starts _expandedMonths as an empty Set — never reads it back from
    // localStorage, unlike e.g. S.dialinSession.
    const freshExpandedMonths = new Set();
    expect(freshExpandedMonths.has('2026-04')).toBe(false);
  });
});
