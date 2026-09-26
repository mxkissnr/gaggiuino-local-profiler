import { describe, it, expect, beforeEach } from 'vitest';

// Same module-load stubbing as annotation-basket-puckscreen-save.test.js —
// annotation.js imports state.js, which reads localStorage/navigator at
// module load time.
// vitest's node environment has no browser globals; stub them through a loose
// view of globalThis (the same bridge test/annotation-basket-puckscreen-save.ts
// uses) so the minimal fakes need not satisfy the full Storage/Navigator shapes.
const g = globalThis as unknown as Record<string, unknown>;
g.localStorage ??= { getItem: () => null, setItem: () => {} };
g.navigator    ??= { language: 'en-US' };

const { S } = await import('../public-src/state/index.js');
const { _applyShotDefaults } = await import('../public-src/views/shots/annotation.js');

beforeEach(() => {
  S.shotDefaults = null;
});

describe('_applyShotDefaults (#654)', () => {
  it('returns the annotation untouched when no defaults are configured', () => {
    const ann = {};
    expect(_applyShotDefaults(ann)).toBe(ann);
  });

  it('merges configured defaults into a brand-new (empty) annotation', () => {
    S.shotDefaults = {
      drinkType: 'espresso', coffee: 'Kenya AA', beanId: 7,
      basketId: 3, puckScreenId: 5, grinder: 'Niche Zero', dose: 18.5,
    };
    expect(_applyShotDefaults({})).toEqual({
      drinkType: 'espresso', coffee: 'Kenya AA', beanId: 7,
      basketId: 3, puckScreenId: 5, grinder: 'Niche Zero', dose: 18.5,
    });
  });

  it('never overrides an already-annotated shot, even a partially-annotated one', () => {
    S.shotDefaults = { drinkType: 'espresso', coffee: 'Kenya AA', beanId: 7, basketId: 3, puckScreenId: 5, grinder: 'Niche Zero', dose: 18.5 };
    const existing = { notes: 'great shot' };
    expect(_applyShotDefaults(existing)).toBe(existing);
  });

  it('falls back to null/empty for fields with no configured default', () => {
    S.shotDefaults = { drinkType: null, coffee: null, beanId: null, basketId: null, puckScreenId: null, grinder: '', dose: null };
    expect(_applyShotDefaults({})).toEqual({
      drinkType: null, coffee: null, beanId: null,
      basketId: null, puckScreenId: null, grinder: '', dose: null,
    });
  });

  it('is a no-op (returns the same empty ann) when defaults have never loaded', () => {
    const ann = {};
    expect(_applyShotDefaults(ann)).toBe(ann);
  });
});
