// Bean comparison (#2119): the pure numbers behind the compare page. Every
// figure comes from an existing helper (the analytics bean ranking for the
// average, best, first good shot and brew time, the recipe summary for dose
// and yield, the library's rating, best grind and freshness), so the page and
// the other views can never disagree. No DOM here; the compare view renders it.
import { calcBeanRating, freshnessOverrideFrom, resolveFreshness, roastAgeDays } from '../../utils.js';
import type { FreshnessBand } from '../../utils.js';
import { matchFlavors } from '../../flavor-match.js';
import { calcBestGrindCombosForBean, tasteTagOf, TASTE_TAGS } from '../shots/grind.js';
import type { GrindShot, TasteTag } from '../shots/grind.js';
import { _computeBeanRanking } from '../analytics/bean-shelf.js';
import { _beanGroup, _beans, computeRecipeSummary } from '../analytics/shared.js';
import type { ShotAnnotation, ShotRow } from '../analytics/shared.js';
import { classifyBeanBags } from './bags.js';
import type { BeanListRow } from './bean-shared.js';

// A shot row with the annotation fields the comparison reads on top of the
// analytics view of a shot.
export type CompareShot = ShotRow & {
  annotation?: (ShotAnnotation & { tasteTag?: string | null; rating?: string | null }) | null;
};

export type Side = 'a' | 'b';

// Below this many scored shots a bean gets no winner verdict.
export const MIN_VERDICT_SHOTS = 3;

export interface BeanCompareStats {
  shots: number;
  scoredShots: number;
  avgScore: number | null;
  best: number | null;
  rating: number | null;
  taste: TasteTag | null;
  bestGrind: { grinder: string; grindSetting: number } | null;
  dose: number | null;
  yield: number | null;
  avgTime: number | null;
  firstGood: number | null;
  pricePerShot: number | null;
  gramsLeft: number | null;
  roastAgeDays: number | null;
  freshness: FreshnessBand | null;
}

export type VerdictReason = 'dialin-same-grinder' | 'dialin' | 'best' | 'rating' | 'score';

export type BeanCompareVerdict =
  | { kind: 'few'; side: Side }
  | { kind: 'tie' }
  | { kind: 'winner'; winner: Side; diff: number; reason: VerdictReason };

export interface BeanComparison {
  a: BeanCompareStats;
  b: BeanCompareStats;
  grinder: string | null;
  sharedAromas: Set<string>;
  verdict: BeanCompareVerdict;
}

// The freshness wording the shot annotation uses for a band.
export const FRESHNESS_TEXT_KEYS: Record<FreshnessBand, string> = {
  degassing: 'degas_too_fresh',
  almost: 'degas_almost',
  peak: 'degas_optimal',
  fading: 'degas_aging',
  old: 'degas_old',
};

// A bean's single-bean shots, grouped exactly like the analytics bean
// ranking: beanId first, then the name; mixed shots are left out.
export function beanShotsOf(beanId: number, shots: CompareShot[]): CompareShot[] {
  const beans = _beans();
  return shots.filter(s => _beanGroup(s.annotation, beans)?.beanId === beanId);
}

function grinderKey(s: CompareShot): string {
  return String(s.annotation?.grinder ?? '').trim().toLowerCase();
}

// The grinder both beans were used with most: among the grinders each bean
// has shots on, the one with the most shots of both together; a tie goes to
// the alphabetically first. Null when the beans share no grinder. The name is
// returned as the first bean's first shot on it spells it.
export function sharedGrinder(aShots: CompareShot[], bShots: CompareShot[]): string | null {
  const count = (shots: CompareShot[]): Map<string, { label: string; n: number }> => {
    const counts = new Map<string, { label: string; n: number }>();
    for (const s of shots) {
      const key = grinderKey(s);
      if (!key) continue;
      const entry = counts.get(key);
      if (entry) entry.n += 1;
      else counts.set(key, { label: String(s.annotation?.grinder ?? '').trim(), n: 1 });
    }
    return counts;
  };
  const a = count(aShots);
  const b = count(bShots);
  let best: { key: string; label: string; n: number } | null = null;
  for (const [key, entry] of a) {
    const other = b.get(key);
    if (!other) continue;
    const n = entry.n + other.n;
    if (!best || n > best.n || (n === best.n && key < best.key)) best = { key, label: entry.label, n };
  }
  return best ? best.label : null;
}

// The taste tag a bean's shots carry most often; a tie goes to the tag listed
// first in TASTE_TAGS. Null when no shot carries one.
export function mostCommonTasteTag(shots: CompareShot[]): TasteTag | null {
  const counts = new Map<TasteTag, number>();
  for (const s of shots) {
    const tag = tasteTagOf(s.annotation);
    if (tag) counts.set(tag, (counts.get(tag) ?? 0) + 1);
  }
  let best: TasteTag | null = null;
  for (const tag of TASTE_TAGS) {
    const n = counts.get(tag) ?? 0;
    if (n > 0 && (best === null || n > (counts.get(best) ?? 0))) best = tag;
  }
  return best;
}

// Price per shot: the bag's price per gram times the average dose, rounded to
// cents. The bag is the one being drawn from, else the next full one (the bag
// the shelf's stock line describes). Null without a price, a bag weight or a
// dose.
export function pricePerShot(bean: BeanListRow, dose: number | null): number | null {
  const { current, upcoming } = classifyBeanBags(bean);
  const bag = (current ?? upcoming[0] ?? null)?.bg;
  const price = Number(bag?.price_eur);
  const grams = parseFloat(String(bag?.stock_g ?? ''));
  if (!(price > 0) || !(grams > 0) || dose === null || !(dose > 0)) return null;
  return Math.round((price / grams) * dose * 100) / 100;
}

