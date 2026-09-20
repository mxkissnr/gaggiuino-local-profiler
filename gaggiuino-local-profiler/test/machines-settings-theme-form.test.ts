// #595 code review fix: onThemeCustomColorBChange() wrote _selectedTheme.b
// correctly but forgot the syncThemeFormUI() call its sibling handlers
// (onThemeCustomColorAChange, onThemeGradientToggleChange) both have, so the
// live SVG preview (#machineThemePreview) went stale when editing the second
// gradient stop until some unrelated action happened to re-render it.
import { describe, it, expect, beforeEach } from 'vitest';

// vitest's node environment has no browser globals; stub them through a loose
// view of globalThis (the same bridge test/machine-accent-theme.test.ts uses)
// so the minimal fakes below need not satisfy the full Storage/Navigator/Window
// shapes.
const g = globalThis as unknown as Record<string, unknown>;
g.localStorage ??= { getItem: () => null, setItem: () => {} };
g.navigator ??= { language: 'en-US' };
g.window ??= globalThis;

// Minimal fake DOM: just enough for openMachineForm()/syncThemeFormUI() to
// run without throwing — value/innerHTML/textContent/style are read/written,
// querySelectorAll only needs to exist (renderThemeSwatches binds click
// listeners on its result, irrelevant here since we call the exported
// handlers directly rather than simulating a click).
class FakeEl {
    value = '';
    innerHTML = '';
    textContent = '';
    style: Record<string, string> = {};
    constructor() { this.value = ''; this.innerHTML = ''; this.textContent = ''; this.style = {}; }
    querySelectorAll(): unknown[] { return []; }
}

const elements: Record<string, FakeEl> = {};
function fakeElement(id: string): FakeEl { return (elements[id] ??= new FakeEl()); }

g.document = {
    getElementById: fakeElement,
};

const { openMachineForm, onThemeCustomColorBChange } = await import('../public-src/components/machines-settings.js');

// openMachineForm()'s parameter type (machines-settings.ts's MachineView)
// requires an id, but these fixtures exercise the "brand-new machine" path the
// real callers use (no id), so express that through the parameter type.
type MachineFormArg = NonNullable<Parameters<typeof openMachineForm>[0]>;

describe('onThemeCustomColorBChange (#595 review fix)', () => {
    beforeEach(() => {
        for (const key of Object.keys(elements)) delete elements[key];
    });

    it('refreshes the live preview SVG when the second gradient stop colour changes', () => {
        openMachineForm({ name: 'Test', host: 'x', theme: { a: '#f59e0b', b: '#f59e0b' } } as unknown as MachineFormArg);
        const previewBefore = fakeElement('machineThemePreview').innerHTML;
        expect(previewBefore).toContain('#f59e0b');

        fakeElement('machineThemeCustomB').value = '#0891b2';
        onThemeCustomColorBChange();

        const previewAfter = fakeElement('machineThemePreview').innerHTML;
        expect(previewAfter).toContain('#0891b2');
        expect(previewAfter).not.toBe(previewBefore);
    });

    it('is a no-op when no custom theme is selected (preset active) — does not throw', () => {
        openMachineForm({ name: 'Test', host: 'x', theme: { preset: 'ember-espresso' } } as unknown as MachineFormArg);
        expect(() => onThemeCustomColorBChange()).not.toThrow();
    });
});
