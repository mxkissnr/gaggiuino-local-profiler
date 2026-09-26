import { getShot } from './api/shots.js';
import type { HydratedShot } from './api/types.js';
import { mapShotDatapoints } from './utils.js';
import type { ShotDatapoints, ShotSeries } from './utils.js';

// Per-shot curve cache (#957). GET /api/shots now returns metadata-only rows
// (no `datapoints`), so the sample series a shot's charts / score fallback /
// exports need is fetched lazily per shot from GET /api/shots/{id} and
// memoised here. One in-flight fetch per id (the Map holds the Promise, not
// the resolved value), so N callers asking for the same shot at once share
// one request, and re-opening a shot fires none.

const _pending  = new Map<number, Promise<ShotDatapoints>>(); // id -> Promise<datapoints-shaped object>
const _resolved = new Map<number, ShotDatapoints>(); // id -> settled datapoints object (sync reads)

// Bounded concurrency for ensureCurves(): the comparative-advice panel and
// the analytics machine-comparison can ask for dozens of curves at once, and
// firing them all in parallel would stampede the add-on.
const CONCURRENCY = 6;

function _store(id: number, promise: Promise<ShotDatapoints>): Promise<ShotDatapoints> {
  _pending.set(id, promise);
  void promise.then(
    v => { if (_pending.get(id) === promise) _resolved.set(id, v || {}); },
    () => {},
  );
  return promise;
}

// Merges the top-level gaggimateBleScale flag into the datapoints object so
// mapShotDatapoints can use it for the chart weight label. Needed for shots
// synced before bleScaleConnected was added to the datapoints themselves.
function _mergeScaleFlag(shot: HydratedShot): ShotDatapoints {
  const dp = shot.datapoints || {};
  if (shot.gaggimateBleScale != null && dp.bleScaleConnected == null) {
    dp.bleScaleConnected = shot.gaggimateBleScale;
  }
  return dp;
}

function _fetchCurve(id: number): Promise<ShotDatapoints> {
  return getShot(id)
    .then(shot => {
      if (!shot) { _pending.delete(id); return {}; } // transient — allow a later retry
      // The detail endpoint already ships the previous same-profile shot in
      // full — seed it so the auto-compare ghost curve is instant too.
      if (shot.previousShot && shot.previousShot.id != null && shot.previousShot.datapoints) {
        primeCurve(shot.previousShot.id, _mergeScaleFlag(shot.previousShot));
      }
      return _mergeScaleFlag(shot);
    })
    .catch(() => {
      _pending.delete(id); // don't cache a transient failure
      return {};
    });
}

// getShotCurve(id) -> Promise resolving to the raw datapoints object
// ({} when the shot has none or the fetch failed). Memoised per id.
export function getShotCurve(id: number | null | undefined): Promise<ShotDatapoints> {
  if (id == null) return Promise.resolve({});
  const existing = _pending.get(id);
  if (existing) return existing;
  return _store(id, _fetchCurve(id));
}

// ensureCurves(ids) -> resolves once every id's curve is cached, at most
// CONCURRENCY fetches in flight. Deduped and null-safe.
export async function ensureCurves(ids: (number | null | undefined)[] | null | undefined): Promise<void> {
  const todo = [...new Set((ids || []).filter(id => id != null))];
  let cursor = 0;
  async function worker() {
    while (cursor < todo.length) {
      await getShotCurve(todo[cursor++]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, todo.length) }, worker));
}

// primeCurve(id, datapoints) -> seed the cache from a full shot object
// already in hand (live.js post-brew, a detail fetch's previousShot).
export function primeCurve(id: number | null | undefined, datapoints: ShotDatapoints | null | undefined): void {
  if (id == null) return;
  void _store(id, Promise.resolve(datapoints || {}));
}

// evictCurve(id) -> drop a cached curve (shot trashed / permanently deleted).
export function evictCurve(id: number | null | undefined): void {
  _pending.delete(id as number);
  _resolved.delete(id as number);
}

// hasCurve(id) -> whether a curve for this id is cached (resolved or in
// flight). Sync.
export function hasCurve(id: number): boolean {
  return _pending.has(id);
}

// getRawCurve(id) -> the cached raw datapoints object, or null if the curve
// isn't resolved yet. Sync — callers that can't await (or tolerate a miss).
export function getRawCurve(id: number | null | undefined): ShotDatapoints | null {
  return _resolved.get(id as number) ?? null;
}

// getCachedShotData(id) -> the mapped XY form (mirror of utils.getShotData),
// or null if the curve isn't cached yet.
export function getCachedShotData(id: number | null | undefined): ShotSeries | null {
  const raw = getRawCurve(id);
  return raw ? mapShotDatapoints(raw) : null;
}

// __resetCurveCacheForTests clears the cache — vitest only.
export function __resetCurveCacheForTests() {
  _pending.clear();
  _resolved.clear();
}
