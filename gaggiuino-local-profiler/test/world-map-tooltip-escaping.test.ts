import { describe, it, expect, beforeAll } from 'vitest';

// analytics.js pulls in state.js/i18n.js (localStorage/navigator at module
// load) -- same minimal stub other analytics test files use (see
// world-map-antimeridian.test.js, world-map-theme-colors.test.js).
let worldMapTooltipFormatter: (typeof import('../public-src/views/analytics.js'))['worldMapTooltipFormatter'];

beforeAll(async () => {
  Object.defineProperty(globalThis, 'localStorage', {
    value: { getItem: () => null, setItem: () => {} },
    configurable: true, writable: true,
  });
  Object.defineProperty(globalThis, 'navigator', {
    value: { language: 'en' },
    configurable: true, writable: true,
  });
  ({ worldMapTooltipFormatter } = await import('../public-src/views/analytics.js'));
});

// #1054: bean/region names reach this formatter unescaped from the Library
// (typed by hand) or the bean importer (scraped from a roaster's website).
// ECharts renders a formatter's return value as tooltip innerHTML under the
// default renderMode ("html"), so an unescaped name is stored HTML injection.
describe('worldMapTooltipFormatter (#1054)', () => {
  it('escapes an HTML-metacharacter bean name in the per-bean-point branch', () => {
    const html = worldMapTooltipFormatter({
      seriesType: 'effectScatter',
      name: '<img src=x onerror=alert(1)>',
      data: { _region: null },
    });
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });

  it('escapes an HTML-metacharacter region alongside the bean name', () => {
    const html = worldMapTooltipFormatter({
      seriesType: 'effectScatter',
      name: 'Test Bean',
      data: { _region: '<script>alert(1)</script>' },
    });
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('escapes an HTML-metacharacter bean name in the country-stats branch', () => {
    const html = worldMapTooltipFormatter({
      seriesType: 'map',
      name: 'ET',
      data: {
        _stats: {
          shots: 3,
          beans: new Set(['<b>Evil</b> Bean']),
          beanShots: new Map([['<b>Evil</b> Bean', 3]]),
        },
      },
    });
    expect(html).not.toContain('<b>Evil</b>');
    expect(html).toContain('&lt;b&gt;Evil&lt;/b&gt; Bean');
  });
});
