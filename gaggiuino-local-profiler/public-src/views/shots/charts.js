import Chart from 'chart.js/auto';
import { S }                                              from '../../state.js';
import { t }                                              from '../../i18n.js';
import { corsairPlugin, clearChartOnTouchEnd } from '../../constants.js';
import { formatTimeLabel, chartColors, mapShotDatapoints } from '../../utils.js';
import { getRawCurve, getCachedShotData }                 from '../../shot-curves.js';

// #957: curves are lazy. updateView() (index.js) ensureCurves() for the
// selected + comparand shots before switching to the P·Q / fullscreen chart,
// so these synchronous cache reads hit; a synthetic/demo shot still carries
// its own datapoints, used as the fallback.
function _rawCurve(shot) {
  return getRawCurve(shot.id) || shot.datapoints || {};
}
function _xyCurve(shot) {
  return getCachedShotData(shot.id) || mapShotDatapoints(shot.datapoints);
}

// ── Chart tab switching ───────────────────────────────────────────────────

export function switchChartTab(tab) {
  S.currentChartTab = tab;
  document.getElementById('tabZeit').classList.toggle('active', tab === 'zeit');
  document.getElementById('tabPQ').classList.toggle('active',   tab === 'pq');
  document.getElementById('zeitContainer').style.display = tab === 'zeit' ? '' : 'none';
  document.getElementById('pqContainer').style.display   = tab === 'pq'   ? '' : 'none';
  if (tab === 'pq') updatePQChart();
}

// ── P·Q Chart ─────────────────────────────────────────────────────────────

function getPQData(shot) {
  const d = _rawCurve(shot);
  const tm = d.timeInShot || [];
  const p  = d.pressure   || [];
  const f  = d.pumpFlow   || [];
  const n  = Math.min(tm.length, p.length, f.length);
  const result = [];
  for (let i = 0; i < n; i++) {
    if (p[i] != null && f[i] != null && p[i] >= 30 && f[i] > 0)
      result.push({ x: f[i] / 10, y: p[i] / 10 });
  }
  return result;
}

