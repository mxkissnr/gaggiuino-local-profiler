import { S } from '../state.js';
import { t } from '../i18n.js';
import { LOCALE_MAP, COFFEE_COUNTRIES, countryName, flagEmoji } from '../constants.js';
import { scoreClass } from '../utils.js';

// ── Analytics entry point ─────────────────────────────────────────────────
export function initAnalytics() {
  buildSummaryKpis();
  buildTrendChart();
  buildCalendar();
  buildPersonalBests();
  buildBeanStats();
  buildWorldMap();
  buildProfileChart();
  buildGrinderStats();
  buildDistribution();
  buildTimeOfDay();
}

// ── Helpers ───────────────────────────────────────────────────────────────
function calcLongestStreak(shots) {
  if (!shots.length) return 0;
  const days = [...new Set(shots.map(s => {
    const d = new Date(s.timestamp * 1000);
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  }))].sort();
  let max = 1, cur = 1;
  for (let i = 1; i < days.length; i++) {
    const diff = (new Date(days[i]) - new Date(days[i-1])) / 86400000;
    if (diff === 1) { max = Math.max(max, ++cur); } else cur = 1;
  }
  return max;
}

const _esc = s => s == null ? '' : String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
const _bgColor = sc => sc == null ? 'rgba(63,63,70,.5)'
  : sc >= 88 ? 'rgba(34,197,94,.7)' : sc >= 75 ? 'rgba(132,204,22,.7)'
  : sc >= 60 ? 'rgba(234,179,8,.7)'  : sc >= 45 ? 'rgba(249,115,22,.7)' : 'rgba(239,68,68,.7)';

// ── Summary KPIs ──────────────────────────────────────────────────────────
export function buildSummaryKpis() {
  const el = document.getElementById('summaryKpis');
  if (!el) return;

  const total   = S.shots.length;
  const scored  = S.shots.filter(s => window.calcShotScore && window.getShotData
    && window.calcShotScore(s, window.getShotData(s)) !== null);
  const avgScore = scored.length
    ? Math.round(scored.reduce((a, s) => a + window.calcShotScore(s, window.getShotData(s)), 0) / scored.length)
    : null;

  const totalG = S.shots.reduce((sum, s) => sum + (s.annotation?.dose || 0), 0);
  const totalCoffee = totalG >= 1000 ? (totalG / 1000).toFixed(1) + ' kg' : Math.round(totalG) + ' g';

  const _now = new Date();
  const weekStartMs = new Date(_now.getFullYear(), _now.getMonth(), _now.getDate() - (_now.getDay() + 6) % 7).getTime();
  const thisWeek = S.shots.filter(s => s.timestamp * 1000 >= weekStartMs).length;
  const streak   = calcLongestStreak(S.shots);

  const kpis = [
    { val: total,  lbl: t('analytics_total_shots') },
    { val: avgScore !== null ? avgScore : '—', lbl: t('analytics_avg_score'), cls: avgScore !== null ? scoreClass(avgScore) : '' },
    { val: total > 0 ? totalCoffee : '—', lbl: t('analytics_total_coffee') },
    { val: thisWeek, lbl: t('analytics_this_week') },
    { val: streak > 0 ? t('analytics_days', streak) : '—', lbl: t('analytics_streak') },
  ];
  el.innerHTML = kpis.map(k =>
    `<div class="kpi-tile"><div class="kpi-val ${k.cls||''}">${k.val}</div><div class="kpi-lbl">${k.lbl}</div></div>`
  ).join('');

  // Trend warning: check last 5 scored shots for declining trend
  const warnEl = document.getElementById('trendWarning');
  if (warnEl) {
    const recent = scored.slice(-5);
    if (recent.length >= 3 && window.calcShotScore && window.getShotData) {
      const recentScores = recent.map(s => window.calcShotScore(s, window.getShotData(s)));
      const n = recentScores.length;
      const xs = recentScores.map((_, i) => i);
      const xm = (n - 1) / 2;
      const ym = recentScores.reduce((a, b) => a + b, 0) / n;
      const slope = xs.reduce((s, x, i) => s + (x - xm) * (recentScores[i] - ym), 0) /
                    xs.reduce((s, x) => s + (x - xm) ** 2, 0);
      if (slope < -1.5) {
        const drop = Math.abs(slope).toFixed(1);
        warnEl.className = 'trend-warning';
        warnEl.textContent = t('analytics_trend_warning', n, drop);
        warnEl.style.display = '';
      } else {
        warnEl.style.display = 'none';
      }
    } else {
      warnEl.style.display = 'none';
    }
  }
}

