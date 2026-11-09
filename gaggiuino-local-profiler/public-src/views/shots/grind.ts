import { t }                               from '../../i18n.js';
import { S }                               from '../../state/index.js';
import { detectChanneling, calcBrewRatio, esc, html, joinHtml } from '../../utils.js';
import type { ShotSeries, Html } from '../../utils.js';
import { calcShotScore }                   from './utils.js';
import type { ShotLike }                   from './utils.js';
import { getRawCurve }                     from '../../shot-curves.js';
import { normalizeGrindToNow }             from '../../grind-zero.js';
import { LIGHTNING_ICON_SVG, SCALE_ICON_SVG, BAR_CHART_ICON_SVG } from '../../icons.js';
import { isBeanMix } from '../../shared/bean-mix.js';
import type { BeanMixPartInput } from '../../shared/bean-mix.js';

interface GrindAnnotation {
  coffee?: string | null;
  beanId?: number | null;
  grinder?: string | null;
  dose?: string | number | null;
  grindSetting?: string | number | null;
  beanMix?: readonly BeanMixPartInput[] | null;
  tasteTag?: string | null;
}

export interface GrindShot extends ShotLike {
  id?: number;
  duration?: number | null;
  profile?: { name?: string | null } | null;
  annotation?: GrindAnnotation | null;
}

interface XYPoint { x: number; y: number }

export interface GrindAdvice {
  type: string;
  icon: Html;
  text: string;
}

interface ComparativeShot {
  shot: GrindShot;
  grind: number | null;
  score: number;
}

interface ComparativeAdvice extends GrindAdvice {
  shots: ComparativeShot[];
}

interface GrindCombo {
  grinder: string;
  grindSetting: number;
  avgScore: number;
  shotCount: number;
}

interface GrindBean {
  id?: unknown;
  name?: unknown;
  knownGrindSettings?: { grinder: string; grindSetting: string }[];
}

interface GrindLibrary {
  beans?: GrindBean[];
  grinders?: { name?: unknown; isDefault?: unknown }[];
}

// The library's default grinder (#1954), or '' when none is set.
export function defaultGrinderName(library: GrindLibrary | null | undefined): string {
  const name = library?.grinders?.find(g => g.isDefault === true)?.name;
  return typeof name === 'string' ? name.trim() : '';
}

export interface GrindSuggestion {
  grinder: string;
  grindSetting: string | number;
  dose: string | number;
}

// ── Mini chart thumbnail ───────────────────────────────────────────────────

// #957: curves are lazy — callers (index.ts updateView) ensureCurves() for
// every comparable shot before rendering the panel, so the cache read is
// synchronous here; a still-missing curve falls back to the shot's own
// datapoints (synthetic/demo) and finally to the no-data placeholder.
export function _miniShotChart(shot: GrindShot): Html {
  const d  = getRawCurve(shot.id) || shot.datapoints || {};
  const tm = d.timeInShot || [];
  const series = [
    { vals: (d.pressure  || []).map((v, i) => ({ x: (tm[i] ?? NaN) / 10, y: v / 10 })).filter(p => p.y > 0), color: '#60a5fa' },
    { vals: (d.pumpFlow  || []).map((v, i) => ({ x: (tm[i] ?? NaN) / 10, y: v / 10 })).filter(p => p.y >= 0), color: '#fb923c' },
  ].filter(s => s.vals.length >= 3);
  if (!series.length) return html`<div class="comp-thumb-no-data">–</div>`;

  const W = 140, H = 65, pad = 2;
  const allX = series.flatMap(s => s.vals.map(p => p.x));
  const allY = series.flatMap(s => s.vals.map(p => p.y));
  const xMin = Math.min(...allX), xMax = Math.max(...allX) || 1;
  const yMax = Math.max(...allY, 1);

  const px = (x: number): number => pad + ((x - xMin) / (xMax - xMin)) * (W - pad * 2);
  const py = (y: number): number => H - pad - (y / yMax) * (H - pad * 2);

  const polyline = ({ vals, color }: { vals: XYPoint[]; color: string }): Html => {
    const pts = vals.map(p => `${px(p.x).toFixed(1)},${py(p.y).toFixed(1)}`).join(' ');
    return html`<polyline points="${esc(pts)}" fill="none" stroke="${esc(color)}" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round" opacity=".9"/>`;
  };
  return html`<svg viewBox="0 0 ${esc(W)} ${esc(H)}" preserveAspectRatio="none" style="width:100%;height:${esc(H)}px;display:block">${joinHtml(series.map(polyline))}</svg>`;
}

