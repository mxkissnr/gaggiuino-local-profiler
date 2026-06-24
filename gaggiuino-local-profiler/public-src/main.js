import './style.css';

import { S } from './state.js';
import { initToken, apiFetch } from './api.js';
import { t, setLang, applyTranslations } from './i18n.js';

import { renderSidebar, updateSidebarHighlighting, filterShots, setSortMode, sortedShots, updateFlapCounter,
         toggleDesktopSidebar, openSidebar, closeSidebar, toggleSidebar, collapseSidebarOnMobile, selectShot } from './components/sidebar.js';
import { updateStatus, updatePowerButton, toggleMachinePower, triggerSync } from './components/status.js';
import { checkForUpdate } from './components/update-check.js';
import { switchMode, goToShot } from './components/mode.js';

import { getShotData, calcShotScore, loadData, loadTrashData, renderTrash, toggleTrash,
         trashShot, restoreShot, permanentDeleteShot,
         renderAnnotationPanel, renderStars, quickClone, saveAnnotation, scheduleAutoSave, updateDegassing, calcBeanAgeAtShot,
         updateView, switchChartTab, updatePQChart,
         openChartFullscreen, closeChartFullscreen, switchFsTab,
         exportCSV, exportAllCSV, exportShot, exportProfile, restoreFromFile,
         loadDrinkMenu, loadMilkTypes, selectDrinkType, selectMilkType } from './views/shots.js';

import { initLiveChart, populateRefSelector, autoApplyRefShot, onRefShotChange, clearReferenceShot,
         connectLiveStream, disconnectLiveStream, setLiveBadge, handleLiveData,
         fetchPreheatData, updatePreheatWidget, fetchLiveData } from './views/live.js';

import { initAnalytics, setTrendWindow, buildCalendar, buildTrendChart, buildBeanStats, buildProfileChart, _renderCalendar } from './views/analytics.js';

import { loadMaintenanceView, markMaintDone, saveMaintThreshold, setMaintMode,
         renderMaintenanceCards, maintStatusLabel, _buildMaintCard,
         openMaintLogForm, closeMaintLogForm, submitMaintLogEntry, deleteMaintLogEntry } from './views/maintenance.js';

import { loadOrdersView, startOrdersPolling, stopOrdersPolling, setOrdersEnabled,
         toggleOrdersMenu, addOrderMenuItem, toggleOrdersStats, toggleOrdersNotify,
         renderOrdersList, renderOrderCard, renderOrdersMenuAdmin, renderOrdersStats,
         acceptOrder, toggleDeclineRow, submitDecline, completeOrder,
         deleteOrder, clearOrderHistory,
         loadNotifyMappingView, saveNotifyMapping, saveBroadcastRecipients, saveBaristaNotify,
         _updateOrdersToggleUI, _orderTimeAgo } from './views/orders.js';

import { loadLibrary, updateLibraryDatalist, switchLibTab, renderBeanList, renderGrinderList,
         openBeanForm, closeBeanForm, editBean, saveBean, deleteBean,
         openGrinderForm, closeGrinderForm, editGrinder, saveGrinder, deleteGrinder,
         toggleBeanQR, generateBeanQR,
         toggleBagHistory, openNewBagForm, closeNewBagForm, saveNewBag, deleteBag,
         openRecipeForm, closeRecipeForm, editRecipe, saveRecipe, deleteRecipe, renderRecipeList,
         addRecipeStep, removeRecipeStep,
         toggleUrlImport, importFromUrl,
         openScanModal, closeScanModal, _runScanLoop, _handleScanResult,
         renderMilkList, openMilkForm, closeMilkForm, saveMilk, restockMilk, deleteMilk } from './views/library.js';

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
  setAccentTheme: (name) => {
    localStorage.setItem('glp_accent_theme', name);
    document.documentElement.dataset.accent = name;
    document.querySelectorAll('.accent-swatch').forEach(b =>
      b.classList.toggle('active', b.dataset.accent === name));
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

  // update check
  checkForUpdate,

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
  selectMilkType,
  loadDrinkMenu,
  loadMilkTypes,
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
  openMaintLogForm,
  closeMaintLogForm,
  submitMaintLogEntry,
  deleteMaintLogEntry,

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
  saveBroadcastRecipients,
  saveBaristaNotify,
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
  toggleBagHistory,
  openNewBagForm,
  closeNewBagForm,
  saveNewBag,
  deleteBag,
  openRecipeForm,
  closeRecipeForm,
  editRecipe,
  saveRecipe,
  deleteRecipe,
  renderRecipeList,
  addRecipeStep,
  removeRecipeStep,
  toggleUrlImport,
  importFromUrl,
  openScanModal,
  closeScanModal,
  _runScanLoop,
  _handleScanResult,
  renderMilkList,
  openMilkForm,
  closeMilkForm,
  saveMilk,
  restockMilk,
  deleteMilk,

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

  // ── annCoffee: auto-fill roast date + show bean age hint ───────────────
  const annCoffee = document.getElementById('annCoffee');
  if (annCoffee) {
    annCoffee.addEventListener('change', () => {
      const name = annCoffee.value.trim();
      const hintEl = document.getElementById('beanAgeHint');
      if (!name || !S.coffeeLibrary) { if (hintEl) hintEl.style.display = 'none'; return; }

      const bean = S.coffeeLibrary.beans?.find(b => b.name === name);
      if (!bean) { if (hintEl) hintEl.style.display = 'none'; return; }

      // Find roast date from the active bag at shot time
      const shot   = S.primaryShotId ? S.shots?.find(s => s.id === S.primaryShotId) : null;
      const shotMs = shot ? shot.timestamp * 1000 : Date.now();
      const bags   = Array.isArray(bean.bags) ? bean.bags : [];
      let roastDate = bean.roastDate;
      if (bags.length) {
        const activeBag = bags
          .filter(b => (b.openedAt || 0) <= shotMs)
          .sort((a, b) => b.openedAt - a.openedAt)[0];
        if (activeBag?.roastDate) roastDate = activeBag.roastDate;
      }

      // Auto-fill roast date from library (always update when coffee changes)
      const annRoastDate = document.getElementById('annRoastDate');
      if (annRoastDate && roastDate) {
        annRoastDate.value = roastDate;
        updateDegassing(roastDate);
      }

      // Show bean age hint
      const ageDays = calcBeanAgeAtShot(name, shot?.timestamp);
      if (hintEl && ageDays != null) {
        hintEl.textContent = t('bean_age_at_shot', ageDays);
        hintEl.style.display = '';
      } else if (hintEl) {
        hintEl.style.display = 'none';
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

  const _savedAccent = localStorage.getItem('glp_accent_theme') || 'amber';
  document.documentElement.dataset.accent = _savedAccent;
  document.querySelectorAll('.accent-swatch').forEach(b =>
    b.classList.toggle('active', b.dataset.accent === _savedAccent));

  // ── Init sequence ──────────────────────────────────────────────────────
  applyTranslations();

  initToken().then(() => {
    loadDrinkMenu();
    loadMilkTypes();
    loadData();
    loadLibrary();
    updateStatus();
    checkForUpdate();
  });

  setInterval(updateStatus, 30000);
  collapseSidebarOnMobile();

});
