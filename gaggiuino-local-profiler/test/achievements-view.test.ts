// #812: the achievements ("stamp card") view — public-src/views/achievements.js.
//
// These cover the four properties of the view that can break silently, i.e.
// without any visible error: a secret badge leaking its copy before it is
// unlocked, a stamp angle that re-jitters on every paint, a timestamp read in
// the wrong unit, and a category name that only exists in German.
import { describe, it, expect, beforeEach, vi } from 'vitest';

// state.js reads localStorage/navigator at module-load time, so the stubs have
// to exist before its import is evaluated — vi.hoisted() runs ahead of the
// hoisted import statements below. Same reason as test/api-token-client-
// storage.test.js's import-time stubbing. (navigator already exists in this
// runtime as a getter-only global, so state.js's navigator.language read
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

import de from '../public-src/i18n/de.js';
import en from '../public-src/i18n/en.js';
import itLang from '../public-src/i18n/it.js';
import fr from '../public-src/i18n/fr.js';
import es from '../public-src/i18n/es.js';
import nl from '../public-src/i18n/nl.js';

import { S } from '../public-src/state/index.js';
import { askewDeg, formatStampedOn, isCardFull, fieldHtml } from '../public-src/views/achievements.js';

// views/achievements.js's Achievement interface isn't exported; derive it from
// the functions under test so the fixtures stay shape-checked against it.
type Achievement = Parameters<typeof fieldHtml>[0];

const LANGS = { de, en, it: itLang, fr, es, nl };

// Mirrors CARD_KEYS/CARD_NAME_KEYS in the view (and CARD_KEYS in
// lib/achievements/registry.js). Spelled out rather than imported so that
// dropping a category from the view is a test failure, not a silently
// shorter loop.
const CARD_NAME_KEYS = [
  'ach_card_basics', 'ach_card_craft', 'ach_card_beans', 'ach_card_endurance',
  'ach_card_care', 'ach_card_house', 'ach_card_secret',
];
const CHROME_KEYS = [
  'nav_achievements', 'ach_card_of', 'ach_full', 'ach_stamped_on',
  'ach_progress', 'ach_not_yet', 'ach_secret_locked_hint',
];

describe('achievements view — i18n completeness', () => {
  it('every one of the 7 category names exists in all 6 languages', () => {
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