export function updatePQChart() {
  // #814: resolved per render, never at module load — the value has to be
  // whatever the ACTIVE theme resolves to right now.
  const C = chartColors();
  const shotA = S.shots.find(s => s.id === S.primaryShotId);
  if (!shotA) return;

  const canvas = document.getElementById('pqChart');
  if (S.pqChart) { S.pqChart.destroy(); S.pqChart = null; }

  const shotB = S.compareShotId ? S.shots.find(s => s.id === S.compareShotId) : null;
  const dataA = getPQData(shotA);
  const dataB = shotB ? getPQData(shotB) : [];

  const allFlow = [...dataA, ...dataB].map(d => d.x);
  const xMax = allFlow.length ? Math.max(3, Math.ceil(Math.max(...allFlow) * 1.1 * 2) / 2) : 5;

  const datasets = [
    { label: `Shot ${shotA.id}`, data: dataA,
      showLine: true, tension: 0.2, fill: false,
      borderColor: '#3498db', backgroundColor: '#3498db',
      borderWidth: 2, pointRadius: 1.5, pointHoverRadius: 4 }
  ];
  if (shotB && dataB.length) datasets.push(
    { label: `Shot ${shotB.id}`, data: dataB,
      showLine: true, tension: 0.2, fill: false,
      borderColor: 'rgba(52,152,219,.55)', backgroundColor: 'rgba(52,152,219,.55)',
      borderDash: [4,3], borderWidth: 2, pointRadius: 1, pointHoverRadius: 3 }
  );

  S.pqChart = new Chart(canvas, {
    type: 'scatter',
    data: { datasets },
    options: {
      responsive: true, maintainAspectRatio: false, animation: false,
      plugins: {
        legend: { labels: { color: C.text, font: { family: 'Figtree' } } },
        tooltip: { callbacks: { label: c => `${c.parsed.y.toFixed(1)} bar @ ${c.parsed.x.toFixed(1)} ml/s` } }
      },
      scales: {
        x: { type: 'linear', min: 0, max: xMax,
             title: { display: true, text: t('chart_flow_unit'), color: '#71717a', font: { family: 'Figtree' } },
             ticks: { color: C.tick }, grid: { color: C.grid } },
        y: { type: 'linear', min: 0, max: 12,
             title: { display: true, text: t('chart_pressure_unit'), color: '#71717a', font: { family: 'Figtree' } },
             ticks: { color: C.tick }, grid: { color: C.grid } }
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
  // #814: resolved per render, never at module load — the value has to be
  // whatever the ACTIVE theme resolves to right now.
  const C = chartColors();
  const shotA = S.shots.find(s => s.id === S.primaryShotId);
  if (!shotA) return;
  const existing = Chart.getChart('espressoShotChartFs');
  if (existing) existing.destroy();
  S.fsChart = null;

  const canvas = document.getElementById('espressoShotChartFs');

  if (S.currentFsTab === 'pq') {
    const data = getPQData(shotA);
    const xMax = data.length
      ? Math.max(3, Math.ceil(Math.max(...data.map(d => d.x)) * 1.1 * 2) / 2)
      : 5;
    S.fsChart = new Chart(canvas, {
      type: 'scatter',
      data: { datasets: [{ label: `Shot ${shotA.id}`, data,
          showLine: true, tension: 0.2, fill: false,
          borderColor: '#3498db', backgroundColor: '#3498db',
          borderWidth: 2.5, pointRadius: 2, pointHoverRadius: 5 }] },
      options: {
        responsive: true, maintainAspectRatio: false, animation: false,
        plugins: {
          legend: { labels: { color: C.text, font: { family: 'Figtree' } } },
          tooltip: { callbacks: { label: c => `${c.parsed.y.toFixed(1)} bar @ ${c.parsed.x.toFixed(1)} ml/s` } }
        },
        scales: {
          x: { type: 'linear', min: 0, max: xMax,
               title: { display: true, text: t('chart_flow_unit'), color: '#71717a', font: { family: 'Figtree' } },
               ticks: { color: C.tick }, grid: { color: C.grid } },
          y: { type: 'linear', min: 0, max: 12,
               title: { display: true, text: t('chart_pressure_unit'), color: '#71717a', font: { family: 'Figtree' } },
               ticks: { color: C.tick }, grid: { color: C.grid } }
        }
      }
    });
    clearChartOnTouchEnd(S.fsChart);
    return;
  }

  if (!S.chart) return;
  const dA     = _xyCurve(shotA);
  const maxTempA = Math.max(...(_rawCurve(shotA).temperature || []).map(v => v / 10), 0);
  const tms    = Math.ceil(maxTempA + 5) || 100;
  const maxTime = dA.rawTimes.length > 0 ? dA.rawTimes[dA.rawTimes.length - 1] : 60;
  const datasets = S.chart.data.datasets.map(ds => ({ ...ds, data: [...ds.data] }));

  S.fsChart = new Chart(canvas, {
    type: 'line',
    plugins: [corsairPlugin],
    data: { datasets },
    options: {
      responsive: true, maintainAspectRatio: false, animation: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: true, position: 'bottom',
          labels: { color: C.text, font: { family: 'Figtree', size: 11 }, boxWidth: 12, padding: 8 } },
        tooltip: { callbacks: { title: c => 'Zeit: ' + formatTimeLabel(c[0].parsed.x) } }
      },
      scales: {
        x:  { type:'linear', min:0, max:maxTime, clip:false,
              ticks:{ color:C.tick, font:{family:'Figtree'}, stepSize:5, callback:v=>formatTimeLabel(v) },
              grid:{ color:C.grid } },
        y:  { type:'linear', position:'left',  min:0, max:12, ticks:{color:C.tick}, grid:{color:C.grid} },
        y1: { type:'linear', position:'right', min:0, max:tms, ticks:{color:C.tick}, grid:{drawOnChartArea:false} }
      }
    }
  });
  clearChartOnTouchEnd(S.fsChart);
}
