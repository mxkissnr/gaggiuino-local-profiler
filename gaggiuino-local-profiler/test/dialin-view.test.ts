import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// views/dialin.ts pulls in state/index.ts (localStorage/navigator at module load)
// and i18n.ts — neither exists in the plain Node test environment, so stub the
// minimum before importing, same approach as maint-dashboard.test.ts.
const g = globalThis as unknown as Record<string, unknown>;

type DialinView = typeof import('../public-src/views/dialin.js');
type SharedModule = typeof import('../public-src/views/analytics/shared.js');
type BottomNavModule = typeof import('../public-src/components/bottom-nav.js');

let _dialinBeanOptions: DialinView['_dialinBeanOptions'];
let _dialinBeanKey: DialinView['_dialinBeanKey'];
let _dialinShots: DialinView['_dialinShots'];
let _dialinVerdictState: DialinView['_dialinVerdictState'];
let _dialinVerdictHtml: DialinView['_dialinVerdictHtml'];
let _dialinRowHtml: DialinView['_dialinRowHtml'];
let renderDialin: DialinView['renderDialin'];
let setDialinBean: DialinView['setDialinBean'];
let openDialinShot: DialinView['openDialinShot'];
let DIALIN_ALL_BEANS: DialinView['DIALIN_ALL_BEANS'];
let S: typeof import('../public-src/state/index.js').S;
let en: Record<string, unknown>;
let de: Record<string, unknown>;
let es: Record<string, unknown>;
let fr: Record<string, unknown>;
let itLang: Record<string, unknown>;
let nl: Record<string, unknown>;
let NAV_ITEMS: BottomNavModule['NAV_ITEMS'];
let _seedBeans: SharedModule['_beans'];
type ShotRow = SharedModule['ShotRow'];
type SharedBean = SharedModule['SharedBean'];

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_DIR = join(__dirname, '..');

beforeAll(async () => {
  Object.defineProperty(globalThis, 'localStorage', {
    value: { getItem: () => null, setItem: () => {} },
    configurable: true, writable: true,
  });
  Object.defineProperty(globalThis, 'navigator', {
    value: { language: 'en' },
    configurable: true, writable: true,
  });
  g.window = globalThis;
  ({ _dialinBeanOptions, _dialinBeanKey, _dialinShots, _dialinVerdictState, _dialinVerdictHtml,
     _dialinRowHtml, renderDialin, setDialinBean, openDialinShot, DIALIN_ALL_BEANS } =
    await import('../public-src/views/dialin.js'));
  ({ S } = await import('../public-src/state/index.js'));
  en = (await import('../public-src/i18n/en.js')).default;
  de = (await import('../public-src/i18n/de.js')).default;
  es = (await import('../public-src/i18n/es.js')).default;
  fr = (await import('../public-src/i18n/fr.js')).default;
  itLang = (await import('../public-src/i18n/it.js')).default;
  nl = (await import('../public-src/i18n/nl.js')).default;
  ({ NAV_ITEMS } = await import('../public-src/components/bottom-nav.js'));
  ({ _beans: _seedBeans } = await import('../public-src/views/analytics/shared.js'));
});

beforeEach(() => {
  S.currentLang = 'en';
  S.coffeeLibrary = { beans: [] } as unknown as typeof S.coffeeLibrary;
  S.shots = [];
  S.allShotsLoaded = true;
  S.shotsLoadFailed = false;
  delete g.document;
});

afterEach(() => {
  const w = g.window as Record<string, unknown> | undefined;
  if (w) delete w.calcShotScore;
});

describe('Dial-In naming (#1465)', () => {
  it('uses "Dial-In" for the nav entry and the page title in every language', () => {
    for (const [name, dict] of Object.entries({ en, de, es, fr, it: itLang, nl })) {
      expect(dict.nav_dialin, `${name} nav_dialin`).toBe('Dial-In');
      expect(dict.dialin_title, `${name} dialin_title`).toBe('Dial-In');
    }
  });

  it('labels the bottom-nav dialin entry "Dial-In"', () => {
    const entry = NAV_ITEMS.find(i => i.id === 'dialin');
    expect(entry?.label).toBe('Dial-In');
  });

  it('leaves no "Bezugslog" in the markup, the German docs, the German dictionary or the bottom nav', () => {
    for (const file of ['public-src/index.html', 'DOCS.de.md', 'public-src/i18n/de.ts', 'public-src/components/bottom-nav.ts']) {
      const text = readFileSync(join(REPO_DIR, file), 'utf8');
      expect(text, file).not.toContain('Bezugslog');
    }
  });
});

