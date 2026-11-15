// Bean profile history (#1963, slice 2 of 4): derives the profiles that are
// proven for a bean and, for a bean with little history of its own, the
// profiles worth suggesting from similar beans. Pure — no S, no DOM — so the
// bean detail sheet (slice 3) and the tests share exactly the same rules.
//
// Defaults (product decisions, still open questions for Max):
//   - Proven: at least MIN_RATED_SHOTS rated shots (1-5) of this bean with that
//     profile on that machine, averaging MIN_AVG_RATING or better. The same
//     "3 samples" bar as the best grinder combo.
//   - Similar bean: same decaf flag (absent counts as false); roast level
//     within one step when both beans carry one; when either lacks a level the
//     coarse roast type (espresso / filter / omni) must match when both carry
//     one, with omni matching anything; process (trimmed, case-insensitive)
//     must match when both carry one. Missing data on either side never
//     excludes a bean, so similarity degrades gracefully. Archived beans
//     count — their history is still real. A target bean with none of roast
//     level, roast type or process gets no suggestions at all, so a fresh
//     empty bean is not flooded with unrelated profiles.
//   - Suggestion: shots of all similar beans pooled per (machine, profile).
//     Eligible with MIN_RATED_SHOTS rated shots averaging MIN_AVG_RATING, or
//     when at least one similar bean pinned it — an explicit pin outweighs thin
//     statistics. Ranked by average rating (rows without rated shots after
//     rated ones), then rated-shot count, then the number of similar beans that
//     pinned it, then name. At most MAX_DERIVED_ROWS.
//   - Renames: given the selected machine's current profile names, a proven or
//     pinned row whose name is gone is flagged `missing` (shown, so the user
//     can unpin it) and a missing suggestion is dropped.
//
// The bean join is the one the bean star rating uses: a resolved bean id is
// trusted, otherwise a case-insensitive name match (#456). Mixed shots carry no
// single bean to learn from and are skipped (#1837). Roast levels follow
// ROAST_LEVELS / normalizeRoastLevel (the five-step order from #1977).

import { ROAST_LEVELS, normalizeRoastLevel, resolveBeanForAnnotation } from '../utils.js';
import { isBeanMix } from './bean-mix.js';
import type { BeanMixPartInput } from './bean-mix.js';

/** A pin as the server stores it: per machine, matched by profile name. */
export interface PinnedProfile {
  machineId: number;
  name: string;
}

/** The annotation fields a profile statistic reads. */
export interface ProfileAnnotation {
  beanId?: number | null;
  coffee?: string | null;
  rating?: string | number | null;
  beanMix?: readonly BeanMixPartInput[] | null;
}

/** The shot fields a profile statistic reads. */
export interface ProfileShot {
  machineId?: number | null;
  timestamp?: number;
  profileName?: unknown;
  profile?: { name?: unknown } | null;
  annotation?: ProfileAnnotation | null;
}

/** The bean fields a profile statistic reads. */
export interface ProfileBean {
  id: number;
  name?: string | null;
  decaf?: boolean | null;
  roastLevel?: string | null;
  roastType?: string | null;
  process?: string | null;
  pinnedProfiles?: unknown;
}

/** One derived profile row, for one machine. */
export interface ProfileRow {
  machineId: number;
  name: string;
  ratedShots: number;
  /** One decimal, null when the row has no rated shots yet. */
  avgRating: number | null;
  pinned: boolean;
  /** Distinct similar beans with rated shots for this row. */
  beanCount: number;
  /** Distinct similar beans that pinned this profile. */
  pinnedBy: number;
  /** The profile name is no longer among the machine's current profiles. */
  missing: boolean;
}

/** Everything the derivation needs; `machineId` null means all machines. */
export interface ProfileContext {
  shots: readonly ProfileShot[];
  beans: readonly ProfileBean[];
  machineId: number | null;
  /** The selected machine's current profile names, lower-cased and trimmed. */
  availableNames?: ReadonlySet<string> | null;
}

/** Samples a profile needs before it counts as proven. */
export const MIN_RATED_SHOTS = 3;
/** Average star rating a proven or suggested profile must reach. */
export const MIN_AVG_RATING = 4;
/** Most derived rows one derivation returns. */
export const MAX_DERIVED_ROWS = 3;
/** Server cap for a bean's pinned list. */
export const MAX_PINNED_PROFILES = 20;

