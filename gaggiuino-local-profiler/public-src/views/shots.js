import { S } from '../state.js';
import { t } from '../i18n.js';
import { apiFetch } from '../api.js';
import { LOCALE_MAP, phasePlugin, corsairPlugin } from '../constants.js';
import {
  esc, avg, avgActive, max, safeLast, fmt, formatTimeLabel, mapToXY,
  stddev, detectPhases, detectChanneling, isoToGerman, germanToIso, scoreClass
} from '../utils.js';
import { renderSidebar, updateSidebarHighlighting } from '../components/sidebar.js';

// ── Shot data helper ──────────────────────────────────────────────────────
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
    targetTemp:     mapToXY(t, d.targetTemperature)
  };
}

// ── Shot score ────────────────────────────────────────────────────────────
export function calcShotScore(shot, data) {
  const pVals = data.pressure.map(p => p.y).filter(v => v >= 5);
  if (pVals.length <= 3) return null;

  const scores = [], weights = [];

  if (pVals.length > 3) {
    const avgP = pVals.reduce((a, b) => a + b, 0) / pVals.length;
    let s = avgP >= 7 && avgP <= 9.5 ? 100
          : avgP < 7                  ? Math.max(20, 100 - (7 - avgP) * 22)
                                      : Math.max(20, 100 - (avgP - 9.5) * 28);
    scores.push(Math.round(s)); weights.push(25);
  }

  const tVals = data.temp.map(p => p.y);
  if (tVals.length > 5) {
    const sd = stddev(tVals) || 0;
    const s  = sd <= 0.3 ? 100 : sd <= 0.7 ? 90 : sd <= 1.5 ? 72
             : sd <= 3   ? 50  : Math.max(15, 50 - (sd - 3) * 12);
    scores.push(Math.round(s)); weights.push(20);
  }

  const secs = (shot.duration || 0) / 10;
  if (secs > 5) {
    const s = secs >= 25 && secs <= 35 ? 100
            : secs >= 20 && secs < 25   ? 82
            : secs > 35 && secs <= 42   ? 82
            : secs > 42 && secs <= 55   ? 62
            : secs < 20 ? Math.max(15, 70 - (20 - secs) * 5)
                         : Math.max(15, 62 - (secs - 55) * 3);
    scores.push(Math.round(s)); weights.push(20);
  }

  const ann = shot.annotation || {};
  const finalW = max(data.weight.map(p => p.y));
  if (ann.dose && ann.dose > 0 && finalW) {
    const r = finalW / ann.dose;
    const s = r >= 1.8 && r <= 2.5 ? 100
            : r >= 1.5 && r < 1.8   ? 75
            : r > 2.5 && r <= 3.2   ? 75
            : r < 1.5 ? Math.max(15, 55 - (1.5 - r) * 40)
                       : Math.max(15, 60 - (r - 3.2) * 22);
    scores.push(Math.round(s)); weights.push(20);
  }

  const pTimes = data.pressure.map(p => p.x);
  const pAll   = data.pressure.map(p => p.y);
  scores.push(detectChanneling(pTimes, pAll) ? 20 : 100);
  weights.push(15);

  if (!scores.length) return null;
  const tw = weights.reduce((a, b) => a + b, 0);
  return Math.round(scores.reduce((s, v, i) => s + v * weights[i], 0) / tw);
}

// ── Grind advice ──────────────────────────────────────────────────────────
function calcGrindAdvice(shot, data) {
  const secs = (shot.duration || 0) / 10;
  if (secs < 8) return null;

  const pTimes = data.pressure.map(p => p.x);
  const pAll   = data.pressure.map(p => p.y);

  if (detectChanneling(pTimes, pAll))
    return { type: 'warning', icon: '⚡', text: t('grind_channeling_full') };

  if (secs < 18) return { type: 'finer',   icon: '↓', text: t('grind_short', secs.toFixed(0)) };
  if (secs < 23) return { type: 'finer',   icon: '↓', text: t('grind_short_slight', secs.toFixed(0)) };
  if (secs > 50) return { type: 'coarser', icon: '↑', text: t('grind_long', secs.toFixed(0)) };
  if (secs > 42) return { type: 'coarser', icon: '↑', text: t('grind_long_slight', secs.toFixed(0)) };

  const pVals = pAll.filter(v => v >= 5);
  const avgP  = pVals.length ? pVals.reduce((a, b) => a + b, 0) / pVals.length : 0;
  return { type: 'ok', icon: '✓', text: `Mahlgrad passt – ${secs.toFixed(0)} s${avgP > 0 ? `, ${avgP.toFixed(1)} bar Ø` : ''}` };
}

// ── Data loading ──────────────────────────────────────────────────────────
export async function loadData() {
  const shotsEl = document.getElementById('shots');
  shotsEl.innerHTML = `<div class="loading-state">${t('loading')}</div>`;

  let fetched;
  try {
    const r = await apiFetch('shots.json');
    if (!r.ok) {
      shotsEl.innerHTML = `<div class="loading-state" style="color:#ef4444">HTTP ${r.status}</div>`;
      return;
    }
    fetched = await r.json();
  } catch (e) {
    shotsEl.innerHTML =
      `<div class="loading-state" style="color:#ef4444">Verbindungsfehler<br>` +
      `<button onclick="loadData()" style="margin-top:10px;padding:4px 12px;cursor:pointer;` +
      `background:rgba(63,63,70,.5);color:#a1a1aa;border:1px solid #3f3f46;border-radius:6px;` +
      `font-family:Figtree,sans-serif;font-size:.8rem">${t('btn_reload')}</button></div>`;
    return;
  }

  S.shots = fetched;
  renderSidebar();
  loadTrashData();

  const empty     = document.getElementById('empty-state');
  const chartArea = document.getElementById('chart-area');
  if (S.shots.length > 0) {
    empty.style.display     = 'none';
    chartArea.style.display = 'flex';
    if (!S.primaryShotId || !S.shots.find(s => s.id === S.primaryShotId))
      S.primaryShotId = S.shots[S.shots.length - 1].id;
    updateView();
  } else {
    empty.style.display     = 'flex';
    chartArea.style.display = 'none';
  }
}

