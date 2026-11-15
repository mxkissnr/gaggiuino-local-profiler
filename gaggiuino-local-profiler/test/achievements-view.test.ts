// #812: the achievements ("stamp card") view — public-src/views/achievements.ts.
//
// These cover the four properties of the view that can break silently, i.e.
// without any visible error: a secret badge leaking its copy before it is
// unlocked, a stamp angle that re-jitters on every paint, a timestamp read in
// the wrong unit, and a category name that only exists in German.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// state/index.ts reads localStorage/navigator at module-load time, so the stubs have
// to exist before its import is evaluated — vi.hoisted() runs ahead of the
// hoisted import statements below. Same reason as test/api-token-client-
// storage.test.ts's import-time stubbing. (navigator already exists in this
// runtime as a getter-only global, so state/index.ts's navigator.language read
// needs no stub.)
vi.hoisted(() => {
  // vitest's node environment has no browser globals; stub localStorage
  // through a loose view of globalThis (the same bridge
  // test/helpers/fake-option-dom.ts uses for the DOM).

  const g = globalThis as unknown as Record<string, unknown>;
  const store = new Map<string, string>();
  g.localStorage = {
    getItem: (k: string) => (store.has(k) ? store.get(k) : null),
    setItem: (k: string, v: string) => store.set(k, String(v)),
    removeItem: (k: string) => store.delete(k),
  };
});

// The view's only API call; hoisted so the mock is in place before
// views/achievements.ts is evaluated, like the localStorage stub above.
const api = vi.hoisted(() => ({ getAchievements: vi.fn() }));
vi.mock('../public-src/api/system.js', () => ({ getAchievements: api.getAchievements }));

import de from '../public-src/i18n/de.js';
import en from '../public-src/i18n/en.js';
import itLang from '../public-src/i18n/it.js';
import fr from '../public-src/i18n/fr.js';
import es from '../public-src/i18n/es.js';
import nl from '../public-src/i18n/nl.js';

import { S } from '../public-src/state/index.js';
import { localeFor } from '../public-src/constants.js';
import { formatDate } from '../public-src/utils.js';
import {
  achDetail, achPageHtml, achUpcoming, achVerdictHtml, askewDeg, fieldHtml, formatStampedOn,
  isCardFull, loadAchievementsView, openAchievement,
} from '../public-src/views/achievements.js';

// views/achievements.ts's Achievement interface isn't exported; derive it from
// the functions under test so the fixtures stay shape-checked against it.
type Achievement = Parameters<typeof fieldHtml>[0];

const LANGS = { de, en, it: itLang, fr, es, nl };

// Mirrors CARD_KEYS/CARD_NAME_KEYS in the view (and CARD_KEYS in
// the achievement registry). Spelled out rather than imported so that
// dropping a category from the view is a test failure, not a silently
// shorter loop.
const CARD_NAME_KEYS = [
  'ach_card_basics', 'ach_card_craft', 'ach_card_beans', 'ach_card_endurance',
  'ach_card_moments', 'ach_card_care', 'ach_card_house', 'ach_card_secret',
];
const CHROME_KEYS = [
  'nav_achievements', 'ach_full', 'ach_stamped_on',
  'ach_progress', 'ach_not_yet', 'ach_secret_locked_hint',
  'ach_verdict_of', 'ach_verdict_next', 'ach_verdict_open', 'ach_verdict_all',
  'ach_soon', 'ach_recent', 'ach_filter_got', 'ach_filter_open',
];

// A full English fixture: one unlocked of six, three with a started counter, a
// locked secret badge and one counter still at zero. streak_7 leads (5/7 beats
// 294/500), so it is the stamp the verdict names.
const STAMP = { stamp: 'gear' };
const FIXTURE: Achievement[] = [
  { id: 'shots_10', card: 'basics', ...STAMP, progress: { current: 3, target: 10 } },
  { id: 'streak_7', card: 'endurance', ...STAMP, progress: { current: 5, target: 7 } },
  { id: 'shots_500', card: 'craft', ...STAMP, progress: { current: 294, target: 500 } },
  { id: 'shots_100', card: 'craft', ...STAMP, progress: { current: 0, target: 100 } },
  { id: 'secret_night_owl', card: 'secret', secret: true, ...STAMP },
  { id: 'countries_10', card: 'beans', unlocked: true, unlockedAt: 1_772_000_000, ...STAMP },
];

