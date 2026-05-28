import { S } from '../state.js';
import { t } from '../i18n.js';
import { apiFetch } from '../api.js';
import { mapToXY, formatTimeLabel } from '../utils.js';

// ── Live chart init ───────────────────────────────────────────────────────
export function initLiveChart() {
  const ctx = document.getElementById('liveChart');
  const _existing = Chart.getChart(ctx);
  if (_existing) _existing.destroy();
  S.liveChart = null;

  S.liveChart = new Chart(ctx, {
    type: 'line',
    data: {
      datasets: [
        { label: t('chart_pressure'), data: [], yAxisID: 'y',  borderWidth: 2.5, tension: 0.1, borderColor: '#3498db', backgroundColor: 'transparent', pointStyle: false },
        { label: t('chart_flow'),     data: [], yAxisID: 'y',  borderWidth: 2,   tension: 0.1, borderColor: '#f39c12', backgroundColor: 'transparent', pointStyle: false },
        { label: t('chart_weight'),   data: [], yAxisID: 'y1', borderWidth: 2,   tension: 0.1, borderColor: '#2ecc71', backgroundColor: 'transparent', pointStyle: false },
        { label: t('chart_temp'),     data: [], yAxisID: 'y1', borderWidth: 2.5, tension: 0.1, borderColor: '#e74c3c', backgroundColor: 'transparent', pointStyle: false },
        // Reference datasets (4-7) — dashed, semi-transparent
        { label: t('ref_pressure'), data: [], yAxisID: 'y',  borderWidth: 1.5, tension: 0.1, borderColor: 'rgba(52,152,219,0.4)',  borderDash: [6,3], backgroundColor: 'transparent', pointStyle: false },
        { label: t('ref_flow'),     data: [], yAxisID: 'y',  borderWidth: 1.5, tension: 0.1, borderColor: 'rgba(243,156,18,0.4)',  borderDash: [6,3], backgroundColor: 'transparent', pointStyle: false },
        { label: t('ref_weight'),   data: [], yAxisID: 'y1', borderWidth: 1.5, tension: 0.1, borderColor: 'rgba(46,204,113,0.4)',  borderDash: [6,3], backgroundColor: 'transparent', pointStyle: false },
        { label: t('ref_temp'),     data: [], yAxisID: 'y1', borderWidth: 1.5, tension: 0.1, borderColor: 'rgba(231,76,60,0.4)',   borderDash: [6,3], backgroundColor: 'transparent', pointStyle: false }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { labels: { color: '#e4e4e7', font: { family: 'Figtree' } } },
        tooltip: { callbacks: { title: ctx => t('chart_time', formatTimeLabel(ctx[0].parsed.x)) } }
      },
      scales: {
        x:  { type: 'linear', min: 0, max: 60, ticks: { color: '#a1a1aa', callback: v => formatTimeLabel(v), stepSize: 5 }, grid: { color: '#27272a' } },
        y:  { type: 'linear', position: 'left',  min: 0, max: 12, ticks: { color: '#a1a1aa' }, grid: { color: '#27272a' } },
        y1: { type: 'linear', position: 'right', min: 0, max: 100, ticks: { color: '#a1a1aa' }, grid: { drawOnChartArea: false } }
      }
    }
  });

  // Re-apply reference shot after chart re-init
  if (S.refShotId) {
    const refShot = S.shots.find(s => s.id === S.refShotId);
    if (refShot && window.getShotData) _applyRefDatasets(window.getShotData(refShot));
  }
}

function _applyRefDatasets(d) {
  if (!S.liveChart) return;
  S.liveChart.data.datasets[4].data = d.pressure;
  S.liveChart.data.datasets[5].data = d.flow;
  S.liveChart.data.datasets[6].data = d.weight;
  S.liveChart.data.datasets[7].data = d.temp;
  S.liveChart.update('none');
}

export function populateRefSelector() {
  const sel = document.getElementById('refShotSelect');
  if (!sel) return;
  const prev = sel.value;
  sel.innerHTML = `<option value="">${t('ref_none')}</option>`;
  S.shots.filter(s => (s.datapoints?.pressure?.length || 0) > 5)
    .slice().reverse().slice(0, 40)
    .forEach(s => {
      const date    = new Date(s.timestamp * 1000).toLocaleDateString();
      const profile = s.profile?.name || s.profileName || '?';
      const ann     = s.annotation || {};
      const score   = ann.score != null ? ` · ${ann.score}` : '';
      const coffee  = ann.coffee ? ` — ${ann.coffee}` : '';
      const opt = document.createElement('option');
      opt.value       = s.id;
      opt.textContent = `${date} · ${profile}${coffee}${score}`;
      if (String(s.id) === String(prev)) opt.selected = true;
      sel.appendChild(opt);
    });
}

