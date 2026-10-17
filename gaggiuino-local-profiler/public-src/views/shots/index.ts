import Chart from 'chart.js/auto';
import { S, filterShotsByMachine }                            from '../../state/index.js';
import * as chartRegistry                                     from '../../state/charts.js';
import { t, tHtml }                                           from '../../i18n.js';
import { isApiPortBlocked }                                   from '../../api/transport.js';
import { listShots, sendShotToTrash, restoreShotFromTrash, deleteShotPermanently, getShot } from '../../api/shots.js';
import { fetchMachineProfilesResponse, fetchMachineProfileResponse } from '../../api/machines.js';
import { localeFor, phasePlugin, corsairPlugin, clearChartOnTouchEnd, buildGmPhaseRanges, buildRecordedGmPhaseRanges, exitReasonKey } from '../../constants.js';
import {
  esc, avg, avgActive, max, fmt, formatTimeLabel, formatDelta,
  stddev, detectPhases, detectChanneling, scoreClass, scoreColor,
  chartColors, html, joinHtml
} from '../../utils.js';
import { renderSidebar, updateSidebarHighlighting } from '../../components/sidebar.js';
import { apiPortClosedHtml }                                  from '../../components/api-port-notice.js';
import { calcShotScore, shotUsedBeanTarget, shotPressureNote, findPreviousShot, buildGrinderGrindLabel } from './utils.js';
import { mapShotDatapoints } from '../../utils.js';
import { ensureCurves, getRawCurve, getCachedShotData, evictCurve } from '../../shot-curves.js';
import { calcGrindAdvice, calcComparativeGrindAdvice, _miniShotChart } from './grind.js';
import { renderAnnotationPanel, annotationBusy }              from './annotation.js';
import { markDirty }                                          from '../../live-sync.js';
import { updatePQChart }                                      from './charts.js';
import { updateMachineBanner, updateOnboardingPanel }          from '../../components/onboarding.js';
import { GEAR_ICON_SVG, COFFEE_ICON_SVG, TARGET_ICON_SVG }    from '../../icons.js';
import { loadShotImageBlobUrl, invalidateShotImage }          from '../../bean-image.js';
import { openLightbox }                                       from '../../components/lightbox.js';
import { showToast }                                          from '../../components/toast.js';
import type { Html } from '../../utils.js';
import type { ChartConfiguration } from 'chart.js';
import { _shots }                                             from './shared.js';
import type { ShotRow }                                       from './shared.js';
import { safeLocalStorage } from '../../storage.js';

export { _equipmentName } from './shared.js';
export { exportAllCSV, exportCSV, exportProfile, exportShot, shareCard } from './export.js';

// fetchShotsPage()'s normalised page: either a page of rows, or a transport
// error code the callers surface.
interface ShotsPage { shots?: ShotRow[]; nextCursor?: string | null; hasMore?: boolean; error?: number }

type GmPhaseRanges = ReturnType<typeof buildGmPhaseRanges>;

interface GmPhasesOption {
  preinfusion?: number;
  extraction?: number;
  gaggimatePhases?: GmPhaseRanges;
}

// ── Data loading ──────────────────────────────────────────────────────────

// Guards against overlapping calls (loadData() is fired unawaited from at
// least 6 independent triggers — main.js init, the reload-data button, live.js's
// post-brew setTimeout, status.js, sidebar.js, onboarding.js — with no
// coordination between them): a monotonic token is captured before the fetch
// and only the call that is still the latest one when its response lands is
// allowed to write state, same pattern as loadMachineProfileList() in
// library-profile-editor.js (#521, #644).
let _loadDataReqToken = 0;
// True while a loadData() request is in flight. A live-sync reload defers on
// shotsLoadInProgress() so it never starts mid-walk and truncates S.allShots
// back to the first page.
let _loadDataInFlight = false;

// GaggiMate phase-name lookup cache, keyed by `${machineId}:${profileName}`.
// Invalidated by invalidateGmPhaseCache() after a profile save.
const _gmPhaseCache = new Map<string, GmPhaseRanges>();

// getElementById() returns HTMLElement|null and every id in this view is a
// static element from index.html, so it is asserted once here rather than at
// each of the ~40 lookups (the genuinely optional elements — trash section,
// shot photo, fw badge — still keep their own `if (el)` guards).
const _el = (id: string): HTMLElement => document.getElementById(id) as HTMLElement;

export function invalidateGmPhaseCache(machineId: number): void {
  const prefix = `${machineId}:`;
  for (const key of _gmPhaseCache.keys()) {
    if (key.startsWith(prefix)) _gmPhaseCache.delete(key);
  }
}

// GaggiMate only serves one WS request at a time — an overlapping call
// (e.g. the live-status poll) can 503 even though the machine is fine.
// Retries up to 3x; a real 4xx/other 5xx returns immediately.
async function _fetchWithRetry(fetcher: (signal: AbortSignal) => Promise<Response>, signal: AbortSignal) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const r = await fetcher(signal);
      if (r.ok || r.status < 500 || attempt === 3) return r;
    } catch (e) {
      if (attempt === 3 || signal?.aborted) throw e;
    }
    await new Promise(res => setTimeout(res, 400 * attempt));
  }
}