// ── Personal Bests ────────────────────────────────────────────────────────
export function buildPersonalBests() {
  const el = document.getElementById('personalBests');
  if (!el) return;
  if (S.shots.length < 3) {
    el.innerHTML = `<p style="color:#52525b;font-size:.85rem">${t('analytics_no_bests')}</p>`;
    return;
  }

  let bestShot = null, bestScore = -1;
  for (const s of S.shots) {
    if (!window.calcShotScore || !window.getShotData) continue;
    const sc = window.calcShotScore(s, window.getShotData(s));
    if (sc !== null && sc > bestScore) { bestScore = sc; bestShot = s; }
  }

  const byBean    = {}, byProfile = {}, byDay = {};
  for (const s of S.shots) {
    const bean = s.annotation?.coffee;
    if (bean) byBean[bean] = (byBean[bean] || 0) + 1;
    const prof = s.profile?.name || s.profileName;
    if (prof) byProfile[prof] = (byProfile[prof] || 0) + 1;
    const key = new Date(s.timestamp * 1000).toISOString().slice(0, 10);
    byDay[key] = (byDay[key] || 0) + 1;
  }
  const favBean    = Object.entries(byBean).sort((a, b) => b[1] - a[1])[0];
  const favProfile = Object.entries(byProfile).sort((a, b) => b[1] - a[1])[0];
  const busiestDay = Object.entries(byDay).sort((a, b) => b[1] - a[1])[0];
  const streak     = calcLongestStreak(S.shots);
  const locale     = LOCALE_MAP[S.currentLang] || 'de-DE';

  const rows = [];
  if (bestShot) {
    const d  = new Date(bestShot.timestamp * 1000).toLocaleDateString(locale, { day: '2-digit', month: '2-digit', year: 'numeric' });
    rows.push({ lbl: t('analytics_best_shot'),
      val: `<span class="${scoreClass(bestScore)}">${bestScore}</span> · ${d}`,
      link: bestShot.id });
  }
  if (streak > 0) rows.push({ lbl: t('analytics_longest_streak'), val: t('analytics_days', streak) });
  if (favBean)    rows.push({ lbl: t('analytics_fav_bean'),    val: `${_esc(favBean[0])} <span class="bests-count">${favBean[1]} ${t('bean_stat_shots')}</span>` });
  if (favProfile) rows.push({ lbl: t('analytics_fav_profile'), val: `${_esc(favProfile[0])} <span class="bests-count">${favProfile[1]} ${t('bean_stat_shots')}</span>` });
  if (busiestDay) {
    const d = new Date(busiestDay[0]).toLocaleDateString(locale, { day: '2-digit', month: '2-digit', year: 'numeric' });
    rows.push({ lbl: t('analytics_busiest_day'), val: `${d} <span class="bests-count">${busiestDay[1]} ${t('bean_stat_shots')}</span>` });
  }

  el.innerHTML = `<div class="bests-list">${rows.map(r =>
    `<div class="bests-row"><span class="bests-lbl">${r.lbl}</span><span class="bests-val">${r.val}${
      r.link ? ` <button class="bests-link" data-action="goto-shot" data-id="${r.link}">→</button>` : ''}</span></div>`
  ).join('')}</div>`;
}

