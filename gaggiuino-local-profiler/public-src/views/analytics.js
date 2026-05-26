import { S } from '../state.js';
import { t } from '../i18n.js';
import { LOCALE_MAP } from '../constants.js';
import { scoreClass } from '../utils.js';

// ── Analytics entry point ─────────────────────────────────────────────────
export function initAnalytics() {
  buildTrendChart();
  buildCalendar();
  buildBeanStats();
  buildProfileChart();
}

export function setTrendWindow(n) {
  S.trendWindow = n;
  document.getElementById('trendBtn30') .classList.toggle('active', n === 30);
  document.getElementById('trendBtn90') .classList.toggle('active', n === 90);
  document.getElementById('trendBtnAll').classList.toggle('active', n === 0);
  buildTrendChart();
}

export function buildTrendChart() {
  const all = S.shots.filter(s => {
    if (!window.calcShotScore || !window.getShotData) return false;
    return window.calcShotScore(s, window.getShotData(s)) !== null;
  });
  const src = S.trendWindow > 0 ? all.slice(-S.trendWindow) : all;

  const ctx = document.getElementById('trendChart');
  if (!ctx) return;
  if (S.trendChart) { S.trendChart.destroy(); S.trendChart = null; }

  if (src.length < 2) {
    ctx.parentElement.innerHTML = `<p style="color:#52525b;font-size:.85rem;padding-top:8px">${t('analytics_no_trend')}</p>`;
    return;
  }

  const locale   = LOCALE_MAP[S.currentLang] || 'de-DE';
  const labels   = src.map(s => new Date(s.timestamp * 1000).toLocaleDateString(locale, { day: '2-digit', month: '2-digit' }));
  const scoreData = src.map(s => window.calcShotScore(s, window.getShotData(s)));
  const maData    = scoreData.map((_, i) => {
    const sl = scoreData.slice(Math.max(0, i - 4), i + 1);
    return Math.round(sl.reduce((a, b) => a + b, 0) / sl.length);
  });

  S.trendChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: [
        { label: 'Score', data: scoreData, borderColor: '#ef4444', backgroundColor: 'rgba(239,68,68,.12)',
          pointRadius: 4, pointHoverRadius: 6, fill: true, tension: 0.3, order: 2 },
        { label: 'Ø 5-Shot', data: maData, borderColor: 'rgba(255,255,255,.35)',
          pointRadius: 0, fill: false, tension: 0.5, borderWidth: 2, order: 1 }
      ]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      onClick: (_, elements) => {
        if (elements.length > 0 && window.goToShot) window.goToShot(src[elements[0].index].id);
      },
      plugins: {
        legend: { labels: { color: '#a1a1aa', font: { size: 11 } } },
        tooltip: { callbacks: { footer: () => '↗ Shot anzeigen' } },
      },
      scales: {
        x: { ticks: { color: '#52525b', font: { size: 10 }, maxRotation: 45 }, grid: { color: 'rgba(63,63,70,.3)' } },
        y: { min: 0, max: 100, ticks: { color: '#52525b', font: { size: 10 }, stepSize: 20 }, grid: { color: 'rgba(63,63,70,.3)' } }
      }
    }
  });
}

export function buildCalendar() {
  const el = document.getElementById('shotCalendar');
  if (!el) return;

  if (!S._calendarResizeObserver) {
    S._calendarResizeObserver = new ResizeObserver(() => _renderCalendar());
    S._calendarResizeObserver.observe(el);
  }
  _renderCalendar();
}