const ROAST_TYPES = ['espresso', 'filter', 'omni'];

/** Identity of a profile: machine id plus the trimmed lower-cased name. */
export function profileKey(machineId: number, name: string): string {
  return `${machineId}:${name.trim().toLowerCase()}`;
}

/** The shot's profile name — `profile.name` wins over the flat `profileName`. */
export function shotProfileName(shot: ProfileShot): string {
  const nested = shot.profile?.name;
  if (typeof nested === 'string' && nested.trim()) return nested.trim();
  const flat = shot.profileName;
  if (typeof flat === 'string' && flat.trim()) return flat.trim();
  return '';
}

// Array.isArray() types its argument as any[] in the narrowed branch, so the
// predicate spells the element type out as unknown (same guard as bean-mix.ts).
function _isEntryList(v: unknown): v is readonly unknown[] {
  return Array.isArray(v);
}

/** The bean's stored pins, dropping anything malformed. */
export function pinnedProfilesOf(bean: ProfileBean | null | undefined): PinnedProfile[] {
  const raw = bean?.pinnedProfiles;
  if (!_isEntryList(raw)) return [];
  const pins: PinnedProfile[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const { machineId, name } = entry as Record<string, unknown>;
    if (typeof machineId !== 'number' || !Number.isInteger(machineId) || machineId <= 0) continue;
    if (typeof name !== 'string' || !name.trim()) continue;
    pins.push({ machineId, name: name.trim() });
  }
  return pins;
}

/**
 * Adds or removes a pin, returning a new list: removing when the same
 * (machine, name) key exists, otherwise prepending the pin. Capped at the
 * server's own MAX_PINNED_PROFILES limit.
 */
export function togglePinnedProfile(
  pins: readonly PinnedProfile[],
  machineId: number,
  name: string,
): PinnedProfile[] {
  const trimmed = name.trim();
  const key = profileKey(machineId, trimmed);
  const without = pins.filter(p => profileKey(p.machineId, p.name) !== key);
  if (without.length !== pins.length || !trimmed) return without;
  return [{ machineId, name: trimmed }, ...without].slice(0, MAX_PINNED_PROFILES);
}

// ── Similarity ────────────────────────────────────────────────────────────

function _roastTypeOf(bean: ProfileBean): string | null {
  const raw = typeof bean.roastType === 'string' ? bean.roastType.trim().toLowerCase() : '';
  return ROAST_TYPES.includes(raw) ? raw : null;
}

function _processOf(bean: ProfileBean): string {
  return typeof bean.process === 'string' ? bean.process.trim().toLowerCase() : '';
}

function _roastIndex(bean: ProfileBean): number | null {
  const level = normalizeRoastLevel(bean.roastLevel);
  return level ? ROAST_LEVELS.indexOf(level) : null;
}

/**
 * Whether two beans are close enough for one to suggest profiles from the
 * other's history. Missing data never excludes a bean.
 */
export function isSimilarBean(a: ProfileBean, b: ProfileBean): boolean {
  if (a.id === b.id) return false;
  if (Boolean(a.decaf) !== Boolean(b.decaf)) return false;

  const levelA = _roastIndex(a);
  const levelB = _roastIndex(b);
  if (levelA != null && levelB != null) {
    if (Math.abs(levelA - levelB) > 1) return false;
  } else {
    const typeA = _roastTypeOf(a);
    const typeB = _roastTypeOf(b);
    if (typeA && typeB && typeA !== typeB && typeA !== 'omni' && typeB !== 'omni') return false;
  }

  const processA = _processOf(a);
  const processB = _processOf(b);
  if (processA && processB && processA !== processB) return false;

  return true;
}

function _hasSimilarityData(bean: ProfileBean): boolean {
  return _roastIndex(bean) != null || _roastTypeOf(bean) != null || _processOf(bean) !== '';
}

// ── Shot statistics ───────────────────────────────────────────────────────

interface ProfileStats {
  machineId: number;
  name: string;
  ratedShots: number;
  ratingSum: number;
  /** Timestamp and spelling of the most recent shot of this profile. */
  latestTimestamp: number;
  latestName: string;
}

