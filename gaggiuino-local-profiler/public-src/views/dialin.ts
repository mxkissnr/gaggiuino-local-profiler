// #1465: the Dial-In page in the Home Assistant page pattern (docs/DESIGN.md
// "Page anatomy"): one name, a sticky top app bar, filter chips, a verdict, one
// card of shot rows and one floating action button. Everything is a shared
// building block — `.settings-bar`/`.settings-group`/`.settings-row` for the bar
// and the rows, `analytics-verdict-*` for the verdict, `openDetailSheet` for the
// shot details, `_beanGroup()` for the bean grouping and `avgActive()` so the
// average pressure matches the shot page (CLAUDE.md regression rule b).
import { S } from '../state/index.js';
import { t, tHtml } from '../i18n.js';
import { localeFor } from '../constants.js';
import { avgActive, esc, formatDate, formatDelta, html, joinHtml, scoreClass, SCORE_STEPS } from '../utils.js';
import type { Html } from '../utils.js';
import { safeLocalStorage } from '../storage.js';
import { openDetailSheet } from '../components/detail-sheet.js';
import { COFFEE_ICON_SVG } from '../icons.js';
import { _miniShotChart, _parseGrindNum } from './shots/grind.js';
import type { GrindShot } from './shots/grind.js';
import { _beanGroup, _beans, _recentShots } from './analytics/shared.js';
import type { ShotAnnotation, ShotRow, SharedBean } from './analytics/shared.js';

// The bean choice lives in a module variable for the session only: no API and
// no stored-data change (#1465).
let _chosenBean: string | null = null;
let _lastShots: ShotRow[] = [];

export const DIALIN_ALL_BEANS = 'all';

export interface DialinBeanOption {
  key: string;
  label: string;
}

// One entry per bean group in first-seen order — `shots` is newest first, so the
// most recently used bean leads.
export function _dialinBeanOptions(shots: ShotRow[], beans: SharedBean[]): DialinBeanOption[] {
  const seen = new Map<string, string>();
  for (const shot of shots) {
    const group = _beanGroup(shot.annotation, beans);
    if (!group || seen.has(group.key)) continue;
    seen.set(group.key, group.label);
  }
  return [...seen.entries()].map(([key, label]) => ({ key, label }));
}

// The chosen bean while it still exists, else the newest shot's bean, else all.
export function _dialinBeanKey(
  chosen: string | null,
  options: DialinBeanOption[],
  newest: ShotRow | undefined,
  beans: SharedBean[],
): string {
  if (chosen === DIALIN_ALL_BEANS || options.some(o => o.key === chosen)) return chosen as string;
  const newestGroup = newest ? _beanGroup(newest.annotation, beans) : null;
  return newestGroup ? newestGroup.key : DIALIN_ALL_BEANS;
}

export function _dialinShots(shots: ShotRow[], key: string, n: number, beans: SharedBean[]): ShotRow[] {
  const filtered = key === DIALIN_ALL_BEANS
    ? shots
    : shots.filter(s => (_beanGroup(s.annotation, beans)?.key ?? '') === key);
  return filtered.slice(0, n);
}

export type DialinVerdictKind = 'dialled' | 'close' | 'off' | 'last';

export interface DialinVerdictState {
  kind: DialinVerdictKind;
  newest: number | null;
  trend: number | null;
  seq: number[];
}

// `scores` is newest first. No new thresholds: the shared score scale decides.
export function _dialinVerdictState(scores: (number | null)[], allBeans: boolean): DialinVerdictState {
  const scored = scores.filter((s): s is number => s != null);
  const newest = scored[0] ?? null;
  const lastThree = scored.slice(0, 3);
  // A "sequence" needs at least two values to read as one.
  const seq = lastThree.length >= 2 ? [...lastThree].reverse() : [];
  const oldest = seq[0];
  const trend = seq.length >= 2 && newest != null && oldest != null ? newest - oldest : null;

  let kind: DialinVerdictKind;
  if (allBeans || newest == null) kind = 'last';
  else if (scored.length >= 3 && lastThree.every(s => s >= SCORE_STEPS.great)) kind = 'dialled';
  else if (newest >= SCORE_STEPS.good) kind = 'close';
  else kind = 'off';

  return { kind, newest, trend, seq };
}

function _dialinBarHeight(score: number): number {
  return Math.round(Math.min(100, Math.max(8, (score - 40) * 100 / 60)));
}