// ── Grind setting parser ───────────────────────────────────────────────────

export function _parseGrindNum(s: string | number | null | undefined): number | null {
  // Only null/undefined and empty/whitespace strings mean "no value" — a
  // grind setting of 0 is a real setting and must survive.
  if (s === null || s === undefined) return null;
  if (typeof s === 'number') return Number.isFinite(s) ? s : null;
  if (s.trim() === '') return null;
  const m = s.match(/(\d+(?:[.,]\d+)?)/);
  const captured = m?.[1];
  return captured !== undefined ? parseFloat(captured.replace(',', '.')) : null;
}

// ── Taste tags (#1957) ─────────────────────────────────────────────────────

export const TASTE_TAGS = ['sour', 'bitter', 'balanced', 'thin'] as const;
export type TasteTag = typeof TASTE_TAGS[number];

// The chips' i18n keys; three are shared with the Profile Dial-In wizard.
export const TASTE_TAG_LABELS: Record<TasteTag, string> = {
  sour: 'profile_dialin_symptom_sour',
  bitter: 'profile_dialin_symptom_bitter',
  balanced: 'profile_dialin_symptom_balanced',
  thin: 'taste_tag_thin',
};

// An absent or unknown value is no tag: a backup from a newer version may carry
// a tag this one does not know.
export function tasteTagOf(ann: { tasteTag?: unknown } | null | undefined): TasteTag | null {
  const tag = ann?.tasteTag;
  return TASTE_TAGS.find(known => known === tag) ?? null;
}

type GrindDirection = 'finer' | 'coarser';
type TasteOutcome = GrindDirection | 'hold' | 'conflict' | 'thin';

// What a tag does to a grind direction; null keeps the advice as it is. Keep in
// step with tasteOutcome in go/internal/shots/taste.go. timeFarOff applies to
// the single-shot advice only, where a far-off time wins over a disagreeing taste.
function _tasteOutcome(tag: TasteTag, dir: GrindDirection | null, timeFarOff: boolean): TasteOutcome | null {
  if (tag === 'balanced') return dir ? 'hold' : null;
  if (tag === 'thin') return dir ? null : 'thin';
  const want: GrindDirection = tag === 'sour' ? 'finer' : 'coarser';
  if (!dir) return want;
  return dir !== want && !timeFarOff ? 'conflict' : null;
}

const COMPARATIVE_TASTE_KEYS: Partial<Record<TasteOutcome, string>> = {
  finer: 'grind_comparative_taste_finer',
  coarser: 'grind_comparative_taste_coarser',
  hold: 'grind_comparative_taste_hold',
  conflict: 'grind_comparative_taste_conflict',
};

// A sibling the user tasted as sour or bitter cannot be the best setting,
// unless that would leave none.
function _rankableSiblings(comparable: GrindShot[]): GrindShot[] {
  const kept = comparable.filter(s => {
    const tag = tasteTagOf(s.annotation);
    return tag !== 'sour' && tag !== 'bitter';
  });
  return kept.length ? kept : comparable;
}

const GRIND_FAR_SHORT_S = 18;
const GRIND_FAR_LONG_S = 50;

function _applyTaste(base: GrindAdvice | null, shot: GrindShot): GrindAdvice | null {
  const tag = tasteTagOf(shot.annotation);
  if (!base || !tag || base.type === 'warning') return base;
  const secs = (shot.duration || 0) / 10;
  const dir = base.type === 'finer' || base.type === 'coarser' ? base.type : null;
  const s = secs.toFixed(0);
  switch (_tasteOutcome(tag, dir, secs < GRIND_FAR_SHORT_S || secs > GRIND_FAR_LONG_S)) {
    case 'finer':    return { type: 'finer',   icon: html`↓`, text: t('grind_taste_finer') };
    case 'coarser':  return { type: 'coarser', icon: html`↑`, text: t('grind_taste_coarser') };
    case 'hold':     return { type: 'ok',      icon: html`✓`, text: t('grind_taste_balanced', s) };
    case 'conflict': return { type: 'warning', icon: html`↕`, text: t('grind_taste_conflict', s) };
    case 'thin':     return { type: 'ok',      icon: html`✓`, text: t('grind_taste_thin') };
    default:         return base;
  }
}

// ── Grind advice ──────────────────────────────────────────────────────────

