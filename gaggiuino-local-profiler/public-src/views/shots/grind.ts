import { t }                               from '../../i18n.js';
import { S }                               from '../../state/index.js';
import { detectChanneling, calcBrewRatio } from '../../utils.js';
import type { ShotSeries } from '../../utils.js';
import { calcShotScore }                   from './utils.js';
import type { ShotLike }                   from './utils.js';
import { getRawCurve }                     from '../../shot-curves.js';
import { normalizeGrindToNow }             from '../../grind-zero.js';
import { LIGHTNING_ICON_SVG, SCALE_ICON_SVG, BAR_CHART_ICON_SVG } from '../../icons.js';

interface GrindAnnotation {
  coffee?: string | null;
  beanId?: number | null;
  grinder?: string | null;
  dose?: string | number | null;
  grindSetting?: string | number | null;
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
  icon: string;
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
}

export interface GrindSuggestion {
  grinder: string;
  grindSetting: string | number;
  dose: string | number;
}

// ── Mini chart thumbnail ───────────────────────────────────────────────────

// #957: curves are lazy — callers (index.js updateView) ensureCurves() for
// every comparable shot before rendering the panel, so the cache read is
// synchronous here; a still-missing curve falls back to the shot's own
// datapoints (synthetic/demo) and finally to the no-data placeholder.
export function _miniShotChart(shot: GrindShot): string {
  const d  = getRawCurve(shot.id) || shot.datapoints || {};
  const tm = d.timeInShot || [];
  const series = [
    { vals: (d.pressure  || []).map((v, i) => ({ x: tm[i] / 10, y: v / 10 })).filter(p => p.y > 0), color: '#60a5fa' },
    { vals: (d.pumpFlow  || []).map((v, i) => ({ x: tm[i] / 10, y: v / 10 })).filter(p => p.y >= 0), color: '#fb923c' },
  ].filter(s => s.vals.length >= 3);
  if (!series.length) return '<div class="comp-thumb-no-data">–</div>';

  const W = 140, H = 65, pad = 2;
  const allX = series.flatMap(s => s.vals.map(p => p.x));
  const allY = series.flatMap(s => s.vals.map(p => p.y));
  const xMin = Math.min(...allX), xMax = Math.max(...allX) || 1;
  const yMax = Math.max(...allY, 1);

  const px = (x: number): number => pad + ((x - xMin) / (xMax - xMin)) * (W - pad * 2);
  const py = (y: number): number => H - pad - (y / yMax) * (H - pad * 2);

  const polyline = ({ vals, color }: { vals: XYPoint[]; color: string }): string => {
    const pts = vals.map(p => `${px(p.x).toFixed(1)},${py(p.y).toFixed(1)}`).join(' ');
    return `<polyline points="${pts}" fill="none" stroke="${color}" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round" opacity=".9"/>`;
  };
  return `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" style="width:100%;height:${H}px;display:block">${series.map(polyline).join('')}</svg>`;
}

// ── Grind setting parser ───────────────────────────────────────────────────

export function _parseGrindNum(s: string | number | null | undefined): number | null {
  if (!s) return null;
  const m = String(s).match(/(\d+(?:[.,]\d+)?)/);
  return m ? parseFloat(m[1].replace(',', '.')) : null;
}

// ── Grind advice ──────────────────────────────────────────────────────────

