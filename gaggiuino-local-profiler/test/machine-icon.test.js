// #594: machine icon rendering (public-src/machine-icon.js). Pure ESM string
// builder, no DOM dependency, so it's tested directly the same way
// public-src/bean-math.js is (see test/bean-math.test.js).
import { describe, it, expect } from 'vitest';
import { machineIconSvg, machineIconMiniSvg } from '../public-src/machine-icon.js';
import { THEME_PRESETS, resolveTheme } from '../lib/machines/theme-presets.js';

const HEX_RE = /^#[0-9a-fA-F]{6}$/;

describe('machineIconSvg / machineIconMiniSvg theme rendering (#594)', () => {
    it('renders the default accent gradient when no theme is set', () => {
        const svg = machineIconSvg(null);
        expect(svg).toContain('var(--accent-from)');
        expect(svg).toContain('var(--accent-to)');
    });

    it('renders a preset theme\'s resolved hex stops', () => {
        const preset = THEME_PRESETS.find(p => p.key === 'ember-espresso');
        const svg = machineIconSvg({ preset: 'ember-espresso' });
        expect(svg).toContain(preset.a);
        expect(svg).toContain(preset.b);
        expect(svg).not.toContain('var(--accent-from)');
    });

    it('renders a custom flat colour and a custom gradient', () => {
        expect(machineIconSvg({ a: '#f59e0b', b: '#f59e0b' })).toContain('#f59e0b');
        const gradient = machineIconSvg({ a: '#f59e0b', b: '#0891b2' });
        expect(gradient).toContain('#f59e0b');
        expect(gradient).toContain('#0891b2');
    });

    it('falls back to the default gradient for an unknown preset key rather than throwing', () => {
        expect(() => machineIconSvg({ preset: 'not-a-real-preset' })).not.toThrow();
        expect(machineIconSvg({ preset: 'not-a-real-preset' })).toContain('var(--accent-from)');
    });

    // XSS safety: theme.a/b are meant to be validated #rrggbb hex by
    // machineSchema (see lib/validation/schemas.js) before ever reaching the
    // DB, but this module has its own defense-in-depth guard (HEX_RE in
    // machine-icon.js) — a value that somehow bypassed validation (corrupt
    // DB row, future caller that forgets to validate) must never be
    // interpolated verbatim into the SVG markup returned here.
    it('never interpolates a non-hex theme value into the rendered SVG (defense in depth against XSS)', () => {
        const payload = '"/><script>alert(1)</script><stop stop-color="';
        const svg = machineIconSvg({ a: payload, b: '#f59e0b' });
        expect(svg).not.toContain('<script>');
        expect(svg).not.toContain(payload);
        expect(svg).toContain('var(--accent-from)'); // safe fallback used instead
    });

    it('rejects a hex-shaped but non-6-digit value (e.g. #fff shorthand) the same way', () => {
        const svg = machineIconSvg({ a: '#fff', b: '#fff' });
        expect(svg).toContain('var(--accent-from)');
    });

    it('mini variant renders without the sub-2px detail paths (portafilter handle)', () => {
        const full = machineIconSvg({ preset: 'amber-americano' });
        const mini = machineIconMiniSvg({ preset: 'amber-americano' });
        expect(full).toContain('M47 82 L53 82'); // portafilter handle path present in full
        expect(mini).not.toContain('M47 82 L53 82');
    });

    it('every gradient id is unique across repeated calls so multiple icons in one document never collide', () => {
        const first = machineIconSvg(null);
        const second = machineIconSvg(null);
        const idOf = (svg) => svg.match(/id="(glp-machine-icon-\d+)"/)[1];
        expect(idOf(first)).not.toBe(idOf(second));
    });
});

describe('resolveTheme (lib/machines/theme-presets.js)', () => {
    it('returns null for no theme / unknown preset', () => {
        expect(resolveTheme(null)).toBeNull();
        expect(resolveTheme({ preset: 'nonexistent' })).toBeNull();
    });

    it('resolves every known preset key to a valid #rrggbb pair', () => {
        for (const p of THEME_PRESETS) {
            const resolved = resolveTheme({ preset: p.key });
            expect(resolved.a).toMatch(HEX_RE);
            expect(resolved.b).toMatch(HEX_RE);
        }
    });

    it('resolves a custom {a,b} theme as-is', () => {
        expect(resolveTheme({ a: '#111111', b: '#222222' })).toEqual({ a: '#111111', b: '#222222' });
    });
});
