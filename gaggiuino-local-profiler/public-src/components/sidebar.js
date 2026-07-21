import { S } from '../state.js';
import { t } from '../i18n.js';
import { LOCALE_MAP } from '../constants.js';
import { esc, scoreClass, formatTimeLabel, groupShotsByDay } from '../utils.js';
import { loadShotImageBlobUrl } from '../bean-image.js';
import { openLightbox } from './lightbox.js';
import { STAR_ICON_SVG } from '../icons.js';

// These are imported lazily via window to avoid circular dependencies
// updateView is on window, calcShotScore/getShotData are set from shots.js

export function renderSidebar() {
  const el = document.getElementById('shots');
  el.innerHTML = '';
  const countEl = document.getElementById('shot-count');
  if (countEl) countEl.textContent = `(${S.shots.length})`;
  updateFlapCounter(S.shots.length);

  const shots = sortedShots();
  // #412: day-separator groups only make sense in chronological order —
  // score/rating/duration sort would scatter unrelated days under
  // confusing headers, same reasoning the old month-grouping used.
  if (S.currentSort !== 'newest') {
    shots.forEach(shot => el.appendChild(_buildShotWrapper(shot)));
  } else {
    const locale = LOCALE_MAP[S.currentLang] || 'de-DE';
    const formatRecent = d => d.toLocaleDateString(locale, { weekday: 'long', day: '2-digit', month: '2-digit' });
    const formatOlder = d => d.toLocaleDateString(locale, { month: 'long', year: 'numeric' });
    const groups = groupShotsByDay(shots, new Date(), t('day_today'), t('day_yesterday'), formatRecent, formatOlder);
    groups.forEach(group => {
      if (group.tier === 'month') {
        // #439: month-tier groups collapse behind a clickable header,
        // restoring the pre-#399 accordion — collapsed by default unless
        // this session already expanded it (S._expandedMonths survives
        // re-renders but resets on a fresh page load).
        const expanded = S._expandedMonths.has(group.key);
        const header = document.createElement('button');
        header.type = 'button';
        header.className = 'sidebar-month-header';
        header.dataset.action = 'toggle-month-group';
        header.dataset.id = group.key;
        header.textContent = `${expanded ? '▾' : '▸'} ${group.label}`;
        el.appendChild(header);

        const body = document.createElement('div');
        body.className = 'sidebar-month-body';
        body.id = `monthGroup-${group.key}`;
        body.style.display = expanded ? '' : 'none';
        group.shots.forEach(shot => body.appendChild(_buildShotWrapper(shot)));
        el.appendChild(body);
      } else {
        const sep = document.createElement('div');
        sep.className = 'day-sep';
        sep.dataset.dayKey = group.key;
        sep.textContent = group.label;
        el.appendChild(sep);
        group.shots.forEach(shot => el.appendChild(_buildShotWrapper(shot)));
      }
    });
  }

  updateSidebarHighlighting();
  if (S.currentFilter) filterShots(S.currentFilter);
  loadShotThumbnails();
}

// Shot images need the auth token, so <img src> can't point at the API
// directly (see bean-image.js) — set the blob-url src async after render,
// mirroring loadBeanThumbnails() in views/library.js.
function loadShotThumbnails() {
  document.querySelectorAll('.shot-thumb[data-shot-id]').forEach(img => {
    const id = parseInt(img.dataset.shotId);
    loadShotImageBlobUrl(id).then(url => { if (url) img.src = url; });
  });
}