// ── Grinder Stats ─────────────────────────────────────────────────────────
export function buildGrinderStats() {
  const el = document.getElementById('grinderStats');
  if (!el) return;
  const byGrinder = {};
  for (const s of S.shots) {
    const name = s.annotation?.grinder;
    if (!name) continue;
    if (!byGrinder[name]) byGrinder[name] = { count: 0, scores: [], durations: [] };
    byGrinder[name].count++;
    if (window.calcShotScore && window.getShotData) {
      const sc = window.calcShotScore(s, window.getShotData(s));
      if (sc !== null) byGrinder[name].scores.push(sc);
    }
    const dur = (s.duration || 0) / 10;
    if (dur > 5) byGrinder[name].durations.push(dur);
  }
  const grinders = Object.entries(byGrinder).sort((a, b) => b[1].count - a[1].count);
  if (grinders.length === 0) {
    el.innerHTML = `<p style="color:#52525b;font-size:.85rem">${t('analytics_no_grinders')}</p>`;
    return;
  }
  let html = '<div class="bean-cards">';
  for (const [name, d] of grinders) {
    const avgSc  = d.scores.length    ? Math.round(d.scores.reduce((a, b) => a + b, 0) / d.scores.length) : null;
    const bestSc = d.scores.length    ? Math.max(...d.scores) : null;
    const avgDur = d.durations.length ? (d.durations.reduce((a, b) => a + b, 0) / d.durations.length).toFixed(1) : null;
    html += `<div class="bean-card">
      <div class="bean-card-name" title="${_esc(name)}">${_esc(name)}</div>
      <div class="bean-card-stats">
        <div class="bean-stat"><span class="bean-stat-val">${d.count}</span><span class="bean-stat-lbl">${t('bean_stat_shots')}</span></div>
        ${avgSc  !== null ? `<div class="bean-stat"><span class="bean-stat-val ${scoreClass(avgSc)}">${avgSc}</span><span class="bean-stat-lbl">${t('bean_stat_avg')}</span></div>` : ''}
        ${bestSc !== null ? `<div class="bean-stat"><span class="bean-stat-val">${bestSc}</span><span class="bean-stat-lbl">${t('bean_stat_best')}</span></div>` : ''}
        ${avgDur !== null ? `<div class="bean-stat"><span class="bean-stat-val">${avgDur}s</span><span class="bean-stat-lbl">${t('bean_stat_duration')}</span></div>` : ''}
      </div>
    </div>`;
  }
  el.innerHTML = html + '</div>';
}

// ── Distributions ─────────────────────────────────────────────────────────
export function buildDistribution() {
  _buildDoseDist();
  _buildRatioDist();
}

function _buildDoseDist() {
  const ctx = document.getElementById('doseDistChart');
  if (!ctx) return;
  if (S.doseDistChart) { S.doseDistChart.destroy(); S.doseDistChart = null; }
  const doses = S.shots.map(s => s.annotation?.dose).filter(d => d != null && d > 5 && d < 50);
  if (doses.length < 5) {
    ctx.parentElement.innerHTML = `<p style="color:#52525b;font-size:.85rem;padding-top:8px">${t('analytics_no_distribution')}</p>`;
    return;
  }
  const lo = Math.floor(Math.min(...doses) * 2) / 2;
  const hi = Math.ceil(Math.max(...doses) * 2) / 2;
  const buckets = {};
  for (let b = lo; b <= hi + 0.001; b += 0.5) buckets[b.toFixed(1)] = 0;
  for (const d of doses) { const k = (Math.floor(d * 2) / 2).toFixed(1); if (k in buckets) buckets[k]++; }
  S.doseDistChart = new Chart(ctx, {
    type: 'bar',
    data: { labels: Object.keys(buckets).map(k => k + 'g'),
            datasets: [{ data: Object.values(buckets), backgroundColor: 'rgba(239,68,68,.6)', borderRadius: 3, borderSkipped: false }] },
    options: { responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        x: { ticks: { color: '#52525b', font: { size: 10 } }, grid: { display: false } },
        y: { ticks: { color: '#52525b', font: { size: 10 }, precision: 0 }, grid: { color: 'rgba(63,63,70,.3)' } }
      }
    }
  });
}