type BeanIndex = Map<number, Map<string, ProfileStats>>;

function _parseRating(raw: unknown): number | null {
  if (raw == null) return null;
  const n = parseFloat(String(raw));
  return Number.isFinite(n) && n >= 1 && n <= 5 ? n : null;
}

function _shotMachine(shot: ProfileShot): number {
  return typeof shot.machineId === 'number' && Number.isFinite(shot.machineId) ? shot.machineId : 1;
}

function _avg(stats: { ratedShots: number; ratingSum: number }): number | null {
  if (!stats.ratedShots) return null;
  return Math.round((stats.ratingSum / stats.ratedShots) * 10) / 10;
}

function _meetsProvenBar(stats: { ratedShots: number; ratingSum: number }): boolean {
  return stats.ratedShots >= MIN_RATED_SHOTS && (_avg(stats) ?? 0) >= MIN_AVG_RATING;
}

/** Groups the eligible shots by bean id, then by (machine, profile). */
function _buildIndex(ctx: ProfileContext): BeanIndex {
  const index: BeanIndex = new Map();
  for (const shot of ctx.shots) {
    if (isBeanMix(shot.annotation)) continue;
    const name = shotProfileName(shot);
    if (!name) continue;
    const machineId = _shotMachine(shot);
    if (ctx.machineId != null && machineId !== ctx.machineId) continue;
    const beanId = resolveBeanForAnnotation(shot.annotation, ctx.beans)?.id;
    if (typeof beanId !== 'number') continue;

    let byProfile = index.get(beanId);
    if (!byProfile) {
      byProfile = new Map();
      index.set(beanId, byProfile);
    }
    const key = profileKey(machineId, name);
    let stats = byProfile.get(key);
    if (!stats) {
      stats = {
        machineId,
        name,
        ratedShots: 0,
        ratingSum: 0,
        latestTimestamp: Number.NEGATIVE_INFINITY,
        latestName: name,
      };
      byProfile.set(key, stats);
    }
    const timestamp = typeof shot.timestamp === 'number' && Number.isFinite(shot.timestamp) ? shot.timestamp : 0;
    if (timestamp >= stats.latestTimestamp) {
      stats.latestTimestamp = timestamp;
      stats.latestName = name;
    }
    const rating = _parseRating(shot.annotation?.rating);
    if (rating != null) {
      stats.ratedShots += 1;
      stats.ratingSum += rating;
    }
  }
  return index;
}

function _isMissing(name: string, availableNames: ReadonlySet<string> | null | undefined): boolean {
  if (!availableNames) return false;
  return !availableNames.has(name.trim().toLowerCase());
}

// ── Proven profiles for one bean ──────────────────────────────────────────

/**
 * The profiles proven for `bean`: its pins first (stored order, whatever
 * statistics they have), then derived rows that meet the sample/rating bar,
 * ranked by average rating, then rated-shot count, then recency.
 */
export function provenProfilesForBean(bean: ProfileBean, ctx: ProfileContext): ProfileRow[] {
  const byProfile = _buildIndex(ctx).get(bean.id);
  const rows: ProfileRow[] = [];
  const seen = new Set<string>();

  for (const pin of pinnedProfilesOf(bean)) {
    if (ctx.machineId != null && pin.machineId !== ctx.machineId) continue;
    const key = profileKey(pin.machineId, pin.name);
    if (seen.has(key)) continue;
    seen.add(key);
    const stats = byProfile?.get(key);
    rows.push({
      machineId: pin.machineId,
      name: pin.name,
      ratedShots: stats?.ratedShots ?? 0,
      avgRating: stats ? _avg(stats) : null,
      pinned: true,
      beanCount: 1,
      pinnedBy: 0,
      missing: _isMissing(pin.name, ctx.availableNames),
    });
  }

  if (byProfile) {
    const derived = [...byProfile.entries()]
      .filter(([key, stats]) => !seen.has(key) && _meetsProvenBar(stats))
      .map(([, stats]) => stats)
      .sort((a, b) =>
        (_avg(b) ?? 0) - (_avg(a) ?? 0)
        || b.ratedShots - a.ratedShots
        || b.latestTimestamp - a.latestTimestamp
        || a.latestName.localeCompare(b.latestName))
      .slice(0, MAX_DERIVED_ROWS);
    for (const stats of derived) {
      // The row keeps the spelling of the most recent shot.
      rows.push({
        machineId: stats.machineId,
        name: stats.latestName,
        ratedShots: stats.ratedShots,
        avgRating: _avg(stats),
        pinned: false,
        beanCount: 1,
        pinnedBy: 0,
        missing: _isMissing(stats.latestName, ctx.availableNames),
      });
    }
  }

  return rows;
}

