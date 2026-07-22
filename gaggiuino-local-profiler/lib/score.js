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

// "1:2.4" -> 2.4 — the bean form's own brewRatio convention (see
// sanitize-bean.js). Anything that doesn't match (empty, freeform notes,
// old data predating the field) yields null so callers fall back cleanly.
function _parseBrewRatioTarget(brewRatio) {
  if (!brewRatio) return null;
  const m = String(brewRatio).match(/^\s*1\s*:\s*(\d+(?:\.\d+)?)\s*$/);
  return m ? parseFloat(m[1]) : null;
}

// Weighted: pressure 25, temp stability 20, duration 20, brew ratio 20, channeling 15.
// `bean` (#450) is the coffee-library entry matching the shot's own
// annotation.coffee, resolved by the caller — optional. When absent, or when
// it has no brewTempC/brewRatio set, scoring is byte-identical to before
// #450 (generic fixed bands). When present, its own recommendation becomes
// the target instead of the generic band — but never overrides the shot's
// own recorded target-temperature curve, which stays the highest-priority
// source since it reflects what the profile actually asked for.
//
// calcShotScoreDetail (#457) is the actual implementation, returning both
// the score and whether the bean's own brewTempC/brewRatio recommendation
// was actually used for either factor (as opposed to the shot's own target
// curve or the generic fallback band) — powers the verdict header's "scored
// against this bean's target" hint. calcShotScore stays a thin wrapper
// around it so every existing caller that only wants the number (there are
// many, across both backend and frontend) is untouched.
function calcShotScoreDetail(shot, bean) {
  if (!shot) return { score: null, usedBeanTarget: false };
  const d = shot.datapoints || {};
  const p = (d.pressure || []).map(v => v / 10);
  const pVals = p.filter(v => v >= 5);
  if (pVals.length <= 3) return { score: null, usedBeanTarget: false };

  const scores = [], weights = [];
  let usedBeanTarget = false;

  const avgP = pVals.reduce((a, b) => a + b, 0) / pVals.length;
  let s = avgP >= 7 && avgP <= 9.5 ? 100
        : avgP < 7                  ? Math.max(20, 100 - (7 - avgP) * 22)
                                    : Math.max(20, 100 - (avgP - 9.5) * 28);
  scores.push(Math.round(s)); weights.push(25);

  const tVals = (d.temperature || []).map(v => v / 10);
  if (tVals.length > 5) {
    const sd = _stddev(tVals) || 0;
    const stab = sd <= 0.3 ? 100 : sd <= 0.7 ? 90 : sd <= 1.5 ? 72
      : sd <= 3 ? 50 : Math.max(15, 50 - (sd - 3) * 12);
    // accuracy vs. (in priority order) the shot's own target curve, the
    // bean's brewTempC recommendation (#450), or a fallback 90–96 °C band.
    const avgT = tVals.reduce((a, b) => a + b, 0) / tVals.length;
    const tgt  = (d.targetTemperature || []).map(v => v / 10).filter(v => v > 0);
    let acc;
    if (tgt.length) {
      const dev = Math.abs(avgT - tgt.reduce((a, b) => a + b, 0) / tgt.length);
      acc = dev <= 0.5 ? 100 : dev <= 1 ? 90 : dev <= 2 ? 75
          : dev <= 4 ? 50 : Math.max(15, 50 - (dev - 4) * 8);
    } else if (bean && typeof bean.brewTempC === 'number' && bean.brewTempC > 0) {
      const dev = Math.abs(avgT - bean.brewTempC);
      acc = dev <= 0.5 ? 100 : dev <= 1 ? 90 : dev <= 2 ? 75
          : dev <= 4 ? 50 : Math.max(15, 50 - (dev - 4) * 8);
      usedBeanTarget = true;
    } else {
      const off = avgT >= 90 && avgT <= 96 ? 0 : avgT < 90 ? 90 - avgT : avgT - 96;
      acc = off === 0 ? 100 : Math.max(15, 100 - off * 10);
    }
    s = Math.round((stab + acc) / 2);
    scores.push(s); weights.push(20);
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
    // Bean's own brewRatio recommendation (#450) replaces the generic
    // 1.8–2.5 band as the target when set.
    const beanRatioTarget = bean ? _parseBrewRatioTarget(bean.brewRatio) : null;
    if (beanRatioTarget != null) {
      const dev = Math.abs(r - beanRatioTarget);
      s = dev <= 0.35 ? 100 : dev <= 0.75 ? 75 : Math.max(15, 75 - (dev - 0.75) * 30);
      usedBeanTarget = true;
    } else {
      s = r >= 1.8 && r <= 2.5 ? 100
        : (r >= 1.5 && r < 1.8) || (r > 2.5 && r <= 3.2) ? 75
        : r < 1.5 ? Math.max(15, 55 - (1.5 - r) * 40)
                  : Math.max(15, 60 - (r - 3.2) * 22);
    }
    scores.push(Math.round(s)); weights.push(20);
  }

  // Extraction Yield (SCA "Golden Cup" 18–22 %) — only when TDS + dose are known
  if (ann.dose && ann.dose > 0 && ann.tds && finalW) {
    const ey = (finalW * ann.tds) / ann.dose;
    s = ey >= 18 && ey <= 22 ? 100
      : (ey >= 16 && ey < 18) || (ey > 22 && ey <= 24) ? 75
      : ey < 16 ? Math.max(15, 60 - (16 - ey) * 10)
                : Math.max(15, 60 - (ey - 24) * 10);
    scores.push(Math.round(s)); weights.push(20);
  }

  const times = (d.timeInShot || []).map(v => v / 10);
  scores.push(_detectChanneling(times, p) ? 20 : 100); weights.push(15);

  const tw = weights.reduce((a, b) => a + b, 0);
  const score = tw ? Math.round(scores.reduce((acc, v, i) => acc + v * weights[i], 0) / tw) : null;
  return { score, usedBeanTarget: score !== null && usedBeanTarget };
}

function calcShotScore(shot, bean) {
  return calcShotScoreDetail(shot, bean).score;
}

module.exports = { calcShotScore, calcShotScoreDetail };