// ── Trash bin ─────────────────────────────────────────────────────────────
export async function loadTrashData() {
  try {
    const r = await apiFetch('shots.json?trash=1');
    if (!r.ok) return;
    S.trashedShots = await r.json();
    renderTrash();
  } catch (e) {}
}

export function renderTrash() {
  const section = document.getElementById('trash-section');
  const countEl = document.getElementById('trash-count');
  const listEl  = document.getElementById('trash-list');
  const count   = S.trashedShots.length;

  section.style.display = count > 0 ? 'block' : 'none';
  countEl.textContent   = count;

  listEl.innerHTML = '';
  const now = Date.now();
  S.trashedShots.forEach(shot => {
    const daysLeft = Math.max(0, 30 - Math.floor((now - shot.trashedAt) / 86400000));
    const name = shot.profile?.name || shot.profileName || `Shot ${shot.id}`;
    const row  = document.createElement('div');
    row.className = 'trash-item';
    row.innerHTML = `
      <div class="trash-item-info">
        <div class="trash-item-name">${esc(name)}</div>
        <div class="trash-item-days">Shot ${shot.id} · ${t('trash_days_left', daysLeft)}</div>
      </div>
      <button class="trash-restore-btn" onclick="restoreShot(${shot.id})">${t('trash_restore_label')}</button>
      <button class="trash-delete-btn" title="${t('trash_delete_title')}" onclick="permanentDeleteShot(${shot.id})"><svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16" aria-hidden="true"><path d="M6,19A2,2 0 0,0 8,21H16A2,2 0 0,0 18,19V7H6V19M8,9H10V19H8V9M14,9H16V19H14V9M15.5,4L14.5,3H9.5L8.5,4H5V6H19V4H15.5Z"/></svg></button>
    `;
    listEl.appendChild(row);
  });
}

export function toggleTrash() {
  S.trashOpen = !S.trashOpen;
  document.getElementById('trash-list').style.display = S.trashOpen ? 'block' : 'none';
}

export async function trashShot(id) {
  try {
    const r = await apiFetch(`api/shots/${id}/trash`, { method: 'POST', headers: { 'Content-Type': 'application/json' } });
    if (!r.ok) throw new Error(await r.text());
    S.shots = S.shots.filter(s => s.id !== id);
    if (S.primaryShotId === id) { S.primaryShotId = S.shots[0]?.id || null; }
    if (S.compareShotId === id) { S.compareShotId = null; }
    renderSidebar();
    updateView();
    await loadTrashData();
  } catch (e) {
    alert(t('error_generic', e.message));
  }
}

export async function restoreShot(id) {
  try {
    const r = await apiFetch(`api/shots/${id}/restore`, { method: 'POST', headers: { 'Content-Type': 'application/json' } });
    if (!r.ok) throw new Error(await r.text());
    await loadData();
  } catch (e) {
    alert(t('error_generic', e.message));
  }
}

export async function permanentDeleteShot(id) {
  if (!confirm(t('confirm_perm_delete', id))) return;
  try {
    const r = await apiFetch(`api/shots/${id}/delete`, { method: 'POST', headers: { 'Content-Type': 'application/json' } });
    if (!r.ok) throw new Error(await r.text());
    S.trashedShots = S.trashedShots.filter(s => s.id !== id);
    renderTrash();
  } catch (e) {
    alert(t('error_generic', e.message));
  }
}

// ── Annotation panel ──────────────────────────────────────────────────────
export function renderAnnotationPanel(shot) {
  const ann = shot.annotation || {};
  S.currentRating = ann.rating || 0;
  renderStars(S.currentRating);
  document.getElementById('annCoffee').value       = ann.coffee       || '';
  document.getElementById('annGrinder').value      = ann.grinder      || '';
  document.getElementById('annGrindSetting').value = ann.grindSetting || '';
  document.getElementById('annDose').value         = ann.dose         || '';
  document.getElementById('annRoastDate').value    = isoToGerman(ann.roastDate || '');
  document.getElementById('annTds').value          = ann.tds          || '';
  document.getElementById('annNotes').value        = ann.notes        || '';
  const btn = document.getElementById('saveAnnotationBtn');
  btn.textContent = t('btn_save');
  btn.classList.remove('saved');
}

export function renderStars(rating) {
  document.querySelectorAll('#starRating .star').forEach(s => {
    s.classList.toggle('active', parseInt(s.dataset.val) <= rating);
  });
}

