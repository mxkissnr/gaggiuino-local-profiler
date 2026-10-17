import { t, tHtml } from '../../i18n.js';
import { esc, html, joinHtml, scoreClass, scoreColor } from '../../utils.js';
import type { Html } from '../../utils.js';
import { openDetailSheet } from '../../components/detail-sheet.js';
import { shelfBagImage } from '../library/shelf.js';
import type { ShelfBagImageBean } from '../library/shelf.js';
import { loadBeanImageBlobUrl } from '../../bean-image.js';
import { _beanGroup, _beans, _counterText, _pageShots } from './shared.js';
import type { SharedBean, ShotRow } from './shared.js';

// One bean's aggregate for the "Beans by score" shelf (#1467) and its detail
// sheet.
interface BeanRankRow {
  name: string;
  // The most recent shot's annotation.beanId, or null when it carried none.
  beanId: number | null;
  shots: number;
  avgScore: number | null;
  best: number | null;
  hundreds: number;
  avgTime: number | null;
  firstGood: number | null;
  lastGrind: string | number | null | undefined;
  trend: number | null;
}

// ── Beans by score (#1467) ──────────────────────────────────────────────────
// One shelf of beans, sorted by average score (or shot count), each tile a
// tap away from the bean's detail sheet. Pure aggregation kept separate from
// rendering (unit-testable without a DOM).
export function _computeBeanRanking(shots: ShotRow[]): BeanRankRow[] {
  const beans = _beans();
  const byBean = new Map<string, { label: string; beanId: number | null; shots: ShotRow[] }>();
  for (const s of shots) {
    const group = _beanGroup(s.annotation, beans);
    if (!group) continue;
    let entry = byBean.get(group.key);
    if (!entry) { entry = { label: group.label, beanId: group.beanId, shots: [] }; byBean.set(group.key, entry); }
    entry.shots.push(s);
  }

  const rows: BeanRankRow[] = [];
  for (const group of byBean.values()) {
    const beanShots = group.shots;
    const name = group.label;
    const sorted = [...beanShots].sort((a, b) => a.timestamp - b.timestamp);
    const scored = sorted
      .map(s => ({ s, sc: window.calcShotScore ? window.calcShotScore(s) : null }))
      .filter((x): x is { s: ShotRow; sc: number } => x.sc !== null);
    const avgScore = scored.length ? Math.round(scored.reduce((a, x) => a + x.sc, 0) / scored.length) : null;
    const best = scored.length ? Math.max(...scored.map(x => x.sc)) : null;
    const hundreds = scored.reduce((a, x) => a + (x.sc >= 100 ? 1 : 0), 0);

    // The first shot (1-based, chronological) to reach 80 — the old dial-in
    // figure the bean cards reported.
    let firstGood: number | null = null;
    if (window.calcShotScore) {
      for (let i = 0; i < sorted.length; i++) {
        const shot = sorted[i];
        if (!shot) continue;
        const sc = window.calcShotScore(shot);
        if (sc !== null && sc >= 80) { firstGood = i + 1; break; }
      }
    }

    // Brew time in seconds from the ×10-scaled duration, ignoring the ≤ 5 s
    // noise of aborted shots.
    const times = sorted.map(s => (s.duration || 0) / 10).filter(d => d > 5);
    const avgTime = times.length ? Math.round((times.reduce((a, b) => a + b, 0) / times.length) * 10) / 10 : null;

    const lastShot = sorted[sorted.length - 1];
    const lastBeanId = lastShot?.annotation?.beanId;
    // A resolved (id-keyed) group already knows its bean; only an unresolved
    // group falls back to the most recent shot's beanId, as before.
    const beanId = group.beanId ?? (typeof lastBeanId === 'number' ? lastBeanId : null);

    const lastGrindShot = [...sorted].reverse().find(s => s.annotation?.grindSetting);
    const lastGrind = lastGrindShot ? lastGrindShot.annotation!.grindSetting : null;

    let trend = null;
    if (scored.length >= 4) {
      const last5 = scored.slice(-5);
      const prev5 = scored.slice(Math.max(0, scored.length - 10), scored.length - 5);
      if (prev5.length >= 2) {
        const avg = (arr: { s: ShotRow; sc: number }[]) => arr.reduce((a, x) => a + x.sc, 0) / arr.length;
        trend = Math.round((avg(last5) - avg(prev5)) * 10) / 10;
      }
    }

    rows.push({ name, beanId, shots: sorted.length, avgScore, best, hundreds, avgTime, firstGood, lastGrind, trend });
  }
  return rows;
}

