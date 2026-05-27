import { S } from '../state.js';
import { t } from '../i18n.js';
import { LOCALE_MAP } from '../constants.js';
import { esc, scoreClass } from '../utils.js';

// These are imported lazily via window to avoid circular dependencies
// updateView is on window, calcShotScore/getShotData are set from shots.js

export function renderSidebar() {
  const el = document.getElementById('shots');
  el.innerHTML = '';
  const countEl = document.getElementById('shot-count');
  if (countEl) countEl.textContent = `(${S.shots.length})`;
  updateFlapCounter(S.shots.length);

  sortedShots().forEach(shot => {
    const wrapper = document.createElement('div');
    wrapper.className = 'shot-wrapper';
    wrapper.id = `wrapper-${shot.id}`;

    const divShot = document.createElement('div');
    divShot.className = 'shot';

    const date = new Date(shot.timestamp * 1000);
    const profileName = shot.profile?.name || shot.profileName || 'Unknown Profile';
    const ann = shot.annotation || {};

    const coffeeHtml = ann.coffee
      ? `<div class="coffee-name-sidebar">${esc(ann.coffee)}${ann.dose ? ` · ${esc(String(ann.dose))}g` : ''}</div>` : '';
    const starsHtml = ann.rating
      ? `<div class="sidebar-stars">${'★'.repeat(ann.rating)}${'☆'.repeat(5 - ann.rating)}</div>` : '';

    const sc = window.calcShotScore ? window.calcShotScore(shot, window.getShotData(shot)) : null;
    const scorePill = sc !== null
      ? `<span class="sidebar-score ss-${scoreClass(sc).replace('score-', '')}">${sc}</span>`
      : '';
    const drinkItem = ann.drinkType && S.drinkMenu?.find(m => m.id === ann.drinkType);
    const drinkHtml = drinkItem
      ? `<span class="sidebar-drink-badge">${drinkItem.emoji} ${esc(drinkItem.name)}</span>`
      : '';
    divShot.innerHTML = `
      <div class="profile-name-sidebar">${esc(profileName)}${scorePill}</div>
      ${coffeeHtml}
      <div class="shotid-sidebar">Shot ${esc(String(shot.id))}${ann.grinder ? ` · ${esc(ann.grinder)}` : ''}${drinkHtml}</div>
      <div class="date-sidebar">${esc(date.toLocaleString(LOCALE_MAP[S.currentLang] || 'de-DE'))}</div>
      ${starsHtml}
    `;

    divShot.onclick = e => {
      if (e.ctrlKey || e.metaKey) { toggleCompare(shot.id); }
      else {
        S.primaryShotId = shot.id; S.compareShotId = null;
        localStorage.setItem('glp_primaryShotId', shot.id);
        localStorage.removeItem('glp_compareShotId');
        updateSidebarHighlighting();
        if (S.currentMode !== 'shots' && window.switchMode) window.switchMode('shots');
        collapseSidebarOnMobile();
        if (window.innerWidth <= 768) {
          setTimeout(() => { if (window.updateView) window.updateView(); }, 50);
        } else {
          if (window.updateView) window.updateView();
        }
      }
    };

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
    el.appendChild(wrapper);
  });
  updateSidebarHighlighting();
  if (S.currentFilter) filterShots(S.currentFilter);
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
}

export function setSortMode(mode) {
  if (S.currentSort === mode) {
    S.sortAsc = !S.sortAsc;
  } else {
    S.currentSort = mode;
    S.sortAsc = false;
  }
  const arrow = S.sortAsc ? ' ↑' : ' ↓';
  const labels = { newest: t('sort_newest'), score: t('sort_score'), rating: `⭐ ${t('sort_rating')}`, duration: t('sort_duration') };
  document.querySelectorAll('.sort-btn').forEach(b => b.classList.remove('active'));
  const map = { newest: 'sortNewest', score: 'sortScore', rating: 'sortRating', duration: 'sortDur' };
  const activeBtn = document.getElementById(map[mode]);
  if (activeBtn) {
    activeBtn.classList.add('active');
    activeBtn.textContent = (labels[mode] || mode) + arrow;
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
    setTimeout(() => _flapFlip(container, str), 350);
  } else {
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

// ── Sidebar overlay (mobile) ──────────────────────────────────────────────
export function openSidebar() {
  document.getElementById('sidebar').classList.add('open');
  document.getElementById('sidebar-backdrop').classList.add('visible');
  const btn = document.getElementById('sidebarToggle');
  if (btn) btn.textContent = '✕';
}

export function closeSidebar() {
  document.getElementById('sidebar').classList.remove('open');
  document.getElementById('sidebar-backdrop').classList.remove('visible');
}

export function toggleSidebar() {
  const sidebar = document.getElementById('sidebar');
  sidebar.classList.contains('open') ? closeSidebar() : openSidebar();
}

export function collapseSidebarOnMobile() {
  if (window.innerWidth <= 768) closeSidebar();
}

// ── selectShot (used from dialin onclick) ────────────────────────────────
export function selectShot(id) {
  S.primaryShotId = id;
  S.compareShotId = null;
  localStorage.setItem('glp_primaryShotId', id);
  localStorage.removeItem('glp_compareShotId');
  updateSidebarHighlighting();
  if (window.updateView) window.updateView();
}