describe('_dialinVerdictState (#1465)', () => {
  it('reads a rising sequence as "almost there" and reports its trend', () => {
    const state = _dialinVerdictState([89, 84, 78, 72, 64], false);
    expect(state.kind).toBe('close');
    expect(state.newest).toBe(89);
    expect(state.trend).toBe(11);
    expect(state.seq).toEqual([78, 84, 89]);
  });

  it('reads three great scores in a row as dialled in', () => {
    expect(_dialinVerdictState([92, 90, 88], false).kind).toBe('dialled');
  });

  it('reads a newest good score after a bad run as not there yet', () => {
    expect(_dialinVerdictState([70, 90, 95], false).kind).toBe('off');
  });

  it('never judges across all beans', () => {
    expect(_dialinVerdictState([92, 90, 88], true).kind).toBe('last');
  });

  it('handles an unscored history', () => {
    const state = _dialinVerdictState([null, null], false);
    expect(state.kind).toBe('last');
    expect(state.newest).toBeNull();
    expect(state.trend).toBeNull();
  });

  it('has no trend from a single score', () => {
    const state = _dialinVerdictState([80], false);
    expect(state.trend).toBeNull();
    expect(state.seq).toEqual([]);
  });
});

describe('_dialinVerdictHtml (#1465)', () => {
  it('renders the verdict title, the sequence, the facts, the newest score and one bar per shot', () => {
    const scores = [89, 84, 78, 72, 64];
    const out = _dialinVerdictHtml(_dialinVerdictState(scores, false), scores, scores.length, 'Profil · Niche');
    expect(out).toContain('Almost there');
    expect(out).toContain('78 → 84 → 89 in the last 3 shots');
    expect(out).toContain('Profil · Niche');
    expect(out).toContain('score-great');
    expect(out).toContain('+11');
    expect(out.match(/<i /g) || []).toHaveLength(5);
  });
});

const shot = (id: number, over: Partial<ShotRow> = {}): ShotRow => ({
  id, timestamp: 1_700_000_000 + id, ...over,
});

const beans: SharedBean[] = [
  { id: 1, name: 'Bean A' },
  { id: 2, name: 'Bean B' },
];

describe('bean grouping (#1465)', () => {
  const shots = [
    shot(3, { annotation: { beanId: 1, coffee: 'Bean A' } }),
    shot(2, { annotation: { beanId: 2, coffee: 'Bean B' } }),
    shot(1, { annotation: { beanId: 1, coffee: 'Bean A' } }),
    shot(0, { annotation: {} }),
  ];

  it('offers each bean once, most recent first, skipping shots without one', () => {
    const options = _dialinBeanOptions(shots, beans);
    expect(options.map(o => o.label)).toEqual(['Bean A', 'Bean B']);
  });

  it('defaults to the newest shot\'s bean when nothing was chosen', () => {
    const options = _dialinBeanOptions(shots, beans);
    expect(_dialinBeanKey(null, options, shots[0], beans)).toBe('id:1');
    expect(_dialinBeanKey('all', options, shots[0], beans)).toBe(DIALIN_ALL_BEANS);
    expect(_dialinBeanKey('id:gone', options, shots[0], beans)).toBe('id:1');
  });

  it('keeps only the chosen bean\'s shots, or every shot for all beans', () => {
    const a = _dialinShots(shots, 'id:1', 5, beans).map(s => s.id);
    expect(a).toEqual([3, 1]);
    const all = _dialinShots(shots, DIALIN_ALL_BEANS, 2, beans).map(s => s.id);
    expect(all).toEqual([3, 2]);
  });

  it('seeds the library from the shared module for the render test', () => {
    S.coffeeLibrary = { beans } as unknown as typeof S.coffeeLibrary;
    expect(_seedBeans().map(b => b.name)).toEqual(['Bean A', 'Bean B']);
  });
});

