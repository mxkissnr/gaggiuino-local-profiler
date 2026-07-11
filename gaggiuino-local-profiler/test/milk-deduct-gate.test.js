import { describe, it, expect, beforeEach, vi } from 'vitest';

// annotation.js imports state.js, which reads localStorage/navigator at
// module load time — stub the minimum browser globals needed so the module
// graph can be imported under vitest's node environment.
globalThis.localStorage ??= { getItem: () => null, setItem: () => {} };
globalThis.navigator    ??= { language: 'en-US' };

const { S } = await import('../public-src/state.js');
const apiModule = await import('../public-src/api.js');
const fetchSpy = vi.spyOn(apiModule, 'apiFetch').mockResolvedValue({
    ok: true, json: async () => ({ id: 1, stockMl: 850 }),
});
const { _maybeDeductMilk } = await import('../public-src/views/shots/annotation.js');

const MENU_ITEM = { id: 'm_latte', name: 'Latte', milkMl: 150 };

beforeEach(() => {
    fetchSpy.mockClear();
    S.drinkMenu  = [MENU_ITEM];
    S.milkTypes  = [{ id: 1, name: 'Hafermilch', stockMl: 1000 }];
});

describe('_maybeDeductMilk', () => {
    it('deducts when a drink with milk is newly assigned to a shot with no prior annotation', () => {
        _maybeDeductMilk(undefined, { drinkType: 'm_latte', milkType: 1 });
        expect(fetchSpy).toHaveBeenCalledWith('api/library/milk/1/deduct', expect.objectContaining({
            method: 'POST', body: JSON.stringify({ ml: 150 }),
        }));
    });

    it('deducts when the drink changes but the milk type stays the same (regression: previous gate only checked milkType changing)', () => {
        const shot = { annotation: { drinkType: 'm_old', milkType: 1 } };
        _maybeDeductMilk(shot, { drinkType: 'm_latte', milkType: 1 });
        expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    it('deducts when the milk type changes but the drink stays the same', () => {
        const shot = { annotation: { drinkType: 'm_latte', milkType: 2 } };
        _maybeDeductMilk(shot, { drinkType: 'm_latte', milkType: 1 });
        expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    it('does not double-deduct when re-saving the exact same drink+milk combo', () => {
        const shot = { annotation: { drinkType: 'm_latte', milkType: 1 } };
        _maybeDeductMilk(shot, { drinkType: 'm_latte', milkType: 1 });
        expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('does nothing when no milk type is selected', () => {
        _maybeDeductMilk(undefined, { drinkType: 'm_latte', milkType: null });
        expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('does nothing when the assigned drink has no milk configured', () => {
        S.drinkMenu = [{ id: 'm_espresso', name: 'Espresso', milkMl: null }];
        _maybeDeductMilk(undefined, { drinkType: 'm_espresso', milkType: 1 });
        expect(fetchSpy).not.toHaveBeenCalled();
    });
});
