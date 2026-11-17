// #2093 slice 4: the shot list sort is a group of shared .chip buttons whose
// only pressed state is aria-pressed. The node test env has no DOM, so the four
// chips and the #shots container are faked; every classList method throws, which
// proves setSortMode() never touches a class.
import { describe, it, expect, beforeEach } from 'vitest';

const g = globalThis as unknown as Record<string, unknown>;
g.localStorage ??= { getItem: () => null, setItem: () => {} };
g.navigator ??= { language: 'en-US' };

const { S } = await import('../public-src/state/index.js');
const { setSortMode } = await import('../public-src/components/sidebar.js');

interface FakeChip {
  id: string;
  innerHTML: string;
  attrs: Record<string, string>;
  setAttribute(name: string, value: string): void;
  getAttribute(name: string): string | null;
  classList: { add(): never; remove(): never; toggle(): never };
}

const SORT_IDS = ['sortNewest', 'sortScore', 'sortRating', 'sortDur'] as const;

const throwing = (): never => { throw new Error('setSortMode must not touch a class'); };

function fakeChip(id: string): FakeChip {
  return {
    id,
    innerHTML: '',
    attrs: {},
    setAttribute(name: string, value: string): void { this.attrs[name] = value; },
    getAttribute(name: string): string | null { return this.attrs[name] ?? null; },
    classList: { add: throwing, remove: throwing, toggle: throwing },
  };
}

function fakeDocument(): Record<string, FakeChip> {
  const chips: Record<string, FakeChip> = {};
  for (const id of SORT_IDS) chips[id] = fakeChip(id);
  const shots = { innerHTML: '', appendChild() {} };
  g.document = {
    getElementById: (id: string): unknown => chips[id] ?? (id === 'shots' ? shots : null),
    querySelectorAll: (): unknown[] => [],
    querySelector: (): null => null,
  };
  return chips;
}

describe('#2093 shot list sort chips', () => {
  let chips: Record<string, FakeChip>;

  beforeEach(() => {
    S.shots = [];
    S.currentSort = 'newest';
    S.sortAsc = false;
    chips = fakeDocument();
  });

  it('presses only the chosen sort chip', () => {
    setSortMode('score');
    expect(chips.sortScore?.getAttribute('aria-pressed')).toBe('true');
    expect(chips.sortNewest?.getAttribute('aria-pressed')).toBe('false');
    expect(chips.sortRating?.getAttribute('aria-pressed')).toBe('false');
    expect(chips.sortDur?.getAttribute('aria-pressed')).toBe('false');
    expect(chips.sortScore?.innerHTML.endsWith('↓')).toBe(true);
  });

  it('keeps the chip pressed and flips the arrow when the same sort is picked again', () => {
    setSortMode('score');
    setSortMode('score');
    expect(chips.sortScore?.getAttribute('aria-pressed')).toBe('true');
    expect(chips.sortScore?.innerHTML.endsWith('↑')).toBe(true);
  });

  it('moves the pressed state to another sort', () => {
    setSortMode('score');
    setSortMode('duration');
    expect(chips.sortDur?.getAttribute('aria-pressed')).toBe('true');
    expect(chips.sortScore?.getAttribute('aria-pressed')).toBe('false');
  });
});
