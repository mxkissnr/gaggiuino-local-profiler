import { describe, it, expect, beforeAll } from 'vitest';

// analytics.js pulls in state.js/i18n.js (localStorage/navigator at module
// load) -- same minimal stub other analytics test files use (see
// world-map-antimeridian.test.js, analytics-world-map-race.test.js).
let resolveWorldMapColors;

beforeAll(async () => {
  Object.defineProperty(globalThis, 'localStorage', {
    value: { getItem: () => null, setItem: () => {} },
    configurable: true, writable: true,
  });
  Object.defineProperty(globalThis, 'navigator', {
    value: { language: 'en' },
    configurable: true, writable: true,
  });
  ({ resolveWorldMapColors } = await import('../public-src/views/analytics.js'));
});

// #1024: resolveWorldMapColors() reads --gray-900/--gray-600/--gray-500/
// --accent-to via themeColor() (utils.js, #814), i.e.
// getComputedStyle(document.documentElement).getPropertyValue(...) at call
// time. Faking just that entry point lets this flip between the dark- and
// light-theme token values actually declared in style.css (:root vs.
// [data-theme="light"], same source test/theme-contrast.test.js audits)
// without needing a real stylesheet or DOM.
function stubTheme(tokens) {
  globalThis.document = { documentElement: {} };
  globalThis.getComputedStyle = () => ({
    getPropertyValue: (name) => tokens[name] || '',
  });
}

// Values copied from public-src/style.css's :root (dark) and
// [data-theme="light"] blocks.
const DARK = {
  '--gray-900': '#131416', '--gray-600': '#93989c', '--gray-500': '#a4a9ad',
  '--accent-to': '#f59e0b',
};
const LIGHT = {
  '--gray-900': '#f7f7f6', '--gray-600': '#63686c', '--gray-500': '#585d61',
  '--accent-to': '#f59e0b',
};

describe('resolveWorldMapColors (#1024)', () => {
  it('resolves the map background from the live theme, not a fixed dark literal', () => {
    stubTheme(DARK);
    const dark = resolveWorldMapColors();
    stubTheme(LIGHT);
    const light = resolveWorldMapColors();

    expect(dark.backgroundColor).toBe('rgba(19,20,22,0.55)');
    expect(light.backgroundColor).toBe('rgba(247,247,246,0.55)');
    expect(dark.backgroundColor).not.toBe(light.backgroundColor);
  });

  it('derives land fill (--gray-600) and border (--gray-500) colors per theme at the original alphas', () => {
    stubTheme(DARK);
    const dark = resolveWorldMapColors();
    expect(dark.areaColor).toBe('rgba(147,152,156,0.4)');
    expect(dark.emphasisAreaColor).toBe('rgba(147,152,156,0.6)');
    expect(dark.borderColor).toBe('rgba(164,169,173,0.7)');

    stubTheme(LIGHT);
    const light = resolveWorldMapColors();
    expect(light.areaColor).toBe('rgba(99,104,108,0.4)');
    expect(light.emphasisAreaColor).toBe('rgba(99,104,108,0.6)');
    expect(light.borderColor).toBe('rgba(88,93,97,0.7)');

    expect(dark.areaColor).not.toBe(light.areaColor);
    expect(dark.borderColor).not.toBe(light.borderColor);
  });

  it('falls back to the old dark-theme literals when no stylesheet has applied yet', () => {
    globalThis.document = { documentElement: {} };
    globalThis.getComputedStyle = () => ({ getPropertyValue: () => '' });
    const c = resolveWorldMapColors();
    expect(c.backgroundColor).toBe('rgba(19,20,22,0.55)');
    expect(c.accentTo).toBe('#f97316');
  });
});
