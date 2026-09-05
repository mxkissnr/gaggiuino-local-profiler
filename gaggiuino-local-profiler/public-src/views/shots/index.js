import Chart from 'chart.js/auto';
import { S, filterShotsByMachine }                            from '../../state.js';
import { t }                                                  from '../../i18n.js';
import { apiFetch, isApiPortBlocked }                         from '../../api.js';
import { localeFor, phasePlugin, corsairPlugin, clearChartOnTouchEnd } from '../../constants.js';
import {
  esc, avg, avgActive, max, fmt, formatTimeLabel, formatDelta,
  stddev, detectPhases, detectChanneling, scoreClass, scoreColor, shareOrDownloadBlob,
  chartColors
} from '../../utils.js';
import { renderSidebar }                                      from '../../components/sidebar.js';
import { apiPortClosedHtml }                                  from '../../components/api-port-notice.js';
import { calcShotScore, shotUsedBeanTarget, findPreviousShot, buildGrinderGrindLabel } from './utils.js';
import { mapShotDatapoints } from '../../utils.js';
import { getShotCurve, ensureCurves, getRawCurve, getCachedShotData, evictCurve, primeCurve } from '../../shot-curves.js';
import { calcGrindAdvice, calcComparativeGrindAdvice, _miniShotChart } from './grind.js';
import { renderAnnotationPanel }                              from './annotation.js';
import { updatePQChart }                                      from './charts.js';
import { updateMachineBanner, updateOnboardingPanel }          from '../../components/onboarding.js';
import { GEAR_ICON_SVG, COFFEE_ICON_SVG, TARGET_ICON_SVG }    from '../../icons.js';
import { loadShotImageBlobUrl }                               from '../../bean-image.js';
import { openLightbox }                                       from '../../components/lightbox.js';

// ── Data loading ──────────────────────────────────────────────────────────

// Guards against overlapping calls (loadData() is fired unawaited from at
// least 6 independent triggers — main.js init, the reload-data button, live.js's
// post-brew setTimeout, status.js, sidebar.js, onboarding.js — with no
// coordination between them): a monotonic token is captured before the fetch
// and only the call that is still the latest one when its response lands is
// allowed to write state, same pattern as loadMachineProfileList() in
// library-profile-editor.js (#521, #644).
let _loadDataReqToken = 0;

// #635: baskets/puck screens are pure ID-based library selections (see
// annotation.js's _renderBasketSelect/_renderPuckScreenSelect) — this
// resolves an annotation's basketId/puckScreenId to the current library
// entry's name for display/export, the same way ann.coffee already carries
// the bean's name directly (no lookup needed there since beans store the
// name on the annotation itself).
export function _equipmentName(list, id) {
  if (id == null) return null;
  return (list || []).find(e => e.id === id)?.name || null;
}

// #957: GET /api/shots is keyset-paginated and metadata-only (no curve
// blobs). loadData() paints from page 1; loadAllShotMeta() then walks every
// following page in the background so S.allShots ends up holding the full
// shot-metadata history the non-visual consumers (analytics, dial-in
// wizards, per-machine counts, findPreviousShot) still expect. Curve data is
// fetched per shot on demand via shot-curves.js.
const SHOTS_PAGE_LIMIT = 60;

// #969: renderSidebar() rebuilds a DOM wrapper for every visible shot, so
// calling it after every page of loadAllShotMeta()'s background walk made a
// large history (e.g. 15k shots / 250 pages) effectively O(n^2) in render
// work. Rebuild at most once per this interval during the walk instead.
const RENDER_THROTTLE_MS = 400;

// #957: GET /api/shots is Go-only. The shared frontend also runs against the
// (frozen, bugfix-only) Node backend during the migration, which serves the
// old full /shots.json dump and no paginated route — so on a 404 we fall
// back to that dump, seeding the curve cache from the datapoints it carries
// so the lazy per-shot loader is a pure cache hit there. `trash` toggles the
// trashed list on either backend. Returns a normalised page:
// { shots: <newest-first, metadata-only>, nextCursor, hasMore }.
async function fetchShotsPage({ cursor = null, trash = false } = {}) {
  const params = new URLSearchParams({ limit: String(SHOTS_PAGE_LIMIT) });
  if (cursor) params.set('cursor', cursor);
  if (trash) params.set('trash', '1');

  const r = await apiFetch(`api/shots?${params}`);
  if (r.status === 404) {
    const fb = await apiFetch(trash ? 'shots.json?trash=1' : 'shots.json');
    if (!fb.ok) return { error: fb.status };
    const dump = await fb.json();               // full ASC array, datapoints inline
    const shots = Array.isArray(dump) ? dump : [];
    for (const s of shots) {
      if (s && s.datapoints) {
        // Seed the curve cache so the lazy per-shot loader is a pure cache
        // hit on Node. The row keeps its datapoints (Node's existing shape),
        // so the metadata-only readers just ignore the extra key.
        primeCurve(s.id, s.datapoints);
        s.hasChartData = (s.datapoints.timeInShot?.length || s.datapoints.pressure?.length || 0) > 0;
      }
    }
    shots.reverse();                            // normalise to newest-first
    return { shots, nextCursor: null, hasMore: false };
  }
  if (!r.ok) return { error: r.status };
  const page = await r.json();
  return { shots: page.shots || [], nextCursor: page.nextCursor ?? null, hasMore: !!page.hasMore };
}