function _timeGrindAdvice(shot: GrindShot, data: ShotSeries): GrindAdvice | null {
  const secs = (shot.duration || 0) / 10;
  if (secs < 8) return null;
  const pTimes = data.pressure.map(p => p.x);
  const pAll   = data.pressure.map(p => p.y);
  if (detectChanneling(pTimes, pAll))
    return { type: 'warning', icon: LIGHTNING_ICON_SVG, text: t('grind_channeling_full') };
  if (secs < GRIND_FAR_SHORT_S) return { type: 'finer',   icon: html`↓`, text: t('grind_short', secs.toFixed(0)) };
  if (secs < 23) return { type: 'finer',   icon: html`↓`, text: t('grind_short_slight', secs.toFixed(0)) };
  if (secs > GRIND_FAR_LONG_S) return { type: 'coarser', icon: html`↑`, text: t('grind_long', secs.toFixed(0)) };
  if (secs > 42) return { type: 'coarser', icon: html`↑`, text: t('grind_long_slight', secs.toFixed(0)) };
  // Duration is fine — check the brew ratio against the classic espresso
  // window (1:1.8–1:2.2). Yield is machine-stopped, so this is dose/yield
  // guidance rather than a grind direction.
  const ratio = calcBrewRatio(shot, data);
  if (ratio !== null && ratio > 2.3)
    return { type: 'warning', icon: SCALE_ICON_SVG, text: t('dialin_ratio_high', ratio.toFixed(1)) };
  if (ratio !== null && ratio < 1.7)
    return { type: 'warning', icon: SCALE_ICON_SVG, text: t('dialin_ratio_low', ratio.toFixed(1)) };
  const pVals = pAll.filter(v => v >= 5);
  const avgP  = pVals.length ? pVals.reduce((a, b) => a + b, 0) / pVals.length : 0;
  return { type: 'ok', icon: html`✓`, text: `${t('grind_ok')} – ${secs.toFixed(0)} s${avgP > 0 ? `, ${avgP.toFixed(1)} bar Ø` : ''}` };
}

export function calcGrindAdvice(shot: GrindShot, data: ShotSeries): GrindAdvice | null {
  return _applyTaste(_timeGrindAdvice(shot, data), shot);
}

// Parses a shot's own recorded grindSetting and normalizes it to what it
// would read on the grinder TODAY (see grind-zero.ts) — so a comparison or
// average built across shots straddling a zero-point reset (e.g. after
// cleaning) stays meaningful, without any past shot's recorded value
// needing to be rewritten. A no-op when the shot's grinder never tracked a
// zero point.
function _currentGrindNum(grinderName: string | null | undefined, grindSettingStr: string | number | null | undefined, shotTimestampSec: number | undefined): number | null {
  const raw = _parseGrindNum(grindSettingStr);
  return normalizeGrindToNow(S.coffeeLibrary?.grinders, grinderName, raw, shotTimestampSec != null ? shotTimestampSec * 1000 : undefined) ?? null;
}