// Sort rows for the shelf. Score: descending, nulls last, ties broken by shot
// count. Shots: descending, then the same score order.
export function _sortBeanShelfRows(rows: BeanRankRow[], key: 'score' | 'shots'): BeanRankRow[] {
  const scoreDesc = (a: BeanRankRow, b: BeanRankRow): number => {
    if (a.avgScore == null && b.avgScore == null) return b.shots - a.shots;
    if (a.avgScore == null) return 1;
    if (b.avgScore == null) return -1;
    return b.avgScore - a.avgScore || b.shots - a.shots;
  };
  const copy = [...rows];
  copy.sort(key === 'shots' ? (a, b) => b.shots - a.shots || scoreDesc(a, b) : scoreDesc);
  return copy;
}

// The library bean a shelf row belongs to: by the most recent shot's beanId
// first, else by case-insensitive name.
function _matchLibraryBean(row: BeanRankRow): SharedBean | null {
  const beans = _beans();
  if (row.beanId !== null) {
    const byId = beans.find(b => b.id === row.beanId);
    if (byId) return byId;
  }
  const name = row.name.toLowerCase();
  return beans.find(b => String(b.name || '').toLowerCase() === name) ?? null;
}

function _shelfImageBean(row: BeanRankRow, bean: SharedBean | null): ShelfBagImageBean {
  if (!bean) return { name: row.name };
  return {
    id: typeof bean.id === 'number' ? bean.id : null,
    name: bean.name,
    roaster: typeof bean.roaster === 'string' ? bean.roaster : null,
    image: typeof bean.image === 'string' ? bean.image : null,
  };
}

const _BEAN_SHELF_LIMIT = 16;
let _beanShelfSort: 'score' | 'shots' = 'score';
let _beanShelfColumnsWired = false;

// The shelf grid is 3 columns on phones and 8 from 900px up. Showing a
// partial last row leaves a lone tile on the second row, so the visible
// shelf carries only complete rows; the rest waits behind "show all".
function _beanShelfColumns(): number {
  return typeof window.matchMedia === 'function' && window.matchMedia('(min-width: 900px)').matches ? 8 : 3;
}

function _beanShelfHeadCount(total: number): number {
  const columns = _beanShelfColumns();
  const cap = Math.min(_BEAN_SHELF_LIMIT, total);
  if (cap < columns) return cap; // fewer beans than one row: show them all
  return Math.floor(cap / columns) * columns;
}

// Re-render when the grid crosses the 900px 3→8 column breakpoint.
function _watchBeanShelfColumns(): void {
  if (_beanShelfColumnsWired || typeof window.matchMedia !== 'function') return;
  _beanShelfColumnsWired = true;
  window.matchMedia('(min-width: 900px)').addEventListener('change', () => buildBeanShelf());
}

// Bean photos need the auth token, so <img src> can't point at the API
// (see bean-image.js). Load them directly here rather than through
// views/library.js, whose loadBeanThumbnails would pull in the whole
// Library module (and its lightbox) just to fill these tiles.
function _loadBeanShelfThumbnails(): void {
  document.querySelectorAll<HTMLImageElement>('#beanShelf .lib-shelf-img[data-bean-id]').forEach(img => {
    const id = Number(img.dataset.beanId);
    void loadBeanImageBlobUrl(id).then(url => { if (url) img.src = url; });
  });
}

function _beanShelfTile(row: BeanRankRow, rank: number): Html {
  const bean = _matchLibraryBean(row);
  const avg = row.avgScore;
  const score = avg !== null
    ? html`<span class="analytics-shelf-score" style="color:${esc(scoreColor(avg))}">${esc(avg)}</span>`
    : html`<span class="analytics-shelf-score">–</span>`;
  const crema = row.hundreds > 0
    ? html`<span class="analytics-shelf-crema" title="${esc(t('analytics_shelf_perfect'))}"></span>`
    : esc('');
  return html`<button type="button" class="analytics-shelf-tile" data-action="analytics-bean" data-name="${esc(row.name)}">
    <span class="analytics-shelf-rank${esc(rank <= 3 ? ' top' : '')}">${esc(rank)}</span>
    <span class="analytics-shelf-bag">${shelfBagImage(_shelfImageBean(row, bean))}</span>
    <span class="analytics-shelf-name serif-display">${esc(row.name)}</span>
    <span class="analytics-shelf-row2">${score}${crema}</span>
    <span class="analytics-shelf-shots">${esc(row.shots)} ${esc(t('analytics_unit_shots', row.shots))}</span>
  </button>`;
}