describe('achievements view — i18n completeness', () => {
  it('every one of the 8 category names exists in all 6 languages', () => {
    for (const [lang, dict] of Object.entries(LANGS)) {
      for (const key of CARD_NAME_KEYS) {
        expect(dict[key], `missing translation: ${lang}:${key}`).toBeTruthy();
      }
    }
  });

  it('every UI chrome string of the stamp card exists in all 6 languages', () => {
    for (const [lang, dict] of Object.entries(LANGS)) {
      for (const key of CHROME_KEYS) {
        expect(dict[key], `missing translation: ${lang}:${key}`).toBeTruthy();
      }
    }
  });

  it('no longer carries the strings of the removed arrows, dots and detail box', () => {
    for (const [lang, dict] of Object.entries(LANGS)) {
      for (const key of ['ach_card_of', 'ach_prev', 'ach_next', 'ach_tap_hint']) {
        expect(dict[key], `${lang} still defines ${key}`).toBeUndefined();
      }
      // One argument now: the date and the time come as one formatted string.
      expect((dict.ach_stamped_on as (when: string) => string).length, `${lang}:ach_stamped_on arity`).toBe(1);
    }
  });
});

describe('achievements view — a locked secret badge leaks nothing', () => {
  it('renders neither name nor description for a secret badge that is still locked', () => {
    // The API never sends name/description for a locked secret badge, but a
    // stale cache or a future refactor could. Feed them in deliberately: the
    // view must not render them either way.
    const html = fieldHtml({
      id: 'secret_night_owl', card: 'secret', secret: true, unlocked: false,
      name: 'Night Owl', description: 'Pulled a shot after 2 a.m.',
    } as Achievement);
    expect(html).not.toContain('Night Owl');
    expect(html).not.toContain('2 a.m.');
    expect(html, 'a locked secret field should carry the "?" placeholder').toContain('ach-qm');
  });

  it('renders the stamp once the same secret badge is unlocked', () => {
    const html = fieldHtml({
      id: 'secret_night_owl', card: 'secret', secret: true, unlocked: true,
      unlockedAt: 1_772_000_000, stamp: 'moon', name: 'Night Owl', description: 'x',
    });
    expect(html).toContain('ach-ink');
    expect(html).not.toContain('ach-qm');
  });
});

describe('achievements view — stamps sit still', () => {
  it('gives the same badge the same angle every time it is asked', () => {
    for (const id of ['first_shot', 'hundred', 'secret_night_owl', 'a']) {
      expect(askewDeg(id), `angle drifted for "${id}"`).toBe(askewDeg(id));
    }
  });

  it('keeps every angle inside the -7..7 degree range', () => {
    for (const id of ['first_shot', 'hundred', 'patient', 'rested', 'highland', 'zz']) {
      const deg = askewDeg(id);
      expect(deg, `${id} rotated out of range`).toBeGreaterThanOrEqual(-7);
      expect(deg).toBeLessThanOrEqual(7);
    }
  });

  it('does not give every badge the same angle', () => {
    const ids = ['first_shot', 'hundred', 'patient', 'rested', 'highland', 'washed', 'natural'];
    expect(new Set(ids.map(askewDeg)).size).toBeGreaterThan(1);
  });
});

describe('achievements view — unlockedAt is Unix seconds', () => {
  beforeEach(() => { S.currentLang = 'de'; });

  it('formats a seconds timestamp as its real date, not as 1970', () => {
    // 2026-03-12 08:14:00 UTC
    const seconds = Math.floor(Date.UTC(2026, 2, 12, 8, 14, 0) / 1000);
    const out = formatStampedOn(seconds, 'de');
    expect(out, 'timestamp was read as milliseconds').toContain('2026');
    expect(out).not.toContain('1970');
  });

  it('takes the date and the time from the shared date helper', () => {
    const seconds = Math.floor(Date.UTC(2026, 2, 12, 8, 14, 0) / 1000);
    expect(formatStampedOn(seconds, 'de'))
      .toBe((de.ach_stamped_on as (when: string) => string)(formatDate(seconds * 1000, localeFor('de'), 'short', true)));
  });

  it('has no date formatter of its own left in the view', () => {
    const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../public-src/views/achievements.ts'), 'utf8');
    expect(source).not.toContain('toLocaleTimeString');
    expect(source).not.toContain('toLocaleDateString');
  });
});