export function calcComparativeGrindAdvice(shot: GrindShot, allShots: GrindShot[]): ComparativeAdvice | null {
  const ann          = shot.annotation || {};
  // #1837: a mixed shot has no single bean to compare against — its top-level
  // coffee/beanId only name the primary part, so neither it nor any other mixed
  // shot may feed this comparison.
  if (isBeanMix(shot.annotation)) return null;
  const coffee       = ann.coffee?.trim().toLowerCase();
  const beanId       = ann.beanId ?? null;
  const grinder      = ann.grinder?.trim().toLowerCase();
  const profile      = (shot.profile?.name || shot.profileName || '').trim().toLowerCase();
  const dose         = parseFloat(ann.dose as string) || null;
  const currentGrind = _currentGrindNum(ann.grinder, ann.grindSetting, shot.timestamp);
  if (!coffee || !grinder) return null;

  // #456: beanId-first match when both sides have one — a row whose beanId
  // points at a different (or now-deleted) bean is NOT rescued by a name
  // match, same convention as computeBeanRemaining/resolveBeanForAnnotation.
  const sameBean = (a: GrindAnnotation): boolean => beanId != null && a.beanId != null
    ? a.beanId === beanId
    : a.coffee?.trim().toLowerCase() === coffee;

  const comparable = allShots.filter(s => {
    if (s.id === shot.id) return false;
    const a  = s.annotation || {};
    if (isBeanMix(s.annotation)) return false;
    if (!sameBean(a)) return false;
    if (a.grinder?.trim().toLowerCase() !== grinder) return false;
    if ((s.profile?.name || s.profileName || '').trim().toLowerCase() !== profile) return false;
    if (dose) {
      const sd = parseFloat(a.dose as string) || null;
      if (!sd || Math.abs(sd - dose) > 1) return false;
    }
    if (_parseGrindNum(a.grindSetting) === null) return false;
    return calcShotScore(s) !== null;
  });
  if (comparable.length < 1) return null;

  const ranked = _rankableSiblings(comparable);

  const byGrind: Record<number, number[]> = {};
  ranked.forEach(s => {
    const g   = _currentGrindNum(s.annotation?.grinder, s.annotation?.grindSetting, s.timestamp) as number;
    const sc  = calcShotScore(s) as number;
    const key = Math.round(g * 2) / 2;
    const bucket = (byGrind[key] ??= []);
    bucket.push(sc);
  });

  let bestSetting: number | null = null, bestAvg = -1;
  Object.entries(byGrind).forEach(([key, scores]) => {
    const a = scores.reduce((a, b) => a + b, 0) / scores.length;
    if (a > bestAvg) { bestAvg = a; bestSetting = parseFloat(key); }
  });
  if (bestSetting === null) return null;

  const n         = ranked.length;
  const bestScore = Math.round(bestAvg);
  const shots: ComparativeShot[] = ranked
    .map(s => ({ shot: s, grind: _currentGrindNum(s.annotation?.grinder, s.annotation?.grindSetting, s.timestamp), score: calcShotScore(s) as number }))
    .sort((a, b) => b.score - a.score);

  if (currentGrind === null)
    return { type: 'ok',      icon: BAR_CHART_ICON_SVG, text: t('grind_comparative_ok',      n, bestSetting, bestScore), shots };
  const diff = currentGrind - bestSetting;
  const tag = tasteTagOf(ann);
  const outcome = tag && _tasteOutcome(tag, Math.abs(diff) < 0.6 ? null : diff > 0 ? 'finer' : 'coarser', false);
  const tasteKey = outcome ? COMPARATIVE_TASTE_KEYS[outcome] : undefined;
  if (outcome && tasteKey) {
    return { type: outcome === 'finer' || outcome === 'coarser' ? outcome : 'ok', icon: BAR_CHART_ICON_SVG, text: t(tasteKey, n, bestSetting, bestScore), shots };
  }
  if (Math.abs(diff) < 0.6)
    return { type: 'ok',      icon: BAR_CHART_ICON_SVG, text: t('grind_comparative_ok',      n, bestSetting, bestScore), shots };
  if (diff > 0)
    return { type: 'finer',   icon: BAR_CHART_ICON_SVG, text: t('grind_comparative_finer',   n, bestSetting, bestScore), shots };
  return   { type: 'coarser', icon: BAR_CHART_ICON_SVG, text: t('grind_comparative_coarser', n, bestSetting, bestScore), shots };
}

// ── Best grinder+grind-setting combo per bean (Coffee Library) ────────────
// Unlike calcComparativeGrindAdvice (scoped to one shot vs. its comparable
// siblings), this aggregates a bean's *entire* shot history, grouped by
// (grinder, grind setting), to answer "which combo works best for this bean
// overall" — independent of any single shot being viewed.
//
// A combo needs at least MIN_COMBO_SAMPLES shots to be reported: with just
// 1-2 shots a single channeling pour or a bad tamp can make a mediocre combo
// look best, so 3 is the smallest sample that gives a believable average.
const MIN_COMBO_SAMPLES = 3;

export function calcBestGrindCombosForBean(
  beanName: string | null | undefined,
  allShots: GrindShot[] | null | undefined,
  beanId?: number | null,
): GrindCombo[] | null {
  const name = beanName?.trim().toLowerCase();
  if (!name || !Array.isArray(allShots)) return null;

  const scored = allShots.filter(s => {
    const a = s.annotation || {};
    // #1837: a mixed shot's grind says nothing about how THIS bean dials in —
    // only the primary part is named at the top level, so skip it entirely.
    if (isBeanMix(s.annotation)) return false;
    // #456: beanId-first, name fallback — see calcComparativeGrindAdvice.
    const sameBean = beanId != null && a.beanId != null
      ? a.beanId === beanId
      : (a.coffee || '').trim().toLowerCase() === name;
    if (!sameBean) return false;
    if (!a.grinder?.trim()) return false;
    if (_parseGrindNum(a.grindSetting) === null) return false;
    return calcShotScore(s) !== null;
  });
  if (!scored.length) return null;

  const byCombo: Record<string, { grinder: string; grindSetting: number; scores: number[] }> = {};
  scored.forEach(s => {
    const grinder = (s.annotation?.grinder as string).trim();
    const grind    = Math.round((_currentGrindNum(grinder, s.annotation?.grindSetting, s.timestamp) as number) * 2) / 2;
    const key      = `${grinder.toLowerCase()}${grind}`;
    const combo    = (byCombo[key] ??= { grinder, grindSetting: grind, scores: [] });
    combo.scores.push(calcShotScore(s) as number);
  });

  const combos = Object.values(byCombo)
    .filter(c => c.scores.length >= MIN_COMBO_SAMPLES)
    .map(c => ({
      grinder:      c.grinder,
      grindSetting: c.grindSetting,
      avgScore:     Math.round(c.scores.reduce((a, b) => a + b, 0) / c.scores.length),
      shotCount:    c.scores.length,
    }))
    .sort((a, b) => b.avgScore - a.avgScore);

  return combos.length ? combos : null;
}