// codeql[js/xss-through-dom] false positive: esc()/html already applied, see #760
export function _dialinVerdictHtml(state: DialinVerdictState, scores: (number | null)[], shown: number, facts: string): Html {
  let title: string;
  if (state.kind === 'dialled') title = t('dialin_verdict_dialled');
  else if (state.kind === 'close') title = t('dialin_verdict_close');
  else if (state.kind === 'off') title = t('dialin_verdict_off');
  else title = t('dialin_verdict_last', shown);

  const newest = state.newest;
  const trend = formatDelta(state.trend);
  return html`
    <div class="analytics-verdict-head">
      <div class="analytics-verdict-text">
        <h2 class="analytics-verdict-title">${esc(title)}</h2>
        ${state.seq.length >= 2 ? html`<p class="analytics-verdict-sub">${esc(t('dialin_verdict_seq', state.seq.join(' → '), state.seq.length))}</p>` : html``}
        ${facts ? html`<p class="analytics-verdict-sub">${esc(facts)}</p>` : html``}
      </div>
      <div class="analytics-verdict-score">
        <span class="analytics-verdict-score-num serif-display${newest != null ? html` ${esc(scoreClass(newest))}` : html``}">${esc(newest ?? '–')}</span>
        ${trend ? html`<span class="analytics-verdict-score-lbl">${esc(trend)}</span>` : html``}
      </div>
    </div>
    <div class="dialin-score-bars" aria-hidden="true">${joinHtml([...scores].reverse().map(s => s == null
      ? html`<i class="dialin-bar-none" style="height:8%"></i>`
      : html`<i class="${esc(scoreClass(s))}" style="height:${esc(_dialinBarHeight(s))}%"></i>`))}</div>`;
}

// The grind arrow only means something within one grinder's own scale.
function _dialinGrindArrow(shot: ShotRow, older: ShotRow | undefined): Html {
  if (!older) return html``;
  const grind = _parseGrindNum(shot.annotation?.grindSetting);
  const olderGrind = _parseGrindNum(older.annotation?.grindSetting);
  const grinder = shot.annotation?.grinder || '';
  const olderGrinder = older.annotation?.grinder || '';
  if (grind == null || olderGrind == null || grinder !== olderGrinder) return html``;
  if (grind < olderGrind) return html`<span class="dialin-grind-dir" aria-hidden="true">↓</span>`;
  if (grind > olderGrind) return html`<span class="dialin-grind-dir" aria-hidden="true">↑</span>`;
  return html``;
}

// codeql[js/xss-through-dom] false positive: esc()/html already applied, see #760
export function _dialinRowHtml(shot: ShotRow, older: ShotRow | undefined, score: number | null, extra: string[], locale: string): Html {
  const ann: ShotAnnotation = shot.annotation ?? {};
  const grind = _parseGrindNum(ann.grindSetting);

  const doseNum = parseFloat(String(ann.dose ?? ''));
  const dose = Number.isFinite(doseNum) && doseNum > 0 ? doseNum : null;
  const yieldNum = shot.weight != null ? shot.weight / 10 : null;
  const title = dose != null && yieldNum != null
    ? `${String(dose)} → ${yieldNum.toFixed(1)} g · 1:${(yieldNum / dose).toFixed(1)}`
    : yieldNum != null ? `${yieldNum.toFixed(1)} g` : '–';

  const sub: string[] = [formatDate(shot.timestamp * 1000, locale, 'short', true)];
  if (shot.duration) sub.push(`${(shot.duration / 10).toFixed(0)} s`);
  const pressure = avgActive((window.getShotDataById?.(shot.id)?.pressure ?? []).map(pt => pt.y), 1.5);
  if (pressure != null) sub.push(`${pressure.toFixed(1)} bar`);
  sub.push(...extra);

  return html`
    <button type="button" class="settings-row dialin-row" data-action="open-dialin-shot" data-id="${esc(shot.id)}" aria-haspopup="dialog">
      <span class="settings-row-icon dialin-grind">${esc(grind ?? '–')}${_dialinGrindArrow(shot, older)}</span>
      <span class="settings-row-text">
        <span class="settings-row-title">${esc(title)}</span>
        <span class="settings-row-sub">${esc(sub.join(' · '))}</span>
      </span>
      <span class="settings-row-value dialin-score${score != null ? html` ${esc(scoreClass(score))}` : html``}">${esc(score ?? '–')}</span>
      <span class="settings-chev" aria-hidden="true"></span>
    </button>`;
}

// The value every shown shot agrees on — '' when they disagree or it is empty.
function _sharedValue(values: string[]): string {
  const first = values[0];
  return first && values.every(v => v === first) ? first : '';
}

