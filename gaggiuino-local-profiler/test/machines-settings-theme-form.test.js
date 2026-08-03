// #595 code review fix: onThemeCustomColorBChange() wrote _selectedTheme.b
// correctly but forgot the syncThemeFormUI() call its sibling handlers
// (onThemeCustomColorAChange, onThemeGradientToggleChange) both have, so the
// live SVG preview (#machineThemePreview) went stale when editing the second
// gradient stop until some unrelated action happened to re-render it.
import { describe, it, expect, beforeEach } from 'vitest';

globalThis.localStorage ??= { getItem: () => null, setItem: () => {} };
globalThis.navigator ??= { language: 'en-US' };
globalThis.window ??= globalThis;

// Minimal fake DOM: just enough for openMachineForm()/syncThemeFormUI() to
// run without throwing — value/innerHTML/textContent/style are read/written,
// querySelectorAll only needs to exist (renderThemeSwatches binds click
// listeners on its result, irrelevant here since we call the exported
// handlers directly rather than simulating a click).
class FakeEl {
    constructor() { this.value = ''; this.innerHTML = ''; this.textContent = ''; this.style = {}; }
    querySelectorAll() { return []; }
}

const elements = {};
function fakeElement(id) { return (elements[id] ??= new FakeEl()); }

globalThis.document = {
    getElementById: fakeElement,
};

const { openMachineForm, onThemeCustomColorBChange } = await import('../public-src/components/machines-settings.js');

describe('onThemeCustomColorBChange (#595 review fix)', () => {
    beforeEach(() => {
        for (const key of Object.keys(elements)) delete elements[key];
    });

    it('refreshes the live preview SVG when the second gradient stop colour changes', () => {
        openMachineForm({ name: 'Test', host: 'x', theme: { a: '#f59e0b', b: '#f59e0b' } });
        const previewBefore = fakeElement('machineThemePreview').innerHTML;
        expect(previewBefore).toContain('#f59e0b');

        fakeElement('machineThemeCustomB').value = '#0891b2';
        onThemeCustomColorBChange();

        const previewAfter = fakeElement('machineThemePreview').innerHTML;
        expect(previewAfter).toContain('#0891b2');
        expect(previewAfter).not.toBe(previewBefore);
    });

    it('is a no-op when no custom theme is selected (preset active) — does not throw', () => {
        openMachineForm({ name: 'Test', host: 'x', theme: { preset: 'ember-espresso' } });
        expect(() => onThemeCustomColorBChange()).not.toThrow();
    });
});
