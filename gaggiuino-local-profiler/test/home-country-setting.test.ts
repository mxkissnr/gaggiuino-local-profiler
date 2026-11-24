import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';

// #2210: the Home country select boot module. Its imports read globals at load
// (state/i18n, ui-prefs), so stub localStorage/navigator before importing, the
// same minimal fakes the analytics tests use.

// vi.mock is hoisted above the imports, so the in-memory store has to exist
// before the factories run.
const prefs = vi.hoisted(() => new Map<string, unknown>());

vi.mock('../public-src/components/mode.js', () => ({ switchMode: vi.fn() }));
vi.mock('../public-src/boot/settings-page.js', () => ({ openSettingsPage: vi.fn() }));
vi.mock('../public-src/ui-prefs.js', () => ({
  getUiPref: (k: string) => prefs.get(k),
  setUiPref: vi.fn((k: string, v: unknown) => { prefs.set(k, v); }),
}));
// Precedent (analytics-bean-shelf.test.ts): keep the real module, replace the
// one function the DOM-free test cannot run.
vi.mock('../public-src/views/analytics/world-map.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../public-src/views/analytics/world-map.js')>()),
  refreshWorldMapHome: vi.fn(() => false),
}));

type HomeCountryModule = typeof import('../public-src/boot/home-country.js');
let mod: HomeCountryModule;
let switchMode: ReturnType<typeof vi.fn>;
let openSettingsPage: ReturnType<typeof vi.fn>;
let setUiPref: ReturnType<typeof vi.fn>;
let refreshWorldMapHome: ReturnType<typeof vi.fn>;
let S: (typeof import('../public-src/state/index.js'))['S'];
let HOME_COUNTRY_NUM: (typeof import('../public-src/constants.js'))['HOME_COUNTRY_NUM'];

interface FakeSelect extends EventTarget {
  options: { value: string; textContent?: string }[];
  value: string;
  remove(i: number): void;
  appendChild(o: { value: string; textContent?: string }): void;
  focus: ReturnType<typeof vi.fn>;
}

let select: FakeSelect;
let link: EventTarget;

beforeAll(async () => {
  Object.defineProperty(globalThis, 'localStorage', {
    value: { getItem: () => null, setItem: () => {} },
    configurable: true, writable: true,
  });
  Object.defineProperty(globalThis, 'navigator', {
    value: { language: 'en-US' },
    configurable: true, writable: true,
  });
  mod = await import('../public-src/boot/home-country.js');
  switchMode = (await import('../public-src/components/mode.js')).switchMode as unknown as ReturnType<typeof vi.fn>;
  openSettingsPage = (await import('../public-src/boot/settings-page.js')).openSettingsPage as unknown as ReturnType<typeof vi.fn>;
  setUiPref = (await import('../public-src/ui-prefs.js')).setUiPref as unknown as ReturnType<typeof vi.fn>;
  refreshWorldMapHome = (await import('../public-src/views/analytics/world-map.js')).refreshWorldMapHome as unknown as ReturnType<typeof vi.fn>;
  S = (await import('../public-src/state/index.js')).S;
  HOME_COUNTRY_NUM = (await import('../public-src/constants.js')).HOME_COUNTRY_NUM;
});

beforeEach(() => {
  vi.clearAllMocks();
  prefs.clear();
  const fake = Object.assign(new EventTarget(), {
    options: [{ value: '' }, { value: 'none' }] as { value: string; textContent?: string }[],
    value: '',
    focus: vi.fn(),
  });
  select = Object.assign(fake, {
    remove: (i: number) => { fake.options.splice(i, 1); },
    appendChild: (o: { value: string; textContent?: string }) => { fake.options.push(o); },
  }) as FakeSelect;
  link = new EventTarget();
  Object.defineProperty(globalThis, 'document', {
    value: {
      getElementById: (id: string) => {
        if (id === 'settingsHomeCountry') return select;
        if (id === 'worldMapSetHome') return link;
        return null;
      },
      createElement: () => ({ value: '', textContent: '' }),
    },
    configurable: true, writable: true,
  });
});

describe('homeCountryOptions (#2210)', () => {
  it('lists every map home country sorted by name in the UI language', () => {
    const en = mod.homeCountryOptions('en');
    expect(en).toHaveLength(20);
    expect(new Set(en.map(([code]) => code))).toEqual(new Set(Object.keys(HOME_COUNTRY_NUM)));
    expect(en.slice(0, 2).map(([code]) => code)).toEqual(['AU', 'AT']);

    const de = mod.homeCountryOptions('de').map(([code]) => code);
    expect(de.slice(de.indexOf('NO'), de.indexOf('NO') + 2)).toEqual(['NO', 'AT']); // Norwegen, Österreich
  });
});

describe('homeCountrySelectValue (#2210)', () => {
  it('maps the stored setting to the select value', () => {
    expect(mod.homeCountrySelectValue(undefined)).toBe('');
    expect(mod.homeCountrySelectValue('')).toBe('');
    expect(mod.homeCountrySelectValue('none')).toBe('none');
    expect(mod.homeCountrySelectValue('DE')).toBe('DE');
    expect(mod.homeCountrySelectValue('XX')).toBe('');
    expect(mod.homeCountrySelectValue('de')).toBe('');
  });
});

describe('renderHomeCountrySelect (#2210)', () => {
  it('keeps the two fixed options and adds the countries once', () => {
    S.currentLang = 'en';
    mod.renderHomeCountrySelect();
    mod.renderHomeCountrySelect();
    expect(select.options).toHaveLength(22);
    expect(select.options[0]?.value).toBe('');
    expect(select.options[1]?.value).toBe('none');

    prefs.set('analytics.home_country', 'FR');
    mod.renderHomeCountrySelect();
    expect(select.value).toBe('FR');
  });
});

describe('wireHomeCountrySetting (#2210)', () => {
  it('changing the select stores the choice', () => {
    S.currentLang = 'en';
    mod.wireHomeCountrySetting();
    select.value = 'IT';
    select.dispatchEvent(new Event('change'));
    expect(setUiPref).toHaveBeenCalledWith('analytics.home_country', 'IT');

    select.value = '';
    select.dispatchEvent(new Event('change'));
    expect(setUiPref).toHaveBeenCalledWith('analytics.home_country', '');
  });

  it('the map link opens Settings > Appearance at the select', () => {
    S.currentLang = 'en';
    mod.wireHomeCountrySetting();
    link.dispatchEvent(new Event('click'));
    expect(switchMode).toHaveBeenCalledWith('settings');
    expect(openSettingsPage).toHaveBeenCalledWith('appearance');
    expect(select.focus).toHaveBeenCalledTimes(1);
  });
});

describe('syncHomeCountrySetting (#2210)', () => {
  it('shows the stored choice and asks the map to refresh', () => {
    S.currentLang = 'en';
    prefs.set('analytics.home_country', 'none');
    mod.syncHomeCountrySetting();
    expect(select.value).toBe('none');
    expect(refreshWorldMapHome).toHaveBeenCalledTimes(1);
  });
});