export async function loadData() {
  const token = ++_loadDataReqToken;
  const shotsEl = document.getElementById('shots');
  shotsEl.innerHTML = `<div class="loading-state">${t('loading')}</div>`;

  let fetched;
  try {
    const page = await fetchShotsPage();
    if (token !== _loadDataReqToken) return;
    if (page.error != null) {
      // #807: Shots is the landing view, so a session that arrived on the
      // direct port with expose_api_port off sees this 401 before it ever
      // sees the Settings card that explains it. Everything needed to
      // explain it is already client-side (see isApiPortBlocked), so say it
      // here instead of showing a bare status code.
      shotsEl.innerHTML = isApiPortBlocked(page.error)
        ? apiPortClosedHtml()
        : `<div class="loading-state" style="color:#ef4444">HTTP ${page.error}</div>`;
      return;
    }
    fetched = [...page.shots].reverse(); // page is newest-first; keep S.allShots oldest-first
    S.shotsPageCursor = page.hasMore ? page.nextCursor : null;
    S.shotsHasMore    = !!page.hasMore;
    S.allShotsLoaded  = !page.hasMore;
  } catch {
    if (token !== _loadDataReqToken) return;
    shotsEl.innerHTML =
      // #814: was a hardcoded #ef4444 (the pre-redesign err value) and an
      // untranslated German string in an otherwise six-language app.
      `<div class="loading-state" style="color:var(--err)">${t('conn_error')}<br>` +
      // #814: was inline dark-theme neutrals (rgba(63,63,70,.5) fill, #a1a1aa
      // text, #3f3f46 border) that never inverted. .export-btn is the same
      // "fill, no persistent border" button this was hand-rolling.
      `<button data-action="reload-data" class="export-btn" style="margin-top:var(--sp-3)">${t('btn_reload')}</button></div>`;
    return;
  }

  // Multi-machine filtering (#325): S.allShots is the true unfiltered
  // fetch; S.shots (what every existing view already reads) becomes the
  // machine-filtered projection, re-derived whenever the active machine
  // changes (see applyActiveMachineChange() in components/machines-settings.js).
  S.allShots = fetched;
  S.shots = filterShotsByMachine(fetched, S.activeMachineId);
  renderSidebar();
  loadTrashData();

  const empty     = document.getElementById('empty-state');
  const chartArea = document.getElementById('chart-area');
  if (S.shots.length > 0) {
    empty.style.display     = 'none';
    chartArea.style.display = 'flex';
    const savedCompare = parseInt(localStorage.getItem('glp_compareShotId'));
    // #431: the mobile Shots tab now opens straight to a shot's detail (no
    // list step in between), so the initial selection needs to actually
    // honor the last-selected shot (persisted on every selection, see
    // selectShot()/the sidebar row click handler) rather than always
    // resetting to the newest one.
    const savedPrimary = parseInt(localStorage.getItem('glp_primaryShotId'));
    S.primaryShotId = (savedPrimary && S.shots.find(s => s.id === savedPrimary))
      ? savedPrimary
      : S.shots[S.shots.length - 1].id;
    if (savedCompare && S.shots.find(s => s.id === savedCompare) && savedCompare !== S.primaryShotId) {
      S.compareShotId = savedCompare;
    }
    updateView();
  } else {
    empty.style.display     = 'flex';
    chartArea.style.display = 'none';
  }
  updateOnboardingPanel();
  // Re-evaluate the machine-unreachable banner as soon as shots finish loading,
  // instead of waiting for the next 30s updateStatus() poll (#288).
  updateMachineBanner();

  // Background: pull every remaining page of shot metadata so S.allShots
  // holds the full history for analytics / dial-in wizards / per-machine
  // counts / findPreviousShot, without blocking first paint.
  loadAllShotMeta(token, S.shotsPageCursor);
}

// loadAllShotMeta walks api/shots page by page (oldest direction) from
// startCursor until the server reports no more, concatenating each page into
// S.allShots and re-deriving S.shots. Guarded by the same _loadDataReqToken
// as loadData, so a newer loadData() abandons a superseded walk. The loop is
// driven entirely by the local `cursor` (never re-read from S across an
// await), and every S write takes its value from the just-fetched page, so
// there is no read-then-write race on S.
let _metaWalkActive = false;