function _buildRatioDist() {
  const ctx = document.getElementById('ratioDistChart');
  if (!ctx) return;
  if (S.ratioDistChart) { S.ratioDistChart.destroy(); S.ratioDistChart = null; }
  const ratios = S.shots
    .map(s => s.annotation?.dose && s.weight ? (s.weight / 10) / s.annotation.dose : null)
    .filter(r => r != null && r > 1 && r < 4);
  if (ratios.length < 5) {
    ctx.parentElement.innerHTML = `<p style="color:#52525b;font-size:.85rem;padding-top:8px">${t('analytics_no_distribution')}</p>`;
    return;
  }
  const lo = Math.floor(Math.min(...ratios) * 10) / 10;
  const hi = Math.ceil(Math.max(...ratios) * 10) / 10;
  const buckets = {};
  for (let b = lo; b <= hi + 0.001; b += 0.1) buckets[b.toFixed(1)] = 0;
  for (const r of ratios) { const k = (Math.floor(r * 10) / 10).toFixed(1); if (k in buckets) buckets[k]++; }
  S.ratioDistChart = new Chart(ctx, {
    type: 'bar',
    data: { labels: Object.keys(buckets).map(k => '1:' + k),
            datasets: [{ data: Object.values(buckets), backgroundColor: 'rgba(132,204,22,.6)', borderRadius: 3, borderSkipped: false }] },
    options: { responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        x: { ticks: { color: '#52525b', font: { size: 10 } }, grid: { display: false } },
        y: { ticks: { color: '#52525b', font: { size: 10 }, precision: 0 }, grid: { color: 'rgba(63,63,70,.3)' } }
      }
    }
  });
}