function _buildShotWrapper(shot) {
    const wrapper = document.createElement('div');
    wrapper.className = 'shot-wrapper';
    wrapper.id = `wrapper-${shot.id}`;

    const divShot = document.createElement('div');
    divShot.className = 'shot';

    const date = new Date(shot.timestamp * 1000);
    const profileName = shot.profile?.name || shot.profileName || 'Unknown Profile';
    const ann = shot.annotation || {};

    // #412: rich 3-line card (partial revert of #399's flattened 2-line
    // row) — line 1 is name + right-aligned score (+ machine badge), line 2
    // is coffee + dose, line 3 is star rating + grinder + time-of-day. The
    // date itself now lives in the day-separator header above the group
    // (renderSidebar()), not per-row.
    const data = window.getShotData ? window.getShotData(shot) : null;
    const sc   = data && window.calcShotScore ? window.calcShotScore(shot, data) : null;
    const scoreHtml = sc !== null
      ? `<span class="sidebar-score ${scoreClass(sc)}">${sc}</span>`
      : '';

    const dose = parseFloat(ann.dose);
    const durLabel = shot.duration ? formatTimeLabel(shot.duration / 10) : null;
    const line2 = [ann.coffee || null, dose ? `${dose.toFixed(1)} g` : null].filter(Boolean).join(' · ') || durLabel || '';

    const rating = parseInt(ann.rating) || 0;
    const starsHtml = rating > 0
      ? `<span class="stars">${'★'.repeat(rating)}<span class="off">${'★'.repeat(5 - rating)}</span></span>`
      : '';
    const timeLabel = date.toLocaleTimeString(LOCALE_MAP[S.currentLang] || 'de-DE', { hour: '2-digit', minute: '2-digit' });
    // #429: grind setting alongside the grinder in the meta line.
    const grinderLabel = [ann.grinder, ann.grindSetting].filter(Boolean).join(' · ');
    const grinderHtml = grinderLabel ? `<span class="shot-grinder">${esc(grinderLabel)}</span>` : '';

    const thumbHtml = shot.image ? `<img class="shot-thumb" data-shot-id="${shot.id}" alt="">` : '';
    // Multi-machine badge (#325): only shown in "all machines" mode with
    // more than one machine registered — a machine-scoped list already
    // implies every visible shot is from that machine, so the badge would
    // be redundant noise there.
    const machineBadge = (S.machines?.length > 1 && S.activeMachineId === 'all' && shot.machineId != null)
      ? `<span class="shot-machine-badge">${esc((S.machines.find(m => m.id === shot.machineId) || {}).name || '?')}</span>` : '';
    divShot.innerHTML = `
      <div class="shot-row">
        ${thumbHtml}
        <div class="shot-text">
          <div class="shot-line1">
            <span class="shot-line1-name"><span class="profile-name-sidebar">${esc(profileName)}</span>${machineBadge}</span>
            ${scoreHtml}
          </div>
          <div class="shot-line2">${esc(line2)}</div>
          <div class="shot-line3">${starsHtml}${grinderHtml}<span class="shot-time">${esc(timeLabel)}</span></div>
        </div>
      </div>
    `;

    divShot.onclick = e => {
      if (e.ctrlKey || e.metaKey) { toggleCompare(shot.id); }
      else {
        // #430: flush a pending annotation edit on the shot being switched
        // away from before its DOM fields get overwritten by the new shot.
        if (S.primaryShotId !== shot.id && window.flushAutoSave) window.flushAutoSave();
        S.primaryShotId = shot.id; S.compareShotId = null;
        localStorage.setItem('glp_primaryShotId', shot.id);
        localStorage.removeItem('glp_compareShotId');
        updateSidebarHighlighting();
        if (S.currentMode !== 'shots' && window.switchMode) window.switchMode('shots');
        // #410: mobile no longer shows the shot list as a drawer over the
        // detail view — tapping a shot navigates from the primary list
        // screen to the detail screen (back chevron returns to the list).
        if (window.innerWidth <= 768) {
          setMobileShotSubview('detail');
          setTimeout(() => { if (window.updateView) window.updateView(); }, 50);
        } else {
          if (window.updateView) window.updateView();
        }
      }
    };

    // #367: clicking the shot photo opens it full-size (same lightbox as
    // the annotation panel's own photo, openShotPhotoLightbox() in
    // shots/annotation.js) instead of just selecting the row.
    const thumbEl = divShot.querySelector('.shot-thumb');
    if (thumbEl) {
      thumbEl.style.cursor = 'pointer';
      thumbEl.onclick = e => { e.stopPropagation(); if (thumbEl.src) openLightbox(thumbEl.src); };
    }

    const btnCmp = document.createElement('button');
    btnCmp.className = 'compare-btn';
    btnCmp.innerHTML = '⇄';
    btnCmp.title = t('btn_compare_tooltip');
    btnCmp.onclick = e => { e.stopPropagation(); toggleCompare(shot.id); };

    const btnDel = document.createElement('button');
    btnDel.className = 'delete-btn';
    btnDel.innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16" aria-hidden="true"><path d="M6,19A2,2 0 0,0 8,21H16A2,2 0 0,0 18,19V7H6V19M8,9H10V19H8V9M14,9H16V19H14V9M15.5,4L14.5,3H9.5L8.5,4H5V6H19V4H15.5Z"/></svg>';
    btnDel.title = t('btn_delete_tooltip');
    btnDel.onclick = e => { e.stopPropagation(); if (window.trashShot) window.trashShot(shot.id); };

    wrapper.appendChild(divShot);
    wrapper.appendChild(btnCmp);
    wrapper.appendChild(btnDel);
    return wrapper;
}

