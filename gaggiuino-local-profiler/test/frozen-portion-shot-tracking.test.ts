import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { CoffeeLibrary, LibraryRow } from '../public-src/state/index.js';

// annotation.js imports state.js, which reads localStorage/navigator at
// module load time — stub the minimum browser globals needed so the module
// graph can be imported under vitest's node environment (same pattern as
// test/milk-deduct-gate.test.js).
// globalThis carries the full DOM type; stub only the sliver state.js reads.
const g = globalThis as unknown as Record<string, unknown>;
g.localStorage ??= { getItem: () => null, setItem: () => {} };
g.navigator    ??= { language: 'en-US' };

const { S } = await import('../public-src/state/index.js');
const apiModule = await import('../public-src/api/transport.js');
const fetchSpy = vi.spyOn(apiModule, 'apiFetch').mockResolvedValue({
    ok: true, json: () => Promise.resolve({}),
} as unknown as Response);
const { _maybeAdjustFrozenPortion, _renderFrozenPortionPills } = await import('../public-src/views/shots/annotation.js');

interface FrozenPortionFixture {
    id: number;
    portionCount: number;
    remainingCount: number;
    frozenAt?: number;
    thawedAt?: number;
}

// Mirrors the non-exported AnnotationPayload contract in
// public-src/views/shots/annotation.ts; only frozenPortionId varies below.
interface AnnotationPayloadFixture {
    rating: number | null;
    coffee: string;
    beanId: number | null;
    basketId: number | null;
    puckScreenId: number | null;
    grinder: string;
    grindSetting: string;
    dose: number | null;
    roastDate: string | null;
    tds: number | null;
    notes: string;
    drinkType: string | null;
    milkType: number | null;
    recipeId: number | null;
    beanAgeDays: number | null;
    frozenPortionId: number | null;
}

function payload(frozenPortionId: number | null): AnnotationPayloadFixture {
    return {
        rating: null, coffee: '', beanId: null, basketId: null, puckScreenId: null,
        grinder: '', grindSetting: '', dose: null, roastDate: null, tds: null,
        notes: '', drinkType: null, milkType: null, recipeId: null, beanAgeDays: null,
        frozenPortionId,
    };
}

function library(beans: LibraryRow[]): CoffeeLibrary {
    return { beans, grinders: [] };
}

function makeBean(portions: FrozenPortionFixture[]) {
    return { id: 1, name: 'Flower Power', bags: [{ id: 1, frozenPortions: portions }] };
}

beforeEach(() => {
    fetchSpy.mockClear();
});

