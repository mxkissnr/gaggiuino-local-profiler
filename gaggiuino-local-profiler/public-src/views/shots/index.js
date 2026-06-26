import { S }                                                  from '../../state.js';
import { t }                                                  from '../../i18n.js';
import { apiFetch }                                           from '../../api.js';
import { LOCALE_MAP, phasePlugin, corsairPlugin, clearChartOnTouchEnd } from '../../constants.js';
import {
  esc, avg, avgActive, max, safeLast, fmt, formatTimeLabel,
  stddev, detectPhases, detectChanneling, scoreClass
} from '../../utils.js';
import { renderSidebar, updateSidebarHighlighting }           from '../../components/sidebar.js';
import { getShotData, calcShotScore }                         from './utils.js';
import { calcGrindAdvice, calcComparativeGrindAdvice, _miniShotChart } from './grind.js';
import { renderAnnotationPanel }                              from './annotation.js';
import { updatePQChart }                                      from './charts.js';

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
      `<button data-action="reload-data" style="margin-top:10px;padding:4px 12px;cursor:pointer;` +
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
    const savedPrimary = parseInt(localStorage.getItem('glp_primaryShotId'));
    const savedCompare = parseInt(localStorage.getItem('glp_compareShotId'));
    if (savedPrimary && S.shots.find(s => s.id === savedPrimary)) {
      S.primaryShotId = savedPrimary;
    } else if (!S.primaryShotId || !S.shots.find(s => s.id === S.primaryShotId)) {
      S.primaryShotId = S.shots[S.shots.length - 1].id;
    }
    if (savedCompare && S.shots.find(s => s.id === savedCompare) && savedCompare !== S.primaryShotId) {
      S.compareShotId = savedCompare;
    }
    updateView();
  } else {
    empty.style.display     = 'flex';
    chartArea.style.display = 'none';
  }
}

// ── Trash ─────────────────────────────────────────────────────────────────

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
      <button class="trash-restore-btn" data-action="restore-shot" data-id="${shot.id}">${t('trash_restore_label')}</button>
      <button class="trash-delete-btn" title="${t('trash_delete_title')}" data-action="perm-delete-shot" data-id="${shot.id}"><svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16" aria-hidden="true"><path d="M6,19A2,2 0 0,0 8,21H16A2,2 0 0,0 18,19V7H6V19M8,9H10V19H8V9M14,9H16V19H14V9M15.5,4L14.5,3H9.5L8.5,4H5V6H19V4H15.5Z"/></svg></button>
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
    if (S.primaryShotId === id) {
      S.primaryShotId = S.shots[0]?.id || null;
      if (S.primaryShotId) localStorage.setItem('glp_primaryShotId', S.primaryShotId);
      else localStorage.removeItem('glp_primaryShotId');
    }
    if (S.compareShotId === id) {
      S.compareShotId = null;
      localStorage.removeItem('glp_compareShotId');
    }
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