describe('achievements view — the "Full" overprint', () => {
  const badge = (id: string, unlocked: boolean): Achievement =>
    ({ id, card: 'basics', secret: false, unlocked } as Achievement);

  it('treats a card whose badges are all unlocked as full', () => {
    expect(isCardFull([badge('a', true), badge('b', true)])).toBe(true);
  });

  it('does not treat a card that is one badge short as full', () => {
    expect(isCardFull([badge('a', true), badge('b', false)])).toBe(false);
  });

  it('does not treat an empty card as full', () => {
    expect(isCardFull([])).toBe(false);
  });
});

describe('achievements view — what comes next', () => {
  it('orders the started counters by share, then by the fewest left', () => {
    const order = achUpcoming(FIXTURE).map(b => b.id);
    // 5/7 beats 294/500 beats 3/10; 0/100 has not started and never appears.
    expect(order).toEqual(['streak_7', 'shots_500', 'shots_10']);
  });

  it('prefers the one with fewer left when the shares are equal', () => {
    const badges: Achievement[] = [
      { id: 'long', card: 'basics', stamp: 'gear', progress: { current: 50, target: 100 } },
      { id: 'short', card: 'basics', stamp: 'gear', progress: { current: 5, target: 10 } },
    ];
    expect(achUpcoming(badges).map(b => b.id)).toEqual(['short', 'long']);
  });
});

describe('achievements view — the verdict', () => {
  beforeEach(() => { S.currentLang = 'en'; });

  it('shows the collected count as the big number and names the next stamp', () => {
    const out = achVerdictHtml(FIXTURE);
    expect(out).toContain('analytics-verdict-score-num serif-display');
    expect(out).toContain('>1</span>');
    expect(out).toContain('of 6 stamps');
    expect(out).toContain('Next up: Streak');
    expect(out).toContain('5 of 7');
  });

  it('says how many stamps are still open when none has a started counter', () => {
    const badges: Achievement[] = [
      { id: 'a', card: 'basics', stamp: 'gear', unlocked: true },
      { id: 'b', card: 'basics', stamp: 'gear', unlocked: true },
      { id: 'c', card: 'basics', stamp: 'gear' },
      { id: 'd', card: 'basics', stamp: 'gear' },
      { id: 'e', card: 'basics', stamp: 'gear' },
    ];
    expect(achVerdictHtml(badges)).toContain('3 stamps still open');
  });

  it('says every stamp is collected when the card is complete', () => {
    const badges = FIXTURE.map(b => ({ ...b, unlocked: true, progress: null }));
    expect(achVerdictHtml(badges)).toContain('Every stamp collected');
  });
});

describe('achievements view — the details in the sheet', () => {
  beforeEach(() => { S.currentLang = 'en'; });

  it('names the stamp, its category, its description and when it was stamped', () => {
    const d = achDetail({
      id: 'countries_10', card: 'beans', stamp: 'globe', unlocked: true,
      unlockedAt: 1_772_000_000,
    });
    expect(d.title).toBe('Globetrotter');
    expect(d.sub).toBe(en.ach_card_beans);
    expect(d.body).toContain('Beans from ten different countries.');
    expect(d.body).toContain('Stamped on');
  });

  it('draws a progress bar for a locked stamp with a started counter', () => {
    const d = achDetail({ id: 'streak_7', card: 'endurance', stamp: 'flame', progress: { current: 5, target: 7 } });
    expect(d.body).toContain('ach-bar');
    expect(d.body).toContain('width:71%');
  });

  it('says nothing about a locked secret stamp, even when the record carries its copy', () => {
    const d = achDetail({
      id: 'secret_night_owl', card: 'secret', stamp: 'moon', secret: true, unlocked: false,
      name: 'Night Owl', description: 'Pulled a shot after 2 a.m.',
    } as Achievement);
    expect(d.title).toBe('Secret');
    expect(d.sub).toBe('');
    expect(d.body).not.toContain('Night Owl');
    expect(d.body).not.toContain('2 a.m.');
  });
});