// #439: restores the pre-#399 month-accordion toggle — flips the body's
// display and the header's chevron, and tracks expanded state in the
// in-memory S._expandedMonths Set so it survives renderSidebar() re-renders
// within the session (never persisted to localStorage).
export function toggleMonthGroup(key) {
  const body = document.getElementById(`monthGroup-${key}`);
  const btn = document.querySelector(`[data-action="toggle-month-group"][data-id="${key}"]`);
  if (!body) return;
  const willExpand = body.style.display === 'none';
  body.style.display = willExpand ? '' : 'none';
  if (btn) btn.textContent = `${willExpand ? '▾' : '▸'} ${btn.textContent.replace(/^[▾▸]\s*/, '')}`;
  if (willExpand) S._expandedMonths.add(key); else S._expandedMonths.delete(key);
}

export function toggleCompare(id) {
  if (S.primaryShotId === id) return;
  S.compareShotId = (S.compareShotId === id) ? null : id;
  if (S.compareShotId) localStorage.setItem('glp_compareShotId', S.compareShotId);
  else localStorage.removeItem('glp_compareShotId');
  updateSidebarHighlighting();
  if (window.updateView) window.updateView();
}

export function updateSidebarHighlighting() {
  document.querySelectorAll('.shot-wrapper').forEach(x => {
    x.classList.remove('active', 'compare-active');
    const id = parseInt(x.id.replace('wrapper-', ''));
    if (id === S.primaryShotId) x.classList.add('active');
    if (id === S.compareShotId) x.classList.add('compare-active');
  });
}

export function filterShots(query) {
  S.currentFilter = query;
  const q = query.trim().toLowerCase();
  document.querySelectorAll('#shots .shot-wrapper').forEach(wrapper => {
    const id = parseInt(wrapper.id.replace('wrapper-', ''));
    const shot = S.shots.find(s => s.id === id);
    if (!shot) { wrapper.style.display = 'none'; return; }
    const ann = shot.annotation || {};
    const haystack = [
      shot.profile?.name || shot.profileName || '',
      ann.coffee || '',
      ann.grinder || '',
      ann.notes || ''
    ].join(' ').toLowerCase();
    wrapper.style.display = (!q || haystack.includes(q)) ? '' : 'none';
  });
  // #412: a day-separator header with every shot underneath it filtered out
  // would otherwise sit there empty — hide it too, until the next visible
  // shot-wrapper sibling (i.e. the next day-sep, month-header or the list's
  // end). Month-tier siblings are skipped here (handled separately below)
  // rather than counted as "visible", since their own display isn't a
  // signal about this day-sep's shots.
  document.querySelectorAll('#shots .day-sep').forEach(sep => {
    let sib = sep.nextElementSibling;
    let hasVisible = false;
    while (sib && !sib.classList.contains('day-sep') && !sib.classList.contains('sidebar-month-header')) {
      if (sib.classList.contains('shot-wrapper') && sib.style.display !== 'none') { hasVisible = true; break; }
      sib = sib.nextElementSibling;
    }
    sep.style.display = hasVisible ? '' : 'none';
  });
  // #439: while actively searching, force every month group open so matches
  // nested inside a collapsed month are actually visible; hide the
  // header+body pair entirely if none of its shots match, and restore the
  // session's collapse state once the query is cleared (parity with the
  // pre-#399 behavior).
  document.querySelectorAll('#shots .sidebar-month-body').forEach(body => {
    const key = body.id.replace('monthGroup-', '');
    const header = document.querySelector(`[data-action="toggle-month-group"][data-id="${key}"]`);
    if (q) {
      const hasVisible = [...body.children].some(c => c.style.display !== 'none');
      body.style.display = hasVisible ? '' : 'none';
      if (header) header.style.display = hasVisible ? '' : 'none';
    } else {
      body.style.display = S._expandedMonths.has(key) ? '' : 'none';
      if (header) header.style.display = '';
    }
  });
}

export function setSortMode(mode) {
  if (S.currentSort === mode) {
    S.sortAsc = !S.sortAsc;
  } else {
    S.currentSort = mode;
    S.sortAsc = false;
  }
  const arrow = S.sortAsc ? ' ↑' : ' ↓';
  const labels = { newest: t('sort_newest'), score: t('sort_score'), rating: `${STAR_ICON_SVG} ${t('sort_rating')}`, duration: t('sort_duration') };
  document.querySelectorAll('.sort-btn').forEach(b => b.classList.remove('active'));
  const map = { newest: 'sortNewest', score: 'sortScore', rating: 'sortRating', duration: 'sortDur' };
  const activeBtn = document.getElementById(map[mode]);
  if (activeBtn) {
    activeBtn.classList.add('active');
    activeBtn.innerHTML = (labels[mode] || mode) + arrow;
  }
  renderSidebar();
}