// Roast age of the bag being drawn from (else the bean's roast date) and its
// freshness band, read like the bean sheet's freshness badge.
export function roastAgeOf(bean: BeanListRow): { days: number | null; band: FreshnessBand | null } {
  const { current } = classifyBeanBags(bean);
  const days = roastAgeDays(current?.bg.roastDate || bean.roastDate);
  return { days, band: resolveFreshness(days, bean.roastLevel, freshnessOverrideFrom(bean)).state };
}

// Freshness for the better mark: inside the peak window beats almost ready or
// fading, which beat too fresh or too old. Lower is better.
export function freshnessRank(band: FreshnessBand | null): number | null {
  if (band === null) return null;
  if (band === 'peak') return 0;
  return band === 'almost' || band === 'fading' ? 1 : 2;
}

// One key per aroma: the flavour-wheel node it matches, so "Blueberry" and
// "Blaubeere" are the same aroma; an unmatched aroma by its trimmed,
// lower-cased text.
export function aromaKey(raw: string): string {
  const node = [...matchFlavors([raw]).matched][0];
  return node ?? `text:${raw.trim().toLowerCase()}`;
}

// The aroma keys both beans list.
export function sharedAromaKeys(a: readonly string[] | null | undefined, b: readonly string[] | null | undefined): Set<string> {
  const bKeys = new Set((b ?? []).map(aromaKey));
  return new Set((a ?? []).map(aromaKey).filter(key => bKeys.has(key)));
}

// Which side a row marks as better: null when either value is missing or
// both are equal.
export function betterSide(a: number | null, b: number | null, better: 'higher' | 'lower'): Side | null {
  if (a === null || b === null || a === b) return null;
  return (a > b) === (better === 'higher') ? 'a' : 'b';
}

// One bean's figures. Results use all of its shots; the dial-in figures use
// its shots on `grinder` (all shots when null).
export function computeBeanCompareStats(bean: BeanListRow, shots: CompareShot[], grinder: string | null): BeanCompareStats {
  const own = beanShotsOf(bean.id, shots);
  const rank = _computeBeanRanking(own)[0] ?? null;
  const scoredShots = own.filter(s => (window.calcShotScore ? window.calcShotScore(s) : null) !== null).length;
  const key = grinder === null ? null : grinder.trim().toLowerCase();
  const dialShots = key === null ? own : own.filter(s => grinderKey(s) === key);
  const dial = _computeBeanRanking(dialShots)[0] ?? null;
  const recipe = computeRecipeSummary(dialShots);
  const combos = calcBestGrindCombosForBean(bean.name, shots as unknown as GrindShot[], bean.id) ?? [];
  const combo = key === null ? combos[0] : combos.find(c => c.grinder.trim().toLowerCase() === key);
  const age = roastAgeOf(bean);
  const rating = calcBeanRating(bean, shots as unknown as Parameters<typeof calcBeanRating>[1], _beans());
  return {
    shots: own.length,
    scoredShots,
    avgScore: rank?.avgScore ?? null,
    best: rank?.best ?? null,
    rating: rating?.avg ?? null,
    taste: mostCommonTasteTag(own),
    bestGrind: combo ? { grinder: combo.grinder, grindSetting: combo.grindSetting } : null,
    dose: recipe.dose,
    yield: recipe.yield,
    avgTime: dial?.avgTime ?? null,
    firstGood: dial?.firstGood ?? null,
    pricePerShot: pricePerShot(bean, recipe.dose),
    gramsLeft: bean.remainingG != null ? Math.max(0, Math.round(bean.remainingG)) : null,
    roastAgeDays: age.days,
    freshness: age.band,
  };
}

// The verdict rule: a bean with fewer than MIN_VERDICT_SHOTS scored shots gets
// no winner; otherwise the higher average wins, and the reason is the first
// of: it reached a good shot (80+) in fewer tries, a higher best shot, a
// higher rating, else the average itself.
export function compareVerdict(a: BeanCompareStats, b: BeanCompareStats, onSharedGrinder: boolean): BeanCompareVerdict {
  if (a.scoredShots < MIN_VERDICT_SHOTS || a.avgScore === null) return { kind: 'few', side: 'a' };
  if (b.scoredShots < MIN_VERDICT_SHOTS || b.avgScore === null) return { kind: 'few', side: 'b' };
  const diff = a.avgScore - b.avgScore;
  if (diff === 0) return { kind: 'tie' };
  const winner: Side = diff > 0 ? 'a' : 'b';
  const w = winner === 'a' ? a : b;
  const l = winner === 'a' ? b : a;
  let reason: VerdictReason = 'score';
  if (w.firstGood !== null && (l.firstGood === null || w.firstGood < l.firstGood)) {
    reason = onSharedGrinder ? 'dialin-same-grinder' : 'dialin';
  } else if (w.best !== null && l.best !== null && w.best > l.best) {
    reason = 'best';
  } else if (w.rating !== null && l.rating !== null && w.rating > l.rating) {
    reason = 'rating';
  }
  return { kind: 'winner', winner, diff: Math.abs(diff), reason };
}

// Everything the compare page shows for bean a (left) and bean b (right).
export function computeBeanComparison(a: BeanListRow, b: BeanListRow, shots: CompareShot[]): BeanComparison {
  const grinder = sharedGrinder(beanShotsOf(a.id, shots), beanShotsOf(b.id, shots));
  const statsA = computeBeanCompareStats(a, shots, grinder);
  const statsB = computeBeanCompareStats(b, shots, grinder);
  return {
    a: statsA,
    b: statsB,
    grinder,
    sharedAromas: sharedAromaKeys(a.flavors, b.flavors),
    verdict: compareVerdict(statsA, statsB, grinder !== null),
  };
}
