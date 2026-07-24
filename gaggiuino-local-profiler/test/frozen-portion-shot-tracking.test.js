import { describe, it, expect, beforeEach, vi } from 'vitest';

// annotation.js imports state.js, which reads localStorage/navigator at
// module load time — stub the minimum browser globals needed so the module
// graph can be imported under vitest's node environment (same pattern as
// test/milk-deduct-gate.test.js).
globalThis.localStorage ??= { getItem: () => null, setItem: () => {} };
globalThis.navigator    ??= { language: 'en-US' };

const { S } = await import('../public-src/state.js');
const apiModule = await import('../public-src/api.js');
const fetchSpy = vi.spyOn(apiModule, 'apiFetch').mockResolvedValue({
    ok: true, json: async () => ({}),
});
const { _maybeAdjustFrozenPortion, _renderFrozenPortionPills } = await import('../public-src/views/shots/annotation.js');

function makeBean(portions) {
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
        S.coffeeLibrary = { beans: [makeBean([{ id: 100, portionCount: 20, remainingCount: 20 }])] };
        _maybeAdjustFrozenPortion(undefined, { frozenPortionId: 100 });
        expect(fetchSpy).toHaveBeenCalledWith('api/library/bean/1/adjust-frozen-portion', expect.objectContaining({
            method: 'POST', body: JSON.stringify({ portionId: 100, remainingCount: 19 }),
        }));
    });

    it('does not double-decrement when re-saving the exact same portion choice', () => {
        S.coffeeLibrary = { beans: [makeBean([{ id: 100, portionCount: 20, remainingCount: 19 }])] };
        const shot = { annotation: { frozenPortionId: 100 } };
        _maybeAdjustFrozenPortion(shot, { frozenPortionId: 100 });
        expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('reverses the previous portion and applies the new one when the choice changes', () => {
        S.coffeeLibrary = { beans: [makeBean([
            { id: 100, portionCount: 20, remainingCount: 19 },
            { id: 200, portionCount: 5, remainingCount: 5 },
        ])] };
        const shot = { annotation: { frozenPortionId: 100 } };
        _maybeAdjustFrozenPortion(shot, { frozenPortionId: 200 });
        expect(fetchSpy).toHaveBeenCalledWith('api/library/bean/1/adjust-frozen-portion', expect.objectContaining({
            body: JSON.stringify({ portionId: 100, remainingCount: 20 }),
        }));
        expect(fetchSpy).toHaveBeenCalledWith('api/library/bean/1/adjust-frozen-portion', expect.objectContaining({
            body: JSON.stringify({ portionId: 200, remainingCount: 4 }),
        }));
        expect(fetchSpy).toHaveBeenCalledTimes(2);
    });

    it('reverses the previous portion (increments it back) when switching back to "not frozen"', () => {
        S.coffeeLibrary = { beans: [makeBean([{ id: 100, portionCount: 20, remainingCount: 19 }])] };
        const shot = { annotation: { frozenPortionId: 100 } };
        _maybeAdjustFrozenPortion(shot, { frozenPortionId: null });
        expect(fetchSpy).toHaveBeenCalledWith('api/library/bean/1/adjust-frozen-portion', expect.objectContaining({
            body: JSON.stringify({ portionId: 100, remainingCount: 20 }),
        }));
        expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    it('never increments a reversed portion above its own portionCount', () => {
        S.coffeeLibrary = { beans: [makeBean([{ id: 100, portionCount: 20, remainingCount: 20 }])] };
        // Shouldn't normally happen (remainingCount already at max), but the
        // clamp must hold regardless of how the previous state got there.
        const shot = { annotation: { frozenPortionId: 100 } };
        _maybeAdjustFrozenPortion(shot, { frozenPortionId: null });
        expect(fetchSpy).toHaveBeenCalledWith('api/library/bean/1/adjust-frozen-portion', expect.objectContaining({
            body: JSON.stringify({ portionId: 100, remainingCount: 20 }),
        }));
    });

    it('does nothing when neither the previous nor the new annotation used a frozen portion', () => {
        S.coffeeLibrary = { beans: [makeBean([{ id: 100, portionCount: 20, remainingCount: 20 }])] };
        _maybeAdjustFrozenPortion(undefined, { frozenPortionId: null });
        expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('does nothing when the referenced portion no longer exists in the library', () => {
        S.coffeeLibrary = { beans: [] };
        _maybeAdjustFrozenPortion(undefined, { frozenPortionId: 999 });
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
    globalThis.document = {
        getElementById: id => ({
            frozenPortionField: field,
            frozenPortionPillsContainer: container,
            annFrozenPortionId: hidden,
        }[id]),
    };
    return { field, container, hidden };
}

describe('_renderFrozenPortionPills', () => {
    it('hides the field entirely when the bean has no active frozen portions', () => {
        S.coffeeLibrary = { beans: [makeBean([])] };
        const { field, container } = fakePanelDom();
        _renderFrozenPortionPills('Flower Power', Date.now(), null);
        expect(field.style.display).toBe('none');
        expect(container.innerHTML).toBe('');
    });

    it('hides the field when the only portions are already fully thawed (remainingCount 0)', () => {
        S.coffeeLibrary = { beans: [makeBean([{ id: 100, portionCount: 20, remainingCount: 0, thawedAt: Date.now() }])] };
        const { field } = fakePanelDom();
        _renderFrozenPortionPills('Flower Power', Date.now(), null);
        expect(field.style.display).toBe('none');
    });

    it('shows one "not frozen" pill plus one pill per active portion, always including "not frozen"', () => {
        S.coffeeLibrary = { beans: [makeBean([
            { id: 100, portionCount: 20, remainingCount: 19, frozenAt: Date.now() },
            { id: 200, portionCount: 5, remainingCount: 5, frozenAt: Date.now() },
        ])] };
        const { field, container } = fakePanelDom();
        _renderFrozenPortionPills('Flower Power', Date.now(), null);
        expect(field.style.display).toBe('');
        expect((container.innerHTML.match(/data-action="select-frozen-portion"/g) || [])).toHaveLength(3);
        expect(container.innerHTML).toContain('data-id=""');
        expect(container.innerHTML).toContain('data-id="100"');
        expect(container.innerHTML).toContain('data-id="200"');
    });

    it('marks the selected portion pill active and sets the hidden input value', () => {
        S.coffeeLibrary = { beans: [makeBean([{ id: 100, portionCount: 20, remainingCount: 19, frozenAt: Date.now() }])] };
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
        S.coffeeLibrary = { beans: [bean] };
        const { container } = fakePanelDom();
        // A shot timestamped before bag 2 was ever opened must resolve to bag 1.
        _renderFrozenPortionPills('Flower Power', 2000, null);
        expect(container.innerHTML).toContain('data-id="100"');
        expect(container.innerHTML).not.toContain('data-id="200"');
    });
});