// #502: mirrors test/milk-deduct-gate.test.js's coverage shape for the
// analogous milk-deduction gate — same "compare previous vs. new, only act
// on a real change" contract, applied to frozen-portion remainingCount.
describe('_maybeAdjustFrozenPortion', () => {
    it('decrements remainingCount when a frozen portion is newly picked for a shot with no prior annotation', () => {
        S.coffeeLibrary = library([makeBean([{ id: 100, portionCount: 20, remainingCount: 20 }])]);
        _maybeAdjustFrozenPortion(undefined, payload(100));
        expect(fetchSpy).toHaveBeenCalledWith('api/library/bean/1/adjust-frozen-portion', expect.objectContaining({
            method: 'POST', body: JSON.stringify({ portionId: 100, remainingCount: 19 }),
        }));
    });

    it('does not double-decrement when re-saving the exact same portion choice', () => {
        S.coffeeLibrary = library([makeBean([{ id: 100, portionCount: 20, remainingCount: 19 }])]);
        const shot = { id: 1, annotation: { frozenPortionId: 100 } };
        _maybeAdjustFrozenPortion(shot, payload(100));
        expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('reverses the previous portion and applies the new one when the choice changes', () => {
        S.coffeeLibrary = library([makeBean([
            { id: 100, portionCount: 20, remainingCount: 19 },
            { id: 200, portionCount: 5, remainingCount: 5 },
        ])]);
        const shot = { id: 1, annotation: { frozenPortionId: 100 } };
        _maybeAdjustFrozenPortion(shot, payload(200));
        expect(fetchSpy).toHaveBeenCalledWith('api/library/bean/1/adjust-frozen-portion', expect.objectContaining({
            body: JSON.stringify({ portionId: 100, remainingCount: 20 }),
        }));
        expect(fetchSpy).toHaveBeenCalledWith('api/library/bean/1/adjust-frozen-portion', expect.objectContaining({
            body: JSON.stringify({ portionId: 200, remainingCount: 4 }),
        }));
        expect(fetchSpy).toHaveBeenCalledTimes(2);
    });

    it('reverses the previous portion (increments it back) when switching back to "not frozen"', () => {
        S.coffeeLibrary = library([makeBean([{ id: 100, portionCount: 20, remainingCount: 19 }])]);
        const shot = { id: 1, annotation: { frozenPortionId: 100 } };
        _maybeAdjustFrozenPortion(shot, payload(null));
        expect(fetchSpy).toHaveBeenCalledWith('api/library/bean/1/adjust-frozen-portion', expect.objectContaining({
            body: JSON.stringify({ portionId: 100, remainingCount: 20 }),
        }));
        expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    it('never increments a reversed portion above its own portionCount', () => {
        S.coffeeLibrary = library([makeBean([{ id: 100, portionCount: 20, remainingCount: 20 }])]);
        // Shouldn't normally happen (remainingCount already at max), but the
        // clamp must hold regardless of how the previous state got there.
        const shot = { id: 1, annotation: { frozenPortionId: 100 } };
        _maybeAdjustFrozenPortion(shot, payload(null));
        expect(fetchSpy).toHaveBeenCalledWith('api/library/bean/1/adjust-frozen-portion', expect.objectContaining({
            body: JSON.stringify({ portionId: 100, remainingCount: 20 }),
        }));
    });

    it('does nothing when neither the previous nor the new annotation used a frozen portion', () => {
        S.coffeeLibrary = library([makeBean([{ id: 100, portionCount: 20, remainingCount: 20 }])]);
        _maybeAdjustFrozenPortion(undefined, payload(null));
        expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('does nothing when the referenced portion no longer exists in the library', () => {
        S.coffeeLibrary = library([]);
        _maybeAdjustFrozenPortion(undefined, payload(999));
        expect(fetchSpy).not.toHaveBeenCalled();
    });
});

// _renderFrozenPortionPills() reads/writes DOM nodes by id — stub only what
// it touches, same "fake minimal document" approach as
// test/sidebar-bean-filter.test.js.
function fakePanelDom() {
    const field     = { style: { display: 'none' } };
    const container = { innerHTML: '' };
    const hidden    = { value: '' };
    g.document = {
        getElementById: (id: string) => {
            const nodes: Record<string, unknown> = {
                frozenPortionField: field,
                frozenPortionPillsContainer: container,
                annFrozenPortionId: hidden,
            };
            return nodes[id];
        },
    };
    return { field, container, hidden };
}

describe('_renderFrozenPortionPills', () => {
    it('hides the field entirely when the bean has no active frozen portions', () => {
        S.coffeeLibrary = library([makeBean([])]);
        const { field, container } = fakePanelDom();
        _renderFrozenPortionPills('Flower Power', Date.now(), null);
        expect(field.style.display).toBe('none');
        expect(container.innerHTML).toBe('');
    });

    it('hides the field when the only portions are already fully thawed (remainingCount 0)', () => {
        S.coffeeLibrary = library([makeBean([{ id: 100, portionCount: 20, remainingCount: 0, thawedAt: Date.now() }])]);
        const { field } = fakePanelDom();
        _renderFrozenPortionPills('Flower Power', Date.now(), null);
        expect(field.style.display).toBe('none');
    });

    it('shows one "not frozen" pill plus one pill per active portion, always including "not frozen"', () => {
        S.coffeeLibrary = library([makeBean([
            { id: 100, portionCount: 20, remainingCount: 19, frozenAt: Date.now() },
            { id: 200, portionCount: 5, remainingCount: 5, frozenAt: Date.now() },
        ])]);
        const { field, container } = fakePanelDom();
        _renderFrozenPortionPills('Flower Power', Date.now(), null);
        expect(field.style.display).toBe('');
        expect((container.innerHTML.match(/data-action="select-frozen-portion"/g) || [])).toHaveLength(3);
        expect(container.innerHTML).toContain('data-id=""');
        expect(container.innerHTML).toContain('data-id="100"');
        expect(container.innerHTML).toContain('data-id="200"');
    });

    it('marks the selected portion pill active and sets the hidden input value', () => {
        S.coffeeLibrary = library([makeBean([{ id: 100, portionCount: 20, remainingCount: 19, frozenAt: Date.now() }])]);
        const { hidden } = fakePanelDom();
        _renderFrozenPortionPills('Flower Power', Date.now(), 100);
        expect(hidden.value).toBe('100');
    });

    it('resolves to the bag active at the given shot timestamp, not just the newest bag', () => {
        const bean = {
            id: 1, name: 'Flower Power',
            bags: [
                { id: 1, openedAt: 1000, frozenPortions: [{ id: 100, portionCount: 20, remainingCount: 20 }] },
                { id: 2, openedAt: 999999999999, frozenPortions: [{ id: 200, portionCount: 5, remainingCount: 5 }] },
            ],
        };
        S.coffeeLibrary = library([bean]);
        const { container } = fakePanelDom();
        // A shot timestamped before bag 2 was ever opened must resolve to bag 1.
        _renderFrozenPortionPills('Flower Power', 2000, null);
        expect(container.innerHTML).toContain('data-id="100"');
        expect(container.innerHTML).not.toContain('data-id="200"');
    });
});