export function quickClone() {
  if (!S.primaryShotId) return;
  const prev = S.shots.filter(s => s.id < S.primaryShotId).sort((a, b) => b.id - a.id)[0];
  if (!prev) return;
  const ann = prev.annotation || {};
  document.getElementById('annCoffee').value       = ann.coffee       || '';
  document.getElementById('annGrinder').value      = ann.grinder      || '';
  document.getElementById('annGrindSetting').value = ann.grindSetting || '';
  document.getElementById('annDose').value         = ann.dose         || '';
  const rd = isoToGerman(ann.roastDate || '');
  document.getElementById('annRoastDate').value = rd;
  if (rd) updateDegassing(rd);
}

export async function saveAnnotation() {
  if (!S.primaryShotId) return;
  const btn = document.getElementById('saveAnnotationBtn');
  const payload = {
    rating:       S.currentRating || null,
    coffee:       document.getElementById('annCoffee').value.trim(),
    grinder:      document.getElementById('annGrinder').value.trim(),
    grindSetting: document.getElementById('annGrindSetting').value.trim(),
    dose:         parseFloat(document.getElementById('annDose').value) || null,
    roastDate:    germanToIso(document.getElementById('annRoastDate').value) || null,
    tds:          parseFloat(document.getElementById('annTds').value) || null,
    notes:        document.getElementById('annNotes').value.trim()
  };
  try {
    const r = await apiFetch(`api/shots/${S.primaryShotId}/annotate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (r.ok) {
      const idx = S.shots.findIndex(s => s.id === S.primaryShotId);
      if (idx !== -1) S.shots[idx].annotation = payload;
      btn.textContent = t('btn_saved');
      btn.classList.add('saved');
      setTimeout(() => { btn.textContent = t('btn_save'); btn.classList.remove('saved'); }, 2000);
      renderSidebar();
      updateSidebarHighlighting();
    }
  } catch (e) { console.error('Annotation-Fehler:', e); }
}

export function updateDegassing(val) {
  const tracker = document.getElementById('degassingTracker');
  const fill    = document.getElementById('degassingFill');
  const label   = document.getElementById('degassingLabel');
  // parseDMY inlined here to avoid needing a utils import with potential issues
  const parseDMY = (s) => {
    if (!s) return null;
    const m = s.match(/^(\d{1,2})[.\-\/](\d{1,2})[.\-\/](\d{2,4})$/);
    if (!m) return null;
    const y = m[3].length === 2 ? 2000 + parseInt(m[3]) : parseInt(m[3]);
    const d = new Date(y, parseInt(m[2]) - 1, parseInt(m[1]));
    return isNaN(d) ? null : d;
  };
  const date = parseDMY(val);
  if (!date) { tracker.style.display = 'none'; return; }
  const days = Math.floor((Date.now() - date.getTime()) / 86400000);
  if (days < 0 || days > 180) { tracker.style.display = 'none'; return; }

  tracker.style.display = 'block';
  const pct = Math.min(100, (days / 42) * 100);
  fill.style.width = pct + '%';

  let color, text;
  if      (days < 4)  { color = '#52525b'; text = t('degas_too_fresh', days); }
  else if (days < 7)  { color = '#eab308'; text = t('degas_almost',    days); }
  else if (days <= 21){ color = '#22c55e'; text = t('degas_optimal',   days); }
  else if (days <= 35){ color = '#f97316'; text = t('degas_aging',     days); }
  else                { color = '#ef4444'; text = t('degas_old',       days); }

  fill.style.background = color;
  label.style.color     = color;
  label.textContent     = text;
}

// ── Shot view ─────────────────────────────────────────────────────────────
export function updateView() {
  const shotA = S.shots.find(s => s.id === S.primaryShotId);
  const shotB = S.compareShotId ? S.shots.find(s => s.id === S.compareShotId) : null;
  if (!shotA) return;

  const dA = getShotData(shotA);
  const dB = getShotData(shotB);

  const maxTempA = max((shotA.datapoints?.temperature || []).map(v => v / 10)) || 0;
  const maxTempB = shotB ? (max((shotB.datapoints?.temperature || []).map(v => v / 10)) || 0) : 0;
  const tempMaxScale = Math.ceil(Math.max(maxTempA, maxTempB) + 5) || 100;

  const nameA = shotA.profile?.name || shotA.profileName || 'Unknown Profile';
  if (shotB) {
    const nameB = shotB.profile?.name || shotB.profileName || 'Unknown Profile';
    document.getElementById('topTitle').innerText   = `Vergleich: Shot ${shotA.id} vs. Shot ${shotB.id}`;
    document.getElementById('valProfile').innerText = `${nameA} vs. ${nameB}`;
  } else {
    document.getElementById('topTitle').innerText   = `${nameA} – Shot ${shotA.id}`;
    document.getElementById('valProfile').innerText = nameA;
  }

  const totalSecs = (shotA.duration || 0) / 10;
  document.getElementById('duration').innerText =
    `${Math.floor(totalSecs / 60).toString().padStart(2, '0')}:${Math.floor(totalSecs % 60).toString().padStart(2, '0')}`;

  const pressureVals  = dA.pressure.map(p => p.y);
  const pressureTimes = dA.pressure.map(p => p.x);
  document.getElementById('pressure').innerText       = fmt(avgActive(pressureVals, 1.5), ' bar');
  document.getElementById('targetPressure').innerText = ` / ${fmt(max(dA.targetPressure.map(p => p.y)), ' bar')}`;
  document.getElementById('flow').innerText           = fmt(avgActive(dA.flow.map(p => p.y), 0.2), ' ml/s');
  document.getElementById('targetFlow').innerText     = ` / ${fmt(avgActive(dA.targetFlow.map(p => p.y), 0.2), ' ml/s')}`;

  const tempVals = dA.temp.map(p => p.y);
  const sdTemp   = stddev(tempVals);
  document.getElementById('temp').innerText           = fmt(avg(tempVals), ' °C');
  document.getElementById('tempStability').textContent = (sdTemp != null && sdTemp < 5) ? `±${sdTemp.toFixed(1)}` : '';
  document.getElementById('targetTemp').innerText     = ` / ${fmt(avg(dA.targetTemp.map(p => p.y)), ' °C')}`;

  const finalWeight = max(dA.weight.map(p => p.y));
  document.getElementById('weight').innerText       = fmt(finalWeight, ' g');
  document.getElementById('weightFlowSub').innerText = ` / ${fmt(safeLast(dA.weightFlow.map(p => p.y)), ' ml/s')}`;
  document.getElementById('wf').innerText           = fmt(avgActive(dA.weightFlow.map(p => p.y), 0.1), ' ml/s');
  document.getElementById('maxWf').innerText        = ` / ${fmt(max(dA.weightFlow.map(p => p.y)), ' max')}`;

  // Ratio
  const ann      = shotA.annotation || {};
  const ratioItem = document.getElementById('ratioItem');
  if (ann.dose && finalWeight && !shotB) {
    const r = (finalWeight / ann.dose).toFixed(1);
    document.getElementById('ratio').textContent = `${ann.dose}g → ${fmt(finalWeight, 'g')} · 1:${r}`;
    ratioItem.style.display = '';
  } else {
    ratioItem.style.display = 'none';
  }

  // EY
  const eyItem = document.getElementById('eyItem');
  if (!shotB && ann.dose && ann.tds && finalWeight) {
    const ey = (finalWeight * ann.tds) / ann.dose;
    const eyEl = document.getElementById('ey');
    eyEl.textContent = `${ey.toFixed(1)} %`;
    const eyOk = ey >= 18 && ey <= 22;
    eyEl.className = 'meta-value ' + (eyOk ? 'score-great' : ey >= 16 && ey <= 24 ? 'score-ok' : 'score-bad');
    eyItem.style.display = '';
  } else {
    eyItem.style.display = 'none';
  }

  // Freshness badge
  const freshEl = document.getElementById('freshnessBadge');
  if (!shotB && ann.roastDate && ann.coffee) {
    const days = Math.round((Date.now() - new Date(ann.roastDate)) / 86400000);
    if (days >= 0 && days <= 365) {
      const cls = days <= 21 ? 'freshness-fresh' : days <= 35 ? 'freshness-ok' : 'freshness-old';
      freshEl.className   = `freshness-badge ${cls}`;
      freshEl.textContent = `${days}d`;
      freshEl.title = t('freshness_title', days);
      freshEl.style.display = '';
    } else { freshEl.style.display = 'none'; }
  } else { freshEl.style.display = 'none'; }

  // Firmware version badge
  const fwEl = document.getElementById('firmwareVersionBadge');
  if (fwEl) {
    const fw = !shotB && shotA.glpFirmwareVersion;
    fwEl.textContent = fw ? `· fw ${fw}` : '';
    fwEl.style.display = fw ? '' : 'none';
  }

  // Phases
  const phases     = !shotB ? detectPhases(pressureTimes, pressureVals) : null;
  const phasesItem = document.getElementById('phasesItem');
  const phaseSubtitle = document.getElementById('phaseSubtitle');
  if (phases) {
    const phaseHtml =
      `<span class="phase-tag">Preinfusion <span>${formatTimeLabel(phases.preinfusion)}</span></span>` +
      `<span class="phase-tag">Extraktion <span>${formatTimeLabel(phases.extraction)}</span></span>`;
    document.getElementById('phases').innerHTML = phaseHtml;
    phasesItem.style.display = '';
    if (phaseSubtitle) { phaseSubtitle.innerHTML = phaseHtml; phaseSubtitle.style.display = ''; }
  } else {
    phasesItem.style.display = 'none';
    if (phaseSubtitle) phaseSubtitle.style.display = 'none';
  }

  // Channeling
  const channeling = !shotB && detectChanneling(pressureTimes, pressureVals);
  document.getElementById('channelingWarning').style.display = channeling ? '' : 'none';

  // Grind advice
  const adviceEl = document.getElementById('grindAdvice');
  const advice    = !shotB ? calcGrindAdvice(shotA, dA) : null;
  if (advice) {
    adviceEl.className = `grind-advice grind-${advice.type}`;
    document.getElementById('grindAdviceIcon').textContent = advice.icon;
    document.getElementById('grindAdviceText').textContent = advice.text;
    adviceEl.style.display = '';
  } else { adviceEl.style.display = 'none'; }

  // Shot score
  const scoreBadge = document.getElementById('shotScoreBadge');
  const scoreVal   = document.getElementById('shotScoreVal');
  if (!shotB && scoreBadge && scoreVal) {
    const sc = calcShotScore(shotA, dA);
    if (sc !== null) {
      scoreVal.textContent = sc;
      scoreVal.className   = 'score-num ' + scoreClass(sc);
      scoreBadge.style.display = '';
    } else {
      scoreBadge.style.display = 'none';
    }
  } else if (scoreBadge) {
    scoreBadge.style.display = 'none';
  }

  renderAnnotationPanel(shotA);

  const maxTimeA = dA.rawTimes.length > 0 ? dA.rawTimes[dA.rawTimes.length - 1] : 0;
  const maxTimeB = dB?.rawTimes.length > 0 ? dB.rawTimes[dB.rawTimes.length - 1] : 0;

  const sfx = shotB ? ' (A)' : '';
  const datasets = [
    { label:`Druck${sfx}`,         data: dA.pressure,  yAxisID:'y',  borderWidth:2.5, tension:.1, borderColor:'#3498db', backgroundColor:'transparent', pointStyle:false },
    { label:`Pumpenfluss${sfx}`,   data: dA.flow,       yAxisID:'y',  borderWidth:2,   tension:.1, borderColor:'#f39c12', backgroundColor:'transparent', pointStyle:false },
    { label:`Gewichtsfluss${sfx}`, data: dA.weightFlow, yAxisID:'y',  borderWidth:2,   tension:.1, borderColor:'#9b59b6', backgroundColor:'transparent', pointStyle:false },
    { label:`Gewicht${sfx}`,       data: dA.weight,     yAxisID:'y1', borderWidth:2,   tension:.1, borderColor:'#2ecc71', backgroundColor:'transparent', pointStyle:false },
    { label:`Temperatur${sfx}`,    data: dA.temp,       yAxisID:'y1', borderWidth:2.5, tension:.1, borderColor:'#e74c3c', backgroundColor:'transparent', pointStyle:false }
  ];

  if (!shotB) {
    datasets.push(
      { label:'Ziel Druck',      data: dA.targetPressure, yAxisID:'y',  borderDash:[5,5], borderWidth:1.5, tension:.1, borderColor:'#3498db', backgroundColor:'transparent', pointStyle:false },
      { label:'Ziel Fluss',      data: dA.targetFlow,     yAxisID:'y',  borderDash:[5,5], borderWidth:1.5, tension:.1, borderColor:'#f39c12', backgroundColor:'transparent', pointStyle:false },
      { label:'Ziel Temperatur', data: dA.targetTemp,     yAxisID:'y1', borderDash:[5,5], borderWidth:1.5, tension:.1, borderColor:'#e74c3c', backgroundColor:'transparent', pointStyle:false }
    );
  }
  if (shotB && dB) {
    datasets.push(
      { label:'Druck (B)',        data: dB.pressure,  yAxisID:'y',  borderDash:[3,3], borderWidth:2,   tension:.1, borderColor:'rgba(52,152,219,.65)',  backgroundColor:'transparent', pointStyle:false },
      { label:'Pumpenfluss (B)', data: dB.flow,       yAxisID:'y',  borderDash:[3,3], borderWidth:1.5, tension:.1, borderColor:'rgba(243,156,18,.65)',  backgroundColor:'transparent', pointStyle:false },
      { label:'Gewfluß (B)',     data: dB.weightFlow, yAxisID:'y',  borderDash:[3,3], borderWidth:1.5, tension:.1, borderColor:'rgba(155,89,182,.65)',  backgroundColor:'transparent', pointStyle:false },
      { label:'Gewicht (B)',     data: dB.weight,     yAxisID:'y1', borderDash:[3,3], borderWidth:1.5, tension:.1, borderColor:'rgba(46,204,113,.65)',  backgroundColor:'transparent', pointStyle:false },
      { label:'Temperatur (B)', data: dB.temp,        yAxisID:'y1', borderDash:[3,3], borderWidth:2,   tension:.1, borderColor:'rgba(231,76,60,.65)',   backgroundColor:'transparent', pointStyle:false }
    );
  }

  if (S.pqChart) { S.pqChart.destroy(); S.pqChart = null; }
  if (S.currentChartTab === 'pq') updatePQChart();

  const ctx = document.getElementById('espressoShotChart');
  const _existingChart = Chart.getChart(ctx);
  if (_existingChart) _existingChart.destroy();
  S.chart = null;

  try {
    S.chart = new Chart(ctx, {
      type: 'line',
      plugins: [corsairPlugin, phasePlugin],
      data: { datasets },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        layout: { padding: { bottom: 20 } },
        interaction: { mode: 'index', intersect: false },
        plugins: {
          phases:  phases ? { preinfusion: phases.preinfusion, extraction: phases.extraction } : {},
          legend:  {
            display: true,
            position: 'bottom',
            labels: { color: '#e4e4e7', font: { family: 'Figtree', size: window.innerWidth <= 600 ? 9 : 11 }, boxWidth: window.innerWidth <= 600 ? 8 : 12, padding: window.innerWidth <= 600 ? 4 : 8 }
          },
          tooltip: { callbacks: { title: ctx => 'Zeit: ' + formatTimeLabel(ctx[0].parsed.x) } }
        },
        scales: {
          x:  { type:'linear', min:0, max:Math.max(maxTimeA, maxTimeB), clip:false,
                ticks:{ color:'#a1a1aa', font:{family:'Figtree'}, stepSize:5, callback:v=>formatTimeLabel(v), maxTicksLimit: window.innerWidth <= 600 ? 6 : 12 },
                grid:{ color:'#27272a' } },
          y:  { type:'linear', position:'left',  min:0, max:12, ticks:{color:'#a1a1aa', maxTicksLimit:6}, grid:{color:'#27272a'} },
          y1: { type:'linear', position:'right', min:0, max:Number(tempMaxScale), ticks:{color:'#a1a1aa', maxTicksLimit:6}, grid:{drawOnChartArea:false} }
        }
      }
    });
  } catch (e) {
    console.error('Chart creation error:', e);
  }
}

// ── P·Q Chart ─────────────────────────────────────────────────────────────
export function switchChartTab(tab) {
  S.currentChartTab = tab;
  document.getElementById('tabZeit').classList.toggle('active', tab === 'zeit');
  document.getElementById('tabPQ').classList.toggle('active',   tab === 'pq');
  document.getElementById('zeitContainer').style.display = tab === 'zeit' ? '' : 'none';
  document.getElementById('pqContainer').style.display   = tab === 'pq'   ? '' : 'none';
  if (tab === 'pq') updatePQChart();
}

function getPQData(shot) {
  const d = shot.datapoints || {};
  const t = d.timeInShot  || [];
  const p = d.pressure    || [];
  const f = d.pumpFlow    || [];
  const n = Math.min(t.length, p.length, f.length);
  const result = [];
  for (let i = 0; i < n; i++) {
    if (p[i] != null && f[i] != null && p[i] >= 30 && f[i] > 0)
      result.push({ x: f[i] / 10, y: p[i] / 10 });
  }
  return result;
}

export function updatePQChart() {
  const shotA = S.shots.find(s => s.id === S.primaryShotId);
  if (!shotA) return;

  const canvas = document.getElementById('pqChart');
  if (S.pqChart) { S.pqChart.destroy(); S.pqChart = null; }

  const shotB = S.compareShotId ? S.shots.find(s => s.id === S.compareShotId) : null;
  const datasets = [
    { label: `Shot ${shotA.id}`, data: getPQData(shotA), borderColor: '#3498db',
      backgroundColor: 'rgba(52,152,219,.08)', fill: true,
      borderWidth: 2.5, pointRadius: 0, tension: 0.3 }
  ];
  if (shotB) datasets.push(
    { label: `Shot ${shotB.id}`, data: getPQData(shotB), borderColor: 'rgba(52,152,219,.5)',
      backgroundColor: 'transparent', fill: false,
      borderDash: [4,3], borderWidth: 2, pointRadius: 0, tension: 0.3 }
  );

  S.pqChart = new Chart(canvas, {
    type: 'line',
    data: { datasets },
    options: {
      responsive: true, maintainAspectRatio: false, animation: false,
      plugins: {
        legend: { labels: { color: '#e4e4e7', font: { family: 'Figtree' } } },
        tooltip: { callbacks: { label: c => `${c.parsed.y.toFixed(1)} bar @ ${c.parsed.x.toFixed(1)} ml/s` } }
      },
      scales: {
        x: { type: 'linear', min: 0, max: 5,
             title: { display: true, text: 'Pumpenfluss (ml/s)', color: '#71717a', font: { family: 'Figtree' } },
             ticks: { color: '#a1a1aa' }, grid: { color: '#27272a' } },
        y: { type: 'linear', min: 0, max: 12,
             title: { display: true, text: 'Druck (bar)', color: '#71717a', font: { family: 'Figtree' } },
             ticks: { color: '#a1a1aa' }, grid: { color: '#27272a' } }
      }
    }
  });
}

// ── Fullscreen chart ──────────────────────────────────────────────────────
export function openChartFullscreen() {
  document.getElementById('chartFullscreen').classList.add('open');
  document.body.style.overflow = 'hidden';
  S.currentFsTab = S.currentChartTab;
  document.getElementById('fsTabZeit').classList.toggle('active', S.currentFsTab === 'zeit');
  document.getElementById('fsTabPQ').classList.toggle('active',   S.currentFsTab === 'pq');
  screen.orientation?.lock?.('landscape').catch(() => {});
  renderFsChart();
}

export function closeChartFullscreen() {
  document.getElementById('chartFullscreen').classList.remove('open');
  document.body.style.overflow = '';
  if (S.fsChart) { S.fsChart.destroy(); S.fsChart = null; }
  screen.orientation?.unlock?.();
}

export function switchFsTab(tab) {
  S.currentFsTab = tab;
  document.getElementById('fsTabZeit').classList.toggle('active', tab === 'zeit');
  document.getElementById('fsTabPQ').classList.toggle('active',   tab === 'pq');
  renderFsChart();
}

function renderFsChart() {
  const shotA = S.shots.find(s => s.id === S.primaryShotId);
  if (!shotA) return;
  const existing = Chart.getChart('espressoShotChartFs');
  if (existing) existing.destroy();
  S.fsChart = null;

  const canvas = document.getElementById('espressoShotChartFs');

  if (S.currentFsTab === 'pq') {
    const data = getPQData(shotA);
    S.fsChart = new Chart(canvas, {
      type: 'scatter',
      data: { datasets: [{ label: `Shot ${shotA.id}`, data, showLine: true, tension: 0.2,
          borderColor: '#3498db', backgroundColor: 'rgba(52,152,219,0.15)',
          borderWidth: 2, pointRadius: 0 }] },
      options: {
        responsive: true, maintainAspectRatio: false, animation: false,
        plugins: {
          legend: { labels: { color: '#e4e4e7', font: { family: 'Figtree' } } },
          tooltip: { callbacks: { label: c => `${c.parsed.y.toFixed(1)} bar @ ${c.parsed.x.toFixed(1)} ml/s` } }
        },
        scales: {
          x: { type: 'linear', min: 0, max: 5,
               title: { display: true, text: 'Pumpenfluss (ml/s)', color: '#71717a', font: { family: 'Figtree' } },
               ticks: { color: '#a1a1aa' }, grid: { color: '#27272a' } },
          y: { type: 'linear', min: 0, max: 12,
               title: { display: true, text: 'Druck (bar)', color: '#71717a', font: { family: 'Figtree' } },
               ticks: { color: '#a1a1aa' }, grid: { color: '#27272a' } }
        }
      }
    });
    return;
  }

  if (!S.chart) return;
  const dA = getShotData(shotA);
  const maxTempA = Math.max(...(shotA.datapoints?.temperature || []).map(v => v / 10), 0);
  const tms = Math.ceil(maxTempA + 5) || 100;
  const maxTime = dA.rawTimes.length > 0 ? dA.rawTimes[dA.rawTimes.length - 1] : 60;
  const datasets = S.chart.data.datasets.map(ds => ({ ...ds, data: [...ds.data] }));

  S.fsChart = new Chart(canvas, {
    type: 'line',
    data: { datasets },
    options: {
      responsive: true, maintainAspectRatio: false, animation: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: true, position: 'bottom',
          labels: { color: '#e4e4e7', font: { family: 'Figtree', size: 11 }, boxWidth: 12, padding: 8 } },
        tooltip: { callbacks: { title: c => 'Zeit: ' + formatTimeLabel(c[0].parsed.x) } }
      },
      scales: {
        x:  { type:'linear', min:0, max:maxTime, clip:false,
              ticks:{ color:'#a1a1aa', font:{family:'Figtree'}, stepSize:5, callback:v=>formatTimeLabel(v) },
              grid:{ color:'#27272a' } },
        y:  { type:'linear', position:'left',  min:0, max:12, ticks:{color:'#a1a1aa'}, grid:{color:'#27272a'} },
        y1: { type:'linear', position:'right', min:0, max:tms, ticks:{color:'#a1a1aa'}, grid:{drawOnChartArea:false} }
      }
    }
  });
}

// ── CSV Export ────────────────────────────────────────────────────────────
function shotToCSVRow(shot) {
  const d      = getShotData(shot);
  const ann    = shot.annotation || {};
  const avgP   = avgActive(d.pressure.map(p => p.y), 1.5);
  const finalW = max(d.weight.map(p => p.y));
  const avgT   = avg(d.temp.map(p => p.y));
  const secs   = ((shot.duration || 0) / 10).toFixed(1);
  const ratio  = (ann.dose && finalW) ? `1:${(finalW / ann.dose).toFixed(1)}` : '';
  const date   = new Date(shot.timestamp * 1000).toLocaleString(LOCALE_MAP[S.currentLang] || 'de-DE');
  return [
    shot.id, date,
    shot.profile?.name || shot.profileName || '',
    secs,
    avgP   != null ? avgP.toFixed(2)  : '',
    finalW != null ? finalW.toFixed(1) : '',
    ann.dose || '', ratio,
    avgT   != null ? avgT.toFixed(1)  : '',
    ann.rating || '', ann.coffee || '', ann.grinder || '',
    ann.grindSetting || '',
    (ann.notes || '').replace(/\n/g, ' ')
  ].map(v => `"${String(v).replace(/"/g, '""')}"`).join(',');
}

