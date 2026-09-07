// #812: the achievements backend.
//
// CLAUDE.md's regression policy is explicit about what these have to prove,
// because the gap it warns about shipped a real bug before (#638/#641/#643/
// #648): a test that only shows a row can be written proves nothing about
// whether anything actually unlocks. So the central test here drives a STATE
// CHANGE — no shots, evaluate, nothing stamped; add a shot, evaluate again,
// the badge appears — rather than calling the repository directly.
import { describe, it, expect, beforeEach } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

const Database = require('better-sqlite3');
const dbPath = require.resolve('../lib/db');
const realDb = require(dbPath);

// The DB stub has to be installed BEFORE anything that reaches for getDb is
// loaded — the repositories and services destructure it at require time, so a
// stub applied later leaves them holding the real, file-backed handle. Same
// approach as test/status-machines-theme.test.js.
const memDb = new Database(':memory:');
realDb.initSchema(memDb);
require.cache[dbPath].exports = { ...realDb, getDb: () => memDb };

const registry = require('../lib/achievements/registry.js');
const repo     = require('../lib/repositories/AchievementRepository.js');
const service  = require('../lib/services/AchievementService.js');

function resetState() {
  memDb.prepare('DELETE FROM achievements').run();
  memDb.prepare('DELETE FROM shots').run();
}