export function calcGrindAdvice(shot: GrindShot, data: ShotSeries): GrindAdvice | null {
  const secs = (shot.duration || 0) / 10;
  if (secs < 8) return null;
  const pTimes = data.pressure.map(p => p.x);
  const pAll   = data.pressure.map(p => p.y);
  if (detectChanneling(pTimes, pAll))
    return { type: 'warning', icon: LIGHTNING_ICON_SVG, text: t('grind_channeling_full') };
  if (secs < 18) return { type: 'finer',   icon: '↓', text: t('grind_short', secs.toFixed(0)) };
  if (secs < 23) return { type: 'finer',   icon: '↓', text: t('grind_short_slight', secs.toFixed(0)) };
  if (secs > 50) return { type: 'coarser', icon: '↑', text: t('grind_long', secs.toFixed(0)) };
  if (secs > 42) return { type: 'coarser', icon: '↑', text: t('grind_long_slight', secs.toFixed(0)) };
  // Duration is fine — check the brew ratio against the classic espresso
  // window (1:1.8–1:2.2). Yield is machine-stopped, so this is dose/yield
  // guidance rather than a grind direction.
  const ratio = calcBrewRatio(shot as unknown as Parameters<typeof calcBrewRatio>[0], data);
  if (ratio !== null && ratio > 2.3)
    return { type: 'warning', icon: SCALE_ICON_SVG, text: t('dialin_ratio_high', ratio.toFixed(1)) };
  if (ratio !== null && ratio < 1.7)
    return { type: 'warning', icon: SCALE_ICON_SVG, text: t('dialin_ratio_low', ratio.toFixed(1)) };
  const pVals = pAll.filter(v => v >= 5);
  const avgP  = pVals.length ? pVals.reduce((a, b) => a + b, 0) / pVals.length : 0;
  return { type: 'ok', icon: '✓', text: `${t('grind_ok')} – ${secs.toFixed(0)} s${avgP > 0 ? `, ${avgP.toFixed(1)} bar Ø` : ''}` };
}

// Parses a shot's own recorded grindSetting and normalizes it to what it
// would read on the grinder TODAY (see grind-zero.js) — so a comparison or
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

  const byGrind: Record<number, number[]> = {};
  comparable.forEach(s => {
    const g   = _currentGrindNum(s.annotation?.grinder, s.annotation?.grindSetting, s.timestamp) as number;
    const sc  = calcShotScore(s) as number;
    const key = Math.round(g * 2) / 2;
    if (!byGrind[key]) byGrind[key] = [];
    byGrind[key].push(sc);
  });

  let bestSetting: number | null = null, bestAvg = -1;
  Object.entries(byGrind).forEach(([key, scores]) => {
    const a = scores.reduce((a, b) => a + b, 0) / scores.length;
    if (a > bestAvg) { bestAvg = a; bestSetting = parseFloat(key); }
  });
  if (bestSetting === null) return null;

  const n         = comparable.length;
  const bestScore = Math.round(bestAvg);
  const shots: ComparativeShot[] = comparable
    .map(s => ({ shot: s, grind: _currentGrindNum(s.annotation?.grinder, s.annotation?.grindSetting, s.timestamp), score: calcShotScore(s) as number }))
    .sort((a, b) => b.score - a.score);

  if (currentGrind === null)
    return { type: 'ok',      icon: BAR_CHART_ICON_SVG, text: t('grind_comparative_ok',      n, bestSetting, bestScore), shots };
  const diff = currentGrind - bestSetting;
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
    if (!byCombo[key]) byCombo[key] = { grinder, grindSetting: grind, scores: [] };
    byCombo[key].scores.push(calcShotScore(s) as number);
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
// Same priority order as dialin-wizard.js's _suggestStartGrind (best
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
  const lastForBean = [...(allShots || [])]
    .filter(s => {
      const a = s.annotation || {};
      return beanId != null && a.beanId != null
        ? a.beanId === beanId
        : (a.coffee || '').trim().toLowerCase() === name.toLowerCase();
    })
    .sort((a, b) => (b.timestamp as number) - (a.timestamp as number))[0];

  if (preferMostRecent && lastForBean?.annotation?.grindSetting) {
    grinder      = lastForBean.annotation.grinder      || '';
    grindSetting = lastForBean.annotation.grindSetting;
  }

  if (!grindSetting) {
    const combos = calcBestGrindCombosForBean(name, allShots, beanId);
    if (combos?.length) {
      grinder = combos[0].grinder;
      grindSetting = String(combos[0].grindSetting);
    } else if (bean?.knownGrindSettings?.length) {
      grinder = bean.knownGrindSettings[0].grinder;
      grindSetting = bean.knownGrindSettings[0].grindSetting;
    }
  }

  if (!grinder)      grinder      = lastForBean?.annotation?.grinder      || '';
  if (!grindSetting) grindSetting = lastForBean?.annotation?.grindSetting || '';
  const dose = lastForBean?.annotation?.dose || '';

  return { grinder, grindSetting, dose };
}