function downloadCSV(rows, filename) {
  const header = ['Shot ID','Date','Profile','Duration (s)','Avg Pressure (bar)','Max Weight (g)',
                  'Dose (g)','Ratio','Avg Temp (C)','Rating','Coffee','Grinder','Grind Setting','Notes'];
  const csv  = [header.join(','), ...rows].join('\r\n');
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}

export function exportCSV() {
  const shot = S.shots.find(s => s.id === S.primaryShotId);
  if (!shot) return;
  const date    = new Date(shot.timestamp * 1000).toISOString().slice(0, 10);
  const profile = (shot.profile?.name || shot.profileName || 'shot').replace(/[^a-z0-9]/gi, '_');
  downloadCSV([shotToCSVRow(shot)], `glp_shot_${date}_${profile}.csv`);
}

export function exportAllCSV() {
  downloadCSV(S.shots.map(shotToCSVRow), 'glp_all_shots.csv');
}

// ── .shot export ──────────────────────────────────────────────────────────
export function exportShot() {
  const shot = S.shots.find(s => s.id === S.primaryShotId);
  if (!shot) return;
  const d   = shot.datapoints || {};
  const ann = shot.annotation || {};
  const timeArr = d.timeInShot || [];

  const tcl = arr => arr?.length ? `{${arr.map(v => (v / 10).toFixed(2)).join(' ')}}` : '{}';

  const finalWeight = d.shotWeight || d.weight || [];
  const lastW = finalWeight.length ? (finalWeight[finalWeight.length - 1] / 10).toFixed(1) : '0.0';
  const date  = new Date(shot.timestamp * 1000).toISOString().replace('T', ' ').slice(0, 19);

  const lines = [
    `clock ${shot.timestamp}`,
    `date ${date}`,
    `profile_title {${(shot.profile?.name || shot.profileName || 'Unknown').replace(/[{}]/g, '')}}`,
    ann.coffee      ? `bean_desc {${ann.coffee.replace(/[{}]/g, '')}}` : '',
    ann.grinder     ? `grinder_model {${ann.grinder.replace(/[{}]/g, '')}}` : '',
    ann.grindSetting ? `grinder_setting {${ann.grindSetting.replace(/[{}]/g, '')}}` : '',
    ann.dose        ? `bean_weight ${ann.dose}` : '',
    ann.notes       ? `espresso_notes {${ann.notes.replace(/[{}]/g, '')}}` : '',
    `espresso_elapsed ${tcl(timeArr)}`,
    `espresso_pressure ${tcl(d.pressure)}`,
    `espresso_flow ${tcl(d.pumpFlow)}`,
    `espresso_weight ${tcl(d.shotWeight || d.weight)}`,
    `espresso_flow_weight ${tcl(d.weightFlow)}`,
    `espresso_temperature_goal ${tcl(d.targetTemperature)}`,
    `espresso_temperature_mix ${tcl(d.temperature)}`,
    `espresso_water_dispensed ${lastW}`,
  ].filter(Boolean).join('\n');

  const blob = new Blob([lines], { type: 'text/plain;charset=utf-8;' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url;
  a.download = `shot_${shot.id}_${date.slice(0, 10)}.shot`;
  a.click();
  URL.revokeObjectURL(url);
}

// ── Profile export ────────────────────────────────────────────────────────
export function exportProfile() {
  const shot = S.shots.find(s => s.id === S.primaryShotId);
  if (!shot) return;

  const profile = shot.profile;

  if (profile && Array.isArray(profile.phases) && profile.phases.length > 0) {
    const out = JSON.parse(JSON.stringify(profile));
    const ann = shot.annotation || {};
    if (!out.recipe) out.recipe = {};
    if (ann.dose) out.recipe.coffeeIn = parseFloat(ann.dose);
    if (!out.recipe.coffeeOut && ann.dose) out.recipe.coffeeOut = parseFloat(ann.dose) * 2;
    if (out.recipe.coffeeIn && out.recipe.coffeeOut)
      out.recipe.ratio = Math.round(out.recipe.coffeeOut / out.recipe.coffeeIn * 100) / 100;
    _downloadJSON(out, (out.name || shot.profileName || `shot_${shot.id}`).replace(/[^a-z0-9_\-]/gi, '_') + '.json');
    return;
  }

  const d    = shot.datapoints || {};
  const rawT = d.timeInShot    || [];
  const rawTP = d.targetPressure || [];

  if (rawT.length === 0 || rawTP.length === 0) {
    alert(t('profile_export_no_data'));
    return;
  }

  const times  = rawT.map(v => v / 10);
  const tPress = rawTP.map(v => v / 10);
  const totalMs = Math.round(times[times.length - 1] * 1000);
  const ann     = shot.annotation || {};

  const PREINF_THRESHOLD = 6;
  let preinfEndIdx = tPress.findIndex(p => p >= PREINF_THRESHOLD);
  if (preinfEndIdx < 0) preinfEndIdx = 0;
  const preinfMs = preinfEndIdx > 0 ? Math.round(times[preinfEndIdx] * 1000) : 0;

  const phases = [];

  if (preinfMs > 500) {
    const preinfTarget = Math.round(Math.max(...tPress.slice(0, preinfEndIdx)) * 10) / 10 || 4;
    phases.push({
      type: 0,
      target: { start: 0, end: preinfTarget, curve: 1, time: preinfMs },
      restriction: 0,
      stopConditions: { time: preinfMs, pressureAbove: 0, pressureBelow: 0, flowAbove: 0, flowBelow: 0, weight: 0 }
    });
  }

  const extractionSlice = tPress.slice(preinfEndIdx || 0);
  const avgExtraction = extractionSlice.length
    ? Math.round(extractionSlice.reduce((a, b) => a + b, 0) / extractionSlice.length * 10) / 10
    : 9;
  const extractionMs = totalMs - preinfMs;
  const yieldG = ann.dose ? parseFloat(ann.dose) * 2 : 36;

  phases.push({
    type: 0,
    target: { start: avgExtraction, end: avgExtraction, curve: 0, time: extractionMs },
    restriction: 0,
    stopConditions: { time: extractionMs, pressureAbove: 0, pressureBelow: 0, flowAbove: 0, flowBelow: 0, weight: yieldG }
  });

  const out = {
    id: shot.id,
    name: shot.profileName || `Shot ${shot.id}`,
    phases,
    globalStopConditions: { time: 0, weight: yieldG, waterPumped: 0 },
    recipe: {
      coffeeIn:  ann.dose ? parseFloat(ann.dose) : 18,
      coffeeOut: yieldG,
      ratio:     ann.dose ? Math.round(yieldG / parseFloat(ann.dose) * 100) / 100 : 2
    }
  };
  _downloadJSON(out, (out.name).replace(/[^a-z0-9_\-]/gi, '_') + '.json');
}

function _downloadJSON(obj, filename) {
  const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}

// ── Backup / Restore ──────────────────────────────────────────────────────
export async function restoreFromFile(input) {
  const file = input.files[0];
  if (!file) return;
  const confirmMsg = t('backup_confirm');
  if (!confirm(confirmMsg)) { input.value = ''; return; }
  try {
    const text   = await file.text();
    const bundle = JSON.parse(text);
    if (!bundle.glp_backup) { alert(t('backup_invalid')); return; }
    const r = await apiFetch('api/restore', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: text
    });
    const res = await r.json();
    if (res.ok) {
      await loadData();
      alert(t('backup_restored', res.shots));
    } else {
      alert(t('backup_error', res.error));
    }
  } catch (e) { alert(t('backup_error', e.message)); }
  input.value = '';
}
