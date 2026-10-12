import { describe, it, expect, beforeEach } from 'vitest';

// #1625 slice 5: a recipe card's average score must average only the scored
// shots instead of counting an unscored shot as 0. renderRecipeList() is the
// only place that badge is built; it writes into #recipeListUI, faked here.

const g = globalThis as unknown as Record<string, unknown>;
g.localStorage ??= { getItem: () => null, setItem: () => {} };
g.navigator ??= { language: 'en-US' };

interface FakeEl { innerHTML: string }
let target: FakeEl = { innerHTML: '' };
g.document = {
  getElementById: (id: string): FakeEl | null => (id === 'recipeListUI' ? target : null),
};

const { S } = await import('../public-src/state/index.js');
const { renderRecipeList } = await import('../public-src/views/library/recipes.js');

describe('recipe average score skips unscored shots (#1625)', () => {
  beforeEach(() => {
    target = { innerHTML: '' };
    S.coffeeLibrary = {
      beans: [], grinders: [],
      recipes: [{ id: 7, name: 'Test Recipe' }],
    } as unknown as typeof S.coffeeLibrary;
    S.shots = [
      { id: 1, timestamp: 1, score: 8,    annotation: { recipeId: 7 } },
      { id: 2, timestamp: 2, score: null, annotation: { recipeId: 7 } },
      { id: 3, timestamp: 3, score: 6,    annotation: { recipeId: 7 } },
    ] as unknown as typeof S.shots;
  });

  it('averages only the scored shots and keeps the total shot count', () => {
    renderRecipeList();

    // [8, null, 6] -> (8 + 6) / 2 = 7.0, and the badge still counts all three.
    expect(target.innerHTML).toContain('3 Shots');
    expect(target.innerHTML).toContain('Ø 7.0');
  });
});