export function _renderCalendar() {
  const el = document.getElementById('shotCalendar');
  if (!el) return;

  const dayMap = {};
  for (const s of S.shots) {
    const key = new Date(s.timestamp * 1000).toISOString().slice(0, 10);
    if (!dayMap[key]) dayMap[key] = { count: 0, scores: [], lastId: null };
    dayMap[key].count++;
    dayMap[key].lastId = s.id;
    if (window.calcShotScore && window.getShotData) {
      const sc = window.calcShotScore(s, window.getShotData(s));
      if (sc !== null) dayMap[key].scores.push(sc);
    }
  }

  const today = new Date(); today.setHours(0, 0, 0, 0);
  const startDate = new Date(today);
  startDate.setDate(startDate.getDate() - 364);
  const dow = (startDate.getDay() + 6) % 7;
  startDate.setDate(startDate.getDate() - dow);

  const locale = LOCALE_MAP[S.currentLang] || 'de-DE';
  const months = [];
  let lastMonth = -1;
  const weeks = [];
  const cur = new Date(startDate);

  while (cur <= today) {
    const week = [];
    for (let d = 0; d < 7; d++) {
      const key  = cur.toISOString().slice(0, 10);
      const data = dayMap[key] || { count: 0, scores: [] };
      const avgSc = data.scores.length ? Math.round(data.scores.reduce((a, b) => a + b, 0) / data.scores.length) : null;
      if (d === 0 && cur.getMonth() !== lastMonth) {
        months.push({ weekIdx: weeks.length, label: cur.toLocaleDateString(locale, { month: 'short' }) });
        lastMonth = cur.getMonth();
      }
      week.push({ date: new Date(cur), key, count: data.count, avgSc, lastId: data.lastId || null });
      cur.setDate(cur.getDate() + 1);
    }
    weeks.push(week);
  }

  const GAP      = 2;
  const W        = Math.floor(el.getBoundingClientRect().width) || 600;
  const cellSize = Math.max(4, Math.floor((W - (weeks.length - 1) * GAP) / weeks.length));
  const CELL     = cellSize + GAP;
  const cellSz   = `width:${cellSize}px;height:${cellSize}px`;

  const cls = c => c === 0 ? 'cal-0' : c === 1 ? 'cal-1' : c === 2 ? 'cal-2' : 'cal-3';

  let html = `<div style="position:relative;height:${cellSize + 3}px;margin-bottom:4px">`;
  for (const m of months) html += `<span style="position:absolute;left:${m.weekIdx * CELL}px;font-size:.65rem;color:#52525b">${m.label}</span>`;
  html += `</div><div class="cal-grid" style="gap:${GAP}px">`;

  for (const week of weeks) {
    html += `<div class="cal-week" style="gap:${GAP}px">`;
    for (const day of week) {
      const isFuture = day.date > today;
      const dateStr  = day.date.toLocaleDateString(locale, { day: '2-digit', month: '2-digit', year: 'numeric' });
      const title    = day.count === 0 ? dateStr
                     : `${dateStr}: ${day.count} Shot${day.count > 1 ? 's' : ''}${day.avgSc !== null ? ` · Ø ${day.avgSc}` : ''}`;
      const clickable = !isFuture && day.count > 0 && day.lastId !== null;
      html += `<div class="${isFuture ? 'cal-future' : cls(day.count)} cal-day${clickable ? ' cal-day-link' : ''}" style="${cellSz}" title="${title}"${clickable ? ` onclick="goToShot(${day.lastId})"` : ''}></div>`;
    }
    html += `</div>`;
  }
  html += `</div>`;
  el.innerHTML = html;
}

