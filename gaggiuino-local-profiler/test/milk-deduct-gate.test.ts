import { describe, it, expect, beforeEach, vi } from 'vitest';

// annotation.js imports state.js, which reads localStorage/navigator at
// module load time — stub the minimum browser globals needed so the module
// graph can be imported under vitest's node environment.
const g = globalThis as unknown as Record<string, unknown>;
g.localStorage ??= { getItem: () => null, setItem: () => {} };
g.navigator    ??= { language: 'en-US' };

const { S } = await import('../public-src/state/index.js');
const apiModule = await import('../public-src/api/transport.js');
const fetchSpy = vi.spyOn(apiModule, 'apiFetch').mockResolvedValue({
    ok: true, json: () => Promise.resolve({ id: 1, stockMl: 850 }),
} as unknown as Response);
const { _maybeDeductMilk } = await import('../public-src/views/shots/annotation.js');

// annotation.ts keeps AnnotationShot/AnnotationPayload module-private; these
// aliases mirror them off the exported function's own parameter types, and the
// helpers build the minimal fixtures each test needs.
type DeductShotArg = NonNullable<Parameters<typeof _maybeDeductMilk>[0]>;
type DeductPayloadArg = Parameters<typeof _maybeDeductMilk>[1];
const shotWith = (annotation: DeductShotArg['annotation']): DeductShotArg => ({ id: 1, annotation });
const payloadOf = (drinkType: string, milkType: number | null): DeductPayloadArg =>
    ({ drinkType, milkType } as unknown as DeductPayloadArg);

const MENU_ITEM = { id: 'm_latte', name: 'Latte', milkMl: 150 };

beforeEach(() => {
    fetchSpy.mockClear();
    S.drinkMenu  = [MENU_ITEM];
    S.milkTypes  = [{ id: 1, name: 'Hafermilch', stockMl: 1000 }];
});

describe('_maybeDeductMilk', () => {
    it('deducts when a drink with milk is newly assigned to a shot with no prior annotation', () => {
        _maybeDeductMilk(undefined, payloadOf('m_latte', 1));
        expect(fetchSpy).toHaveBeenCalledWith('api/library/milk/1/deduct', expect.objectContaining({
            method: 'POST', body: JSON.stringify({ ml: 150 }),
        }));
    });

    it('deducts when the drink changes but the milk type stays the same (regression: previous gate only checked milkType changing)', () => {
        const shot = shotWith({ drinkType: 'm_old', milkType: 1 });
        _maybeDeductMilk(shot, payloadOf('m_latte', 1));
        expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    it('deducts when the milk type changes but the drink stays the same', () => {
        const shot = shotWith({ drinkType: 'm_latte', milkType: 2 });
        _maybeDeductMilk(shot, payloadOf('m_latte', 1));
        expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    it('does not double-deduct when re-saving the exact same drink+milk combo', () => {
        const shot = shotWith({ drinkType: 'm_latte', milkType: 1 });
        _maybeDeductMilk(shot, payloadOf('m_latte', 1));
        expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('does nothing when no milk type is selected', () => {
        _maybeDeductMilk(undefined, payloadOf('m_latte', null));
        expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('does nothing when the assigned drink has no milk configured', () => {
        S.drinkMenu = [{ id: 'm_espresso', name: 'Espresso', milkMl: null }];
        _maybeDeductMilk(undefined, payloadOf('m_espresso', 1));
        expect(fetchSpy).not.toHaveBeenCalled();
    });
});
