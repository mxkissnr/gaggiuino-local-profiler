// #594: machine icon rendering (public-src/machine-icon.js). Pure ESM string
// builder, no DOM dependency, so it's tested directly the same way
// public-src/bean-math.js is (see test/bean-math.test.js).
import { describe, it, expect } from 'vitest';
import { machineIconSvg, machineIconMiniSvg, machineIconAnimatedSvg,
         MACHINE_ICON_MODES, resolveMachineIconState } from '../public-src/machine-icon.js';
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

    it('mini variant renders without the sub-2px detail paths (control panel button highlights)', () => {
        const full = machineIconSvg({ preset: 'amber-americano' });
        const mini = machineIconMiniSvg({ preset: 'amber-americano' });
        // Button highlight strip present in full detail only (#822: dropped by
        // animBody()'s `mini` param, reused from the #811 shared body).
        expect(full).toContain('<rect x="23" y="18.5" width="9.4" height="3.6" rx="1" fill="#fff" opacity=".13"/>');
        expect(mini).not.toContain('<rect x="23" y="18.5" width="9.4" height="3.6" rx="1" fill="#fff" opacity=".13"/>');
    });

    it('every gradient id is unique across repeated calls so multiple icons in one document never collide', () => {
        const first = machineIconSvg(null);
        const second = machineIconSvg(null);
        const idOf = (svg) => svg.match(/id="(glp-machine-icon-\d+)"/)[1];
        expect(idOf(first)).not.toBe(idOf(second));
    });
});

// #822: the settings-screen icons (list rows, topbar switcher, add/edit
// preview) used to call this same machineIconSvg()/machineIconMiniSvg() pair
// when it still rendered the old pre-#811 single "Gaggia Classic" body —
// which had no `kind` parameter at all, so a Gaggiuino machine and a
// GaggiMate machine rendered pixel-identical icons there even though the
// Live view's machineIconAnimatedSvg() already told them apart. These tests
// prove the fix: passing `kind` now changes the rendered body/panel markup.
describe('machineIconSvg / machineIconMiniSvg kind rendering (#822)', () => {
    it('defaults to the Gaggiuino rectangular display panel when kind is omitted', () => {
        const svg = machineIconSvg(null);
        expect(svg).toContain('rx="3" fill="#101012"'); // Gaggiuino display bezel
        expect(svg).not.toContain('fill="#cfd4d9"'); // GaggiMate puck fill
    });

    it('renders the Gaggiuino rectangular display panel for kind="gaggiuino"', () => {
        const svg = machineIconSvg(null, 'gaggiuino');
        expect(svg).toContain('rx="3" fill="#101012"');
        expect(svg).not.toContain('fill="#cfd4d9"');
    });

    it('renders a visibly different GaggiMate round puck/housing for kind="gaggimate"', () => {
        const svg = machineIconSvg(null, 'gaggimate');
        expect(svg).toContain('fill="#cfd4d9"'); // chrome puck housing
        expect(svg).not.toContain('rx="3" fill="#101012"'); // no Gaggiuino display bezel
    });

    it('uses the taller viewBox the GaggiMate puck housing needs (extends above y=0)', () => {
        expect(machineIconSvg(null, 'gaggiuino')).toContain('viewBox="0 0 100 162"');
        expect(machineIconSvg(null, 'gaggimate')).toContain('viewBox="0 -21 100 183"');
    });

    it('mini variant also distinguishes kind the same way', () => {
        const gaggiuino = machineIconMiniSvg(null, 'gaggiuino');
        const gaggimate = machineIconMiniSvg(null, 'gaggimate');
        expect(gaggiuino).toContain('rx="3" fill="#101012"');
        expect(gaggimate).toContain('fill="#cfd4d9"');
        expect(gaggiuino).not.toBe(gaggimate);
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

// #902: steam/flush wiring into the animated icon's state resolver.
describe('resolveMachineIconState() steam/flush (#902)', () => {
    it('resolves isSteaming to the steaming mode', () => {
        expect(resolveMachineIconState({ isSteaming: true }, null)).toEqual({ mode: 'steaming', heatFraction: 1 });
    });

    it('resolves isFlushing to the flushing mode', () => {
        expect(resolveMachineIconState({ isFlushing: true }, null)).toEqual({ mode: 'flushing', heatFraction: 1 });
    });

    it('isLive (brewing) takes priority over isSteaming/isFlushing', () => {
        expect(resolveMachineIconState({ isLive: true, isSteaming: true }, null)).toEqual({ mode: 'brewing', heatFraction: 1 });
    });

    it('machineReachable:false takes priority over isSteaming/isFlushing', () => {
        expect(resolveMachineIconState({ machineReachable: false, isSteaming: true }, null)).toEqual({ mode: 'off', heatFraction: 0 });
    });

    it('falls through to hot/heating when neither isSteaming nor isFlushing is set', () => {
        expect(resolveMachineIconState({}, null)).toEqual({ mode: 'hot', heatFraction: 1 });
    });
});

describe('MACHINE_ICON_MODES flushing (#902)', () => {
    it('flushing mode carries is-on/is-hot/is-flushing classes, same shape as steaming', () => {
        expect(MACHINE_ICON_MODES.flushing).toEqual(['is-on', 'is-hot', 'is-flushing']);
    });
});

describe('machineIconAnimatedSvg() flush display group (#902)', () => {
    it('renders a .d-flush group alongside .d-steam for both machine kinds', () => {
        expect(machineIconAnimatedSvg(null, 'gaggiuino')).toContain('class="d-flush"');
        expect(machineIconAnimatedSvg(null, 'gaggimate')).toContain('class="d-flush"');
    });
});

// #983: descale wiring, mirroring the #902 steam/flush tests above.
describe('resolveMachineIconState() descale (#983)', () => {
    it('resolves isDescaling to the descaling mode', () => {
        expect(resolveMachineIconState({ isDescaling: true }, null)).toEqual({ mode: 'descaling', heatFraction: 1 });
    });

    it('isFlushing takes priority over isDescaling', () => {
        expect(resolveMachineIconState({ isFlushing: true, isDescaling: true }, null)).toEqual({ mode: 'flushing', heatFraction: 1 });
    });

    it('isLive (brewing) takes priority over isDescaling', () => {
        expect(resolveMachineIconState({ isLive: true, isDescaling: true }, null)).toEqual({ mode: 'brewing', heatFraction: 1 });
    });

    it('machineReachable:false takes priority over isDescaling', () => {
        expect(resolveMachineIconState({ machineReachable: false, isDescaling: true }, null)).toEqual({ mode: 'off', heatFraction: 0 });
    });
});

describe('MACHINE_ICON_MODES descaling (#983)', () => {
    it('descaling mode carries is-on/is-hot/is-descaling classes, same shape as flushing', () => {
        expect(MACHINE_ICON_MODES.descaling).toEqual(['is-on', 'is-hot', 'is-descaling']);
    });
});

describe('machineIconAnimatedSvg() descale display group (#983)', () => {
    it('renders a .d-descale group alongside .d-flush for both machine kinds', () => {
        expect(machineIconAnimatedSvg(null, 'gaggiuino')).toContain('class="d-descale"');
        expect(machineIconAnimatedSvg(null, 'gaggimate')).toContain('class="d-descale"');
    });
});