describe('_dialinRowHtml (#1465)', () => {
  beforeEach(() => {
    g.window = globalThis;
  });

  it('points the grind arrow down when the grind got finer on the same grinder', () => {
    const newer = shot(2, { annotation: { grindSetting: '12', grinder: 'Niche' } });
    const older = shot(1, { annotation: { grindSetting: '13', grinder: 'Niche' } });
    const out = _dialinRowHtml(newer, older, 89, [], 'en-US');
    expect(out).toContain('dialin-grind-dir');
    expect(out).toContain('↓');
  });

  it('points it up when the grind got coarser', () => {
    const newer = shot(2, { annotation: { grindSetting: '14', grinder: 'Niche' } });
    const older = shot(1, { annotation: { grindSetting: '13', grinder: 'Niche' } });
    expect(_dialinRowHtml(newer, older, 89, [], 'en-US')).toContain('↑');
  });

  it('shows no arrow across two different grinders', () => {
    const newer = shot(2, { annotation: { grindSetting: '12', grinder: 'Niche' } });
    const older = shot(1, { annotation: { grindSetting: '13', grinder: 'Comandante' } });
    const out = _dialinRowHtml(newer, older, 89, [], 'en-US');
    expect(out).not.toContain('dialin-grind-dir');
  });

  it('spells out dose → yield and the ratio, the sub line and the row action', () => {
    (g.window as Record<string, unknown>).getShotDataById = () => ({ pressure: [{ x: 1, y: 0.5 }, { x: 2, y: 9 }, { x: 3, y: 9 }] });
    const s = shot(2, {
      weight: 362,
      annotation: { dose: 18, grindSetting: '12', grinder: 'Niche' },
    });
    const out = _dialinRowHtml(s, undefined, 89, ['Profil'], 'en-US');
    expect(out).toContain('18 → 36.2 g · 1:2.0');
    expect(out).toContain('9.0 bar');
    expect(out).toContain('score-great');
    expect(out).toContain('data-action="open-dialin-shot"');
    expect(out).toContain('Profil');
  });
});

interface FakeElement {
  value?: string;
  innerHTML: string;
  hidden?: boolean;
  children?: unknown[];
}

function installDom(ids: Record<string, FakeElement>): void {
  g.document = {
    getElementById: (id: string) => ids[id] ?? null,
    documentElement: { lang: 'en' },
    querySelectorAll: () => [],
    body: { classList: { add: () => {}, remove: () => {}, contains: () => false } },
  };
  g.window = globalThis;
}

