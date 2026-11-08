// #1922: the dev-channel score model and blind-rating settings. Both are
// dev-only: `dev.score_model` names the Go backend's registry entry the app
// shows, `dev.blind_rating` hides a shot's score until it has a star rating.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, it, expect, beforeEach, beforeAll, afterEach, vi } from 'vitest';
import type { ShotLike } from '../public-src/views/shots/utils.js';

// ui-prefs.ts (and the state module its import chain reaches) touch
// localStorage/navigator at module load, so the fakes go in before any import
// — the same pattern test/grind-baseline.test.ts uses.
const g = globalThis as unknown as Record<string, unknown>;
const _store = new Map<string, string>();
Object.defineProperty(globalThis, 'localStorage', {
  value: {
    getItem: (k: string) => (_store.has(k) ? _store.get(k) ?? null : null),
    setItem: (k: string, v: string) => { _store.set(k, String(v)); },
    removeItem: (k: string) => { _store.delete(k); },
  },
  configurable: true, writable: true,
});
Object.defineProperty(globalThis, 'navigator', {
  value: { language: 'en' },
  configurable: true, writable: true,
});

type DevSettings = typeof import('../public-src/components/dev-score-settings.js');
type UiPrefs = typeof import('../public-src/ui-prefs.js');
type ShotUtils = typeof import('../public-src/views/shots/utils.js');

let D: DevSettings;
let prefs: UiPrefs;
let shots: ShotUtils;

beforeAll(async () => {
  D = await import('../public-src/components/dev-score-settings.js');
  prefs = await import('../public-src/ui-prefs.js');
  shots = await import('../public-src/views/shots/utils.js');
});

interface FakeClassList {
  names: Set<string>;
  toggle(name: string, force?: boolean): boolean;
  contains(name: string): boolean;
}

function fakeClassList(names: string[] = []): FakeClassList {
  const set = new Set(names);
  return {
    names: set,
    toggle(name: string, force?: boolean): boolean {
      const on = force === undefined ? !set.has(name) : force;
      if (on) set.add(name); else set.delete(name);
      return on;
    },
    contains(name: string): boolean { return set.has(name); },
  };
}

function installDocument(options: { elements?: Record<string, unknown>; bodyClasses?: string[] } = {}): FakeClassList {
  const classList = fakeClassList(options.bodyClasses);
  const elements = options.elements ?? {};
  g.document = {
    body: { classList },
    activeElement: null,
    getElementById: (id: string) => elements[id] ?? null,
  };
  return classList;
}

function okResponse(): Response {
  return { ok: true, status: 200, json: () => Promise.resolve({}) } as unknown as Response;
}

