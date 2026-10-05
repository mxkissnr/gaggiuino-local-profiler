import { describe, it, expect } from 'vitest';
import type { CoffeeLibrary, LibraryRow } from '../public-src/state/index.js';

// annotation.js imports state.js, which reads localStorage/navigator at
// module load time — stub the minimum browser globals needed so the module
// graph can be imported under vitest's node environment.
// globalThis carries the full DOM type; stub only the sliver state.js reads.
const g = globalThis as unknown as Record<string, unknown>;
g.localStorage ??= { getItem: () => null, setItem: () => {} };
g.navigator    ??= { language: 'en-US' };

const { S } = await import('../public-src/state/index.js');
const { _stockFieldsChanged, _renderFrozenPortionPills } = await import('../public-src/views/shots/annotation.js');

interface FrozenPortionFixture {
    id: number;
    portionCount: number;
    remainingCount: number;
    frozenAt?: number;
    thawedAt?: number;
}

function library(beans: LibraryRow[]): CoffeeLibrary {
    return { beans, grinders: [] };
}

function makeBean(portions: FrozenPortionFixture[]) {
    return { id: 1, name: 'Flower Power', bags: [{ id: 1, frozenPortions: portions }] };
}

// #1411: the server books milk stock and frozen-portion counts itself while
// it saves; the client reloads the library only when a field the server books
// from (drink, milk or frozen portion) actually changed.
describe('_stockFieldsChanged (#1411)', () => {
    it('is true when a drink+milk is newly assigned to a shot with no prior annotation', () => {
        expect(_stockFieldsChanged(undefined, { drinkType: 'latte', milkType: 1 })).toBe(true);
    });

    it('is false when only a field the server does not book from changed', () => {
        expect(_stockFieldsChanged(
            { drinkType: 'latte', milkType: 1 },
            { drinkType: 'latte', milkType: 1, rating: 5 },
        )).toBe(false);
    });

    it('is true when the frozen portion is cleared', () => {
        expect(_stockFieldsChanged({ frozenPortionId: 100 }, { frozenPortionId: null })).toBe(true);
    });

    it('is false when the drink type only differs between null and empty string', () => {
        expect(_stockFieldsChanged({ drinkType: null }, { drinkType: '' })).toBe(false);
    });

    it('is false when the milk type only differs between number and string', () => {
        expect(_stockFieldsChanged({ milkType: 1 }, { milkType: '1' })).toBe(false);
    });

    it('is false when neither annotation touches a stock field', () => {
        expect(_stockFieldsChanged({}, { rating: 4 })).toBe(false);
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
