import { S }                    from '../../state/index.js';
import type { LibraryRow }      from '../../state/index.js';
import { mapShotDatapoints }    from '../../utils.js';
import type { ShotDatapoints, ShotSeries } from '../../utils.js';
import { calcShotScore as _calcShotScore, calcShotScoreDetail as _calcShotScoreDetail } from '../../shared/score.js';

// state/index.ts types shot rows as metadata-only `ShotMeta` with an index
// signature; these local aliases name the fields these helpers actually read
// (same pattern as components/sidebar.ts).
interface ShotAnnotationLike {
  beanId?: number | null;
  coffee?: string | null;
  grindSetting?: string | number | null;
  grinder?: string | null;
}

export interface ShotLike {
  id?: number;
  machineId?: number | null;
  timestamp?: number;
  profileName?: string | null;
  score?: number | null;
  usedBeanTarget?: boolean;
  datapoints?: ShotDatapoints;
  annotation?: ShotAnnotationLike | null;
}

interface BeanBag {
  openedAt?: number | null;
  roastDate?: string | null;
}

interface BeanRecord {
  id: number;
  name?: string | null;
  roastDate?: string | null;
  bags?: BeanBag[];
}

// ── Bean age ───────────────────────────────────────────────────────────────

function _parseDMY(str: string | null | undefined): number {
  if (!str) return NaN;
  const p = str.split('.');
  if (p.length !== 3) return NaN;
  return new Date(+p[2], +p[1] - 1, +p[0]).getTime();
}

// #456: resolves a shot/annotation to its library bean, preferring the
// stable beanId link over the free-text coffee name — mirrors
// LibraryService.resolveBeanForAnnotation on the backend, and the same
// underlying rule as library.js's renderBeanList consumption totals: when
// beanId resolves to a bean, it's trusted exclusively; only when it's
// absent, or points at nothing currently in the library, does this fall
// back to a name match (recovering a delete+reimport under the same name,
// and covering annotations that predate beanId).
export function resolveBeanForAnnotation(annotation: unknown, beans?: unknown): LibraryRow | null {
  const ann = annotation as ShotAnnotationLike | null | undefined;
  const list = (Array.isArray(beans) ? beans : S.coffeeLibrary?.beans || []) as LibraryRow[];
  if (ann?.beanId != null) {
    const byId = list.find(b => b.id === ann.beanId);
    if (byId) return byId;
  }
  const name = ann?.coffee;
  if (!name) return null;
  const key = String(name).toLowerCase();
  return list.find(b => String((b.name || '') as string).toLowerCase() === key) || null;
}

export function _roastDateFromLibrary(
  beanName: string | null | undefined,
  shotTimestampSec: number | null | undefined,
  beanId?: number | null,
): string | null {
  if (!S.coffeeLibrary) return null;
  const bean = resolveBeanForAnnotation({ coffee: beanName, beanId }, S.coffeeLibrary.beans) as unknown as BeanRecord | null;
  if (!bean) return null;
  const shotMs = (shotTimestampSec || Date.now() / 1000) * 1000;
  const bags   = Array.isArray(bean.bags) ? bean.bags : [];
  let roastDateStr = bean.roastDate;
  if (bags.length) {
    const activeBag = bags
      .filter(b => (b.openedAt || 0) <= shotMs)
      .sort((a, b) => (b.openedAt as number) - (a.openedAt as number))[0];
    if (activeBag?.roastDate) roastDateStr = activeBag.roastDate;
  }
  return roastDateStr || null;
}

export function calcBeanAgeAtShot(
  beanName: string | null | undefined,
  shotTimestampSec: number | null | undefined,
  beanId?: number | null,
): number | null {
  if (!shotTimestampSec || !S.coffeeLibrary) return null;
  const bean = resolveBeanForAnnotation({ coffee: beanName, beanId }, S.coffeeLibrary.beans) as unknown as BeanRecord | null;
  if (!bean) return null;
  const shotMs = shotTimestampSec * 1000;
  const bags   = Array.isArray(bean.bags) ? bean.bags : [];
  let roastDateStr = bean.roastDate;
  if (bags.length) {
    const activeBag = bags
      .filter(b => (b.openedAt || 0) <= shotMs)
      .sort((a, b) => (b.openedAt as number) - (a.openedAt as number))[0];
    if (activeBag?.roastDate) roastDateStr = activeBag.roastDate;
  }
  const roastMs = _parseDMY(roastDateStr);
  if (isNaN(roastMs)) return null;
  const days = Math.round((shotMs - roastMs) / 86400000);
  return days >= 0 && days <= 730 ? days : null;
}

// ── Shot data ─────────────────────────────────────────────────────────────

// getShotData(shot) reads shot.datapoints directly — only valid for a shot
// object that actually carries its curve blob (synthetic/demo data, a shot
// just fetched from GET /api/shots/{id}, or a live-brew payload). List rows
// from GET /api/shots no longer carry datapoints: go through the curve cache
// (shot-curves.js getShotCurve / getCachedShotData) for those.
export function getShotData(shot: { datapoints?: ShotDatapoints } | null | undefined): ShotSeries | null {
  if (!shot) return null;
  return mapShotDatapoints(shot.datapoints);
}

