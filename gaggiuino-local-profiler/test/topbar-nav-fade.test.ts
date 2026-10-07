// #1516: the desktop topbar's tab row (.topbar-nav-scroll) scrolls
// horizontally with a hidden scrollbar, so on a narrow window the tabs that
// fall off the edge look cut off rather than scrollable. topbarNavFadeClasses
// is the pure decision behind the edge mask; updateTopbarNavFade applies it.
// Node environment, no browser globals needed for the pure part.
import { describe, it, expect } from 'vitest';
import { topbarNavFadeClasses, updateTopbarNavFade } from '../public-src/components/topbar-nav-fade.js';

describe('topbarNavFadeClasses() (#1516)', () => {
    it('adds no fade when every tab fits', () => {
        expect(topbarNavFadeClasses(0, 400, 400)).toEqual([]);
        expect(topbarNavFadeClasses(0, 380, 400)).toEqual([]);
    });

    it('fades only the right edge at the start of an overflowing row', () => {
        expect(topbarNavFadeClasses(0, 1000, 400)).toEqual(['fade-right']);
    });

    it('fades both edges in the middle', () => {
        expect(topbarNavFadeClasses(300, 1000, 400)).toEqual(['fade-left', 'fade-right']);
    });

    it('fades only the left edge at the end', () => {
        expect(topbarNavFadeClasses(600, 1000, 400)).toEqual(['fade-left']);
    });

    it('treats sub-pixel offsets within tolerance as already at the edge', () => {
        expect(topbarNavFadeClasses(0.5, 1000, 400)).toEqual(['fade-right']);
        expect(topbarNavFadeClasses(599.5, 1000, 400)).toEqual(['fade-left']);
    });

    it('shows no fade when the overflow is within tolerance', () => {
        expect(topbarNavFadeClasses(0, 400.5, 400)).toEqual([]);
    });
});

// Minimal stand-in for the row element: classList.toggle(name, force) with a
// Set to record which edge classes are on.
function fakeRow(scrollLeft: number, scrollWidth: number, clientWidth: number): HTMLElement & { classes: Set<string> } {
    const classes = new Set<string>();
    return {
        scrollLeft,
        scrollWidth,
        clientWidth,
        classes,
        classList: {
            toggle: (name: string, force?: boolean): boolean => {
                if (force) classes.add(name);
                else classes.delete(name);
                return classes.has(name);
            },
        },
    } as unknown as HTMLElement & { classes: Set<string> };
}

describe('updateTopbarNavFade() (#1516)', () => {
    it('sets fade-right at the start and clears it once everything fits', () => {
        const row = fakeRow(0, 1000, 400);
        updateTopbarNavFade(row);
        expect([...row.classes]).toEqual(['fade-right']);

        row.scrollWidth = 400;
        updateTopbarNavFade(row);
        expect([...row.classes]).toEqual([]);
    });

    it('sets both edges mid-scroll and only fade-left at the end', () => {
        const row = fakeRow(300, 1000, 400);
        updateTopbarNavFade(row);
        expect([...row.classes].sort()).toEqual(['fade-left', 'fade-right']);

        row.scrollLeft = 600;
        updateTopbarNavFade(row);
        expect([...row.classes]).toEqual(['fade-left']);
    });

    it('ignores a missing row', () => {
        expect(() => updateTopbarNavFade(null)).not.toThrow();
    });
});
