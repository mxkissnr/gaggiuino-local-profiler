import './style.css';

import { S } from './state.js';
import { initToken, apiFetch } from './api.js';
import { t, setLang, applyTranslations } from './i18n.js';

import { renderSidebar, updateSidebarHighlighting, filterShots, setSortMode, sortedShots, updateFlapCounter,
         toggleDesktopSidebar, openSidebar, closeSidebar, toggleSidebar, collapseSidebarOnMobile, selectShot } from './components/sidebar.js';
import { updateStatus, updatePowerButton, toggleMachinePower, triggerSync } from './components/status.js';
import { switchMode, goToShot } from './components/mode.js';

import { getShotData, calcShotScore, loadData, loadTrashData, renderTrash, toggleTrash,
         trashShot, restoreShot, permanentDeleteShot,
         renderAnnotationPanel, renderStars, quickClone, saveAnnotation, scheduleAutoSave, updateDegassing,
         updateView, switchChartTab, updatePQChart,
         openChartFullscreen, closeChartFullscreen, switchFsTab,
         exportCSV, exportAllCSV, exportShot, exportProfile, restoreFromFile,
         loadDrinkMenu, selectDrinkType } from './views/shots.js';

import { initLiveChart, populateRefSelector, autoApplyRefShot, onRefShotChange, clearReferenceShot,
         connectLiveStream, disconnectLiveStream, setLiveBadge, handleLiveData,
         fetchPreheatData, updatePreheatWidget, fetchLiveData } from './views/live.js';

import { initAnalytics, setTrendWindow, buildCalendar, buildTrendChart, buildBeanStats, buildProfileChart, _renderCalendar } from './views/analytics.js';

import { loadMaintenanceView, markMaintDone, saveMaintThreshold, setMaintMode,
         renderMaintenanceCards, maintStatusLabel, _buildMaintCard } from './views/maintenance.js';

import { loadOrdersView, startOrdersPolling, stopOrdersPolling, setOrdersEnabled,
         toggleOrdersMenu, addOrderMenuItem, toggleOrdersStats, toggleOrdersNotify,
         renderOrdersList, renderOrderCard, renderOrdersMenuAdmin, renderOrdersStats,
         acceptOrder, toggleDeclineRow, submitDecline, completeOrder,
         deleteOrder, clearOrderHistory,
         loadNotifyMappingView, saveNotifyMapping,
         _updateOrdersToggleUI, _orderTimeAgo } from './views/orders.js';

import { loadLibrary, updateLibraryDatalist, switchLibTab, renderBeanList, renderGrinderList,
         openBeanForm, closeBeanForm, editBean, saveBean, deleteBean,
         openGrinderForm, closeGrinderForm, editGrinder, saveGrinder, deleteGrinder,
         toggleBeanQR, generateBeanQR,
         toggleUrlImport, importFromUrl,
         openScanModal, closeScanModal, _runScanLoop, _handleScanResult } from './views/library.js';

import { renderDialin } from './views/dialin.js';