describe('achievements view — the page shell', () => {
  beforeEach(() => { S.currentLang = 'en'; });

  it('offers eight category chips with exactly one of them pressed', () => {
    const markup = achPageHtml(FIXTURE, 'craft', 'all');
    expect([...markup.matchAll(/data-ach-card="/g)]).toHaveLength(8);
    const pressed = [...markup.matchAll(/data-ach-card="([a-z]+)" aria-pressed="true"/g)].map(m => m[1]);
    expect(pressed).toEqual(['craft']);
  });

  it('shows only the chosen category page', () => {
    const markup = achPageHtml(FIXTURE, 'craft', 'all');
    const pages = [...markup.matchAll(/data-ach-page="([a-z]+)"( hidden)?/g)];
    expect(pages).toHaveLength(8);
    expect(pages.filter(p => !p[2]).map(p => p[1])).toEqual(['craft']);
  });

  it('carries the filter on the layout and presses only the matching chip', () => {
    const markup = achPageHtml(FIXTURE, 'basics', 'open');
    expect(markup).toContain('data-ach-filter="open"');
    const chips = [...markup.matchAll(/data-ach-show="([a-z]+)" aria-pressed="(true|false)"/g)]
      .filter(m => m[2] === 'true')
      .map(m => m[1]);
    expect(chips).toEqual(['open']);
  });

  it('has no trace of the removed arrows, dots, card line or detail box', () => {
    const markup = achPageHtml(FIXTURE, 'basics', 'all');
    for (const gone of ['ach-pdot', 'ach-pg', 'achFine', 'achDetail']) {
      expect(markup, `${gone} is still in the markup`).not.toContain(gone);
    }
  });

  it('never prints a locked secret stamp name or description', () => {
    const badges: Achievement[] = [{
      id: 'secret_night_owl', card: 'secret', stamp: 'moon', secret: true, unlocked: false,
      name: 'Night Owl', description: 'Pulled a shot after 2 a.m.',
    }];
    const markup = achPageHtml(badges, 'secret', 'all');
    expect(markup).not.toContain('Night Owl');
    expect(markup).not.toContain('2 a.m.');
  });
});

interface FakeEl {
  innerHTML: string;
  dataset: Record<string, string>;
  classList: { add: () => void; remove: () => void; contains: () => boolean };
  querySelector: () => null;
  addEventListener: (type: string, fn: unknown) => void;
}

function makeEl(): FakeEl {
  return {
    innerHTML: '',
    dataset: {},
    classList: { add: () => {}, remove: () => {}, contains: () => false },
    querySelector: () => null,
    addEventListener: () => {},
  };
}

describe('achievements view — opening a stamp from the loaded page', () => {
  const g = globalThis as unknown as Record<string, unknown>;

  function installDom(container: FakeEl, host: FakeEl): void {
    g.window = { matchMedia: () => ({ matches: true }), innerWidth: 390, innerHeight: 844 };
    g.document = {
      getElementById: (id: string) => (id === 'achievements-view' ? container : id === 'detailSheet' ? host : null),
      querySelector: () => null,
      querySelectorAll: () => [],
      body: { classList: { add: () => {}, remove: () => {}, contains: () => false } },
      activeElement: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      contains: () => true,
    };
  }

  afterEach(() => {
    delete g.document;
    delete g.window;
    api.getAchievements.mockReset();
  });

  it('fills the shared sheet with the stamp it was clicked for', async () => {
    S.currentLang = 'en';
    const container = makeEl();
    const host = makeEl();
    installDom(container, host);
    api.getAchievements.mockResolvedValue({ json: async () => ({ badges: FIXTURE }) });

    await loadAchievementsView();
    expect(container.innerHTML).toContain('data-ach-card="basics"');

    openAchievement('countries_10');
    expect(host.innerHTML).toContain('detailSheetTitle');
    expect(host.innerHTML).toContain('Globetrotter');
  });

  it('leaves the sheet alone for an unknown id', async () => {
    S.currentLang = 'en';
    const container = makeEl();
    const host = makeEl();
    installDom(container, host);
    api.getAchievements.mockResolvedValue({ json: async () => ({ badges: FIXTURE }) });

    await loadAchievementsView();
    host.innerHTML = 'untouched';
    openAchievement('nope');
    expect(host.innerHTML).toBe('untouched');
  });
});