// Prefer the server-computed score; only recompute locally for synthetic data
// (server-computed shots always already carry .score, bean-aware per #450).
export function calcShotScore(shot: ShotLike | null | undefined, _data?: unknown): number | null {
  if (shot && shot.score !== undefined) return shot.score;
  const bean = resolveBeanForAnnotation(shot?.annotation);
  return _calcShotScore(shot, bean);
}

// #457: whether the bean's own brewTempC/brewRatio recommendation was
// actually used for this shot's score, powering the verdict header's hint.
// Prefers the server-computed flag (server-computed shots always carry
// .usedBeanTarget alongside .score, per #450/#457); only recomputes locally
// for synthetic data, mirroring calcShotScore above.
export function shotUsedBeanTarget(shot: ShotLike | null | undefined): boolean {
  if (shot && shot.usedBeanTarget !== undefined) return !!shot.usedBeanTarget;
  const bean = resolveBeanForAnnotation(shot?.annotation);
  return _calcShotScoreDetail(shot, bean).usedBeanTarget;
}

// ── Same-profile auto-compare (#402) ────────────────────────────────────────

// Client-side mirror of ShotRepository.findPreviousByProfile: most recent
// shot before `shot` with the same profile name on the same machine. Reads
// from the already-loaded S.shots (bulk shots.json, score included) instead
// of a second network round-trip against GET /api/shots/:id — every shot
// needed for the ghost curve/delta chips is already in memory once the shot
// list has loaded.
export function findPreviousShot(shots: ShotLike[], shot: ShotLike): ShotLike | null {
  if (!shot || !shot.profileName) return null;
  const machineId = shot.machineId ?? 1;
  let prev: ShotLike | null = null;
  for (const s of shots) {
    if (s.id === shot.id) continue;
    if ((s.machineId ?? 1) !== machineId) continue;
    if (s.profileName !== shot.profileName) continue;
    if ((s.timestamp as number) >= (shot.timestamp as number)) continue;
    if (!prev || (s.timestamp as number) > (prev.timestamp as number)) prev = s;
  }
  return prev;
}

// ── Bean grind-setting baseline (#429) ──────────────────────────────────────
// Same "most recent shot before this one" shape as findPreviousShot, but
// scoped to the same bean (annotation.coffee) instead of the same profile —
// used for the "Letzter Mahlgrad" reference chip so the grind advice for the
// newest shot of a bean can be read against what was actually dialed in last.
// #456: two shots are "the same bean" when their resolved beans share an id;
// when either annotation can't be resolved to a current bean (predates
// beanId, or its bean was deleted), falls back to comparing the raw coffee
// name strings as recorded at save time.
function _sameBean(annA: ShotAnnotationLike | null | undefined, annB: ShotAnnotationLike | null | undefined): boolean {
  const beanA = resolveBeanForAnnotation(annA);
  const beanB = resolveBeanForAnnotation(annB);
  if (beanA && beanB) return beanA.id === beanB.id;
  const nameA = (annA?.coffee || '').trim().toLowerCase();
  const nameB = (annB?.coffee || '').trim().toLowerCase();
  return !!nameA && nameA === nameB;
}

export function findPreviousShotForBean(shots: ShotLike[], shot: ShotLike): ShotLike | null {
  const ann = shot?.annotation;
  if (!ann?.coffee && ann?.beanId == null) return null;
  let prev: ShotLike | null = null;
  for (const s of shots) {
    if (s.id === shot.id) continue;
    if (!_sameBean(ann, s.annotation)) continue;
    if ((s.timestamp as number) >= (shot.timestamp as number)) continue;
    if (!prev || (s.timestamp as number) > (prev.timestamp as number)) prev = s;
  }
  return prev;
}

// True when `shot` is the most recent shot recorded for its own bean — the
// reference chip only makes sense while dialing in the newest shot; older
// shots already have later data to compare against via the normal
// comparative grind advice instead.
export function isNewestShotForBean(shots: ShotLike[], shot: ShotLike): boolean {
  const ann = shot?.annotation;
  if (!ann?.coffee && ann?.beanId == null) return false;
  return !shots.some(s =>
    s.id !== shot.id &&
    _sameBean(ann, s.annotation) &&
    (s.timestamp as number) > (shot.timestamp as number)
  );
}

// #838: replaces the separate "Letzter Mahlgrad" chip — the baseline is now
// folded straight into the bean/grinder line's grind portion instead of
// getting its own box. `allowBaseline` is the caller's compare-mode gate
// (the baseline reference only makes sense outside compare mode, same as
// the old chip's `!shotB` check).
export function buildGrinderGrindLabel(
  shots: ShotLike[],
  shot: ShotLike,
  allowBaseline: boolean,
  t: (key: string, ...args: unknown[]) => string,
): string | null {
  const ann: ShotAnnotationLike = shot?.annotation || {};
  if (!ann.grindSetting) return ann.grinder || null;
  const prevGrind = (allowBaseline && isNewestShotForBean(shots, shot))
    ? findPreviousShotForBean(shots, shot)?.annotation?.grindSetting
    : null;
  return prevGrind
    ? t('recipe_grind_with_baseline', ann.grinder || '', ann.grindSetting, prevGrind)
    : t('recipe_grinder_grind', ann.grinder || '', ann.grindSetting);
}