export function sortedShots() {
  const list = [...S.shots];
  const dir = S.sortAsc ? 1 : -1;
  if (S.currentSort === 'newest')
    return S.sortAsc ? list : list.reverse();
  if (S.currentSort === 'score')
    return list.sort((a, b) => dir * (
      ((window.calcShotScore ? window.calcShotScore(b, window.getShotData(b)) : null) ?? -1) -
      ((window.calcShotScore ? window.calcShotScore(a, window.getShotData(a)) : null) ?? -1)
    ));
  if (S.currentSort === 'rating')
    return list.sort((a, b) => dir * ((b.annotation?.rating || 0) - (a.annotation?.rating || 0)));
  if (S.currentSort === 'duration')
    return list.sort((a, b) => dir * ((b.duration || 0) - (a.duration || 0)));
  return list.reverse();
}

// ── Split-flap counter ────────────────────────────────────────────────────
function _flapFlip(container, str) {
  [...str].forEach((ch, i) => {
    const cell = container.children[i];
    if (!cell || cell.dataset.val === ch) return;
    const oldCh = cell.dataset.val;
    cell.dataset.val = ch;
    const fold = document.createElement('div');
    fold.className = 'flap-fold';
    fold.innerHTML = `<span>${oldCh}</span>`;
    cell.appendChild(fold);
    setTimeout(() => {
      fold.classList.add('flipping');
      setTimeout(() => {
        cell.querySelector('.flap-half.top span').textContent = ch;
        cell.querySelector('.flap-half.bottom span').textContent = ch;
        fold.remove();
      }, 140);
    }, i * 55);
  });
}

// #333: loadData() and loadMachines() both race to call renderSidebar() on
// startup with no fixed order — if loadMachines() resolves first (its
// default-machine bootstrap re-filters S.shots from a still-empty
// S.allShots), the resulting 0-count call used to be treated as "the" first
// call, scheduling a deferred flip that then clobbered the real count back
// to zero once it arrived. Tracking the pending timeout lets a later call
// cancel it and win instead, the same way the header text (set synchronously
// on every renderSidebar() call, never deferred) already always shows the
// latest count.
let _flapInitTimeout = null;

export function updateFlapCounter(count) {
  const container = document.getElementById('flapDigits');
  if (!container) return;
  const str = String(count).padStart(Math.max(String(count).length, 4), '0');
  while (container.children.length < str.length) {
    const cell = document.createElement('div');
    cell.className = 'flap-cell';
    cell.dataset.val = '0';
    cell.innerHTML =
      '<div class="flap-half top"><span>0</span></div>' +
      '<div class="flap-half bottom"><span>0</span></div>';
    container.appendChild(cell);
  }
  if (!S._flapInitDone) {
    S._flapInitDone = true;
    _flapInitTimeout = setTimeout(() => { _flapInitTimeout = null; _flapFlip(container, str); }, 350);
  } else {
    if (_flapInitTimeout) { clearTimeout(_flapInitTimeout); _flapInitTimeout = null; }
    _flapFlip(container, str);
  }
}

// ── Desktop sidebar collapse ──────────────────────────────────────────────
export function toggleDesktopSidebar() {
  const sidebar = document.getElementById('sidebar');
  const expandBtn = document.getElementById('expandSidebarBtn');
  const collapseBtn = document.getElementById('collapseBtn');
  const collapsed = sidebar.classList.toggle('desktop-collapsed');
  if (expandBtn) expandBtn.classList.toggle('visible', collapsed);
  if (collapseBtn) collapseBtn.textContent = collapsed ? '›' : '‹';
  if (!collapsed) setTimeout(() => { if (window.updateView) window.updateView(); }, 320);
}

// ── Mobile shot list / detail sub-view (#410) ─────────────────────────────
// On mobile, the shot list (#sidebar) and the shot detail (#shots-view's
// chart-area) are two full-screen alternates of the Shots tab, not a
// permanently-docked column plus a drawer overlay — the list is the primary
// screen, tapping a shot pushes to the detail screen, and the back chevron
// (wired in main.js) returns to the list. Desktop is unaffected: it always
// shows both side by side regardless of S.mobileShotSubview.
export function setMobileShotSubview(view) {
  S.mobileShotSubview = view;
  updateMobileShotSidebarVisibility();
}