export function buildBeanStats() {
  const el = document.getElementById('beanStats');
  if (!el) return;

  const byBean = {};
  for (const s of S.shots) {
    const name = s.annotation?.coffee;
    if (!name) continue;
    if (!byBean[name]) byBean[name] = { count: 0, scores: [], durations: [] };
    byBean[name].count++;
    if (window.calcShotScore && window.getShotData) {
      const sc = window.calcShotScore(s, window.getShotData(s));
      if (sc !== null) byBean[name].scores.push(sc);
    }
    const dur = (s.duration || 0) / 10;
    if (dur > 5) byBean[name].durations.push(dur);
  }

  const beans = Object.entries(byBean).sort((a, b) => b[1].count - a[1].count);

  if (beans.length === 0) {
    el.innerHTML = `<p style="color:#52525b;font-size:.85rem">${t('analytics_no_beans')}</p>`;
    return;
  }

  let html = '<div class="bean-cards">';
  for (const [name, d] of beans) {
    const avgSc  = d.scores.length    ? Math.round(d.scores.reduce((a, b) => a + b, 0) / d.scores.length) : null;
    const bestSc = d.scores.length    ? Math.max(...d.scores) : null;
    const avgDur = d.durations.length ? (d.durations.reduce((a, b) => a + b, 0) / d.durations.length).toFixed(1) : null;
    const scCls  = avgSc !== null ? scoreClass(avgSc) : '';
    const esc    = s => s == null ? '' : String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
    html += `<div class="bean-card">
      <div class="bean-card-name" title="${esc(name)}">${esc(name)}</div>
      <div class="bean-card-stats">
        <div class="bean-stat"><span class="bean-stat-val">${d.count}</span><span class="bean-stat-lbl">${t('bean_stat_shots')}</span></div>
        ${avgSc  !== null ? `<div class="bean-stat"><span class="bean-stat-val ${scCls}">${avgSc}</span><span class="bean-stat-lbl">${t('bean_stat_avg')}</span></div>` : ''}
        ${bestSc !== null ? `<div class="bean-stat"><span class="bean-stat-val">${bestSc}</span><span class="bean-stat-lbl">${t('bean_stat_best')}</span></div>` : ''}
        ${avgDur !== null ? `<div class="bean-stat"><span class="bean-stat-val">${avgDur}s</span><span class="bean-stat-lbl">${t('bean_stat_duration')}</span></div>` : ''}
      </div>
    </div>`;
  }
  html += '</div>';
  el.innerHTML = html;
}

export function buildProfileChart() {
  const byProfile = {};
  for (const s of S.shots) {
    const p = s.profile?.name || s.profileName || 'Unbekannt';
    if (!byProfile[p]) byProfile[p] = { scores: [], count: 0 };
    byProfile[p].count++;
    if (window.calcShotScore && window.getShotData) {
      const sc = window.calcShotScore(s, window.getShotData(s));
      if (sc !== null) byProfile[p].scores.push(sc);
    }
  }

  const entries = Object.entries(byProfile)
    .filter(([, v]) => v.scores.length > 0)
    .map(([name, v]) => ({ name, count: v.count, avgScore: Math.round(v.scores.reduce((a, b) => a + b, 0) / v.scores.length) }))
    .sort((a, b) => b.avgScore - a.avgScore);

  const wrap = document.getElementById('profileChartWrap');
  const ctx  = document.getElementById('profileChart');
  if (!ctx) return;
  if (S.profileBarChart) { S.profileBarChart.destroy(); S.profileBarChart = null; }

  if (entries.length === 0) {
    wrap.innerHTML = `<p style="color:#52525b;font-size:.85rem">${t('analytics_no_profiles')}</p>`;
    return;
  }

  wrap.style.height = Math.max(120, entries.length * 36 + 20) + 'px';

  const bgColor = sc => sc >= 88 ? 'rgba(34,197,94,.7)' : sc >= 75 ? 'rgba(132,204,22,.7)'
                     : sc >= 60 ? 'rgba(234,179,8,.7)'  : sc >= 45 ? 'rgba(249,115,22,.7)' : 'rgba(239,68,68,.7)';

  S.profileBarChart = new Chart(ctx, {
    type: 'bar',
    data: {
      labels:   entries.map(e => e.name.length > 20 ? e.name.slice(0, 19) + '…' : e.name),
      datasets: [{ label: 'Ø Score', data: entries.map(e => e.avgScore),
                   backgroundColor: entries.map(e => bgColor(e.avgScore)), borderRadius: 4 }]
    },
    options: {
      indexAxis: 'y', responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { afterLabel: (c) => `${entries[c.dataIndex].count} Shots` } }
      },
      scales: {
        x: { min: 0, max: 100, ticks: { color: '#52525b', font: { size: 10 } }, grid: { color: 'rgba(63,63,70,.3)' } },
        y: { ticks: { color: '#a1a1aa', font: { size: 11 } }, grid: { display: false } }
      }
    }
  });
}