export function autoApplyRefShot(profileName) {
  const match = S.shots
    .filter(s => (s.profile?.name || s.profileName || '') === profileName
              && (s.datapoints?.pressure?.length || 0) > 5)
    .sort((a, b) => b.timestamp - a.timestamp)[0];
  if (!match) return;
  S.refShotId = match.id;
  if (window.getShotData) _applyRefDatasets(window.getShotData(match));
  const sel = document.getElementById('refShotSelect');
  if (sel) sel.value = String(match.id);
  const btn = document.getElementById('refClearBtn');
  if (btn) btn.style.display = '';
}

export function onRefShotChange(val) {
  if (!val) { clearReferenceShot(); return; }
  S.refShotId = parseInt(val);
  const shot = S.shots.find(s => s.id === S.refShotId);
  if (!shot) return;
  if (window.getShotData) _applyRefDatasets(window.getShotData(shot));
  const btn = document.getElementById('refClearBtn');
  if (btn) btn.style.display = '';
}

export function clearReferenceShot() {
  S.refShotId = null;
  if (S.liveChart) {
    [4, 5, 6, 7].forEach(i => { S.liveChart.data.datasets[i].data = []; });
    S.liveChart.update('none');
  }
  const sel = document.getElementById('refShotSelect');
  if (sel) sel.value = '';
  const btn = document.getElementById('refClearBtn');
  if (btn) btn.style.display = 'none';
}

export function connectLiveStream() {
  disconnectLiveStream();
  initLiveChart();
  setLiveBadge('connecting');
  S.liveLastSeq = -1;
  S.liveWasLive = false;
  fetchLiveData();
  fetchPreheatData();
  S.livePollInterval    = setInterval(fetchLiveData, 1000);
  S.preheatPollInterval = setInterval(fetchPreheatData, 10000);
}

export async function fetchPreheatData() {
  try {
    const r = await apiFetch('api/preheat');
    if (!r.ok) return;
    updatePreheatWidget(await r.json());
  } catch (e) {}
}

export function updatePreheatWidget(d) {
  const readyBadge  = document.getElementById('preheat-ready-badge');
  const warmingWrap = document.getElementById('preheat-warming-wrap');
  const barFill     = document.getElementById('preheat-bar-fill');
  const countdown   = document.getElementById('preheat-countdown');
  if (!readyBadge) return;

  if (d.ready) {
    readyBadge.style.display  = '';
    warmingWrap.style.display = 'none';
  } else if (d.remaining > 0) {
    readyBadge.style.display  = 'none';
    warmingWrap.style.display = '';
    barFill.style.width       = `${Math.round((d.pct || 0) * 100)}%`;
    const m = Math.floor(d.remaining / 60);
    const s = d.remaining % 60;
    countdown.textContent     = t('preheat_remain', m, s);
    const statusEl = document.getElementById('preheat-status-text');
    if (statusEl && d.preheatTime) statusEl.textContent = `${t('preheat_warming')} · ${d.preheatTime} min`;
  } else {
    readyBadge.style.display  = 'none';
    warmingWrap.style.display = 'none';
  }
}

export async function fetchLiveData() {
  try {
    const r = await apiFetch('api/live/data');
    if (!r.ok) { setLiveBadge('error', `HTTP ${r.status}`); return; }
    const msg = await r.json();

    // First successful response — mark as ready
    const statusEl = document.getElementById('live-status-text');
    if (S.livePollInterval && statusEl && statusEl.textContent === t('live_connecting')) {
      setLiveBadge('ready');
    }

    // Brew just started → auto-select last same-profile shot as reference
    if (!S.liveWasLive && msg.isLive && msg.profileName) {
      autoApplyRefShot(msg.profileName);
    }

    // Brew just ended → reload shot list after sync delay
    if (S.liveWasLive && !msg.isLive && msg.seq !== S.liveLastSeq) {
      S.liveLastSeq = msg.seq;
      setTimeout(() => { if (window.loadData) window.loadData(); }, 4000);
    }
    S.liveWasLive = msg.isLive;

    handleLiveData(msg);
  } catch (e) {
    setLiveBadge('error', 'Verbindung unterbrochen');
  }
}