describe('achievements registry (#812)', () => {
  it('carries 54 badges across the 7 cards', () => {
    expect(registry.BADGES).toHaveLength(54);
    expect(registry.CARD_KEYS).toHaveLength(7);
  });

  it('every badge id is unique — ids are the DB primary key', () => {
    const ids = registry.BADGES.map(b => b.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('every badge belongs to a declared card and has a check()', () => {
    for (const b of registry.BADGES) {
      expect(registry.CARD_KEYS, `${b.id} has card "${b.card}"`).toContain(b.card);
      expect(typeof b.check, `${b.id} has no check()`).toBe('function');
    }
  });

  it('a badge declaring progress also declares the target it counts toward', () => {
    for (const b of registry.BADGES) {
      if (b.progress) expect(typeof b.progressTarget, `${b.id}`).toBe('number');
    }
  });
});

describe('achievement copy is complete in all six languages (#812)', () => {
  // The point of this test: without it a badge ships showing its raw id, or
  // silently in German, to anyone not running the language it was written in.
  const LANGS = ['de', 'en', 'it', 'fr', 'es', 'nl'];
  it('every non-secret badge has a name and description in every language', async () => {
    const missing = [];
    for (const lang of LANGS) {
      const mod = await import(`../public-src/i18n/${lang}.js`);
      const dict = mod.default;
      for (const b of registry.BADGES) {
        if (registry.SECRET_IDS.includes(b.id)) continue;   // encoded server-side on purpose
        for (const suffix of ['n', 'd']) {
          const key = `ach_${b.id}_${suffix}`;
          if (!dict[key] || !String(dict[key]).trim()) missing.push(`${lang}:${key}`);
        }
      }
    }
    expect(missing, `missing badge copy: ${missing.join(', ')}`).toEqual([]);
  });

  it('secret badge copy is NOT in the public bundle', async () => {
    // If this fails, the encoded-server-side scheme has been undone and the
    // surprise is readable by anyone who opens the JS bundle.
    for (const lang of LANGS) {
      const dict = (await import(`../public-src/i18n/${lang}.js`)).default;
      for (const id of registry.SECRET_IDS) {
        expect(dict[`ach_${id}_n`], `${lang}: ${id} leaked into i18n`).toBeUndefined();
      }
    }
  });
});

describe('achievement evaluation (#812)', () => {
  beforeEach(() => { resetState(); });

  it('a STATE CHANGE unlocks a badge — not merely writing the row', () => {

    // Nothing brewed yet: the first-shot badge must stay locked.
    service.evaluateAll();
    expect(repo.getAll().first_shot?.unlockedAt, 'stamped with no shots').toBeFalsy();

    // The state change: one shot exists now.
    memDb.prepare(
      `INSERT INTO shots (id, machine_id, timestamp, duration, data)
       VALUES (1, 1, ?, 280, '{}')`
    ).run(Math.floor(Date.now() / 1000));

    const unlocked = service.evaluateAll();
    expect(unlocked, 'first_shot did not unlock after a shot was saved').toContain('first_shot');
    expect(repo.getAll().first_shot.unlockedAt).toBeGreaterThan(0);
  });

  it('evaluates retroactively — an existing history stamps on the first run', () => {
    const now = Math.floor(Date.now() / 1000);
    const insert = memDb.prepare(
      `INSERT INTO shots (id, machine_id, timestamp, duration, data) VALUES (?, 1, ?, 280, '{}')`);
    for (let i = 1; i <= 12; i++) insert.run(i, now - i * 3600);

    service.evaluateAll();
    const state = repo.getAll();
    // Someone who already had a dozen shots before this feature existed must
    // not have to brew ten more to earn the ten-shot badge.
    expect(state.first_shot?.unlockedAt, 'first_shot not stamped retroactively').toBeGreaterThan(0);
    expect(state.shots_10?.unlockedAt, 'shots_10 not stamped retroactively').toBeGreaterThan(0);
  });

  it('is idempotent — a second pass neither re-stamps nor duplicates', () => {
    memDb.prepare(
      `INSERT INTO shots (id, machine_id, timestamp, duration, data) VALUES (1, 1, ?, 280, '{}')`
    ).run(Math.floor(Date.now() / 1000));

    service.evaluateAll();
    const firstAt = repo.getAll().first_shot.unlockedAt;

    const second = service.evaluateAll();
    expect(second, 'a settled install re-reported unlocks').not.toContain('first_shot');
    expect(repo.getAll().first_shot.unlockedAt, 'unlock timestamp moved').toBe(firstAt);
    expect(memDb.prepare('SELECT COUNT(*) c FROM achievements WHERE id = ?').get('first_shot').c).toBe(1);
  });

  // #978: a progress-tracked badge (progressTarget set) calls setProgress()
  // on every pass while still locked, which writes a row with unlocked_at
  // NULL well before the badge actually crosses its target -- unlike the
  // tests above, which only ever call evaluateAll() once the badge is
  // already crossable, and so never exercise a pre-existing progress row.
  // The old `INSERT OR IGNORE` in AchievementRepository.unlock() silently
  // no-op'd against that already-existing row: unlocked_at stayed NULL
  // forever, and every subsequent evaluateAll() call kept re-reporting
  // shots_10 as newly unlocked, without end.
  it('actually unlocks a progress-tracked badge once its target is crossed gradually', () => {
    const insert = memDb.prepare(
      `INSERT INTO shots (id, machine_id, timestamp, duration, data) VALUES (?, 1, ?, 280, '{}')`);
    const now = Math.floor(Date.now() / 1000);

    // Nine shots, evaluated one at a time -- each pass writes a progress row
    // for shots_10 (locked, 9/10) before the badge is ever crossable.
    for (let i = 1; i <= 9; i++) {
      insert.run(i, now - i * 3600);
      service.evaluateAll();
    }
    expect(repo.getAll().shots_10?.unlockedAt, 'shots_10 unlocked too early').toBeFalsy();

    // The tenth shot crosses the target.
    insert.run(10, now - 10 * 3600);
    const unlocked = service.evaluateAll();
    expect(unlocked, 'shots_10 did not unlock on the crossing pass').toContain('shots_10');
    expect(repo.getAll().shots_10?.unlockedAt, 'shots_10 has no unlocked_at after crossing').toBeGreaterThan(0);

    // A further pass (an eleventh shot) must not keep re-reporting it.
    insert.run(11, now - 11 * 3600);
    const again = service.evaluateAll();
    expect(again, 'shots_10 kept re-unlocking after already being stamped').not.toContain('shots_10');
  });

  it('withholds a secret badge\'s name and description until it is unlocked', () => {
    const secretId = registry.SECRET_IDS[0];

    const locked = service.getState('en').find(b => b.id === secretId);
    expect(locked, `${secretId} missing from state`).toBeTruthy();
    expect(locked.unlocked).toBe(false);
    expect(locked.name, 'secret name leaked while locked').toBeFalsy();
    expect(locked.description, 'secret description leaked while locked').toBeFalsy();
  });

  it('reveals a secret badge once it is unlocked', () => {
    const secretId = registry.SECRET_IDS[0];
    repo.unlock(secretId, Math.floor(Date.now() / 1000));

    const shown = service.getState('en').find(b => b.id === secretId);
    expect(shown.unlocked).toBe(true);
    expect(shown.name, 'unlocked secret still has no name').toBeTruthy();
  });
});
