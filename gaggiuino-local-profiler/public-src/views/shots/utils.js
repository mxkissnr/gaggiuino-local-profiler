import { S }                    from '../../state.js';
import { mapToXY }              from '../../utils.js';
import { calcShotScore as _calcShotScore } from '../../../lib/score.js';

// ── Bean age ───────────────────────────────────────────────────────────────

function _parseDMY(str) {
  if (!str) return NaN;
  const p = str.split('.');
  if (p.length !== 3) return NaN;
  return new Date(+p[2], +p[1] - 1, +p[0]).getTime();
}

// #456: resolves a shot/annotation to its library bean, preferring the
// stable beanId link over the free-text coffee name — mirrors
// LibraryService.resolveBeanForAnnotation on the backend. beanId survives
// bean renames (name-matching never could); it deliberately does NOT fall
// back to a name match when it points at a bean that's gone (a bean deleted
// and reimported under the same name is a new identity, correctly distinct
// from the old one). Only annotations that predate beanId fall back to
// name matching.
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

export function getShotData(shot) {
  if (!shot) return null;
  const d = shot.datapoints || {};
  const t = d.timeInShot || [];
  return {
    rawTimes:       t.map(v => v / 10),
    pressure:       mapToXY(t, d.pressure),
    targetPressure: mapToXY(t, d.targetPressure),
    flow:           mapToXY(t, d.pumpFlow),
    targetFlow:     mapToXY(t, d.targetPumpFlow),
    weight:         mapToXY(t, d.shotWeight || d.weight),
    weightFlow:     mapToXY(t, d.weightFlow),
    temp:           mapToXY(t, d.temperature),
    targetTemp:     mapToXY(t, d.targetTemperature),
  };
}

// Prefer the server-computed score; only recompute locally for synthetic data
// (server-computed shots always already carry .score, bean-aware per #450).
export function calcShotScore(shot, _data) {
  if (shot && shot.score !== undefined) return shot.score;
  const bean = resolveBeanForAnnotation(shot?.annotation);
  return _calcShotScore(shot, bean);
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