export async function loadAllShotMeta(token, startCursor) {
  if (_metaWalkActive) return;
  _metaWalkActive = true;
  let cursor = startCursor;
  let done = false;
  // #969: per-page state (S.allShots/S.shots/S.shotsPageCursor/S.shotsHasMore)
  // still updates every page — cheap. Only the DOM rebuild is throttled;
  // renderedSinceStart tracks whether the trailing render below has anything
  // new to paint at all (a superseded/errored walk that never got a page
  // shouldn't render).
  let lastRenderAt = 0;
  let renderedSinceStart = false;
  try {
    while (cursor && token === _loadDataReqToken) {
      let page;
      try {
        page = await fetchShotsPage({ cursor });
      } catch { return; }
      if (token !== _loadDataReqToken) return;
      if (page.error != null) break;

      // Each page is newest-first and older than everything already loaded —
      // reverse it to oldest-first and prepend.
      const merged = [...[...(page.shots || [])].reverse(), ...S.allShots];
      cursor = page.hasMore ? page.nextCursor : null;
      done = !page.hasMore;
      S.allShots        = merged;
      S.shots           = filterShotsByMachine(merged, S.activeMachineId);
      S.shotsPageCursor = cursor;
      S.shotsHasMore    = !!page.hasMore;
      renderedSinceStart = true;
      const now = Date.now();
      if (now - lastRenderAt >= RENDER_THROTTLE_MS) {
        renderSidebar();
        lastRenderAt = now;
      }
    }
    if (token === _loadDataReqToken && done) {
      S.shotsHasMore   = false;
      S.allShotsLoaded = true;
      // Analytics gates its builders on S.allShotsLoaded — let it re-run now
      // that the full history is in memory.
      window.onAllShotMetaLoaded?.();
    }
  } finally {
    // eslint-disable-next-line require-atomic-updates -- single-flight guard; last-writer-wins reset is correct once no walk is in flight (same pattern as status.js triggerSync)
    _metaWalkActive = false;
    // #969: a trailing render covers both the throttle window swallowing the
    // final page's paint, and the loop exiting early (superseded token or a
    // fetch error) after it already mutated S.allShots/S.shots — but only
    // when there's something new to show and this token is still current
    // (a loadData() that superseded this walk owns the next render instead).
    if (renderedSinceStart && token === _loadDataReqToken) renderSidebar();
  }
}

// loadMoreShots pulls the next page on demand (sidebar infinite scroll). No-op
// once the background walk has already loaded everything.
export async function loadMoreShots() {
  if (!S.shotsHasMore || !S.shotsPageCursor) return;
  await loadAllShotMeta(_loadDataReqToken, S.shotsPageCursor);
}

// ── Trash ─────────────────────────────────────────────────────────────────

export async function loadTrashData() {
  try {
    // The trash TTL is 30 days, so a single page is plenty in practice. On
    // the Node backend this falls back to shots.json?trash=1 (#957).
    const page = await fetchShotsPage({ trash: true });
    if (page.error != null) return;
    S.trashedShots = page.shots || [];
    renderTrash();
  } catch { /* ignore */ }
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
    // codeql[js/xss-through-dom] false positive: esc()/escapeHtml() already applied, see #760
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
    evictCurve(id);
    S.shots = S.shots.filter(s => s.id !== id);
    S.allShots = (S.allShots || []).filter(s => s.id !== id);
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
    evictCurve(id);
    S.trashedShots = S.trashedShots.filter(s => s.id !== id);
    renderTrash();
  } catch (e) {
    alert(t('error_generic', e.message));
  }
}

// ── Main view ─────────────────────────────────────────────────────────────

// Shared setter for the #402 delta-chip spans (verdict score + process-zone
// metrics): hides the chip entirely when there's nothing to compare against,
// never shows an empty pill.
function _setDeltaChip(id, delta, decimals = 0, unit = '', colorClass = null, title = '') {
  const el = document.getElementById(id);
  if (!el) return;
  if (delta == null) { el.style.display = 'none'; return; }
  el.textContent = formatDelta(delta, decimals, unit);
  el.className   = 'delta-chip' + (colorClass ? ` ${colorClass}` : '');
  el.title       = title;
  el.style.display = '';
}

let _updateViewToken = 0;

