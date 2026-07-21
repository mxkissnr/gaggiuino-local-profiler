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

export function _roastDateFromLibrary(beanName, shotTimestampSec) {
  if (!beanName || !S.coffeeLibrary) return null;
  const bean = S.coffeeLibrary.beans?.find(b => b.name.toLowerCase() === beanName.toLowerCase());
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

export function calcBeanAgeAtShot(beanName, shotTimestampSec) {
  if (!beanName || !shotTimestampSec || !S.coffeeLibrary) return null;
  const bean = S.coffeeLibrary.beans?.find(b => b.name.toLowerCase() === beanName.toLowerCase());
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
  const coffee = shot?.annotation?.coffee;
  const bean = coffee ? S.coffeeLibrary?.beans?.find(b => b.name.toLowerCase() === coffee.toLowerCase()) : null;
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
export function findPreviousShotForBean(shots, shot) {
  const coffee = shot?.annotation?.coffee?.trim().toLowerCase();
  if (!coffee) return null;
  let prev = null;
  for (const s of shots) {
    if (s.id === shot.id) continue;
    if ((s.annotation?.coffee || '').trim().toLowerCase() !== coffee) continue;
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
  const coffee = shot?.annotation?.coffee?.trim().toLowerCase();
  if (!coffee) return false;
  return !shots.some(s =>
    s.id !== shot.id &&
    (s.annotation?.coffee || '').trim().toLowerCase() === coffee &&
    s.timestamp > shot.timestamp
  );
}