export function buildBeanShelf(): void {
  const el = document.getElementById('beanShelf');
  if (!el) return;
  _watchBeanShelfColumns();

  const rows = _sortBeanShelfRows(_computeBeanRanking(_pageShots()), _beanShelfSort);
  const countEl = document.getElementById('beanShelfCount');
  if (countEl) countEl.textContent = rows.length ? _counterText(t('analytics_counter_beans', rows.length)) : '';
  if (!rows.length) {
    el.innerHTML = html`<p class="empty-note">${tHtml('analytics_no_beans')}</p>`;
    return;
  }

  const total = rows.length;
  const headCount = _beanShelfHeadCount(total);
  const head = rows.slice(0, headCount);
  const rest = rows.slice(headCount);
  el.innerHTML = html`
    <div class="analytics-shelf">${joinHtml(head.map((r, i) => _beanShelfTile(r, i + 1)))}</div>
    ${rest.length ? html`
      <div class="analytics-shelf analytics-shelf-rest" id="beanShelfRest" style="display:none">${joinHtml(rest.map((r, i) => _beanShelfTile(r, headCount + i + 1)))}</div>
      <button type="button" class="analytics-shelf-more" id="beanShelfMore" data-action="expand-bean-shelf">${tHtml('analytics_shelf_show_all', total)}</button>` : esc('')}`;

  _loadBeanShelfThumbnails();
}

export function setBeanShelfSort(key: 'score' | 'shots'): void {
  _beanShelfSort = key;
  document.querySelectorAll<HTMLElement>('[data-action="set-bean-shelf-sort"]').forEach(chip => {
    const on = chip.dataset.sort === key;
    chip.classList.toggle('active', on);
    chip.setAttribute('aria-pressed', on ? 'true' : 'false');
  });
  buildBeanShelf();
}

export function expandBeanShelf(): void {
  const rest = document.getElementById('beanShelfRest');
  if (rest) rest.style.display = '';
  document.getElementById('beanShelfMore')?.remove();
}

// Detail sheet for one bean on the shelf: its numbers, its dial-in figure and
// trend — and, when the bean exists in the library, a shortcut to its sheet.
export function openBeanShelfDetail(name: string, anchor: HTMLElement | null): void {
  const row = _computeBeanRanking(_pageShots()).find(r => r.name === name);
  if (!row) return;
  const bean = _matchLibraryBean(row);
  const line = (lbl: string, val: Html): Html =>
    html`<div class="bests-row"><span class="bests-lbl">${esc(lbl)}</span><span class="bests-val">${val}</span></div>`;

  const parts: Html[] = [line(t('bean_stat_shots'), esc(row.shots))];
  if (row.avgScore !== null) parts.push(line(t('bean_stat_avg'), html`<span class="${esc(scoreClass(row.avgScore))}">${esc(row.avgScore)}</span>`));
  if (row.best !== null) parts.push(line(t('bean_stat_best'), html`<span class="${esc(scoreClass(row.best))}">${esc(row.best)}</span>`));
  if (row.hundreds > 0) parts.push(line(t('analytics_shelf_perfect'), esc(row.hundreds)));
  if (row.avgTime !== null) parts.push(line(t('bean_stat_duration'), esc(`${row.avgTime} s`)));
  if (row.lastGrind != null && row.lastGrind !== '') parts.push(line(t('ann_grind_setting'), esc(String(row.lastGrind))));
  if (row.firstGood !== null) parts.push(line(t('analytics_bean_dialed_in'), tHtml('analytics_bean_dialed_in_at', row.firstGood)));
  if (row.trend !== null) {
    const color = row.trend > 0 ? scoreColor(100) : row.trend < 0 ? scoreColor(0) : 'var(--gray-500)';
    const sign = row.trend > 0 ? '+' : '';
    parts.push(line(t('analytics_bean_rank_trend'), html`<span style="color:${esc(color)}">${esc(`${sign}${row.trend}`)}</span>`));
  }
  if (bean && typeof bean.id === 'number') {
    parts.push(html`<div class="bests-row"><span class="bests-lbl"></span><span class="bests-val"><button type="button" class="bests-link" data-action="open-bean-shelf-in-library" data-id="${esc(bean.id)}">${tHtml('analytics_open_in_library')}</button></span></div>`);
  }

  const roaster = bean && typeof bean.roaster === 'string' ? bean.roaster : '';
  openDetailSheet({
    title: row.name,
    sub: roaster,
    body: html`<div class="detail-rows">${joinHtml(parts)}</div>`,
    anchor,
  });
}