describe('renderDialin (#1465)', () => {
  const threeShots = [
    shot(3, { weight: 360, profileName: 'Profil X', annotation: { beanId: 1, coffee: 'Bean A', grinder: 'Niche' }, duration: 280 }),
    shot(2, { weight: 350, profileName: 'Profil X', annotation: { beanId: 1, coffee: 'Bean A', grinder: 'Niche' }, duration: 270 }),
    shot(1, { weight: 340, profileName: 'Profil X', annotation: { beanId: 1, coffee: 'Bean A', grinder: 'Niche' }, duration: 260 }),
  ];

  beforeEach(() => {
    S.coffeeLibrary = { beans } as unknown as typeof S.coffeeLibrary;
    (g.window as Record<string, unknown>).calcShotScore = () => 90;
    (g.window as Record<string, unknown>).getShotDataById = () => ({ pressure: [{ x: 1, y: 90 }] });
    (g.window as Record<string, unknown>).ensureCurves = async () => {};
  });

  it('renders one shared verdict and one row per shot, not the repeated profile', async () => {
    S.shots = threeShots;
    const ids: Record<string, FakeElement> = {
      dialinCount: { value: '5', innerHTML: '' },
      dialinGrid: { innerHTML: '' },
      dialinVerdict: { innerHTML: '', hidden: true },
      dialinBeanSelect: { innerHTML: '', value: '' },
    };
    installDom(ids);

    await renderDialin();

    const grid = ids.dialinGrid!.innerHTML;
    expect((grid.match(/dialin-row/g) || [])).toHaveLength(3);
    expect(grid).toContain('data-action="open-dialin-shot"');
    const verdict = ids.dialinVerdict!.innerHTML;
    expect(verdict).toContain('Profil X');
    expect((verdict.match(/Profil X/g) || [])).toHaveLength(1);
    expect(grid).not.toContain('Profil X');
    expect(ids.dialinVerdict!.hidden).toBe(false);
    expect(ids.dialinBeanSelect!.innerHTML).toContain('All beans');
    expect(ids.dialinBeanSelect!.innerHTML).toContain('Bean A');
  });

  it('switches the verdict to "Last N shots" for all beans', async () => {
    S.shots = threeShots;
    const ids: Record<string, FakeElement> = {
      dialinCount: { value: '5', innerHTML: '' },
      dialinGrid: { innerHTML: '' },
      dialinVerdict: { innerHTML: '', hidden: true },
      dialinBeanSelect: { innerHTML: '', value: '' },
    };
    installDom(ids);
    setDialinBean('all');

    await renderDialin();

    expect(ids.dialinVerdict!.innerHTML).toContain('Last 3 shots');
  });

  it('explains an empty page and hides the verdict', async () => {
    S.shots = [];
    S.allShotsLoaded = true;
    const ids: Record<string, FakeElement> = {
      dialinCount: { value: '5', innerHTML: '' },
      dialinGrid: { innerHTML: '' },
      dialinVerdict: { innerHTML: '', hidden: false },
      dialinBeanSelect: { innerHTML: '', value: '' },
    };
    installDom(ids);

    await renderDialin();

    expect(ids.dialinGrid!.innerHTML).toContain('dialin-empty');
    expect(ids.dialinGrid!.innerHTML).toContain('No shots yet');
    expect(ids.dialinVerdict!.hidden).toBe(true);
  });
});

interface SheetHost {
  innerHTML: string;
  classList: { add: () => void; remove: () => void; contains: () => boolean };
  querySelector: () => unknown;
  style: Record<string, string>;
}

function makeSheetHost(): SheetHost {
  return {
    innerHTML: '',
    classList: { add: () => {}, remove: () => {}, contains: () => false },
    querySelector: () => null,
    style: {},
  };
}

function installSheetDom(host: SheetHost): void {
  g.window = {
    matchMedia: (q: string) => ({ matches: q.includes('max-width') ? true : false }),
    innerWidth: 390,
    innerHeight: 844,
  };
  g.document = {
    getElementById: (id: string) => (id === 'detailSheet' ? host : null),
    body: { classList: { add: () => {}, remove: () => {}, contains: () => false } },
    activeElement: null,
    contains: () => true,
    addEventListener: () => {},
    removeEventListener: () => {},
  };
}

describe('openDialinShot (#1465)', () => {
  it('fills the sheet with the shot date and a "Go to shot" action', async () => {
    S.coffeeLibrary = { beans } as unknown as typeof S.coffeeLibrary;
    (g.window as Record<string, unknown>).calcShotScore = () => 90;
    (g.window as Record<string, unknown>).getShotDataById = () => ({ pressure: [{ x: 1, y: 90 }] });
    (g.window as Record<string, unknown>).ensureCurves = async () => {};
    S.shots = [shot(7, { weight: 360, profileName: 'Profil X', annotation: { beanId: 1, coffee: 'Bean A' } })];

    const ids: Record<string, FakeElement> = {
      dialinCount: { value: '5', innerHTML: '' },
      dialinGrid: { innerHTML: '' },
      dialinVerdict: { innerHTML: '', hidden: true },
      dialinBeanSelect: { innerHTML: '', value: '' },
    };
    installDom(ids);
    await renderDialin();

    const host = makeSheetHost();
    installSheetDom(host);
    openDialinShot(7, null);

    expect(host.innerHTML).toContain('detailSheetTitle');
    expect(host.innerHTML).toContain('data-action="dialin-goto-shot"');
    expect(host.innerHTML).toContain('data-id="7"');
  });

  it('leaves the sheet alone for an unknown id', () => {
    const host = makeSheetHost();
    host.innerHTML = 'untouched';
    installSheetDom(host);
    openDialinShot(999, null);
    expect(host.innerHTML).toBe('untouched');
  });
});