export async function renderDialin(): Promise<void> {
  const select = document.getElementById('dialinCount') as HTMLSelectElement | null;
  const saved  = safeLocalStorage.getItem('glp_dialin_count');
  if (select && saved && select.value !== saved) select.value = saved;

  const n    = parseInt(select?.value || '5', 10);
  const grid = document.getElementById('dialinGrid');
  if (!grid) return;

  const beans = _beans();
  const all = _recentShots();

  const options = _dialinBeanOptions(all, beans);
  const key = _dialinBeanKey(_chosenBean, options, all[0], beans);

  const beanSelect = document.getElementById('dialinBeanSelect') as HTMLSelectElement | null;
  if (beanSelect) {
    // codeql[js/xss-through-dom] false positive: esc()/html already applied, see #760
    beanSelect.innerHTML = joinHtml([
      html`<option value="${esc(DIALIN_ALL_BEANS)}">${tHtml('dialin_all_beans')}</option>`,
      ...options.map(o => html`<option value="${esc(o.key)}">${esc(o.label)}</option>`),
    ]);
    beanSelect.value = key;
  }

  const shots = _dialinShots(all, key, n, beans);
  _lastShots = shots;

  if (shots.length === 0) {
    // #1962: same three reasons as analytics — failed, still loading, or truly empty.
    const emptyKey = S.shotsLoadFailed ? 'error_load' : !S.allShotsLoaded ? 'loading' : 'empty_title';
    grid.innerHTML = html`<div class="dialin-empty">${tHtml(emptyKey)}</div>`;
    const emptyVerdict = document.getElementById('dialinVerdict');
    if (emptyVerdict) emptyVerdict.hidden = true;
    return;
  }

  const locale = localeFor(S.currentLang);

  // #957: curves are lazy per shot — fetch the handful this grid shows first.
  if (window.ensureCurves) await window.ensureCurves(shots.map(s => s.id));

  const scores = shots.map(s => (window.calcShotScore ? window.calcShotScore(s) : null));

  const allBeans = key === DIALIN_ALL_BEANS;
  const profileOf = (s: ShotRow): string => s.profile?.name || s.profileName || '';
  const beanOf = (s: ShotRow): string => _beanGroup(s.annotation, beans)?.label || s.annotation?.coffee || '';
  const grinderOf = (s: ShotRow): string => s.annotation?.grinder || '';

  // A bean the reader already picked shows in the dropdown, not in the facts.
  const sharedProfile = _sharedValue(shots.map(profileOf));
  const sharedBean    = _sharedValue(shots.map(beanOf));
  const sharedGrinder = _sharedValue(shots.map(grinderOf));
  const facts = [sharedProfile, allBeans ? sharedBean : '', sharedGrinder].filter(Boolean).join(' · ');

  const verdict = document.getElementById('dialinVerdict');
  if (verdict) {
    // codeql[js/xss-through-dom] false positive: esc()/html already applied, see #760
    verdict.innerHTML = _dialinVerdictHtml(_dialinVerdictState(scores, allBeans), scores, shots.length, facts);
    verdict.hidden = false;
  }

  // codeql[js/xss-through-dom] false positive: esc()/html already applied, see #760
  grid.innerHTML = joinHtml(shots.map((s, i) => {
    const extra = [
      sharedProfile ? '' : profileOf(s),
      allBeans && !sharedBean ? beanOf(s) : '',
      sharedGrinder ? '' : grinderOf(s),
    ].filter(Boolean);
    return _dialinRowHtml(s, shots[i + 1], scores[i] ?? null, extra, locale);
  }));
}

export function setDialinBean(key: string): void {
  _chosenBean = key;
  void renderDialin();
}

export function openDialinShot(id: number, anchor: HTMLElement | null): void {
  const shot = _lastShots.find(s => s.id === id);
  if (!shot) return;
  const locale = localeFor(S.currentLang);
  const parts = [
    shot.profile?.name || shot.profileName || '',
    _beanGroup(shot.annotation, _beans())?.label || shot.annotation?.coffee || '',
    shot.annotation?.grinder || '',
  ].filter(Boolean);

  openDetailSheet({
    title: formatDate(shot.timestamp * 1000, locale, 'short', true),
    ...(parts.length ? { sub: parts.join(' · ') } : {}),
    body: html`<div class="dialin-sheet-chart">${_miniShotChart(shot as unknown as GrindShot)}</div>`,
    actions: html`<button type="button" class="lib-sheet-iconbtn" data-action="dialin-goto-shot" data-id="${esc(shot.id)}" aria-label="${tHtml('dialin_wizard_goto_shot')}" title="${tHtml('dialin_wizard_goto_shot')}">${COFFEE_ICON_SVG}</button>`,
    anchor,
  });
}