// ── Time of Day ───────────────────────────────────────────────────────────
export function buildTimeOfDay() {
  const ctx = document.getElementById('timeOfDayChart');
  if (!ctx) return;
  if (S.timeOfDayChart) { S.timeOfDayChart.destroy(); S.timeOfDayChart = null; }
  const hours = Array.from({ length: 24 }, () => ({ count: 0, scores: [] }));
  for (const s of S.shots) {
    const h = new Date(s.timestamp * 1000).getHours();
    hours[h].count++;
    if (window.calcShotScore && window.getShotData) {
      const sc = window.calcShotScore(s, window.getShotData(s));
      if (sc !== null) hours[h].scores.push(sc);
    }
  }
  if (!hours.some(h => h.count > 0)) {
    ctx.parentElement.innerHTML = `<p style="color:#52525b;font-size:.85rem;padding-top:8px">${t('analytics_no_time')}</p>`;
    return;
  }
  const avgSc = h => h.scores.length ? Math.round(h.scores.reduce((a, b) => a + b, 0) / h.scores.length) : null;
  S.timeOfDayChart = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: hours.map((_, i) => String(i).padStart(2, '0') + ':00'),
      datasets: [{ data: hours.map(h => h.count), backgroundColor: hours.map(h => _bgColor(avgSc(h))), borderRadius: 3, borderSkipped: false }]
    },
    options: { responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false },
        tooltip: { callbacks: { label: c => {
          const h = hours[c.dataIndex], sc = avgSc(h);
          return `${c.parsed.y} Shot${c.parsed.y !== 1 ? 's' : ''}${sc !== null ? ' · Ø ' + sc : ''}`;
        }}}
      },
      scales: {
        x: { ticks: { color: '#52525b', font: { size: 9 }, maxRotation: 0 }, grid: { display: false } },
        y: { ticks: { color: '#52525b', font: { size: 10 }, precision: 0 }, grid: { color: 'rgba(63,63,70,.3)' } }
      }
    }
  });
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
      html += `<div class="${isFuture ? 'cal-future' : cls(day.count)} cal-day${clickable ? ' cal-day-link' : ''}" style="${cellSz}" title="${title}"${clickable ? ` data-action="goto-shot" data-id="${day.lastId}"` : ''}></div>`;
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
    if (!byBean[name]) byBean[name] = { count: 0, scores: [], durations: [], dialinShot: null };
    byBean[name].count++;
    if (window.calcShotScore && window.getShotData) {
      const sc = window.calcShotScore(s, window.getShotData(s));
      if (sc !== null) {
        byBean[name].scores.push(sc);
        if (byBean[name].dialinShot === null && sc >= 80)
          byBean[name].dialinShot = byBean[name].count;
      }
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
      ${d.dialinShot !== null ? `<div class="bean-stat-dialin">🎯 ${t('analytics_dialin', d.dialinShot)}</div>` : (d.scores.length >= 3 ? `<div class="bean-stat-dialin" style="color:#52525b">${t('analytics_dialin_none')}</div>` : '')}
    </div>`;
  }
  html += '</div>';
  el.innerHTML = html;
}

// ── Origin world map ──────────────────────────────────────────────────────
// Choropleth of coffee origins: shots are joined to library beans by name
// (case-insensitive, same precedent as the stock math) and colored by shot
// count; beans with an origin but no shots yet are still highlighted.
// chartjs-chart-geo comes from the CDN; the topojson is served locally
// (CSP connect-src 'self') and cached after the first Analytics visit.
let _worldTopo = null;
let _geoRegistered = false;

export async function buildWorldMap() {
  const wrap = document.getElementById('worldMapWrap');
  if (!wrap) return;

  // Offline HA hosts have no CDN: show the empty-state hint instead of crashing
  if (typeof ChartGeo === 'undefined') {
    wrap.innerHTML = `<p style="color:#52525b;font-size:.85rem">${t('analytics_map_empty')}</p>`;
    return;
  }
  if (!_geoRegistered) {
    Chart.register(ChartGeo.ChoroplethController, ChartGeo.GeoFeature, ChartGeo.ColorScale, ChartGeo.ProjectionScale);
    _geoRegistered = true;
  }

  // bean name (lowercased) → origin code, restricted to known coffee countries
  const nameToOrigin = new Map();
  for (const b of (S.coffeeLibrary.beans || [])) {
    if (b.origin && COFFEE_COUNTRIES.some(c => c.code === b.origin))
      nameToOrigin.set(String(b.name || '').toLowerCase(), b.origin);
  }

  // code → { shots, beans:Set } — beans with an origin count even without shots
  const byCode = {};
  for (const [name, code] of nameToOrigin) {
    if (!byCode[code]) byCode[code] = { shots: 0, beans: new Set() };
    byCode[code].beans.add(name);
  }
  for (const s of S.shots) {
    const code = nameToOrigin.get(String(s.annotation?.coffee || '').toLowerCase());
    if (code) byCode[code].shots++;
  }

  if (Object.keys(byCode).length === 0) {
    if (S.worldMapChart) { S.worldMapChart.destroy(); S.worldMapChart = null; }
    wrap.innerHTML = `<p style="color:#52525b;font-size:.85rem">${t('analytics_map_empty')}</p>`;
    return;
  }
  if (!wrap.querySelector('canvas')) wrap.innerHTML = '<canvas id="worldMapChart"></canvas>';

  if (!_worldTopo) {
    try { _worldTopo = await (await fetch('countries-110m.json')).json(); }
    catch {
      wrap.innerHTML = `<p style="color:#52525b;font-size:.85rem">${t('analytics_map_empty')}</p>`;
      return;
    }
  }

  const numToCode = new Map(COFFEE_COUNTRIES.map(c => [c.num, c.code]));
  const features  = ChartGeo.topojson.feature(_worldTopo, _worldTopo.objects.countries).features;
  const maxShots  = Math.max(1, ...Object.values(byCode).map(d => d.shots));
  const data = features.map(f => {
    const code = numToCode.get(String(f.id));
    const d    = code ? byCode[code] : null;
    // beans without shots get a visible floor so their country still lights up
    return { feature: f, value: d ? Math.max(d.shots, maxShots * 0.15) : 0, _code: code, _stats: d };
  });

  const ctx = document.getElementById('worldMapChart');
  if (S.worldMapChart) { S.worldMapChart.destroy(); S.worldMapChart = null; }

  S.worldMapChart = new Chart(ctx, {
    type: 'choropleth',
    data: {
      labels:   features.map(f => f.properties.name),
      datasets: [{
        data,
        borderColor: 'rgba(63,63,70,.8)',
        borderWidth: 0.5,
      }],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      showOutline: false, showGraticule: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          filter: item => !!item.raw?._stats,
          callbacks: {
            label: (c) => {
              const { _code, _stats } = c.raw;
              if (!_stats) return null;
              const name  = `${flagEmoji(_code)} ${countryName(_code, S.currentLang)}`.trim();
              const beans = [..._stats.beans].join(', ');
              return `${name}: ${_stats.shots} ${t('analytics_map_shots')} (${beans})`;
            },
          },
        },
      },
      scales: {
        projection: { axis: 'x', projection: 'equalEarth' },
        color: {
          axis: 'x', display: false,
          interpolate: v => v > 0 ? `rgba(34,197,94,${(0.2 + 0.6 * v).toFixed(2)})` : 'rgba(63,63,70,.35)',
        },
      },
    },
  });
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