beforeEach(async () => {
  _store.clear();
  g.fetch = () => Promise.resolve(okResponse());
  // ui-prefs keeps its values in module state, so clearing the cache above is
  // not enough to get back to the defaults between tests; flushing the queue
  // keeps the debounced PUT from firing later.
  prefs.setUiPref(D.BLIND_RATING_PREF, false);
  prefs.setUiPref(D.SCORE_MODEL_PREF, D.CLASSIC_SCORE_MODEL);
  await prefs.flushUiPrefsOnLeave();
  D.applyDevScoreSettings(false, undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  g.document = undefined;
  g.fetch = undefined;
});

describe('blindRatingActive (#1922)', () => {
  it('is off without the pref, on only while the build is not known to be stable', () => {
    expect(D.blindRatingActive(null, undefined)).toBe(false);
    expect(D.blindRatingActive(true, undefined)).toBe(false);
    expect(D.blindRatingActive(true, false)).toBe(false);
    expect(D.blindRatingActive(true, true)).toBe(true);
    // Unknown build (status not answered yet) counts as dev: no flash.
    expect(D.blindRatingActive(null, true)).toBe(true);
    // A stable build ignores a pref restored from a dev backup.
    expect(D.blindRatingActive(false, true)).toBe(false);
  });
});

describe('applyBlindRating (#1922)', () => {
  it('leaves the body class off with default prefs', () => {
    const classList = installDocument();
    D.applyBlindRating();
    expect(classList.names.has(D.BLIND_RATING_CLASS)).toBe(false);
  });

  it('sets the class for the pref on a dev build and clears it again on stable', () => {
    prefs.setUiPref(D.BLIND_RATING_PREF, true);
    const classList = installDocument();
    D.applyDevScoreSettings(true, ['classic']);
    expect(classList.names.has(D.BLIND_RATING_CLASS)).toBe(true);
    D.applyDevScoreSettings(false, undefined);
    expect(classList.names.has(D.BLIND_RATING_CLASS)).toBe(false);
  });

  it('flips the class when the pref changes', () => {
    const classList = installDocument();
    D.applyDevScoreSettings(true, ['classic']);
    expect(classList.names.has(D.BLIND_RATING_CLASS)).toBe(false);
    prefs.setUiPref(D.BLIND_RATING_PREF, true);
    D.applyBlindRating();
    expect(classList.names.has(D.BLIND_RATING_CLASS)).toBe(true);
    prefs.setUiPref(D.BLIND_RATING_PREF, false);
    D.applyBlindRating();
    expect(classList.names.has(D.BLIND_RATING_CLASS)).toBe(false);
  });

  it('does nothing without a document', () => {
    expect(() => D.applyBlindRating()).not.toThrow();
  });
});

describe('selectedScoreModel (#1922)', () => {
  it('keeps a stored id the server still lists', () => {
    expect(D.selectedScoreModel(['classic', 'test_x'], 'test_x')).toBe('test_x');
  });

  it('falls back to classic for unknown, non-string or missing values', () => {
    expect(D.selectedScoreModel(['classic'], 'gone')).toBe(D.CLASSIC_SCORE_MODEL);
    expect(D.selectedScoreModel(['classic'], 3)).toBe(D.CLASSIC_SCORE_MODEL);
    expect(D.selectedScoreModel(['classic'], undefined)).toBe(D.CLASSIC_SCORE_MODEL);
  });
});

describe('onScoreModelChange (#1922)', () => {
  it('stores the id, flushes it to the server and reloads once', async () => {
    const reload = vi.fn();
    await D.onScoreModelChange('test_x', reload);
    expect(prefs.getUiPref<string>(D.SCORE_MODEL_PREF)).toBe('test_x');
    expect(reload).toHaveBeenCalledTimes(1);
    const cached = JSON.parse(_store.get('glp_ui_prefs') ?? '{}') as Record<string, unknown>;
    expect(cached[D.SCORE_MODEL_PREF]).toBe('test_x');
  });
});

describe('applyDevScoreSettings on a stable build (#1922)', () => {
  it('never touches the controls', () => {
    const select = {
      dataset: {} as Record<string, string>,
      value: '',
      replaceChildren: vi.fn(),
      onchange: null as unknown,
    };
    const box = { checked: false, onchange: null as unknown };
    installDocument({ elements: { devScoreModel: select, devBlindRating: box } });
    D.applyDevScoreSettings(false, ['classic']);
    expect(select.replaceChildren).not.toHaveBeenCalled();
    expect(select.value).toBe('');
    expect(box.checked).toBe(false);
    expect(box.onchange).toBeNull();
  });
});

interface ParityCase { shot: unknown; expected: number | null }

describe('score shown verbatim (#1922)', () => {

  it('renders the server score unchanged for every parity fixture', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const cases = JSON.parse(
      readFileSync(join(here, 'fixtures', 'score-parity.json'), 'utf8'),
    ) as ParityCase[];
    expect(cases.length).toBeGreaterThan(0);
    for (const c of cases) {
      if (c.expected === null) continue;
      const shot = { ...(c.shot as Record<string, unknown>), score: c.expected } as unknown as ShotLike;
      expect(shots.calcShotScore(shot)).toBe(c.expected);
    }
  });

  it('hides nothing with default prefs', () => {
    const stored = prefs.getUiPref(D.BLIND_RATING_PREF);
    expect(D.blindRatingActive(null, stored)).toBe(false);
    expect(D.blindRatingActive(true, stored)).toBe(false);
    expect(D.blindRatingActive(false, stored)).toBe(false);
  });
});

describe('blind-rating CSS and markup contract (#1922)', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const read = (rel: string): string => readFileSync(join(here, '..', rel), 'utf8');

  it('style.css carries both blind-rating selectors', () => {
    const css = read('public-src/style.css');
    expect(css).toContain('body.glp-blind-rating .shot:not(:has(.stars)) .sidebar-score');
    expect(css).toContain('body.glp-blind-rating:not(:has(#starRating .star.active)) #verdictHeader .verdict-line');
  });

  it('the sidebar row still emits the score pill and the rated-only stars', () => {
    const sidebar = read('public-src/components/sidebar.ts');
    expect(sidebar).toContain('sidebar-score');
    expect(sidebar).toContain('class="stars"');
  });

  it('renderStars still toggles .active inside #starRating', () => {
    const annotation = read('public-src/views/shots/annotation.ts');
    expect(annotation).toContain("'#starRating .star'");
    expect(annotation).toContain("'active'");
  });
});