export function disconnectLiveStream() {
  if (S.livePollInterval)    { clearInterval(S.livePollInterval);    S.livePollInterval = null; }
  if (S.preheatPollInterval) { clearInterval(S.preheatPollInterval); S.preheatPollInterval = null; }
  if (S.liveTimerTick)       { clearInterval(S.liveTimerTick);       S.liveTimerTick = null; }
  if (S.liveChart)           { S.liveChart.destroy(); S.liveChart = null; }
  S.liveBrewStartWall = null;
}

export function setLiveBadge(state, detail = '') {
  const badge   = document.getElementById('live-status-badge');
  const textEl  = document.getElementById('live-status-text');
  const liveBtn = document.getElementById('btnLive');

  badge.className = `live-status-badge ${state}`;
  liveBtn.classList.remove('live-brewing', 'live-ready');

  const labels = {
    connecting: t('live_connecting'),
    ready:      t('live_ready_status'),
    brewing:    t('live_brewing'),
    error:      detail || t('live_error_status'),
    idle:       t('live_ready_status')
  };
  textEl.textContent = labels[state] || state;

  if (state === 'brewing') liveBtn.classList.add('live-brewing');
  if (state === 'ready' || state === 'idle') liveBtn.classList.add('live-ready');
}

export function handleLiveData(msg) {
  const dp      = msg.datapoints || {};
  const times   = dp.timeInShot  || [];
  const lastIdx = times.length - 1;

  const metaEl    = document.getElementById('live-meta');
  const contentEl = document.getElementById('live-content');
  const idleEl    = document.getElementById('live-idle');

  if (!msg.isLive && times.length === 0) {
    setLiveBadge('ready');
    metaEl.textContent = '–';
    contentEl.style.display = 'none';
    idleEl.style.display    = 'flex';
    return;
  }

  contentEl.style.display = 'block';
  idleEl.style.display    = 'none';

  if (msg.isLive) {
    setLiveBadge('brewing');
    metaEl.textContent = msg.profileName || '–';
  } else {
    setLiveBadge('idle');
    metaEl.textContent = (msg.profileName || '–') + ' · abgeschlossen';
  }

  if (lastIdx >= 0) {
    const elapsed  = times[lastIdx] / 10;
    const pressure = dp.pressure?.[lastIdx]    != null ? dp.pressure[lastIdx] / 10    : null;
    const flow     = dp.pumpFlow?.[lastIdx]     != null ? dp.pumpFlow[lastIdx] / 10    : null;
    const weight   = (dp.shotWeight || dp.weight)?.[lastIdx] != null
                   ? (dp.shotWeight || dp.weight)[lastIdx] / 10 : null;
    const temp     = dp.temperature?.[lastIdx]  != null ? dp.temperature[lastIdx] / 10 : null;

    if (msg.isLive) {
      // Re-sync wall clock so timer stays accurate
      S.liveBrewStartWall = Date.now() - elapsed * 1000;
      if (!S.liveTimerTick) {
        S.liveTimerTick = setInterval(() => {
          if (S.liveBrewStartWall) {
            const s = (Date.now() - S.liveBrewStartWall) / 1000;
            document.getElementById('liveTime').textContent = formatTimeLabel(s);
          }
        }, 100);
      }
    } else {
      if (S.liveTimerTick) { clearInterval(S.liveTimerTick); S.liveTimerTick = null; }
      S.liveBrewStartWall = null;
      document.getElementById('liveTime').textContent = formatTimeLabel(elapsed);
    }

    document.getElementById('livePressure').textContent = pressure != null ? pressure.toFixed(1) : '–';
    document.getElementById('liveFlow').textContent     = flow     != null ? flow.toFixed(1)     : '–';
    document.getElementById('liveWeight').textContent   = weight   != null ? weight.toFixed(1)   : '–';
    document.getElementById('liveTemp').textContent     = temp     != null ? temp.toFixed(1)     : '–';
  }

  if (S.liveChart) {
    const maxTime = times.length > 0 ? times[times.length - 1] / 10 : 60;
    S.liveChart.data.datasets[0].data = mapToXY(times, dp.pressure);
    S.liveChart.data.datasets[1].data = mapToXY(times, dp.pumpFlow);
    S.liveChart.data.datasets[2].data = mapToXY(times, dp.shotWeight || dp.weight);
    S.liveChart.data.datasets[3].data = mapToXY(times, dp.temperature);
    S.liveChart.options.scales.x.max  = Math.max(maxTime + 5, 30);

    const maxTemp = dp.temperature?.length
      ? dp.temperature.reduce((m, v) => v > m ? v : m, 0) / 10 : 0;
    S.liveChart.options.scales.y1.max = Math.ceil(maxTemp + 5) || 100;

    S.liveChart.update('none');
  }
}
