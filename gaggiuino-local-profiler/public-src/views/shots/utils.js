import { S }                    from '../../state.js';
import { mapShotDatapoints }    from '../../utils.js';
import { calcShotScore as _calcShotScore, calcShotScoreDetail as _calcShotScoreDetail } from '../../../lib/score.js';

// ── Bean age ───────────────────────────────────────────────────────────────

function _parseDMY(str) {
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
export function resolveBeanForAnnotation(annotation, beans) {
  const list = beans || S.coffeeLibrary?.beans || [];
  if (annotation?.beanId != null) {
    const byId = list.find(b => b.id === annotation.beanId);
    if (byId) return byId;
  }
  const name = annotation?.coffee;
  if (!name) return null;
  const key = String(name).toLowerCase();
  return list.find(b => String(b.name || '').toLowerCase() === key) || null;
}

export function _roastDateFromLibrary(beanName, shotTimestampSec, beanId) {
  if (!S.coffeeLibrary) return null;
  const bean = resolveBeanForAnnotation({ coffee: beanName, beanId }, S.coffeeLibrary.beans);
  if (!bean) return null;
  const shotMs = (shotTimestampSec || Date.now() / 1000) * 1000;
  const bags   = Array.isArray(bean.bags) ? bean.bags : [];
  let roastDateStr = bean.roastDate;
  if (bags.length) {
    const activeBag = bags
      .filter(b => (b.openedAt || 0) <= shotMs)
      .sort((a, b) => b.openedAt - a.openedAt)[0];
    if (activeBag?.roastDate) roastDateStr = activeBag.roastDate;
  }
  return roastDateStr || null;
}

export function calcBeanAgeAtShot(beanName, shotTimestampSec, beanId) {
  if (!shotTimestampSec || !S.coffeeLibrary) return null;
  const bean = resolveBeanForAnnotation({ coffee: beanName, beanId }, S.coffeeLibrary.beans);
  if (!bean) return null;
  const shotMs = shotTimestampSec * 1000;
  const bags   = Array.isArray(bean.bags) ? bean.bags : [];
  let roastDateStr = bean.roastDate;
  if (bags.length) {
    const activeBag = bags
      .filter(b => (b.openedAt || 0) <= shotMs)
      .sort((a, b) => b.openedAt - a.openedAt)[0];
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
export function getShotData(shot) {
  if (!shot) return null;
  return mapShotDatapoints(shot.datapoints);
}

// Prefer the server-computed score; only recompute locally for synthetic data
// (server-computed shots always already carry .score, bean-aware per #450).
export function calcShotScore(shot, _data) {
  if (shot && shot.score !== undefined) return shot.score;
  const bean = resolveBeanForAnnotation(shot?.annotation);
  return _calcShotScore(shot, bean);
}

// #457: whether the bean's own brewTempC/brewRatio recommendation was
// actually used for this shot's score, powering the verdict header's hint.
// Prefers the server-computed flag (server-computed shots always carry
// .usedBeanTarget alongside .score, per #450/#457); only recomputes locally
// for synthetic data, mirroring calcShotScore above.
export function shotUsedBeanTarget(shot) {
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
export function findPreviousShot(shots, shot) {
  if (!shot || !shot.profileName) return null;
  const machineId = shot.machineId ?? 1;
  let prev = null;
  for (const s of shots) {
    if (s.id === shot.id) continue;
    if ((s.machineId ?? 1) !== machineId) continue;
    if (s.profileName !== shot.profileName) continue;
    if (s.timestamp >= shot.timestamp) continue;
    if (!prev || s.timestamp > prev.timestamp) prev = s;
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
function _sameBean(annA, annB) {
  const beanA = resolveBeanForAnnotation(annA);
  const beanB = resolveBeanForAnnotation(annB);
  if (beanA && beanB) return beanA.id === beanB.id;
  const nameA = (annA?.coffee || '').trim().toLowerCase();
  const nameB = (annB?.coffee || '').trim().toLowerCase();
  return !!nameA && nameA === nameB;
}

export function findPreviousShotForBean(shots, shot) {
  const ann = shot?.annotation;
  if (!ann?.coffee && ann?.beanId == null) return null;
  let prev = null;
  for (const s of shots) {
    if (s.id === shot.id) continue;
    if (!_sameBean(ann, s.annotation)) continue;
    if (s.timestamp >= shot.timestamp) continue;
    if (!prev || s.timestamp > prev.timestamp) prev = s;
  }
  return prev;
}

// True when `shot` is the most recent shot recorded for its own bean — the
// reference chip only makes sense while dialing in the newest shot; older
// shots already have later data to compare against via the normal
// comparative grind advice instead.
export function isNewestShotForBean(shots, shot) {
  const ann = shot?.annotation;
  if (!ann?.coffee && ann?.beanId == null) return false;
  return !shots.some(s =>
    s.id !== shot.id &&
    _sameBean(ann, s.annotation) &&
    s.timestamp > shot.timestamp
  );
}

// #838: replaces the separate "Letzter Mahlgrad" chip — the baseline is now
// folded straight into the bean/grinder line's grind portion instead of
// getting its own box. `allowBaseline` is the caller's compare-mode gate
// (the baseline reference only makes sense outside compare mode, same as
// the old chip's `!shotB` check).
export function buildGrinderGrindLabel(shots, shot, allowBaseline, t) {
  const ann = shot?.annotation || {};
  if (!ann.grindSetting) return ann.grinder || null;
  const prevGrind = (allowBaseline && isNewestShotForBean(shots, shot))
    ? findPreviousShotForBean(shots, shot)?.annotation?.grindSetting
    : null;
  return prevGrind
    ? t('recipe_grind_with_baseline', ann.grinder || '', ann.grindSetting, prevGrind)
    : t('recipe_grinder_grind', ann.grinder || '', ann.grindSetting);
}