// ── Main view ─────────────────────────────────────────────────────────────

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
  document.getElementById('temp').innerText             = fmt(avg(tempVals), ' °C');
  document.getElementById('tempStability').textContent  = (sdTemp != null && sdTemp < 5) ? `±${sdTemp.toFixed(1)}` : '';
  document.getElementById('targetTemp').innerText       = ` / ${fmt(avg(dA.targetTemp.map(p => p.y)), ' °C')}`;

  const finalWeight = max(dA.weight.map(p => p.y));
  document.getElementById('weight').innerText        = fmt(finalWeight, ' g');
  document.getElementById('weightFlowSub').innerText = ` / ${fmt(safeLast(dA.weightFlow.map(p => p.y)), ' ml/s')}`;
  document.getElementById('wf').innerText            = fmt(avgActive(dA.weightFlow.map(p => p.y), 0.1), ' ml/s');
  document.getElementById('maxWf').innerText         = ` / ${fmt(max(dA.weightFlow.map(p => p.y)), ' max')}`;

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
    const ey   = (finalWeight * ann.tds) / ann.dose;
    const eyEl = document.getElementById('ey');
    eyEl.textContent = `${ey.toFixed(1)} %`;
    const eyOk = ey >= 18 && ey <= 22;
    eyEl.className = 'meta-value ' + (eyOk ? 'score-great' : ey >= 16 && ey <= 24 ? 'score-ok' : 'score-bad');
    eyItem.style.display = '';
  } else {
    eyItem.style.display = 'none';
  }

  // Freshness badge
  const freshEl   = document.getElementById('freshnessBadge');
  const ageAtShot = ann.beanAgeDays != null ? ann.beanAgeDays
    : (!shotB && ann.roastDate && ann.coffee)
      ? Math.round((Date.now() - new Date(ann.roastDate)) / 86400000)
      : null;
  if (ageAtShot != null && ageAtShot >= 0 && ageAtShot <= 365) {
    const cls = ageAtShot <= 21 ? 'freshness-fresh' : ageAtShot <= 35 ? 'freshness-ok' : 'freshness-old';
    freshEl.className   = `freshness-badge ${cls}`;
    freshEl.textContent = ann.beanAgeDays != null ? t('bean_age_badge', ageAtShot) : `${ageAtShot}d`;
    freshEl.title       = ann.beanAgeDays != null ? t('bean_age_at_shot', ageAtShot) : t('freshness_title', ageAtShot);
    freshEl.style.display = '';
  } else { freshEl.style.display = 'none'; }

  // Firmware version badge
  const fwEl = document.getElementById('firmwareVersionBadge');
  if (fwEl) {
    const fw = !shotB && shotA.glpFirmwareVersion;
    fwEl.textContent = fw ? `· fw ${fw}` : '';
    fwEl.style.display = fw ? '' : 'none';
  }

  // Phases
  const phases      = !shotB ? detectPhases(pressureTimes, pressureVals) : null;
  const phasesItem  = document.getElementById('phasesItem');
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
  const advice   = !shotB ? calcGrindAdvice(shotA, dA) : null;
  if (advice) {
    adviceEl.className = `grind-advice grind-${advice.type}`;
    document.getElementById('grindAdviceIcon').textContent = advice.icon;
    document.getElementById('grindAdviceText').textContent = advice.text;
    adviceEl.style.display = '';
  } else { adviceEl.style.display = 'none'; }

  const compEl  = document.getElementById('grindAdviceComparative');
  const compAdv = !shotB ? calcComparativeGrindAdvice(shotA, S.shots) : null;
  if (compEl) {
    if (compAdv) {
      const wasOpen = compEl.classList.contains('expanded');
      compEl.className = `grind-advice grind-comparative grind-${compAdv.type}${wasOpen ? ' expanded' : ''}`;
      document.getElementById('grindAdviceComparativeIcon').textContent = compAdv.icon;
      document.getElementById('grindAdviceComparativeText').textContent = compAdv.text;

      const locale   = LOCALE_MAP[S.currentLang] || 'de-DE';
      const listHtml = compAdv.shots.map(({ shot: s, grind, score }) => {
        const date  = new Date(s.timestamp * 1000).toLocaleDateString(locale, { day: '2-digit', month: '2-digit' });
        const dur   = s.duration ? `${(s.duration / 10).toFixed(0)}s` : '';
        const cls   = scoreClass(score);
        const chart = _miniShotChart(s);
        return `<div class="comp-thumb" data-action="goto-shot" data-id="${s.id}" title="Shot ${s.id} — ${date}">
          <div class="comp-thumb-chart">${chart}</div>
          <div class="comp-thumb-meta">
            <span class="comp-shot-date">${date}</span>
            <span class="comp-shot-grind">⚙ ${grind}</span>
            <span class="comp-shot-score ${cls}">${score}</span>
            ${dur ? `<span class="comp-shot-dur">${dur}</span>` : ''}
          </div>
        </div>`;
      }).join('');

      let panel = compEl.querySelector('.comp-shots-panel');
      if (!panel) {
        panel = document.createElement('div');
        panel.className = 'comp-shots-panel';
        compEl.appendChild(panel);
      }
      panel.innerHTML = listHtml;

      const toggle = compEl.querySelector('.comp-toggle');
      if (!toggle) {
        const btn = document.createElement('button');
        btn.className = 'comp-toggle';
        btn.textContent = '▸';
        btn.dataset.action = 'toggle-comp-grind';
        compEl.insertBefore(btn, compEl.querySelector('#grindAdviceComparativeIcon'));
      }
      compEl.style.display = '';
    } else {
      compEl.style.display = 'none';
    }
  }

  // Ordered-by info
  const obEl = document.getElementById('orderedByInfo');
  if (obEl) {
    const ob = !shotB && (shotA.annotation?.orderedBy);
    if (ob?.customer) {
      const drink = ob.item ? (ob.variant ? `${ob.item} · ${ob.variant}` : ob.item) : null;
      obEl.innerHTML =
        `<span class="ann-ordered-by-label">☕ ${t('ann_ordered_by')}</span>` +
        `<span class="ann-ordered-by-val">${esc(ob.customer)}${drink ? ` · ${esc(drink)}` : ''}${ob.note ? ` · <em>${esc(ob.note)}</em>` : ''}</span>`;
      obEl.style.display = '';
    } else {
      obEl.style.display = 'none';
    }
  }

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

  // Build main chart datasets
  const maxTimeA = dA.rawTimes.length > 0 ? dA.rawTimes[dA.rawTimes.length - 1] : 0;
  const maxTimeB = dB?.rawTimes.length > 0 ? dB.rawTimes[dB.rawTimes.length - 1] : 0;

  const sfx = shotB ? ' (A)' : '';
  const datasets = [
    { label:t('chart_pressure')   + sfx, data: dA.pressure,  yAxisID:'y',  borderWidth:2.5, tension:.1, borderColor:'#3498db', backgroundColor:'transparent', pointStyle:false },
    { label:t('chart_flow')       + sfx, data: dA.flow,       yAxisID:'y',  borderWidth:2,   tension:.1, borderColor:'#f39c12', backgroundColor:'transparent', pointStyle:false },
    { label:t('chart_weightflow') + sfx, data: dA.weightFlow, yAxisID:'y',  borderWidth:2,   tension:.1, borderColor:'#9b59b6', backgroundColor:'transparent', pointStyle:false },
    { label:t('chart_weight')     + sfx, data: dA.weight,     yAxisID:'y1', borderWidth:2,   tension:.1, borderColor:'#2ecc71', backgroundColor:'transparent', pointStyle:false },
    { label:t('chart_temp')       + sfx, data: dA.temp,       yAxisID:'y1', borderWidth:2.5, tension:.1, borderColor:'#e74c3c', backgroundColor:'transparent', pointStyle:false }
  ];

  if (!shotB) {
    datasets.push(
      { label:t('chart_target_pressure'), data: dA.targetPressure, yAxisID:'y',  borderDash:[5,5], borderWidth:1.5, tension:.1, borderColor:'#3498db', backgroundColor:'transparent', pointStyle:false },
      { label:t('chart_target_flow'),     data: dA.targetFlow,     yAxisID:'y',  borderDash:[5,5], borderWidth:1.5, tension:.1, borderColor:'#f39c12', backgroundColor:'transparent', pointStyle:false },
      { label:t('chart_target_temp'),     data: dA.targetTemp,     yAxisID:'y1', borderDash:[5,5], borderWidth:1.5, tension:.1, borderColor:'#e74c3c', backgroundColor:'transparent', pointStyle:false }
    );
  }
  if (shotB && dB) {
    datasets.push(
      { label:t('chart_pressure')   + ' (B)', data: dB.pressure,  yAxisID:'y',  borderDash:[3,3], borderWidth:2,   tension:.1, borderColor:'rgba(52,152,219,.65)',  backgroundColor:'transparent', pointStyle:false },
      { label:t('chart_flow')       + ' (B)', data: dB.flow,       yAxisID:'y',  borderDash:[3,3], borderWidth:1.5, tension:.1, borderColor:'rgba(243,156,18,.65)',  backgroundColor:'transparent', pointStyle:false },
      { label:t('chart_weightflow') + ' (B)', data: dB.weightFlow, yAxisID:'y',  borderDash:[3,3], borderWidth:1.5, tension:.1, borderColor:'rgba(155,89,182,.65)',  backgroundColor:'transparent', pointStyle:false },
      { label:t('chart_weight')     + ' (B)', data: dB.weight,     yAxisID:'y1', borderDash:[3,3], borderWidth:1.5, tension:.1, borderColor:'rgba(46,204,113,.65)',  backgroundColor:'transparent', pointStyle:false },
      { label:t('chart_temp')       + ' (B)', data: dB.temp,       yAxisID:'y1', borderDash:[3,3], borderWidth:2,   tension:.1, borderColor:'rgba(231,76,60,.65)',   backgroundColor:'transparent', pointStyle:false }
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
          tooltip: { callbacks: { title: ctx => t('chart_time', formatTimeLabel(ctx[0].parsed.x)) } }
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
    clearChartOnTouchEnd(S.chart);
  } catch (e) {
    console.error('Chart creation error:', e);
  }
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
    avgP   != null ? avgP.toFixed(2)   : '',
    finalW != null ? finalW.toFixed(1) : '',
    ann.dose || '', ratio,
    avgT   != null ? avgT.toFixed(1)   : '',
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
    ann.coffee       ? `bean_desc {${ann.coffee.replace(/[{}]/g, '')}}` : '',
    ann.grinder      ? `grinder_model {${ann.grinder.replace(/[{}]/g, '')}}` : '',
    ann.grindSetting ? `grinder_setting {${ann.grindSetting.replace(/[{}]/g, '')}}` : '',
    ann.dose         ? `bean_weight ${ann.dose}` : '',
    ann.notes        ? `espresso_notes {${ann.notes.replace(/[{}]/g, '')}}` : '',
    `espresso_elapsed ${tcl(timeArr)}`,
    `espresso_pressure ${tcl(d.pressure)}`,
    `espresso_flow ${tcl(d.pumpFlow)}`,
    `espresso_weight ${tcl(d.shotWeight || d.weight)}`,
    `espresso_flow_weight ${tcl(d.weightFlow)}`,
    `espresso_temperature_goal ${tcl(d.targetTemperature)}`,
    `espresso_temperature_mix ${tcl(d.temperature)}`,
    `espresso_water_dispensed ${lastW}`,
  ].filter(Boolean).join('\n');

  _downloadJSON_blob(lines, `shot_${shot.id}_${date.slice(0, 10)}.shot`, 'text/plain;charset=utf-8;');
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
  const rawT = d.timeInShot     || [];
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
  const avgExtraction   = extractionSlice.length
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
  _downloadJSON_blob(JSON.stringify(obj, null, 2), filename, 'application/json');
}