// Resolves shotA's named GaggiMate profile phases, cache-first. Null on any
// miss/failure — callers treat that as "no enhancement", not an error.
async function _loadGmPhases(shotA: ShotRow, token: number): Promise<GmPhaseRanges | null> {
  const mid = shotA.machineId as number;
  const cacheKey = `${mid}:${shotA.profileName}`;
  if (_gmPhaseCache.has(cacheKey)) return _gmPhaseCache.get(cacheKey) ?? null;

  let gmPhases = null;
  try {
    const r1 = (await _fetchWithRetry(signal => fetchMachineProfilesResponse(mid, signal), AbortSignal.timeout(6000)))!;
    const { optionsRaw: profiles = [] } = (r1.ok && token === _updateViewToken ? await r1.json() : {}) as { optionsRaw?: { name?: string | null; id?: number }[] };
    const match = profiles.find(p => p.name === shotA.profileName || p.id === shotA.profileName);
    const r2 = match && (await _fetchWithRetry(signal => fetchMachineProfileResponse(match.id as number, mid, signal), AbortSignal.timeout(6000)))!;
    const prof = (r2?.ok ? await r2.json() : null) as { phases?: Parameters<typeof buildGmPhaseRanges>[0] } | null;
    if (prof?.phases?.length) gmPhases = buildGmPhaseRanges(prof.phases);
  } catch (e) {
    console.warn('[GLP] GaggiMate phase-name lookup failed:', e);
  }
  if (gmPhases) _gmPhaseCache.set(cacheKey, gmPhases); // only cache a hit — don't stick a transient failure
  return gmPhases;
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

// `trash` toggles the trashed list. Returns a normalised page:
// { shots: <newest-first, metadata-only>, nextCursor, hasMore }.
async function fetchShotsPage({ cursor = null, trash = false }: { cursor?: string | null; trash?: boolean } = {}): Promise<ShotsPage> {
  const r = await listShots({ limit: SHOTS_PAGE_LIMIT, cursor, trash });
  if (!r.ok) return { error: r.status };
  const page = await r.json() as { shots?: ShotRow[]; nextCursor?: string | null; hasMore?: boolean };
  return { shots: page.shots || [], nextCursor: page.nextCursor ?? null, hasMore: !!page.hasMore };
}

// `quiet` skips the "Loading…" placeholder: the live-sync refresh calls it to
// re-fetch the list behind an already-painted sidebar, where flashing the
// placeholder would read as a reload.
export async function loadData(opts?: { quiet?: boolean }): Promise<void> {
  const token = ++_loadDataReqToken;
  _loadDataInFlight = true;
  try {
    await _loadDataBody(opts, token);
  } finally {
    // A superseded call must not clear the flag a newer loadData() still owns.
    if (token === _loadDataReqToken) _loadDataInFlight = false;
  }
}

// The body of loadData(), separated so the in-flight flag above is cleared on
// every early return too.
async function _loadDataBody(opts: { quiet?: boolean } | undefined, token: number): Promise<void> {
  const shotsEl = _el('shots');
  if (!opts?.quiet) shotsEl.innerHTML = html`<div class="loading-state">${tHtml('loading')}</div>`;

  let fetched;
  try {
    const page = await fetchShotsPage();
    if (token !== _loadDataReqToken) return;
    if (page.error != null) {
      // A quiet reload is best-effort: keep the painted sidebar/list untouched
      // rather than replacing them with an error card.
      if (opts?.quiet) return;
      // #807: Shots is the landing view, so a session that arrived on the
      // direct port with expose_api_port off sees this 401 before it ever
      // sees the Settings card that explains it. Everything needed to
      // explain it is already client-side (see isApiPortBlocked), so say it
      // here instead of showing a bare status code.
      shotsEl.innerHTML = isApiPortBlocked(page.error)
        ? apiPortClosedHtml()
        : html`<div class="loading-state" style="color:#ef4444">HTTP ${esc(page.error)}</div>`;
      return;
    }
    fetched = [...(page.shots || [])].reverse(); // page is newest-first; keep S.allShots oldest-first
    S.shotsPageCursor = page.hasMore ? (page.nextCursor ?? null) : null;
    S.shotsHasMore    = !!page.hasMore;
    S.allShotsLoaded  = !page.hasMore;
  } catch {
    if (token !== _loadDataReqToken) return;
    if (opts?.quiet) return;
    shotsEl.innerHTML = joinHtml([
      // #814: was a hardcoded #ef4444 (the pre-redesign err value) and an
      // untranslated German string in an otherwise six-language app.
      html`<div class="loading-state" style="color:var(--err)">${tHtml('conn_error')}<br>`,
      // #814: was inline dark-theme neutrals (rgba(63,63,70,.5) fill, #a1a1aa
      // text, #3f3f46 border) that never inverted. .export-btn is the same
      // "fill, no persistent border" button this was hand-rolling.
      html`<button data-action="reload-data" class="export-btn" style="margin-top:var(--sp-3)">${tHtml('btn_reload')}</button></div>`,
    ]);
    return;
  }

  // Multi-machine filtering (#325): S.allShots is the true unfiltered
  // fetch; S.shots (what every existing view already reads) becomes the
  // machine-filtered projection, re-derived whenever the active machine
  // changes (see applyActiveMachineChange() in components/machines-settings.js).
  //
  // A quiet reload re-fetches only the newest pages, so it would briefly drop
  // every older shot the sidebar already shows. Keep the already-loaded entries
  // older than this page's oldest id appended for now; the walk below drops the
  // ones the fresh pages no longer contain once it finishes (#1614 slice 4).
  const oldestFetchedId = fetched[0]?.id;
  const olderEntries = opts?.quiet && oldestFetchedId != null
    ? (S.allShots as ShotRow[]).filter(s => Number(s.id) < Number(oldestFetchedId))
    : [];
  S.allShots = [...olderEntries, ...fetched];
  S.shots = filterShotsByMachine(S.allShots, S.activeMachineId);
  renderSidebar();
  void loadTrashData();

  const empty     = _el('empty-state');
  const chartArea = _el('chart-area');
  if (S.shots.length > 0) {
    empty.style.display     = 'none';
    chartArea.style.display = 'flex';
    const savedCompare = parseInt(safeLocalStorage.getItem('glp_compareShotId') as string);
    // #431: the mobile Shots tab now opens straight to a shot's detail (no
    // list step in between), so the initial selection needs to actually
    // honor the last-selected shot (persisted on every selection, see
    // selectShot()/the sidebar row click handler) rather than always
    // resetting to the newest one.
    const savedPrimary = parseInt(safeLocalStorage.getItem('glp_primaryShotId') as string);
    S.primaryShotId = (savedPrimary && S.shots.find(s => s.id === savedPrimary))
      ? savedPrimary
      : (S.shots.at(-1)?.id ?? null);
    if (savedCompare && S.shots.find(s => s.id === savedCompare) && savedCompare !== S.primaryShotId) {
      S.compareShotId = savedCompare;
    }
    void updateView();
  } else {
    empty.style.display     = 'flex';
    chartArea.style.display = 'none';
  }
  updateOnboardingPanel();
  // Re-evaluate the machine-unreachable banner as soon as shots finish loading,
  // instead of waiting for the next 30s updateStatus() poll (#288).
  updateMachineBanner();

  // Background: pull every remaining page of shot metadata so S.allShots
  // holds the full history for analytics / dial-in wizard / per-machine
  // counts / findPreviousShot, without blocking first paint. A quiet reload
  // that kept older entries uses replaceOlder so the walk commits the full
  // fresh list once instead of prepending page by page.
  void loadAllShotMeta(token, S.shotsPageCursor, { replaceOlder: olderEntries.length > 0, fetched });
}

// #1539 slice 4: refetch the shots a live-sync `shot`/`shots` event dirtied and
// patch the already-loaded rows in place, so another device's annotation (or
// photo) lands without a full list reload. No library reload is needed here:
// the server publishes `library` together with `shot` for an annotation, which
// covers the derived stock/wear change.
//  - null, or more than REFRESH_INLINE_MAX ids, is not worth a per-shot fetch,
//    so the list is re-fetched quietly (no loading placeholder).
//  - an id the server no longer has (trashed/deleted between the event and the
//    fetch) falls back to the quiet list reload, since the row left the page.
//  - an id outside S.allShots (older than the loaded window) is ignored.
//  - otherwise every field the detail returns is patched: annotation, score,
//    usedBeanTarget, and the image (deleted when the payload no longer has one,
//    i.e. a removed photo). The cached photo/thumbnail is dropped, the sidebar
//    and its highlighting re-render once after the loop, and the open shot's
//    panel refreshes once. The scheduler's canRun held this run back while an
//    edit or save was pending, so it cannot clobber one; and because the loop's
//    sequential fetches give an edit time to start mid-run, the guard is
//    re-checked for the open shot right before it is patched (see below).
const REFRESH_INLINE_MAX = 5;

export async function refreshShots(ids: string[] | null): Promise<void> {
  if (!ids || ids.length > REFRESH_INLINE_MAX) {
    await loadData({ quiet: true });
    return;
  }
  let changed = false;
  let openEntry: ShotRow | null = null;
  for (const raw of ids) {
    const id = Number(raw);
    const shot = await getShot(id);
    if (!shot) {
      await loadData({ quiet: true });
      return;
    }
    const entry = (S.allShots as ShotRow[]).find(s => s.id === id);
    if (!entry) continue;
    // The `shot` handler's canRun checked the edit guard once before this loop
    // started, but up to five sequential getShot round-trips can elapse before
    // this id is reached. If the user began editing the open shot meanwhile,
    // patching it now would clobber that edit: leave it untouched and re-dirty
    // it so the scheduler retries once the edit clears.
    if (id === S.primaryShotId && annotationBusy()) {
      markDirty('shot', [String(id)]);
      continue;
    }
    entry.annotation = shot.annotation ?? null;
    entry.score = shot.score;
    entry.usedBeanTarget = shot.usedBeanTarget;
    if (shot.image) entry.image = shot.image;
    else delete entry.image;
    invalidateShotImage(id);
    changed = true;
    if (id === S.primaryShotId) openEntry = entry;
  }
  if (!changed) return;
  renderSidebar();
  updateSidebarHighlighting();
  if (openEntry) renderAnnotationPanel(openEntry);
}

// loadAllShotMeta walks api/shots page by page (oldest direction) from
// startCursor until the server reports no more, concatenating each page into
// S.allShots and re-deriving S.shots. Guarded by the same _loadDataReqToken
// as loadData, so a newer loadData() abandons a superseded walk. The loop is
// driven entirely by the local `cursor` (never re-read from S across an
// await), and every S write takes its value from the just-fetched page, so
// there is no read-then-write race on S.
// Walk ownership is keyed by that same token rather than a single boolean: a
// walk for the SAME token is already running (the no-op guard below), but a
// walk for an OLDER token is already exiting on its own token check, so a newer
// loadData() (or a live-sync quiet reload) starts its own walk instead of
// returning early and leaving the list cut to page 1 (#1614 slice 4). null when
// no walk is running.
let _metaWalkToken: number | null = null;

// True while the shots list is being (re)loaded: a loadData() request is in
// flight, or loadAllShotMeta() is still walking older pages. The live-sync
// `shots` handler's canRun defers a reload until this clears, so a quiet
// reload cannot cut S.allShots back to the first page mid-walk.
export function shotsLoadInProgress(): boolean {
  return _loadDataInFlight || _metaWalkToken !== null;
}

// `replaceOlder` is the quiet-reload mode: the caller already painted
// [...older entries, ...page 1] optimistically, so this walk collects the
// remaining pages locally and commits [...collected, ...fetched] only once it
// finishes, dropping any older shot the fresh pages no longer contain and
// letting a superseded walk write nothing. Non-quiet loads (and loadMoreShots)
// keep the per-page prepend instead.
export async function loadAllShotMeta(
  token: number,
  startCursor: string | null,
  opts?: { replaceOlder?: boolean; fetched?: ShotRow[] },
): Promise<void> {
  if (_metaWalkToken === token) return;
  _metaWalkToken = token;
  const replaceOlder = !!opts?.replaceOlder;
  const fetched = opts?.fetched ?? [];
  const collected: ShotRow[] = [];
  let cursor = startCursor;
  // With replaceOlder and no cursor there are no pages to walk, yet the
  // optimistic older entries still have to be dropped: treat the walk as done.
  let done = replaceOlder && !startCursor;
  // #969: per-page state (S.allShots/S.shots/S.shotsPageCursor/S.shotsHasMore)
  // still updates every page — cheap. Only the DOM rebuild is throttled;
  // renderedSinceStart tracks whether the trailing render below has anything
  // new to paint at all (a superseded/errored walk that never got a page
  // shouldn't render).
  let lastRenderAt = 0;
  let renderedSinceStart = false;
  try {
    while (cursor && token === _loadDataReqToken) {
      let page: ShotsPage;
      try {
        page = await fetchShotsPage({ cursor });
      } catch { return; }
      if (token !== _loadDataReqToken) return;
      if (page.error != null) break;

      // Each page is newest-first and older than everything already loaded —
      // reverse it to oldest-first.
      const older = [...(page.shots || [])].reverse();
      cursor = page.hasMore ? (page.nextCursor ?? null) : null;
      done = !page.hasMore;
      if (replaceOlder) {
        collected.unshift(...older);
      } else {
        const merged = [...older, ...S.allShots];
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
    }
    if (token === _loadDataReqToken && done) {
      if (replaceOlder) {
        const merged = [...collected, ...fetched];
        S.allShots        = merged;
        S.shots           = filterShotsByMachine(merged, S.activeMachineId);
        S.shotsPageCursor = cursor;
        S.shotsHasMore    = false;
        renderedSinceStart = true;
      } else {
        S.shotsHasMore = false;
      }
      S.allShotsLoaded = true;
      // Analytics gates its builders on S.allShotsLoaded — let it re-run now
      // that the full history is in memory.
      window.onAllShotMetaLoaded?.();
    }
  } finally {
    // Release ownership only if this walk still holds it; a newer walk that
    // took over (different token) clears its own.
    if (_metaWalkToken === token) _metaWalkToken = null;
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
export async function loadMoreShots(): Promise<void> {
  if (!S.shotsHasMore || !S.shotsPageCursor) return;
  await loadAllShotMeta(_loadDataReqToken, S.shotsPageCursor);
}

// ── Trash ─────────────────────────────────────────────────────────────────

export async function loadTrashData(): Promise<void> {
  try {
    // The trash TTL is 30 days, so a single page is plenty in practice.
    const page = await fetchShotsPage({ trash: true });
    if (page.error != null) return;
    S.trashedShots = page.shots || [];
    renderTrash();
  } catch { /* ignore */ }
}

export function renderTrash(): void {
  const section = _el('trash-section');
  const countEl = _el('trash-count');
  const listEl  = _el('trash-list');
  const count   = S.trashedShots.length;

  section.style.display = count > 0 ? 'block' : 'none';
  countEl.textContent   = String(count);

  listEl.innerHTML = html``;
  const now = Date.now();
  (S.trashedShots as ShotRow[]).forEach(shot => {
    const daysLeft = Math.max(0, 30 - Math.floor((now - (shot.trashedAt as number)) / 86400000));
    const name = shot.profile?.name || shot.profileName || `Shot ${shot.id}`;
    const row  = document.createElement('div');
    row.className = 'trash-item';
    // codeql[js/xss-through-dom] false positive: esc()/escapeHtml() already applied, see #760
    row.innerHTML = html`
      <div class="trash-item-info">
        <div class="trash-item-name">${esc(name)}</div>
        <div class="trash-item-days">Shot ${esc(shot.id)} · ${tHtml('trash_days_left', daysLeft)}</div>
      </div>
      <button class="trash-restore-btn" data-action="restore-shot" data-id="${esc(shot.id)}">${tHtml('trash_restore_label')}</button>
      <button class="trash-delete-btn" title="${tHtml('trash_delete_title')}" data-action="perm-delete-shot" data-id="${esc(shot.id)}"><svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16" aria-hidden="true"><path d="M6,19A2,2 0 0,0 8,21H16A2,2 0 0,0 18,19V7H6V19M8,9H10V19H8V9M14,9H16V19H14V9M15.5,4L14.5,3H9.5L8.5,4H5V6H19V4H15.5Z"/></svg></button>
    `;
    listEl.appendChild(row);
  });
}

export function toggleTrash(): void {
  S.trashOpen = !S.trashOpen;
  _el('trash-list').style.display = S.trashOpen ? 'block' : 'none';
}

// How long the "moved to trash" toast keeps its Undo button (#1716).
const TRASH_UNDO_MS = 6000;

export async function trashShot(id: number): Promise<void> {
  try {
    const r = await sendShotToTrash(id);
    if (!r.ok) throw new Error(await r.text());
    evictCurve(id);
    const row = (S.allShots as ShotRow[]).find(s => s.id === id) ?? (S.shots as ShotRow[]).find(s => s.id === id);
    const wasPrimary = S.primaryShotId === id;
    // #1625: pick the neighbour of the trashed shot before removing it — the
    // next newer one if there is one, otherwise the next older one. S.shots is
    // oldest-first, so a higher index is newer; null when nothing is left.
    const idx = S.shots.findIndex(s => s.id === id);
    const neighbourId = idx === -1 ? null : (S.shots[idx + 1] ?? S.shots[idx - 1] ?? null)?.id ?? null;
    S.shots = S.shots.filter(s => s.id !== id);
    S.allShots = (S.allShots || []).filter(s => s.id !== id);
    if (S.primaryShotId === id) {
      S.primaryShotId = neighbourId;
      if (S.primaryShotId) safeLocalStorage.setItem('glp_primaryShotId', String(S.primaryShotId));
      else safeLocalStorage.removeItem('glp_primaryShotId');
    }
    if (S.compareShotId === id) {
      S.compareShotId = null;
      safeLocalStorage.removeItem('glp_compareShotId');
    }
    renderSidebar();
    void updateView();
    // #1716: a single click trashes, so offer a short Undo instead of a
    // confirm dialog. One toast element: trashing another shot replaces it,
    // and the earlier one stays restorable from the trash section.
    if (row) {
      showToast(t('trash_moved_toast'), {
        duration: TRASH_UNDO_MS,
        action: { label: t('trash_undo_label'), onClick: () => { void undoTrashShot(row, wasPrimary); } },
      });
    }
    await loadTrashData();
  } catch (e) {
    alert(t('error_generic', (e as Error).message));
  }
}

// Undo for trashShot() (#1716): restore through the existing endpoint, put the
// saved row back at its place in the oldest-first lists and reselect it when it
// was the open shot. The restore route has no existence check, so a shot that
// was permanently deleted meanwhile is confirmed gone with getShot() and left
// out; one already restored elsewhere (a live-sync reload put it back) is not
// inserted twice. Failures only show the generic error toast.
export async function undoTrashShot(row: ShotRow, wasPrimary: boolean): Promise<void> {
  const id = row.id;
  try {
    const r = await restoreShotFromTrash(id);
    if (!r.ok) throw new Error(await r.text());
    if (!(await getShot(id))) { await loadTrashData(); return; }
    if (!(S.allShots as ShotRow[]).some(s => s.id === id)) {
      const all = S.allShots as ShotRow[];
      const at = all.findIndex(s => Number(s.id) > Number(id));
      S.allShots = at === -1 ? [...all, row] : [...all.slice(0, at), row, ...all.slice(at)];
      S.shots = filterShotsByMachine(S.allShots, S.activeMachineId);
    }
    if (wasPrimary && S.shots.some(s => s.id === id)) {
      S.primaryShotId = id;
      if (S.compareShotId === id) S.compareShotId = null;
      safeLocalStorage.setItem('glp_primaryShotId', String(id));
    }
    renderSidebar();
    void updateView();
    await loadTrashData();
  } catch (e) {
    showToast(t('error_generic', (e as Error).message));
  }
}

export async function restoreShot(id: number): Promise<void> {
  try {
    const r = await restoreShotFromTrash(id);
    if (!r.ok) throw new Error(await r.text());
    await loadData();
  } catch (e) {
    alert(t('error_generic', (e as Error).message));
  }
}

export async function permanentDeleteShot(id: number): Promise<void> {
  if (!confirm(t('confirm_perm_delete', id))) return;
  try {
    const r = await deleteShotPermanently(id);
    if (!r.ok) throw new Error(await r.text());
    evictCurve(id);
    S.trashedShots = S.trashedShots.filter(s => s.id !== id);
    renderTrash();
  } catch (e) {
    alert(t('error_generic', (e as Error).message));
  }
}

// ── Main view ─────────────────────────────────────────────────────────────

// Shared setter for the #402 delta-chip spans (verdict score + process-zone
// metrics): hides the chip entirely when there's nothing to compare against,
// never shows an empty pill.
function _setDeltaChip(id: string, delta: number | null, decimals = 0, unit = '', colorClass: string | null = null, title = ''): void {
  const el = _el(id);
  if (!el) return;
  if (delta == null) { el.style.display = 'none'; return; }
  el.textContent = formatDelta(delta, decimals, unit);
  el.className   = 'delta-chip' + (colorClass ? ` ${colorClass}` : '');
  el.title       = title;
  el.style.display = '';
}

let _updateViewToken = 0;

// Set per updateView() call — lets the async GaggiMate-phases callback
// rebuild the chart once gmPhases lands (see below for why rebuild, not mutate).
let _buildShotChart: ((phasesOpt: GmPhasesOption) => void) | null = null;

export async function updateView(): Promise<void> {
  // #814: resolved per render, never at module load — the value has to be
  // whatever the ACTIVE theme resolves to right now.
  const C = chartColors();
  const shotA = _shots().find(s => s.id === S.primaryShotId);
  const shotB = S.compareShotId ? _shots().find(s => s.id === S.compareShotId) : null;
  if (!shotA) return;

  // Same-profile auto-compare (#402): most recent earlier shot with the same
  // profile on the same machine. Only meaningful outside A/B compare mode —
  // that feature stays untouched and unrelated to this same-profile pairing.
  const previousShot = (!shotB ? findPreviousShot(_shots(), shotA) : null) as ShotRow | null;

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
    _el('topTitle').innerText = t('compare_title', shotA.nativeId ?? shotA.id, shotB.nativeId ?? shotB.id);
  } else {
    _el('topTitle').innerText = `${nameA} – Shot ${shotA.nativeId ?? shotA.id}`;
  }

  // machineSubtitle (#344): make it reflect the machine that actually owns
  // the shot being viewed, not the global default machine from status.js's
  // periodic poll — see that file's updateStatus() for the corresponding
  // guard (`!S.primaryShotId`) that keeps it from clobbering this back.
  // In compare mode there's no single "owning" machine worth naming, so it
  // shows the two profile names being compared instead (#398 dropped the
  // separate "Profil" meta row that used to carry this).
  const subtitleEl = _el('machineSubtitle');
  if (subtitleEl) {
    if (shotB) {
      const nameB = shotB.profile?.name || shotB.profileName || t('profile_unknown');
      subtitleEl.textContent = `${nameA} vs. ${nameB}`;
    } else {
      const machine = S.machines?.find(m => m.id === (shotA.machineId ?? 1));
      if (machine) subtitleEl.textContent = machine.host ? `${machine.name as string} · ${machine.host as string}` : machine.name as string;
    }
  }

  const totalSecs = (shotA.duration || 0) / 10;
  _el('duration').innerText = formatTimeLabel(totalSecs);

  const pressureVals  = dA.pressure.map(p => p.y);
  const pressureTimes = dA.pressure.map(p => p.x);
  const avgPressure   = avgActive(pressureVals, 1.5);
  _el('pressure').innerText       = fmt(avgPressure, ' bar');
  _el('targetPressure').innerText = ` / ${fmt(max(dA.targetPressure.map(p => p.y)), ' bar')}`;
  const avgFlow = avgActive(dA.flow.map(p => p.y), 0.2);
  _el('flow').innerText           = fmt(avgFlow, ' ml/s');
  _el('targetFlow').innerText     = ` / ${fmt(avgActive(dA.targetFlow.map(p => p.y), 0.2), ' ml/s')}`;

  const tempVals = dA.temp.map(p => p.y);
  const sdTemp   = stddev(tempVals);
  const avgTemp  = avg(tempVals);
  _el('temp').innerText             = fmt(avgTemp, ' °C');
  _el('tempStability').textContent  = (sdTemp != null && sdTemp < 5) ? `±${sdTemp.toFixed(1)}` : '';
  _el('targetTemp').innerText       = ` / ${fmt(avg(dA.targetTemp.map(p => p.y)), ' °C')}`;

  // Process-zone delta chips (#402): signed vs. the previous same-profile
  // shot's own average — no quality judgment implied, so no score coloring.
  if (dPrev && previousShot) {
    const prevTitle = t('delta_vs_shot', previousShot.nativeId ?? previousShot.id);
    _setDeltaChip('pressureDeltaChip', avgPressure != null ? avgPressure - (avgActive(dPrev.pressure.map(p => p.y), 1.5) ?? 0) : null, 1, ' bar', null, prevTitle);
    _setDeltaChip('flowDeltaChip',     avgFlow     != null ? avgFlow     - (avgActive(dPrev.flow.map(p => p.y), 0.2) ?? 0)     : null, 1, ' ml/s', null, prevTitle);
    _setDeltaChip('tempDeltaChip',     avgTemp     != null ? avgTemp     - (avg(dPrev.temp.map(p => p.y)) ?? 0)                : null, 1, ' °C', null, prevTitle);
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
  const doseYieldCard = _el('doseYieldCard');
  const ratioCard     = _el('ratioCard');
  if (ann.dose && finalWeight && !shotB) {
    _el('doseYieldVal').textContent = `${fmt(parseFloat(String(ann.dose)), ' g')} → ${fmt(finalWeight, ' g')}`;
    doseYieldCard.style.display = '';

    const r = (finalWeight / ann.dose).toFixed(1);
    _el('ratioVal').textContent = `1:${r}`;
    const eySub = _el('eySub');
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
  const grinderLabel = buildGrinderGrindLabel(_shots(), shotA, !shotB, t);
  _el('beanVal').textContent    = ann.coffee || '–';
  _el('grinderVal').textContent = grinderLabel || '–';

  // Freshness badge
  const freshEl   = _el('freshnessBadge');
  const ageAtShot = ann.beanAgeDays != null ? ann.beanAgeDays
    : (!shotB && ann.roastDate && ann.coffee)
      ? Math.round((Date.now() - new Date(ann.roastDate).getTime()) / 86400000)
      : null;
  if (ageAtShot != null && ageAtShot >= 0 && ageAtShot <= 365) {
    const cls = ageAtShot <= 21 ? 'freshness-fresh' : ageAtShot <= 35 ? 'freshness-ok' : 'freshness-old';
    freshEl.className   = `freshness-badge ${cls}`;
    freshEl.textContent = ann.beanAgeDays != null ? t('bean_age_badge', ageAtShot) : `${ageAtShot}d`;
    freshEl.title       = ann.beanAgeDays != null ? t('bean_age_at_shot', ageAtShot) : t('freshness_title', ageAtShot);
    freshEl.style.display = '';
  } else { freshEl.style.display = 'none'; }

  // Firmware version badge
  const fwEl = _el('firmwareVersionBadge');
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
  const photoThumbEl = _el('shotHeaderThumb') as HTMLImageElement | null;
  const heroPhotoEl  = _el('shotHeroPhoto') as HTMLImageElement | null;
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
      void loadShotImageBlobUrl(shotA.id).then(url => {
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
  // The GaggiMate named-phase lookup below upgrades this later if it lands.
  const phases    = !shotB ? detectPhases(pressureTimes, pressureVals) : null;
  const phasesSub = _el('phasesSub');
  phasesSub.textContent = phases
    ? `${t('phase_preinfusion')} ${formatTimeLabel(phases.preinfusion)} · ${t('phase_extraction')} ${formatTimeLabel(phases.extraction)}`
    : '';

  // #1409: a v1.9.0+ GaggiMate shot records its own phase transitions, so the
  // chart is shaded from the log's timings (and names) instead of the
  // pressure-derived preinfusion/extraction split. Gaggiuino shots and older
  // GaggiMate shots carry none and keep the detectPhases path.
  const recordedTransitions = !shotB ? rawA.phaseTransitions : null;
  const endSecA = dA.rawTimes.at(-1) ?? 0;
  const recordedRanges = buildRecordedGmPhaseRanges(recordedTransitions, endSecA);
  if (recordedRanges.length) {
    phasesSub.textContent = recordedRanges.map(p => p.name).join(' · ');
  }

  const stopKey = !shotB ? exitReasonKey(rawA.finalExitReason) : null;
  _el('stopReasonSub').textContent = stopKey ? t('shot_end_reason', t(stopKey)) : '';

  // Channeling
  const channeling = !shotB && detectChanneling(pressureTimes, pressureVals);
  _el('channelingWarning').style.display = channeling ? '' : 'none';

  // Verdict header (#398): score + the dial-in advice as one plain-language
  // line (#816: de-boxed — was a score badge beside a boxed advice line).
  const verdictHeader = _el('verdictHeader');
  if (!shotB) {
    const advice = calcGrindAdvice(shotA, dA);
    const sc     = calcShotScore(shotA, dA);
    // #813: the score ring is now type. A 58px conic-gradient ring is a badge
    // shape the redesign removes on both surfaces (the shot card did the same
    // in glp-lovelace-card#120) — the number itself, at display size and in
    // the score colour, carries the same information with none of the chrome.
    const ringVal  = _el('verdictRingVal');
    ringVal.style.setProperty('--ring-color', scoreColor(sc));
    ringVal.textContent = sc !== null ? String(sc) : '–';

    // Score delta chip (#402): same-profile auto-compare, unified score
    // scale (#397) for the coloring — omitted entirely when there's no
    // previous same-profile shot or either score is unknown.
    const prevScore = previousShot ? previousShot.score : null;
    const verdictDeltaChip = _el('verdictDeltaChip');
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
    // #1538/#1628: a sub-5-bar shot's pressure scored against the profile's
    // own target (or left out) shares the same icon — one icon, every
    // applicable reason in its tooltip, never two identical icons side by side.
    const pressureNote = shotPressureNote(shotA, rawA);
    const hintTitles = [
      shotUsedBeanTarget(shotA) ? t('verdict_bean_target_hint') : '',
      pressureNote ? t(pressureNote === 'profile' ? 'verdict_pressure_profile_hint' : 'verdict_pressure_omitted_hint') : '',
    ].filter(Boolean);
    const scoreHint: Html = hintTitles.length
      ? html`<span class="verdict-bean-target-hint" title="${esc(hintTitles.join('\n'))}">${TARGET_ICON_SVG}</span>` : html``;
    _el('verdictHeadline').innerHTML = html`${advice ? html`${advice.icon} ${esc(advice.text)}` : esc(t('verdict_no_data'))}${scoreHint}`;
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

  const compEl  = _el('grindAdviceComparative');
  const compAdv = !shotB ? calcComparativeGrindAdvice(shotA, _shots()) : null;
  if (compEl) {
    if (compAdv) {
      const wasOpen = compEl.classList.contains('expanded');
      compEl.className = `grind-advice grind-comparative grind-${compAdv.type}${wasOpen ? ' expanded' : ''}`;
      _el('grindAdviceComparativeIcon').innerHTML = compAdv.icon;
      _el('grindAdviceComparativeText').textContent = compAdv.text;

      // #957: the comparative thumbnails each need their shot's curve — fetch
      // the handful (typically 1-8) before rendering; _miniShotChart falls
      // back to a no-data placeholder for any that are still missing.
      await ensureCurves(compAdv.shots.map(x => x.shot.id));
      if (token !== _updateViewToken) return;

      const locale   = localeFor(S.currentLang);
      const listHtml = joinHtml(compAdv.shots.map(({ shot: s, grind, score }) => {
        const date  = new Date((s.timestamp as number) * 1000).toLocaleDateString(locale, { day: '2-digit', month: '2-digit' });
        const dur   = s.duration ? `${(s.duration / 10).toFixed(0)}s` : '';
        const cls   = scoreClass(score);
        const chart = _miniShotChart(s);
        return html`<div class="comp-thumb" data-action="goto-shot" data-id="${esc(s.id)}" title="Shot ${esc(s.id)} — ${esc(date)}">
          <div class="comp-thumb-chart">${chart}</div>
          <div class="comp-thumb-meta">
            <span class="comp-shot-date">${esc(date)}</span>
            <span class="comp-shot-grind">${GEAR_ICON_SVG} ${esc(grind)}</span>
            <span class="comp-shot-score ${esc(cls)}">${esc(score)}</span>
            ${dur ? html`<span class="comp-shot-dur">${esc(dur)}</span>` : html``}
          </div>
        </div>`;
      }));

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
  const obEl = _el('orderedByInfo');
  if (obEl) {
    const ob = !shotB ? shotA.annotation?.orderedBy : null;
    if (ob?.customer) {
      const drink = ob.item ? (ob.variant ? `${ob.item} · ${ob.variant}` : ob.item) : null;
      obEl.innerHTML = html`<span class="ann-ordered-by-label">${COFFEE_ICON_SVG} ${tHtml('ann_ordered_by')}</span><span class="ann-ordered-by-val">${esc(ob.customer)}${drink ? html` · ${esc(drink)}` : html``}${ob.note ? html` · <em>${esc(ob.note)}</em>` : html``}</span>`;
      obEl.style.display = '';
    } else {
      obEl.style.display = 'none';
    }
  }

  renderAnnotationPanel(shotA);

  // Build main chart datasets
  const maxTimeA    = dA.rawTimes.at(-1) ?? 0;
  const maxTimeB    = dB ? (dB.rawTimes.at(-1) ?? 0) : 0;
  const maxTimePrev = dPrev ? (dPrev.rawTimes.at(-1) ?? 0) : 0;

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
  if (dPrev && previousShot) {
    const ghostSfx = t('chart_prev_suffix', previousShot.nativeId ?? previousShot.id);
    datasets.push(
      { label:t('chart_pressure') + ghostSfx, data: dPrev.pressure, yAxisID:'y',  borderDash:[2,3], borderWidth:1.5, tension:.1, borderColor:'rgba(52,152,219,.35)', backgroundColor:'transparent', pointStyle:false },
      { label:t('chart_flow')     + ghostSfx, data: dPrev.flow,     yAxisID:'y',  borderDash:[2,3], borderWidth:1.5, tension:.1, borderColor:'rgba(243,156,18,.35)', backgroundColor:'transparent', pointStyle:false },
      { label:t(dPrev.weightIsReal ? 'chart_weight' : 'chart_weight_estimated') + ghostSfx, data: dPrev.weight, yAxisID:'y1', borderDash:[2,3], borderWidth:1.5, tension:.1, borderColor:'rgba(46,204,113,.35)', backgroundColor:'transparent', pointStyle:false }
    );
  }

  chartRegistry.dispose('pqChart');
  if (S.currentChartTab === 'pq') updatePQChart();

  const ctx = _el('espressoShotChart') as HTMLCanvasElement;

  // Rebuild rather than mutate options.plugins.phases in place — Chart.js
  // doesn't reliably pick up in-place mutation on the next draw.
  _buildShotChart = (phasesOpt) => {
    const existing = Chart.getChart(ctx);
    if (existing) existing.destroy();
    try {
      chartRegistry.set('chart', new Chart(ctx, ({
        type: 'line',
        plugins: [corsairPlugin, phasePlugin],
        data: { datasets },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          layout: { padding: { bottom: 20 } },
          interaction: { mode: 'index', intersect: false },
          plugins: {
            phases: phasesOpt,
            legend:  {
              display: true,
              position: 'bottom',
              labels: { color: C.text, font: { family: 'Figtree', size: window.innerWidth <= 600 ? 9 : 11 }, boxWidth: window.innerWidth <= 600 ? 8 : 12, padding: window.innerWidth <= 600 ? 4 : 8 }
            },
            tooltip: {
              callbacks: {
                title: (ctx: { parsed: { x: number } }[]) => {
                  const time = ctx[0]?.parsed.x ?? 0;
                  const ph = phasesOpt.gaggimatePhases?.find(p => time >= p.t0 && time <= p.t1);
                  const timeLabel = t('chart_time', formatTimeLabel(time));
                  return ph?.name ? `${ph.name} — ${timeLabel}` : timeLabel;
                },
              },
            }
          },
          scales: {
            x:  { type:'linear', min:0, max:Math.max(maxTimeA, maxTimeB, maxTimePrev), clip:false,
                  ticks:{ color:C.tick, font:{family:'Figtree'}, stepSize:5, callback:(v: number)=>formatTimeLabel(v), maxTicksLimit: window.innerWidth <= 600 ? 6 : 12 },
                  grid:{ color:C.grid } },
            y:  { type:'linear', position:'left',  min:0, max:12, ticks:{color:C.tick, maxTicksLimit:6}, grid:{color:C.grid} },
            y1: { type:'linear', position:'right', min:0, max:Number(tempMaxScale), ticks:{color:C.tick, maxTicksLimit:6}, grid:{drawOnChartArea:false} }
          }
        }
      } as unknown as ChartConfiguration<'line'>)));
      const builtChart = chartRegistry.get('chart');
      if (builtChart) clearChartOnTouchEnd(builtChart);
    } catch (e) {
      console.error('Chart creation error:', e);
    }
  };
  chartRegistry.dispose('chart');
  _buildShotChart(
    recordedRanges.length ? { gaggimatePhases: recordedRanges }
      : phases ? { preinfusion: phases.preinfusion, extraction: phases.extraction }
      : {},
  );

  // GaggiMate: upgrade sub-line + chart once named phases land. Not awaited;
  // must stay after _buildShotChart exists (a cache hit can resolve before
  // it otherwise, since this fn has earlier awaits). Shots have no
  // machineType of their own, hence the S.machines lookup.
  const shotMachine = !shotB ? S.machines?.find(m => m.id === (shotA.machineId ?? 1)) : null;
  if (shotMachine?.type === 'gaggimate' && shotA.machineId) {
    void _loadGmPhases(shotA, token).then(gmPhases => {
      if (!gmPhases || token !== _updateViewToken) return;
      // #1409: when the log recorded its own transitions they win; the profile
      // lookup only supplies each phase's type (preinfusion/brew tint) by index.
      const ranges = recordedRanges.length
        ? buildRecordedGmPhaseRanges(recordedTransitions, endSecA, gmPhases)
        : gmPhases;
      phasesSub.textContent = ranges.map(p => p.name).join(' · ');
      _buildShotChart!({ gaggimatePhases: ranges });
    });
  }
}
