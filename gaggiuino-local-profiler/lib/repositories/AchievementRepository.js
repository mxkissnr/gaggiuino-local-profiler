// #812: raw DB access for the achievements table (lib/db.js). Deliberately
// thin -- the actual badge conditions live in lib/achievements/registry.js,
// this only persists/reads the (id, unlocked_at, progress) rows the
// evaluator decides on.
const { getDb } = require('../db');

class AchievementRepository {
    // Map of id -> { id, unlockedAt, progress } for every row ever written.
    // An id with no row at all (never evaluated true, never had progress)
    // simply isn't a key in this map -- callers treat that as locked/0.
    getAll() {
        const rows = getDb().prepare('SELECT id, unlocked_at, progress FROM achievements').all();
        const out = {};
        for (const r of rows) out[r.id] = { id: r.id, unlockedAt: r.unlocked_at, progress: r.progress };
        return out;
    }

    // Unlocks a badge at `unlockedAt` (Unix seconds). Idempotent: the
    // `WHERE unlocked_at IS NULL` guard means a badge that's already unlocked
    // keeps its original unlocked_at forever, even if evaluateAll() runs
    // again later (retroactive re-run, or another event firing) --
    // re-evaluation must never re-stamp.
    //
    // #978: this used to be a plain `INSERT OR IGNORE`, which only ever wrote
    // the row the *first* time an id was touched. Every progress-tracked
    // badge (progressTarget set) calls setProgress() below on every locked
    // evaluation pass, which itself INSERTs a row (unlocked_at NULL) well
    // before the badge actually crosses its target. By the time check()
    // finally returns true, that row already exists, so the old INSERT OR
    // IGNORE silently did nothing -- unlocked_at stayed NULL forever, and
    // evaluateAll() kept re-reporting the same badge as "newly unlocked" on
    // every single subsequent pass (harmless log spam in normal live usage,
    // but a synchronous storm during a bulk restore -- see routes/backup.js).
    // ON CONFLICT...DO UPDATE, gated the same way setProgress() already gates
    // its own write, actually stamps the row instead of no-op'ing on it.
    unlock(id, unlockedAt, progress = null) {
        getDb().prepare(
            `INSERT INTO achievements (id, unlocked_at, progress) VALUES (?, ?, ?)
             ON CONFLICT(id) DO UPDATE SET unlocked_at = excluded.unlocked_at, progress = excluded.progress
             WHERE achievements.unlocked_at IS NULL`
        ).run(id, unlockedAt, progress);
    }

    // Updates progress on a still-locked badge (e.g. "7 of 10"). Never touches
    // unlocked_at -- once a row is unlocked, unlock() above is the only writer
    // that's still allowed to touch it (and it no-ops via INSERT OR IGNORE).
    setProgress(id, progress) {
        getDb().prepare(
            `INSERT INTO achievements (id, unlocked_at, progress) VALUES (?, NULL, ?)
             ON CONFLICT(id) DO UPDATE SET progress = excluded.progress
             WHERE achievements.unlocked_at IS NULL`
        ).run(id, progress);
    }
}

module.exports = new AchievementRepository();