// ── Bean-aware grinder/grind/dose suggestion ───────────────────────────────
// Same priority order as dialin-wizard.ts's _suggestStartGrind (best
// historical combo, then knownGrindSettings), extended with a "last shot
// with this exact bean" fallback for dose — neither memory source above
// tracks dose. Used to prefill the annotation panel per-bean instead of
// blindly copying whatever the literal previous shot used.
//
// `preferMostRecent` (#389) flips grinder/grindSetting priority to the
// bean's most recently annotated shot FIRST, for quickClone's "↩ Letzten"
// prefill — users expect that action to mean "the grind I last used for
// this bean", not "the statistically best-scoring one". Every other caller
// (e.g. the bean-select change handler, which wants the best-known setting
// when picking a new bean) omits this flag and keeps the original priority.
export function suggestGrindDoseForBean(
  beanName: string | null | undefined,
  coffeeLibrary: GrindLibrary | null | undefined,
  allShots: GrindShot[] | null | undefined,
  { preferMostRecent = false, beanId = null }: { preferMostRecent?: boolean; beanId?: number | null } = {},
): GrindSuggestion {
  const name = beanName?.trim();
  if (!name) return { grinder: '', grindSetting: '', dose: '' };

  const bean = beanId != null
    ? coffeeLibrary?.beans?.find(b => b.id === beanId)
    : coffeeLibrary?.beans?.find(b => b.name === name);
  let grinder = '', grindSetting: string | number = '';

  // #456: beanId-first, name fallback — see calcComparativeGrindAdvice.
  const beanShots = [...(allShots || [])]
    .filter(s => {
      const a = s.annotation || {};
      // #1837: never prefill from a mixed shot — the dose/grind it recorded are
      // the mix's, not this bean's on its own.
      if (isBeanMix(s.annotation)) return false;
      return beanId != null && a.beanId != null
        ? a.beanId === beanId
        : (a.coffee || '').trim().toLowerCase() === name.toLowerCase();
    })
    .sort((a, b) => (b.timestamp as number) - (a.timestamp as number));
  const lastForBean = beanShots[0];

  const defaultGrinder = defaultGrinderName(coffeeLibrary);
  const onDefault = (g: string | null | undefined) =>
    (g || '').trim().toLowerCase() === defaultGrinder.toLowerCase();
  // #1954: with a default grinder only its own shots may supply a grind
  // setting — another grinder's numbers are on a different scale.
  const lastGrindShot = defaultGrinder
    ? beanShots.find(s => onDefault(s.annotation?.grinder) && !!s.annotation?.grindSetting)
    : lastForBean;
  const comboShots = defaultGrinder ? allShots?.filter(s => onDefault(s.annotation?.grinder)) : allShots;

  if (preferMostRecent && lastGrindShot?.annotation?.grindSetting) {
    grinder      = lastGrindShot.annotation.grinder      || '';
    grindSetting = lastGrindShot.annotation.grindSetting;
  }

  if (!grindSetting) {
    const combos = calcBestGrindCombosForBean(name, comboShots, beanId);
    const bestCombo = combos?.[0];
    if (bestCombo) {
      grinder = bestCombo.grinder;
      grindSetting = String(bestCombo.grindSetting);
    } else {
      const known = defaultGrinder
        ? bean?.knownGrindSettings?.find(k => onDefault(k.grinder))
        : bean?.knownGrindSettings?.[0];
      if (known) {
        grinder = known.grinder;
        grindSetting = known.grindSetting;
      }
    }
  }

  if (!grinder)      grinder      = lastGrindShot?.annotation?.grinder      || '';
  if (!grindSetting) grindSetting = lastGrindShot?.annotation?.grindSetting || '';
  const dose = lastForBean?.annotation?.dose || '';

  return { grinder: defaultGrinder || grinder, grindSetting, dose };
}
