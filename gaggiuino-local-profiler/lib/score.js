// Canonical shot score (0–100). Single source of truth shared by the backend
// (served as `score` on each shot) and the frontend. Pure function — no Node/DOM
// deps so it works in both. Inputs are the raw shot object (×10 integer curves).

function _stddev(vals) {
  if (vals.length < 2) return 0;
  const m = vals.reduce((a, b) => a + b, 0) / vals.length;
  return Math.sqrt(vals.reduce((a, b) => a + (b - m) ** 2, 0) / vals.length);
}

function _detectChanneling(times, pressures) {
  if (!times || !times.length || pressures.length < 5) return false;
  for (let i = 1; i < pressures.length; i++) {
    if (pressures[i - 1] < 5) continue;
    const dt = times[i] - times[i - 1];
    if (dt <= 0 || dt > 3) continue;
    if (pressures[i - 1] - pressures[i] > 1.5) return true;
  }
  return false;
}

// Weighted: pressure 25, temp stability 20, duration 20, brew ratio 20, channeling 15.
function calcShotScore(shot) {
  if (!shot) return null;
  const d = shot.datapoints || {};
  const p = (d.pressure || []).map(v => v / 10);
  const pVals = p.filter(v => v >= 5);
  if (pVals.length <= 3) return null;

  const scores = [], weights = [];

  const avgP = pVals.reduce((a, b) => a + b, 0) / pVals.length;
  let s = avgP >= 7 && avgP <= 9.5 ? 100
        : avgP < 7                  ? Math.max(20, 100 - (7 - avgP) * 22)
                                    : Math.max(20, 100 - (avgP - 9.5) * 28);
  scores.push(Math.round(s)); weights.push(25);

  const tVals = (d.temperature || []).map(v => v / 10);
  if (tVals.length > 5) {
    const sd = _stddev(tVals) || 0;
    s = sd <= 0.3 ? 100 : sd <= 0.7 ? 90 : sd <= 1.5 ? 72
      : sd <= 3   ? 50  : Math.max(15, 50 - (sd - 3) * 12);
    scores.push(Math.round(s)); weights.push(20);
  }

  const secs = (shot.duration || 0) / 10;
  if (secs > 5) {
    s = secs >= 25 && secs <= 35 ? 100
      : (secs >= 20 && secs < 25) || (secs > 35 && secs <= 42) ? 82
      : secs > 42 && secs <= 55   ? 62
      : secs < 20 ? Math.max(15, 70 - (20 - secs) * 5)
                  : Math.max(15, 62 - (secs - 55) * 3);
    scores.push(Math.round(s)); weights.push(20);
  }

  const ann    = shot.annotation || {};
  const wArr   = d.shotWeight || d.weight || [];
  const finalW = wArr.length ? Math.max(...wArr.map(v => v / 10)) : 0;
  if (ann.dose && ann.dose > 0 && finalW) {
    const r = finalW / ann.dose;
    s = r >= 1.8 && r <= 2.5 ? 100
      : (r >= 1.5 && r < 1.8) || (r > 2.5 && r <= 3.2) ? 75
      : r < 1.5 ? Math.max(15, 55 - (1.5 - r) * 40)
                : Math.max(15, 60 - (r - 3.2) * 22);
    scores.push(Math.round(s)); weights.push(20);
  }

  const times = (d.timeInShot || []).map(v => v / 10);
  scores.push(_detectChanneling(times, p) ? 20 : 100); weights.push(15);

  const tw = weights.reduce((a, b) => a + b, 0);
  return tw ? Math.round(scores.reduce((acc, v, i) => acc + v * weights[i], 0) / tw) : null;
}

module.exports = { calcShotScore };