export function updateMobileShotSidebarVisibility() {
  const sidebar = document.getElementById('sidebar');
  const backBtn = document.getElementById('mobileBackBtn');
  const shotsView = document.getElementById('shots-view');
  if (!sidebar) return;
  // This function is the single authority for what mobile should show for
  // the current mode/subview — any leftover burger-drawer overlay state
  // (#425) is stale the moment mode/subview changes, so drop it instantly
  // rather than waiting for its own close animation.
  if (sidebar.classList.contains('sidebar-drawer-mode')) {
    sidebar.classList.remove('sidebar-drawer-mode', 'sidebar-drawer-open');
    document.getElementById('sidebar-drawer-backdrop')?.classList.remove('visible');
    document.getElementById('mobileDrawerBtn')?.setAttribute('aria-expanded', 'false');
  }
  if (window.innerWidth > 768) {
    // Desktop: clear any mobile-only inline override so the normal flex
    // column layout (set purely via CSS) applies again, e.g. after a
    // window resize back up past the breakpoint. #shots-view's own display
    // is switchMode()'s responsibility on desktop (mode === 'shots' or not).
    sidebar.style.display = '';
    if (backBtn) backBtn.style.display = 'none';
    return;
  }
  const inShotsMode = S.currentMode === 'shots';
  const showList = inShotsMode && S.mobileShotSubview !== 'detail';
  sidebar.style.display = showList ? 'flex' : 'none';
  if (backBtn) backBtn.style.display = (inShotsMode && !showList) ? 'flex' : 'none';
  // #410: mode.js already set #shots-view to display:flex for mode==='shots'
  // (side-by-side with the sidebar on desktop) — on mobile the list and the
  // detail are two full-screen alternates instead, so override it back to
  // 'none' while the list is the one showing.
  if (shotsView && inShotsMode) shotsView.style.display = showList ? 'none' : 'flex';
}

// ── Mobile burger drawer (#425) ───────────────────────────────────────────
// Additive access path to the shot list from any view/mode on mobile — the
// bottom-nav-driven Shots-primary-screen flow above is untouched by this;
// the drawer just layers #sidebar on top as an overlay with a backdrop,
// then hands back to updateMobileShotSidebarVisibility() once fully closed
// so whatever the current mode/subview would normally show resumes.
let _drawerTouchStartX = null;

export function openShotDrawer() {
  const sidebar = document.getElementById('sidebar');
  const backdrop = document.getElementById('sidebar-drawer-backdrop');
  const btn = document.getElementById('mobileDrawerBtn');
  if (!sidebar || window.innerWidth > 768) return;
  sidebar.classList.add('sidebar-drawer-mode');
  sidebar.style.display = 'flex';
  backdrop?.classList.add('visible');
  btn?.setAttribute('aria-expanded', 'true');
  // Force layout before adding the open class so the transform transition
  // actually plays instead of starting already-open.
  requestAnimationFrame(() => sidebar.classList.add('sidebar-drawer-open'));
}

export function closeShotDrawer() {
  const sidebar = document.getElementById('sidebar');
  const backdrop = document.getElementById('sidebar-drawer-backdrop');
  const btn = document.getElementById('mobileDrawerBtn');
  if (!sidebar || !sidebar.classList.contains('sidebar-drawer-mode')) return;
  sidebar.classList.remove('sidebar-drawer-open');
  backdrop?.classList.remove('visible');
  btn?.setAttribute('aria-expanded', 'false');
  setTimeout(() => {
    sidebar.classList.remove('sidebar-drawer-mode');
    updateMobileShotSidebarVisibility();
  }, 260); // matches the CSS slide transition duration
}

export function handleDrawerTouchStart(e) {
  const sidebar = document.getElementById('sidebar');
  if (!sidebar?.classList.contains('sidebar-drawer-open')) return;
  _drawerTouchStartX = e.touches[0].clientX;
}

export function handleDrawerTouchEnd(e) {
  if (_drawerTouchStartX == null) return;
  const deltaX = e.changedTouches[0].clientX - _drawerTouchStartX;
  _drawerTouchStartX = null;
  if (deltaX < -60) closeShotDrawer(); // swipe left closes (drawer opens from the left edge)
}

// ── selectShot (used from dialin onclick) ────────────────────────────────
export function selectShot(id) {
  if (S.primaryShotId !== id && window.flushAutoSave) window.flushAutoSave(); // #430
  S.primaryShotId = id;
  S.compareShotId = null;
  localStorage.setItem('glp_primaryShotId', id);
  localStorage.removeItem('glp_compareShotId');
  updateSidebarHighlighting();
  if (window.updateView) window.updateView();
}