// ── Toast helper ──────────────────────────────────────────────────────────
function showToast(msg, duration = 3000) {
  let el = document.getElementById('glpToast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'glpToast';
    el.style.cssText = [
      'position:fixed', 'bottom:24px', 'left:50%', 'transform:translateX(-50%)',
      'background:#27272a', 'color:#e4e4e7', 'padding:10px 20px', 'border-radius:8px',
      'font-size:.85rem', 'z-index:9999', 'box-shadow:0 4px 12px rgba(0,0,0,.4)',
      'transition:opacity .3s', 'pointer-events:none', 'white-space:nowrap',
    ].join(';');
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.style.opacity = '1';
  clearTimeout(el._t);
  el._t = setTimeout(() => { el.style.opacity = '0'; }, duration);
}

// ── Expose everything on window (for HTML onclick handlers) ───────────────
Object.assign(window, {
  // state & i18n
  S,
  t,
  setLang,
  applyTranslations,

  // theme
  setTheme: (theme) => {
    localStorage.setItem('glp_theme', theme);
    document.documentElement.dataset.theme = theme;
    document.querySelectorAll('.theme-btn').forEach(b =>
      b.classList.toggle('active', b.dataset.themeVal === theme));
  },

  // api
  initToken,
  apiFetch,

  // sidebar
  renderSidebar,
  updateSidebarHighlighting,
  filterShots,
  setSortMode,
  sortedShots,
  updateFlapCounter,
  toggleDesktopSidebar,
  openSidebar,
  closeSidebar,
  toggleSidebar,
  collapseSidebarOnMobile,
  selectShot,

  // status / machine
  updateStatus,
  updatePowerButton,
  toggleMachinePower,
  triggerSync,

  // mode switcher
  switchMode,
  goToShot,

  // shots view
  getShotData,
  calcShotScore,
  loadData,
  loadTrashData,
  renderTrash,
  toggleTrash,
  trashShot,
  restoreShot,
  permanentDeleteShot,
  renderAnnotationPanel,
  renderStars,
  quickClone,
  saveAnnotation,
  scheduleAutoSave,
  selectDrinkType,
  loadDrinkMenu,
  updateDegassing,
  updateView,
  switchChartTab,
  updatePQChart,
  openChartFullscreen,
  closeChartFullscreen,
  switchFsTab,
  exportCSV,
  exportAllCSV,
  exportShot,
  exportProfile,
  restoreFromFile,

  // live view
  initLiveChart,
  populateRefSelector,
  autoApplyRefShot,
  onRefShotChange,
  clearReferenceShot,
  connectLiveStream,
  disconnectLiveStream,
  setLiveBadge,
  handleLiveData,
  fetchPreheatData,
  updatePreheatWidget,
  fetchLiveData,

  // analytics view
  initAnalytics,
  setTrendWindow,
  buildCalendar,
  buildTrendChart,
  buildBeanStats,
  buildProfileChart,
  _renderCalendar,

  // maintenance view
  loadMaintenanceView,
  markMaintDone,
  saveMaintThreshold,
  setMaintMode,
  renderMaintenanceCards,
  maintStatusLabel,
  _buildMaintCard,

  // orders view
  loadOrdersView,
  startOrdersPolling,
  stopOrdersPolling,
  setOrdersEnabled,
  toggleOrdersMenu,
  addOrderMenuItem,
  toggleOrdersStats,
  toggleOrdersNotify,
  renderOrdersList,
  renderOrderCard,
  renderOrdersMenuAdmin,
  renderOrdersStats,
  acceptOrder,
  toggleDeclineRow,
  submitDecline,
  completeOrder,
  deleteOrder,
  clearOrderHistory,
  loadNotifyMappingView,
  saveNotifyMapping,
  _updateOrdersToggleUI,
  _orderTimeAgo,

  // library view
  loadLibrary,
  updateLibraryDatalist,
  switchLibTab,
  renderBeanList,
  renderGrinderList,
  openBeanForm,
  closeBeanForm,
  editBean,
  saveBean,
  deleteBean,
  openGrinderForm,
  closeGrinderForm,
  editGrinder,
  saveGrinder,
  deleteGrinder,
  toggleBeanQR,
  generateBeanQR,
  toggleUrlImport,
  importFromUrl,
  openScanModal,
  closeScanModal,
  _runScanLoop,
  _handleScanResult,

  // dialin view
  renderDialin,

  // toast
  showToast,
});

// ── Star rating event listeners ───────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  const starRating = document.getElementById('starRating');
  if (starRating) {
    starRating.addEventListener('mouseover', e => {
      const star = e.target.closest('.star');
      if (!star) return;
      const val = parseInt(star.dataset.val);
      starRating.querySelectorAll('.star').forEach(s => {
        s.classList.toggle('hovered', parseInt(s.dataset.val) <= val);
      });
    });
    starRating.addEventListener('mouseout', () => {
      starRating.querySelectorAll('.star').forEach(s => s.classList.remove('hovered'));
    });
    starRating.addEventListener('click', e => {
      const star = e.target.closest('.star');
      if (!star) return;
      const val = parseInt(star.dataset.val);
      S.currentRating = S.currentRating === val ? 0 : val;
      renderStars(S.currentRating);
      if (window.scheduleAutoSave) window.scheduleAutoSave();
    });
  }

  // ── annCoffee: auto-fill roast date from library bean ──────────────────
  const annCoffee = document.getElementById('annCoffee');
  if (annCoffee) {
    annCoffee.addEventListener('change', () => {
      const name = annCoffee.value.trim();
      if (!name || !S.coffeeLibrary) return;
      const bean = S.coffeeLibrary.beans?.find(b => b.name === name);
      if (!bean || !bean.roastDate) return;
      const annRoastDate = document.getElementById('annRoastDate');
      if (annRoastDate && !annRoastDate.value) {
        annRoastDate.value = bean.roastDate;
        updateDegassing(bean.roastDate);
      }
    });
  }

  // ── Keyboard navigation: left/right arrows between shots ──────────────
  document.addEventListener('keydown', e => {
    if (S.currentMode !== 'shots') return;
    // Ignore if focus is in an input/textarea
    const tag = document.activeElement?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

    const shots = sortedShots();
    if (!shots.length) return;
    const idx = shots.findIndex(s => s.id === S.primaryShotId);

    if (e.key === 'ArrowRight') {
      const next = shots[idx + 1];
      if (next) selectShot(next.id);
    } else if (e.key === 'ArrowLeft') {
      const prev = shots[idx - 1];
      if (prev) selectShot(prev.id);
    }
  });

  // ── Theme ──────────────────────────────────────────────────────────────
  const _applyTheme = (theme) => {
    document.documentElement.dataset.theme = theme;
    document.querySelectorAll('.theme-btn').forEach(b =>
      b.classList.toggle('active', b.dataset.themeVal === theme));
  };
  _applyTheme(localStorage.getItem('glp_theme') || 'dark');

  // ── Init sequence ──────────────────────────────────────────────────────
  applyTranslations();

  initToken().then(() => {
    loadDrinkMenu();
    loadData();
    loadLibrary();
    updateStatus();
  });

  setInterval(updateStatus, 30000);
  collapseSidebarOnMobile();

  // ── Service worker ──────────────────────────────────────────────────────
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }
});