function _downloadJSON_blob(content, filename, mime) {
  const blob = new Blob([content], { type: mime });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}

// ── Share card ────────────────────────────────────────────────────────────

export async function shareCard() {
  const shotId = S.primaryShotId;
  if (!shotId) return;
  try {
    const r = await apiFetch(`api/shots/${shotId}/card`);
    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      throw new Error(err.error || r.statusText);
    }
    const blob = await r.blob();
    const file = new File([blob], `glp-shot-${shotId}.png`, { type: 'image/png' });
    if (navigator.canShare?.({ files: [file] })) {
      await navigator.share({ files: [file], title: t('share_card_title') });
    } else {
      const url = URL.createObjectURL(blob);
      const a   = document.createElement('a');
      a.href = url;
      a.download = `glp-shot-${shotId}.png`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
  } catch (e) {
    if (e.name !== 'AbortError') alert(t('error_generic', e.message));
  }
}

// ── Backup / Restore ──────────────────────────────────────────────────────

export async function restoreFromFile(input) {
  const file = input.files[0];
  if (!file) return;
  if (!confirm(t('backup_confirm'))) { input.value = ''; return; }
  try {
    const text   = await file.text();
    const bundle = JSON.parse(text);
    if (!bundle.glp_backup) { alert(t('backup_invalid')); return; }
    const r   = await apiFetch('api/restore', {
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