// ── Suggested profiles from similar beans ─────────────────────────────────

interface PooledStats {
  machineId: number;
  name: string;
  ratedShots: number;
  ratingSum: number;
  latestTimestamp: number;
  latestName: string;
  beansWithRated: Set<number>;
  pinnedBy: Set<number>;
}

function _compareSuggestion(a: ProfileRow, b: ProfileRow): number {
  if (a.avgRating != null && b.avgRating == null) return -1;
  if (a.avgRating == null && b.avgRating != null) return 1;
  return (b.avgRating ?? 0) - (a.avgRating ?? 0)
    || b.ratedShots - a.ratedShots
    || b.pinnedBy - a.pinnedBy
    || a.name.localeCompare(b.name);
}

/**
 * The profiles worth suggesting for `bean`, pooled from beans similar to it:
 * rows with enough rated shots or an explicit pin, minus whatever the bean
 * already has (pinned or proven), best first, at most MAX_DERIVED_ROWS.
 */
export function suggestProfilesForBean(bean: ProfileBean, ctx: ProfileContext): ProfileRow[] {
  if (!_hasSimilarityData(bean)) return [];

  const index = _buildIndex(ctx);
  const excluded = new Set<string>();
  for (const pin of pinnedProfilesOf(bean)) excluded.add(profileKey(pin.machineId, pin.name));
  const own = index.get(bean.id);
  if (own) {
    for (const [key, stats] of own) {
      if (_meetsProvenBar(stats)) excluded.add(key);
    }
  }

  const pool = new Map<string, PooledStats>();
  const ensure = (machineId: number, name: string): PooledStats => {
    const key = profileKey(machineId, name);
    let entry = pool.get(key);
    if (!entry) {
      entry = {
        machineId,
        name,
        ratedShots: 0,
        ratingSum: 0,
        latestTimestamp: Number.NEGATIVE_INFINITY,
        latestName: name,
        beansWithRated: new Set(),
        pinnedBy: new Set(),
      };
      pool.set(key, entry);
    }
    return entry;
  };

  const similar = ctx.beans.filter(other => isSimilarBean(bean, other));
  for (const other of similar) {
    const similarStats = index.get(other.id);
    if (similarStats) {
      for (const shotStats of similarStats.values()) {
        const entry = ensure(shotStats.machineId, shotStats.name);
        entry.ratedShots += shotStats.ratedShots;
        entry.ratingSum += shotStats.ratingSum;
        if (shotStats.ratedShots > 0) entry.beansWithRated.add(other.id);
        if (shotStats.latestTimestamp >= entry.latestTimestamp) {
          entry.latestTimestamp = shotStats.latestTimestamp;
          entry.latestName = shotStats.latestName;
        }
      }
    }
    for (const pin of pinnedProfilesOf(other)) {
      if (ctx.machineId != null && pin.machineId !== ctx.machineId) continue;
      ensure(pin.machineId, pin.name).pinnedBy.add(other.id);
    }
  }

  const rows: ProfileRow[] = [];
  for (const [key, entry] of pool) {
    if (excluded.has(key)) continue;
    // A pin outweighs thin statistics; without one the proven bar applies.
    if (!_meetsProvenBar(entry) && entry.pinnedBy.size === 0) continue;
    const row: ProfileRow = {
      machineId: entry.machineId,
      name: entry.latestName,
      ratedShots: entry.ratedShots,
      avgRating: _avg(entry),
      pinned: false,
      beanCount: entry.beansWithRated.size,
      pinnedBy: entry.pinnedBy.size,
      missing: _isMissing(entry.latestName, ctx.availableNames),
    };
    // A pin that no longer exists on the machine has nothing to preselect.
    if (row.missing) continue;
    rows.push(row);
  }

  return rows.sort(_compareSuggestion).slice(0, MAX_DERIVED_ROWS);
}