export async function updateView() {
  // #814: resolved per render, never at module load — the value has to be
  // whatever the ACTIVE theme resolves to right now.
  const C = chartColors();
  const shotA = S.shots.find(s => s.id === S.primaryShotId);
  const shotB = S.compareShotId ? S.shots.find(s => s.id === S.compareShotId) : null;
  if (!shotA) return;

  // Same-profile auto-compare (#402): most recent earlier shot with the same
  // profile on the same machine. Only meaningful outside A/B compare mode —
  // that feature stays untouched and unrelated to this same-profile pairing.
  const previousShot = !shotB ? findPreviousShot(S.shots, shotA) : null;

  // #957: curve data is lazy per shot now. Fetch the ones this render needs
  // (A, the B comparand, the previous same-profile shot for the ghost curve)
  // before building anything that reads a sample series. A newer updateView()
  // call supersedes this one via the token guard.
  const token = ++_updateViewToken;
  await ensureCurves([shotA.id, shotB && shotB.id, previousShot && previousShot.id].filter(Boolean));
  if (token !== _updateViewToken) return;

  const dA    = getCachedShotData(shotA.id) || mapShotDatapoints({});
  const dB    = shotB ? (getCachedShotData(shotB.id) || mapShotDatapoints({})) : null;
  const dPrev = previousShot ? (getCachedShotData(previousShot.id) || mapShotDatapoints({})) : null;
  const rawA  = getRawCurve(shotA.id) || {};
  const rawB  = shotB ? (getRawCurve(shotB.id) || {}) : {};

  const maxTempA = max((rawA.temperature || []).map(v => v / 10)) || 0;
  const maxTempB = shotB ? (max((rawB.temperature || []).map(v => v / 10)) || 0) : 0;
  const tempMaxScale = Math.ceil(Math.max(maxTempA, maxTempB) + 5) || 100;

  const nameA = shotA.profile?.name || shotA.profileName || t('profile_unknown');
  // Shot N always shows the machine's own native shot number (#359), never
  // the synthetic global id (machineId * 10,000,000 + nativeId) used
  // internally so multi-machine shots never collide — that raw id would be
  // confusing to show ("Shot 20000003") when the machine name is already
  // in the subtitle. nativeId falls back to id for older cached shots.
  if (shotB) {
    document.getElementById('topTitle').innerText = t('compare_title', shotA.nativeId ?? shotA.id, shotB.nativeId ?? shotB.id);
  } else {
    document.getElementById('topTitle').innerText = `${nameA} – Shot ${shotA.nativeId ?? shotA.id}`;
  }

  // machineSubtitle (#344): make it reflect the machine that actually owns
  // the shot being viewed, not the global default machine from status.js's
  // periodic poll — see that file's updateStatus() for the corresponding
  // guard (`!S.primaryShotId`) that keeps it from clobbering this back.
  // In compare mode there's no single "owning" machine worth naming, so it
  // shows the two profile names being compared instead (#398 dropped the
  // separate "Profil" meta row that used to carry this).
  const subtitleEl = document.getElementById('machineSubtitle');
  if (subtitleEl) {
    if (shotB) {
      const nameB = shotB.profile?.name || shotB.profileName || t('profile_unknown');
      subtitleEl.textContent = `${nameA} vs. ${nameB}`;
    } else {
      const machine = S.machines?.find(m => m.id === (shotA.machineId ?? 1));
      if (machine) subtitleEl.textContent = machine.host ? `${machine.name} · ${machine.host}` : machine.name;
    }
  }

  const totalSecs = (shotA.duration || 0) / 10;
  document.getElementById('duration').innerText = formatTimeLabel(totalSecs);

  const pressureVals  = dA.pressure.map(p => p.y);
  const pressureTimes = dA.pressure.map(p => p.x);
  const avgPressure   = avgActive(pressureVals, 1.5);
  document.getElementById('pressure').innerText       = fmt(avgPressure, ' bar');
  document.getElementById('targetPressure').innerText = ` / ${fmt(max(dA.targetPressure.map(p => p.y)), ' bar')}`;
  const avgFlow = avgActive(dA.flow.map(p => p.y), 0.2);
  document.getElementById('flow').innerText           = fmt(avgFlow, ' ml/s');
  document.getElementById('targetFlow').innerText     = ` / ${fmt(avgActive(dA.targetFlow.map(p => p.y), 0.2), ' ml/s')}`;

  const tempVals = dA.temp.map(p => p.y);
  const sdTemp   = stddev(tempVals);
  const avgTemp  = avg(tempVals);
  document.getElementById('temp').innerText             = fmt(avgTemp, ' °C');
  document.getElementById('tempStability').textContent  = (sdTemp != null && sdTemp < 5) ? `±${sdTemp.toFixed(1)}` : '';
  document.getElementById('targetTemp').innerText       = ` / ${fmt(avg(dA.targetTemp.map(p => p.y)), ' °C')}`;

  // Process-zone delta chips (#402): signed vs. the previous same-profile
  // shot's own average — no quality judgment implied, so no score coloring.
  if (dPrev) {
    const prevTitle = t('delta_vs_shot', previousShot.nativeId ?? previousShot.id);
    _setDeltaChip('pressureDeltaChip', avgPressure != null ? avgPressure - avgActive(dPrev.pressure.map(p => p.y), 1.5) : null, 1, ' bar', null, prevTitle);
    _setDeltaChip('flowDeltaChip',     avgFlow     != null ? avgFlow     - avgActive(dPrev.flow.map(p => p.y), 0.2)     : null, 1, ' ml/s', null, prevTitle);
    _setDeltaChip('tempDeltaChip',     avgTemp     != null ? avgTemp     - avg(dPrev.temp.map(p => p.y))                : null, 1, ' °C', null, prevTitle);
  } else {
    _setDeltaChip('pressureDeltaChip', null);
    _setDeltaChip('flowDeltaChip', null);
    _setDeltaChip('tempDeltaChip', null);
  }

  const finalWeight = max(dA.weight.map(p => p.y));
  const ann         = shotA.annotation || {};

  // Recipe zone (#398): dose -> yield + ratio (with EY as a sub-value) —
  // both derived from the same dose/finalWeight pair, so they share one
  // visibility condition (matches the old ratioItem/eyItem gating).
  const doseYieldCard = document.getElementById('doseYieldCard');
  const ratioCard     = document.getElementById('ratioCard');
  if (ann.dose && finalWeight && !shotB) {
    document.getElementById('doseYieldVal').textContent = `${fmt(parseFloat(ann.dose), ' g')} → ${fmt(finalWeight, ' g')}`;
    doseYieldCard.style.display = '';

    const r = (finalWeight / ann.dose).toFixed(1);
    document.getElementById('ratioVal').textContent = `1:${r}`;
    const eySub = document.getElementById('eySub');
    if (ann.tds) {
      const ey   = (finalWeight * ann.tds) / ann.dose;
      const eyOk = ey >= 18 && ey <= 22;
      eySub.textContent = `EY ${ey.toFixed(1)} %`;
      eySub.className   = 'recipe-card-sub ' + (eyOk ? 'score-great' : ey >= 16 && ey <= 24 ? 'score-ok' : 'score-bad');
    } else {
      eySub.textContent = '';
      eySub.className   = 'recipe-card-sub';
    }
    ratioCard.style.display = '';
  } else {
    doseYieldCard.style.display = 'none';
    ratioCard.style.display     = 'none';
  }

  // Bean + grinder + grind setting (#429) — the shot's own annotation,
  // shown regardless of compare mode. #838: when this is the newest shot for
  // its bean and a previous grind setting is on record, the baseline is
  // folded straight into this label ("Mahlgrad X (zuletzt Y)") instead of
  // a separate chip — one place to look instead of two.
  const grinderLabel = buildGrinderGrindLabel(S.shots, shotA, !shotB, t);
  document.getElementById('beanVal').textContent    = ann.coffee || '–';
  document.getElementById('grinderVal').textContent = grinderLabel || '–';

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

  // Shot photo (#448, #850): reuses the same image the annotation panel
  // uploads/shows (_renderShotPhoto() in annotation.js) — the small circular
  // thumb fills the empty space next to the machine/freshness line on
  // mobile, and the large hero panel (floated top-right of #chart-area)
  // fills the unused desktop space above the chart. Both show the same
  // photo, fetched once and shared; CSS (see .shot-hero-photo /
  // .shot-header-thumb) decides which one is visible per breakpoint.
  const photoThumbEl = document.getElementById('shotHeaderThumb');
  const heroPhotoEl  = document.getElementById('shotHeroPhoto');
  if (photoThumbEl || heroPhotoEl) {
    if (!shotB && shotA.image) {
      if (photoThumbEl) {
        photoThumbEl.style.display = '';
        photoThumbEl.onclick = () => { if (photoThumbEl.src) openLightbox(photoThumbEl.src); };
      }
      if (heroPhotoEl) {
        heroPhotoEl.classList.add('has-photo');
        heroPhotoEl.onclick = () => { if (heroPhotoEl.src) openLightbox(heroPhotoEl.src); };
      }
      loadShotImageBlobUrl(shotA.id).then(url => {
        if (!url) return;
        if (photoThumbEl) photoThumbEl.src = url;
        if (heroPhotoEl)  heroPhotoEl.src  = url;
      });
    } else {
      if (photoThumbEl) {
        photoThumbEl.style.display = 'none';
        photoThumbEl.removeAttribute('src');
        photoThumbEl.onclick = null;
      }
      if (heroPhotoEl) {
        heroPhotoEl.classList.remove('has-photo');
        heroPhotoEl.removeAttribute('src');
        heroPhotoEl.onclick = null;
      }
    }
  }

  // Phases -> a compact sub-line on the Recipe zone's duration card (#398).
  const phases    = !shotB ? detectPhases(pressureTimes, pressureVals) : null;
  const phasesSub = document.getElementById('phasesSub');
  phasesSub.textContent = phases
    ? `${t('phase_preinfusion')} ${formatTimeLabel(phases.preinfusion)} · ${t('phase_extraction')} ${formatTimeLabel(phases.extraction)}`
    : '';

  // Channeling
  const channeling = !shotB && detectChanneling(pressureTimes, pressureVals);
  document.getElementById('channelingWarning').style.display = channeling ? '' : 'none';

  // Verdict header (#398): score + the dial-in advice as one plain-language
  // line (#816: de-boxed — was a score badge beside a boxed advice line).
  const verdictHeader = document.getElementById('verdictHeader');
  if (!shotB) {
    const advice = calcGrindAdvice(shotA, dA);
    const sc     = calcShotScore(shotA, dA);
    // #813: the score ring is now type. A 58px conic-gradient ring is a badge
    // shape the redesign removes on both surfaces (the shot card did the same
    // in glp-lovelace-card#120) — the number itself, at display size and in
    // the score colour, carries the same information with none of the chrome.
    const ringVal  = document.getElementById('verdictRingVal');
    ringVal.style.setProperty('--ring-color', scoreColor(sc));
    ringVal.textContent = sc !== null ? sc : '–';

    // Score delta chip (#402): same-profile auto-compare, unified score
    // scale (#397) for the coloring — omitted entirely when there's no
    // previous same-profile shot or either score is unknown.
    const prevScore = previousShot ? previousShot.score : null;
    const verdictDeltaChip = document.getElementById('verdictDeltaChip');
    if (previousShot && sc != null && prevScore != null) {
      const scoreDelta = sc - prevScore;
      const cls = scoreDelta > 0 ? 'score-great' : scoreDelta < 0 ? 'score-bad' : 'score-ok';
      const vsShot = t('delta_vs_shot', previousShot.nativeId ?? previousShot.id);
      verdictDeltaChip.textContent = `${formatDelta(scoreDelta)} ${vsShot}`;
      verdictDeltaChip.className   = `delta-chip ${cls}`;
      verdictDeltaChip.style.display = '';
    } else {
      verdictDeltaChip.style.display = 'none';
    }

    // #457: compact hint icon when the score was weighed against the bean's
    // own brewTempC/brewRatio recommendation (#450) rather than the generic
    // fallback band — native title tooltip, no new permanent header text.
    const beanTargetHint = shotUsedBeanTarget(shotA)
      ? `<span class="verdict-bean-target-hint" title="${esc(t('verdict_bean_target_hint'))}">${TARGET_ICON_SVG}</span>` : '';
    document.getElementById('verdictHeadline').innerHTML = (advice ? `${advice.icon} ${esc(advice.text)}` : esc(t('verdict_no_data'))) + beanTargetHint;
    // #838: duration and avg pressure dropped — they're already shown once
    // each, in the Dauer recipe card (incl. phase breakdown) and the
    // Process-zone pressure card, so repeating them here was pure duplication.
    // #841: profile name + shot number (topTitle, one element above) and the
    // bean name (beanVal, in the recipe zone below) were the only
    // things left in this subline — both already shown elsewhere, so the
    // subline itself is retired (stays hidden, see index.html/style.css).
    verdictHeader.style.display = '';
  } else {
    verdictHeader.style.display = 'none';
  }

  const compEl  = document.getElementById('grindAdviceComparative');
  const compAdv = !shotB ? calcComparativeGrindAdvice(shotA, S.shots) : null;
  if (compEl) {
    if (compAdv) {
      const wasOpen = compEl.classList.contains('expanded');
      compEl.className = `grind-advice grind-comparative grind-${compAdv.type}${wasOpen ? ' expanded' : ''}`;
      document.getElementById('grindAdviceComparativeIcon').innerHTML = compAdv.icon;
      document.getElementById('grindAdviceComparativeText').textContent = compAdv.text;

      // #957: the comparative thumbnails each need their shot's curve — fetch
      // the handful (typically 1-8) before rendering; _miniShotChart falls
      // back to a no-data placeholder for any that are still missing.
      await ensureCurves(compAdv.shots.map(x => x.shot.id));
      if (token !== _updateViewToken) return;

      const locale   = localeFor(S.currentLang);
      const listHtml = compAdv.shots.map(({ shot: s, grind, score }) => {
        const date  = new Date(s.timestamp * 1000).toLocaleDateString(locale, { day: '2-digit', month: '2-digit' });
        const dur   = s.duration ? `${(s.duration / 10).toFixed(0)}s` : '';
        const cls   = scoreClass(score);
        const chart = _miniShotChart(s);
        return `<div class="comp-thumb" data-action="goto-shot" data-id="${s.id}" title="Shot ${s.id} — ${date}">
          <div class="comp-thumb-chart">${chart}</div>
          <div class="comp-thumb-meta">
            <span class="comp-shot-date">${date}</span>
            <span class="comp-shot-grind">${GEAR_ICON_SVG} ${grind}</span>
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
        `<span class="ann-ordered-by-label">${COFFEE_ICON_SVG} ${t('ann_ordered_by')}</span>` +
        `<span class="ann-ordered-by-val">${esc(ob.customer)}${drink ? ` · ${esc(drink)}` : ''}${ob.note ? ` · <em>${esc(ob.note)}</em>` : ''}</span>`;
      obEl.style.display = '';
    } else {
      obEl.style.display = 'none';
    }
  }

  renderAnnotationPanel(shotA);

  // Build main chart datasets
  const maxTimeA    = dA.rawTimes.length > 0 ? dA.rawTimes[dA.rawTimes.length - 1] : 0;
  const maxTimeB    = dB?.rawTimes.length > 0 ? dB.rawTimes[dB.rawTimes.length - 1] : 0;
  const maxTimePrev = dPrev?.rawTimes.length > 0 ? dPrev.rawTimes[dPrev.rawTimes.length - 1] : 0;

  const sfx = shotB ? ' (A)' : '';
  const datasets = [
    { label:t('chart_pressure')   + sfx, data: dA.pressure,  yAxisID:'y',  borderWidth:2.5, tension:.1, borderColor:'#3498db', backgroundColor:'transparent', pointStyle:false },
    { label:t('chart_flow')       + sfx, data: dA.flow,       yAxisID:'y',  borderWidth:2,   tension:.1, borderColor:'#f39c12', backgroundColor:'transparent', pointStyle:false },
    { label:t('chart_weightflow') + sfx, data: dA.weightFlow, yAxisID:'y',  borderWidth:2,   tension:.1, borderColor:'#9b59b6', backgroundColor:'transparent', pointStyle:false },
    { label:t(dA.weightIsReal ? 'chart_weight' : 'chart_weight_estimated') + sfx, data: dA.weight, yAxisID:'y1', borderWidth:2,   tension:.1, borderColor:'#2ecc71', backgroundColor:'transparent', pointStyle:false, ...(dA.weightIsReal ? {} : { borderDash:[5,5] }) },
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
      { label:t(dB.weightIsReal ? 'chart_weight' : 'chart_weight_estimated') + ' (B)', data: dB.weight, yAxisID:'y1', borderDash:[3,3], borderWidth:1.5, tension:.1, borderColor:'rgba(46,204,113,.65)',  backgroundColor:'transparent', pointStyle:false },
      { label:t('chart_temp')       + ' (B)', data: dB.temp,       yAxisID:'y1', borderDash:[3,3], borderWidth:2,   tension:.1, borderColor:'rgba(231,76,60,.65)',   backgroundColor:'transparent', pointStyle:false }
    );
  }

  // Ghost overlay (#402): previous same-profile shot's pressure/flow/weight
  // curves, dashed + low-opacity, feeding into the chart's existing legend
  // (dataset label carries the "(Shot N)" suffix so it's self-explanatory).
  if (dPrev) {
    const ghostSfx = t('chart_prev_suffix', previousShot.nativeId ?? previousShot.id);
    datasets.push(
      { label:t('chart_pressure') + ghostSfx, data: dPrev.pressure, yAxisID:'y',  borderDash:[2,3], borderWidth:1.5, tension:.1, borderColor:'rgba(52,152,219,.35)', backgroundColor:'transparent', pointStyle:false },
      { label:t('chart_flow')     + ghostSfx, data: dPrev.flow,     yAxisID:'y',  borderDash:[2,3], borderWidth:1.5, tension:.1, borderColor:'rgba(243,156,18,.35)', backgroundColor:'transparent', pointStyle:false },
      { label:t(dPrev.weightIsReal ? 'chart_weight' : 'chart_weight_estimated') + ghostSfx, data: dPrev.weight, yAxisID:'y1', borderDash:[2,3], borderWidth:1.5, tension:.1, borderColor:'rgba(46,204,113,.35)', backgroundColor:'transparent', pointStyle:false }
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
            labels: { color: C.text, font: { family: 'Figtree', size: window.innerWidth <= 600 ? 9 : 11 }, boxWidth: window.innerWidth <= 600 ? 8 : 12, padding: window.innerWidth <= 600 ? 4 : 8 }
          },
          tooltip: { callbacks: { title: ctx => t('chart_time', formatTimeLabel(ctx[0].parsed.x)) } }
        },
        scales: {
          x:  { type:'linear', min:0, max:Math.max(maxTimeA, maxTimeB, maxTimePrev), clip:false,
                ticks:{ color:C.tick, font:{family:'Figtree'}, stepSize:5, callback:v=>formatTimeLabel(v), maxTicksLimit: window.innerWidth <= 600 ? 6 : 12 },
                grid:{ color:C.grid } },
          y:  { type:'linear', position:'left',  min:0, max:12, ticks:{color:C.tick, maxTicksLimit:6}, grid:{color:C.grid} },
          y1: { type:'linear', position:'right', min:0, max:Number(tempMaxScale), ticks:{color:C.tick, maxTicksLimit:6}, grid:{drawOnChartArea:false} }
        }
      }
    });
    clearChartOnTouchEnd(S.chart);
  } catch (e) {
    console.error('Chart creation error:', e);
  }
}

// ── CSV Export ────────────────────────────────────────────────────────────

// d is the mapped XY curve bundle for this shot (from the curve cache) — the
// caller fetches it via getShotCurve() first, since list rows no longer carry
// datapoints (#957).
function shotToCSVRow(shot, d) {
  const ann    = shot.annotation || {};
  const avgP   = avgActive(d.pressure.map(p => p.y), 1.5);
  const finalW = max(d.weight.map(p => p.y));
  const avgT   = avg(d.temp.map(p => p.y));
  const secs   = ((shot.duration || 0) / 10).toFixed(1);
  const ratio  = (ann.dose && finalW) ? `1:${(finalW / ann.dose).toFixed(1)}` : '';
  const date   = new Date(shot.timestamp * 1000).toLocaleString(localeFor(S.currentLang));
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
    _equipmentName(S.coffeeLibrary?.baskets, ann.basketId) || '',
    _equipmentName(S.coffeeLibrary?.puckScreens, ann.puckScreenId) || '',
    (ann.notes || '').replace(/\n/g, ' ')
  ].map(v => `"${String(v).replace(/"/g, '""')}"`).join(',');
}

async function downloadCSV(rows, filename) {
  const header = ['Shot ID','Date','Profile','Duration (s)','Avg Pressure (bar)','Max Weight (g)',
                  'Dose (g)','Ratio','Avg Temp (C)','Rating','Coffee','Grinder','Grind Setting',
                  'Basket','Puck Screen','Notes'];
  const csv  = [header.join(','), ...rows].join('\r\n');
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' });
  await shareOrDownloadBlob(blob, filename, { title: t('export_csv_title') });
}

export async function exportCSV() {
  const shot = S.shots.find(s => s.id === S.primaryShotId);
  if (!shot) return;
  await getShotCurve(shot.id);
  const date    = new Date(shot.timestamp * 1000).toISOString().slice(0, 10);
  const profile = (shot.profile?.name || shot.profileName || 'shot').replace(/[^a-z0-9]/gi, '_');
  await downloadCSV([shotToCSVRow(shot, getCachedShotData(shot.id) || mapShotDatapoints({}))], `glp_shot_${date}_${profile}.csv`);
}

export async function exportAllCSV() {
  // Rare, explicit user action — pull every shot's curve (bounded concurrency
  // inside ensureCurves) before building the rows.
  const list = S.shots;
  await ensureCurves(list.map(s => s.id));
  await downloadCSV(list.map(s => shotToCSVRow(s, getCachedShotData(s.id) || mapShotDatapoints({}))), 'glp_all_shots.csv');
}

// ── .shot export ──────────────────────────────────────────────────────────

export async function exportShot() {
  const shot = S.shots.find(s => s.id === S.primaryShotId);
  if (!shot) return;
  const d   = await getShotCurve(shot.id);
  const ann = shot.annotation || {};
  const timeArr = d.timeInShot || [];

  const tcl = arr => arr?.length ? `{${arr.map(v => (v / 10).toFixed(2)).join(' ')}}` : '{}';

  const finalWeight = d.shotWeight || d.weight || [];
  const lastW = finalWeight.length ? (finalWeight[finalWeight.length - 1] / 10).toFixed(1) : '0.0';
  const date  = new Date(shot.timestamp * 1000).toISOString().replace('T', ' ').slice(0, 19);
  const basketName     = _equipmentName(S.coffeeLibrary?.baskets, ann.basketId);
  const puckScreenName = _equipmentName(S.coffeeLibrary?.puckScreens, ann.puckScreenId);

  const lines = [
    `clock ${shot.timestamp}`,
    `date ${date}`,
    `profile_title {${(shot.profile?.name || shot.profileName || 'Unknown').replace(/[{}]/g, '')}}`,
    ann.coffee       ? `bean_desc {${ann.coffee.replace(/[{}]/g, '')}}` : '',
    ann.grinder      ? `grinder_model {${ann.grinder.replace(/[{}]/g, '')}}` : '',
    ann.grindSetting ? `grinder_setting {${ann.grindSetting.replace(/[{}]/g, '')}}` : '',
    basketName       ? `basket {${basketName.replace(/[{}]/g, '')}}` : '',
    puckScreenName   ? `puck_screen {${puckScreenName.replace(/[{}]/g, '')}}` : '',
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

  await _downloadJSON_blob(lines, `shot_${shot.id}_${date.slice(0, 10)}.shot`, 'text/plain;charset=utf-8;');
}

// ── Profile export ────────────────────────────────────────────────────────

export async function exportProfile() {
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
    await _downloadJSON(out, (out.name || shot.profileName || `shot_${shot.id}`).replace(/[^a-z0-9_-]/gi, '_') + '.json');
    return;
  }

  const d    = await getShotCurve(shot.id);
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
  await _downloadJSON(out, (out.name).replace(/[^a-z0-9_-]/gi, '_') + '.json');
}

async function _downloadJSON(obj, filename) {
  await _downloadJSON_blob(JSON.stringify(obj, null, 2), filename, 'application/json');
}

async function _downloadJSON_blob(content, filename, mime) {
  const blob = new Blob([content], { type: mime });
  await shareOrDownloadBlob(blob, filename, { title: filename });
}

// ── Share card ────────────────────────────────────────────────────────────

export async function shareCard(format = 'square') {
  const shotId = S.primaryShotId;
  if (!shotId) return;
  try {
    // #462: the card should visually match whatever accent/theme the user
    // is actually looking at, not a hardcoded snapshot — same attributes
    // main.js applies to <html> (dataset.accent/dataset.theme), same
    // defaults ('amber'/'dark', see _applyTheme()/_savedAccent in main.js).
    const accent = document.documentElement.dataset.accent || 'amber';
    const theme  = document.documentElement.dataset.theme  || 'dark';
    const r = await apiFetch(`api/shots/${shotId}/card?format=${encodeURIComponent(format)}&accent=${encodeURIComponent(accent)}&theme=${encodeURIComponent(theme)}`);
    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      throw new Error(err.error || r.statusText);
    }
    const blob     = await r.blob();
    const filename = `glp-shot-${shotId}-${format}.png`;
    await shareOrDownloadBlob(blob, filename, { title: t('share_card_title'), fallbackOnError: false });
  } catch (e) {
    if (e.name !== 'AbortError') alert(t('error_generic', e.message));
  }
}

// ── Backup / Restore ──────────────────────────────────────────────────────

// Backup export/restore is a modal flow (section picker, passphrase for the
// encrypted API-token/MQTT block, a dry-run preview before anything is
// written) — see public-src/components/backup-modal.js, wired directly from
// main.js's event listeners rather than through this file.
