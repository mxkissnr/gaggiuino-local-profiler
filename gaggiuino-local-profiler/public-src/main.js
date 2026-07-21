import './style.css';

// One-time cleanup for the v1.102.0 service worker (reverted in v1.102.1):
// a client that already registered it keeps it active indefinitely — the
// server no longer trying to re-register does nothing for those clients.
//
// IMPORTANT — the ingress-origin trap (#387): when GLP is loaded through HA
// Ingress, this page's origin IS Home Assistant's own origin, and
// getRegistrations() returns every service worker registered for that
// origin — including HA frontend's own. Unregistering unconditionally used
// to also unregister HA's SW; HA re-registers it and clients.claim() fires
// a controllerchange event that made HA's frontend reload every open tab.
// Only ever touch GLP's own registration (matched by its exact script URL),
// never anything else sharing the origin.
if ('serviceWorker' in navigator) {
  const ownScriptURL = new URL('sw.js', location.href).href;
  navigator.serviceWorker.getRegistrations()
    .then(regs => Promise.all(
      regs
        .filter(r => [r.active, r.waiting, r.installing].some(w => w?.scriptURL === ownScriptURL))
        .map(r => r.unregister())
    ))
    .catch(() => {});
}

// Installable PWA (v1.112.0): register the app-shell service worker, but only
// when the server actually injected the manifest link into this page — see
// server.js's isIngressRequest()/index.html route. Requests arriving through
// HA Ingress (the Companion App's embedded WebView) never get that link, so
// this branch never runs there, which is the structural fix for the
// v1.102.0 regression (that SW's fetch interception broke the Companion
// App's live shot graph — see CHANGELOG).
if ('serviceWorker' in navigator && document.querySelector('link[rel="manifest"]')) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

import { S } from './state.js';
import { initToken, apiFetch } from './api.js';
import { t, setLang, applyTranslations } from './i18n.js';
import { generateBeanQR } from './glp-qr.js';

import { renderSidebar, updateSidebarHighlighting, filterShots, setSortMode, sortedShots, updateFlapCounter,
         toggleDesktopSidebar, setMobileShotSubview, updateMobileShotSidebarVisibility, selectShot } from './components/sidebar.js';
import { updateStatus, updatePowerButton, toggleMachinePower, triggerSync } from './components/status.js';
import { checkForUpdate } from './components/update-check.js';
import { switchMode, goToShot } from './components/mode.js';

import { getShotData, calcShotScore, loadData, loadTrashData, renderTrash, toggleTrash,
         trashShot, restoreShot, permanentDeleteShot,
         renderAnnotationPanel, renderStars, quickClone, saveAnnotation, scheduleAutoSave, updateDegassing, calcBeanAgeAtShot,
         suggestGrindDoseForBean,
         uploadShotImage, removeShotImage, openShotPhotoLightbox,
         updateView, switchChartTab, updatePQChart,
         openChartFullscreen, closeChartFullscreen, switchFsTab,
         exportCSV, exportAllCSV, exportShot, exportProfile, shareCard, restoreFromFile, downloadBackup,
         loadDrinkMenu, loadMilkTypes, selectDrinkType, selectMilkType } from './views/shots.js';

import { initLiveChart, populateRefSelector, autoApplyRefShot, onRefShotChange, clearReferenceShot,
         connectLiveStream, disconnectLiveStream, setLiveBadge, handleLiveData,
         fetchPreheatData, updatePreheatWidget, fetchLiveData } from './views/live.js';

import { initAnalytics, setTrendWindow, buildCalendar, buildTrendChart, buildBeanStats, buildProfileChart, _renderCalendar,
         setBeanRankSort, setDialinProgressionBean } from './views/analytics.js';

import { loadMaintenanceView, markMaintDone, saveMaintThreshold, setMaintMode, setMaintScope,
         renderMaintenanceDashboard, maintStatusLabel,
         openMaintLogForm, closeMaintLogForm, submitMaintLogEntry, deleteMaintLogEntry,
         openGuidedMaint, closeGuidedMaint, submitGuidedMaint, updateGuidedMaintDoneState } from './views/maintenance.js';
import { openFlavorWheel, closeFlavorWheel, zoomFlavorWheelTo } from './components/flavor-wheel.js';

import { loadOrdersView, startOrdersPolling, stopOrdersPolling, setOrdersEnabled,
         toggleOrdersMenu, addOrderMenuItem, toggleOrdersStats, toggleOrdersNotify,
         renderOrdersList, renderOrderCard, renderOrdersMenuAdmin, renderOrdersStats,
         acceptOrder, toggleDeclineRow, submitDecline, completeOrder,
         deleteOrder, clearOrderHistory,
         loadNotifyMappingView, saveNotifyMapping, saveBroadcastRecipients, saveBaristaNotify,
         _updateOrdersToggleUI, _orderTimeAgo } from './views/orders.js';

import { loadLibrary, updateLibraryDatalist, switchLibTab, renderBeanList, renderGrinderList,
         openBeanForm, closeBeanForm, editBean, saveBean, deleteBean, toggleBeanActive, uploadBeanImage,
         openGrinderForm, closeGrinderForm, editGrinder, saveGrinder, deleteGrinder, uploadGrinderImage, resetGrinderBurrs,
         toggleBeanQR,
         toggleBagHistory, openNewBagForm, closeNewBagForm, saveNewBag, deleteBag,
         openBeanStockEdit, closeBeanStockEdit, saveBeanStock,
         openRecipeForm, closeRecipeForm, editRecipe, saveRecipe, deleteRecipe, renderRecipeList,
         addRecipeStep, removeRecipeStep,
         toggleUrlImport, importFromUrl,
         toggleImportSettings, addCustomShopifyDomain,
         openScanModal, closeScanModal, _runScanLoop, _handleScanResult,
         renderMilkList, openMilkForm, closeMilkForm, saveMilk, restockMilk, deleteMilk } from './views/library.js';

import { loadMachineProfileList, updateProfileDatalist, renderProfileList,
         editProfile, deleteMachineProfile, openProfileForm, closeProfileForm, openNewProfileForm,
         createProfileFromBean, applyBeanSuggestion, addProfilePhase, removeProfilePhase,
         sendProfileToMachine, renderProfilePreviewChart } from './views/library-profile-editor.js';

import { renderDialin } from './views/dialin.js';

import { openDialinWizard, closeDialinWizard, startDialinFromBean, renderDialinWizard, dialinGrinderChange,
         dialinConfirmShot, dialinAcceptNext, dialinOverride, dialinEnd, dialinSaveKnownGrind,
         dialinClose } from './views/dialin-wizard.js';

import { startProfileDialinFromList, profileDialinClose,
         profileDialinToggleSymptom, profileDialinAcceptNext, profileDialinOverride,
         profileDialinEnd, profileDialinConfirmShot } from './views/profile-dialin-wizard.js';

import { loadDemoData, endDemo } from './components/onboarding.js';

import { loadMachines, openMachineForm, closeMachineForm, saveMachineForm, testMachineForm, switchActiveMachine, renderMachinesList } from './components/machines-settings.js';

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

// ── API token (Settings view) ──────────────────────────────────────────────
// Shown only once a session actually holds a token — i.e. it came through HA
// Ingress or a Supervisor-internal caller. Unauthenticated LAN callers never
// reach this point since S.glpToken stays empty for them (see api.js).
function renderApiTokenCard() {
  const card = document.getElementById('apiTokenCard');
  const valueEl = document.getElementById('apiTokenValue');
  if (!card || !valueEl) return;
  if (!S.glpToken) { card.style.display = 'none'; return; }
  valueEl.textContent = S.glpToken;
  card.style.display = '';
}

function copyApiToken() {
  if (!S.glpToken) return;
  navigator.clipboard?.writeText(S.glpToken)
    .then(() => showToast(t('settings_api_token_copied')))
    .catch(() => {});
}

// ── Desktop nav rail collapse (#411) ────────────────────────────────────────
// Persisted separately from the shot-sidebar's own collapse (#collapseBtn /
// glp_rail_collapsed vs. the sidebar's desktop-collapsed class, which isn't
// persisted) — the two are independent surfaces, see index.html/style.css.
const RAIL_COLLAPSED_KEY = 'glp_rail_collapsed';

function applyRailCollapsed(collapsed) {
  document.getElementById('rail')?.classList.toggle('rail-collapsed', collapsed);
  const toggleBtn = document.getElementById('railToggle');
  if (toggleBtn) toggleBtn.title = t(collapsed ? 'rail_expand' : 'rail_collapse');
}

function toggleRailCollapsed() {
  const collapsed = !document.getElementById('rail')?.classList.contains('rail-collapsed');
  applyRailCollapsed(collapsed);
  localStorage.setItem(RAIL_COLLAPSED_KEY, collapsed ? '1' : '0');
}

// ── Bottom navigation "Mehr" sheet (#403, mobile) ──────────────────────────
// Collapses Bezugslog/Wartung/Einstellungen (+ Bestellungen when enabled)
// behind the bottom nav's overflow entry — a small popover with its own
// backdrop-click-to-close, unrelated to the mobile shot-list/detail
// sub-view toggling in sidebar.js.
function toggleMoreSheet() {
  const open = document.getElementById('moreSheet').classList.toggle('open');
  document.getElementById('more-sheet-backdrop').classList.toggle('visible', open);
  document.getElementById('bnMore').setAttribute('aria-expanded', open ? 'true' : 'false');
}

function closeMoreSheet() {
  document.getElementById('moreSheet').classList.remove('open');
  document.getElementById('more-sheet-backdrop').classList.remove('visible');
  document.getElementById('bnMore').setAttribute('aria-expanded', 'false');
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
  setMobileShotSubview,
  updateMobileShotSidebarVisibility,
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
  setMaintScope,
  renderMaintenanceDashboard,
  maintStatusLabel,
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
  renderMachinesList,
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
  openBeanStockEdit,
  closeBeanStockEdit,
  saveBeanStock,
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
  toggleImportSettings,
  addCustomShopifyDomain,
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

  // profile editor view
  loadMachineProfileList,
  updateProfileDatalist,
  renderProfileList,
  editProfile,
  deleteMachineProfile,
  openProfileForm,
  closeProfileForm,
  openNewProfileForm,
  createProfileFromBean,
  applyBeanSuggestion,
  addProfilePhase,
  removeProfilePhase,
  sendProfileToMachine,
  renderProfilePreviewChart,

  // dialin view
  renderDialin,

  // guided dial-in wizard
  openDialinWizard,
  closeDialinWizard,
  startDialinFromBean,
  renderDialinWizard,
  dialinConfirmShot,
  dialinAcceptNext,
  dialinOverride,
  dialinEnd,
  dialinSaveKnownGrind,
  dialinClose,

  // profile dial-in wizard
  startProfileDialinFromList,
  profileDialinClose,
  profileDialinToggleSymptom,
  profileDialinAcceptNext,
  profileDialinOverride,
  profileDialinEnd,
  profileDialinConfirmShot,

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

      // Prefill grinder/grind setting/dose from this bean's own history
      // (best scored combo, then known-good grind, then its last shot) —
      // never the literal previous shot, which may have used a different bean.
      const suggested = suggestGrindDoseForBean(name, S.coffeeLibrary, S.shots);
      const grinderEl = document.getElementById('annGrinder');
      const grindEl   = document.getElementById('annGrindSetting');
      const doseEl    = document.getElementById('annDose');
      if (suggested.grinder      && grinderEl) grinderEl.value = suggested.grinder;
      if (suggested.grindSetting && grindEl)   grindEl.value   = suggested.grindSetting;
      if (suggested.dose         && doseEl)    doseEl.value    = suggested.dose;

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

      // Update degassing tracker from library roast date
      updateDegassing(roastDate || '');

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

  // ── Desktop nav rail collapse state (#411) ─────────────────────────────
  applyRailCollapsed(localStorage.getItem(RAIL_COLLAPSED_KEY) === '1');

  // ── Static element wiring ──────────────────────────────────────────────
  document.getElementById('collapseBtn').addEventListener('click', toggleDesktopSidebar);
  document.getElementById('expandSidebarBtn').addEventListener('click', toggleDesktopSidebar);
  // #410: mobile back chevron in the shot-detail topbar returns to the
  // primary shot-list screen (see setMobileShotSubview() in sidebar.js).
  document.getElementById('mobileBackBtn').addEventListener('click', () => setMobileShotSubview('list'));
  document.getElementById('shotSearch').addEventListener('input', e => filterShots(e.target.value));
  document.getElementById('sortNewest').addEventListener('click', () => setSortMode('newest'));
  document.getElementById('sortScore').addEventListener('click', () => setSortMode('score'));
  document.getElementById('sortRating').addEventListener('click', () => setSortMode('rating'));
  document.getElementById('sortDur').addEventListener('click', () => setSortMode('duration'));
  document.getElementById('trash-toggle').addEventListener('click', toggleTrash);
  document.getElementById('powerBtn').addEventListener('click', toggleMachinePower);
  document.getElementById('syncBtn').addEventListener('click', triggerSync);
  document.getElementById('onboardingDemoBtn').addEventListener('click', loadDemoData);
  document.getElementById('glpDemoEndBtn').addEventListener('click', endDemo);
  // ── Desktop nav rail (#411) — same ids as the old #mode-bar buttons,
  // just relocated markup, so switchMode()'s active-state toggling and
  // status.js's live/orders visibility gating both keep working unchanged.
  document.getElementById('btnLive').addEventListener('click', () => switchMode('live'));
  document.getElementById('btnShots').addEventListener('click', () => switchMode('shots'));
  document.getElementById('btnAnalytics').addEventListener('click', () => switchMode('analytics'));
  document.getElementById('btnDialin').addEventListener('click', () => switchMode('dialin'));
  document.getElementById('btnLibrary').addEventListener('click', () => switchMode('library'));
  document.getElementById('btnMaintenance').addEventListener('click', () => switchMode('maintenance'));
  document.getElementById('btnOrders').addEventListener('click', () => switchMode('orders'));
  document.getElementById('btnSettings').addEventListener('click', () => switchMode('settings'));
  document.getElementById('railToggle').addEventListener('click', toggleRailCollapsed);

  // ── Bottom navigation (#403, mobile) ─────────────────────────────────────
  // Shots always returns to the primary shot-list screen (#410) — the list
  // is no longer an overlay drawer over the detail view.
  document.getElementById('bnShots').addEventListener('click', () => { switchMode('shots'); setMobileShotSubview('list'); });
  document.getElementById('bnLive').addEventListener('click', () => switchMode('live'));
  document.getElementById('bnLibrary').addEventListener('click', () => switchMode('library'));
  document.getElementById('bnAnalytics').addEventListener('click', () => switchMode('analytics'));
  document.getElementById('bnMore').addEventListener('click', toggleMoreSheet);
  document.getElementById('more-sheet-backdrop').addEventListener('click', closeMoreSheet);
  document.getElementById('bnDialin').addEventListener('click', () => { closeMoreSheet(); switchMode('dialin'); });
  document.getElementById('bnMaintenance').addEventListener('click', () => { closeMoreSheet(); switchMode('maintenance'); });
  document.getElementById('bnOrders').addEventListener('click', () => { closeMoreSheet(); switchMode('orders'); });
  document.getElementById('bnSettings').addEventListener('click', () => { closeMoreSheet(); switchMode('settings'); });
  document.getElementById('exportAllCsvBtn').addEventListener('click', exportAllCSV);
  document.getElementById('exportShotBtn').addEventListener('click', exportShot);
  document.getElementById('exportProfileBtn').addEventListener('click', exportProfile);
  // Share-card format picker: toggle dropdown, pick format on option click
  document.getElementById('shareCardBtn').addEventListener('click', () => {
    const menu = document.getElementById('cardFmtMenu');
    menu.style.display = menu.style.display === 'block' ? 'none' : 'block';
  });
  document.getElementById('cardFmtMenu').addEventListener('click', e => {
    const opt = e.target.closest('.card-fmt-opt');
    if (!opt) return;
    document.getElementById('cardFmtMenu').style.display = 'none';
    shareCard(opt.dataset.format);
  });
  document.addEventListener('click', e => {
    if (!document.getElementById('cardFmtWrap').contains(e.target))
      document.getElementById('cardFmtMenu').style.display = 'none';
  });
  document.getElementById('tabZeit').addEventListener('click', () => switchChartTab('zeit'));
  document.getElementById('tabPQ').addEventListener('click', () => switchChartTab('pq'));
  document.getElementById('expandChartBtn').addEventListener('click', openChartFullscreen);
  document.getElementById('fsTabZeit').addEventListener('click', () => switchFsTab('zeit'));
  document.getElementById('fsTabPQ').addEventListener('click', () => switchFsTab('pq'));
  document.getElementById('closeFullscreenBtn').addEventListener('click', closeChartFullscreen);
  document.getElementById('quickCloneBtn').addEventListener('click', quickClone);
  document.getElementById('saveAnnotationBtn').addEventListener('click', saveAnnotation);
  document.getElementById('annPhotoPickBtn').addEventListener('click', () => document.getElementById('annPhotoInput').click());
  document.getElementById('annPhotoInput').addEventListener('change', function () { uploadShotImage(this); });
  document.getElementById('annPhotoRemoveBtn').addEventListener('click', removeShotImage);
  document.getElementById('annPhotoThumb').addEventListener('click', openShotPhotoLightbox);
  ['annCoffee','annGrinder','annGrindSetting','annDose','annTds','annNotes'].forEach(id => {
    document.getElementById(id).addEventListener('input', scheduleAutoSave);
  });
  document.getElementById('openMaintLogBtn').addEventListener('click', openMaintLogForm);
  document.getElementById('submitMaintLogBtn').addEventListener('click', submitMaintLogEntry);
  document.getElementById('cancelMaintLogBtn').addEventListener('click', closeMaintLogForm);
  document.getElementById('ordersEnabledToggle').addEventListener('change', e => setOrdersEnabled(e.target.checked));
  document.getElementById('ordersMenuTitle').addEventListener('click', toggleOrdersMenu);
  document.getElementById('ordersStatsTitle').addEventListener('click', toggleOrdersStats);
  document.getElementById('ordersNotifyTitle').addEventListener('click', toggleOrdersNotify);
  document.getElementById('addOrderMenuItemBtn').addEventListener('click', addOrderMenuItem);
  document.getElementById('libTabBeans').addEventListener('click', () => switchLibTab('beans'));
  document.getElementById('libTabGrinders').addEventListener('click', () => switchLibTab('grinders'));
  document.getElementById('libTabRecipes').addEventListener('click', () => switchLibTab('recipes'));
  document.getElementById('libTabMilk').addEventListener('click', () => switchLibTab('milk'));
  document.getElementById('libTabProfiles').addEventListener('click', () => switchLibTab('profiles'));
  document.getElementById('closeBeanFormBtn').addEventListener('click', closeBeanForm);
  document.getElementById('saveBeanBtn').addEventListener('click', saveBean);
  document.getElementById('beanAddTrigger').addEventListener('click', openBeanForm);
  document.getElementById('openScanModalBtn').addEventListener('click', openScanModal);
  document.getElementById('toggleUrlImportBtn').addEventListener('click', toggleUrlImport);
  document.getElementById('urlImportInput').addEventListener('keydown', e => { if (e.key === 'Enter') importFromUrl(); });
  document.getElementById('importFromUrlBtn').addEventListener('click', importFromUrl);
  document.getElementById('toggleImportSettingsBtn').addEventListener('click', toggleImportSettings);
  document.getElementById('importSettingsAddDomainBtn').addEventListener('click', addCustomShopifyDomain);
  document.getElementById('importSettingsDomainInput').addEventListener('keydown', e => { if (e.key === 'Enter') addCustomShopifyDomain(); });
  document.getElementById('closeGrinderFormBtn').addEventListener('click', closeGrinderForm);
  document.getElementById('saveGrinderBtn').addEventListener('click', saveGrinder);
  document.getElementById('grinderAddTrigger').addEventListener('click', openGrinderForm);
  document.getElementById('grinderFormImagePickBtn').addEventListener('click', () => document.getElementById('grinderFormImage').click());
  document.getElementById('grinderFormImage').addEventListener('change', function () {
    if (S.grinderEditId) uploadGrinderImage(S.grinderEditId, this);
  });
  document.getElementById('beanFormImagePickBtn').addEventListener('click', () => document.getElementById('beanFormImage').click());
  document.getElementById('beanFormImage').addEventListener('change', function () {
    if (S.beanEditId) uploadBeanImage(S.beanEditId, this);
  });
  document.getElementById('addRecipeStepBtn').addEventListener('click', addRecipeStep);
  document.getElementById('closeRecipeFormBtn').addEventListener('click', closeRecipeForm);
  document.getElementById('saveRecipeBtn').addEventListener('click', saveRecipe);
  document.getElementById('recipeAddTrigger').addEventListener('click', openRecipeForm);
  document.getElementById('closeMilkFormBtn').addEventListener('click', closeMilkForm);
  document.getElementById('saveMilkBtn').addEventListener('click', saveMilk);
  document.getElementById('milkAddTrigger').addEventListener('click', openMilkForm);
  document.getElementById('profileAddTrigger').addEventListener('click', openNewProfileForm);
  document.getElementById('closeProfileFormBtn').addEventListener('click', closeProfileForm);
  document.getElementById('cancelProfileFormBtn').addEventListener('click', closeProfileForm);
  document.getElementById('addProfilePhaseBtn').addEventListener('click', addProfilePhase);
  document.getElementById('profileApplySuggestionBtn').addEventListener('click', applyBeanSuggestion);
  document.getElementById('sendProfileToMachineBtn').addEventListener('click', sendProfileToMachine);
  // Live preview: any field/phase edit re-synthesizes the chart from the
  // current DOM state (same DOM-as-state source of truth as _collectPhases()).
  document.getElementById('profileEditorModal').addEventListener('input', renderProfilePreviewChart);
  document.getElementById('profileEditorModal').addEventListener('change', renderProfilePreviewChart);
  document.getElementById('refShotSelect').addEventListener('change', e => onRefShotChange(e.target.value));
  document.getElementById('refClearBtn').addEventListener('click', clearReferenceShot);
  document.getElementById('trendBtn30').addEventListener('click', () => setTrendWindow(30));
  document.getElementById('trendBtn90').addEventListener('click', () => setTrendWindow(90));
  document.getElementById('trendBtnAll').addEventListener('click', () => setTrendWindow(0));
  document.getElementById('dialinCount').addEventListener('change', renderDialin);
  document.querySelectorAll('.theme-btn').forEach(btn => {
    btn.addEventListener('click', () => setTheme(btn.dataset.themeVal));
  });
  document.querySelectorAll('.accent-swatch').forEach(btn => {
    btn.addEventListener('click', () => setAccentTheme(btn.dataset.accent));
  });
  document.querySelectorAll('.lang-option-btn').forEach(btn => {
    btn.addEventListener('click', () => setLang(btn.dataset.lang));
  });
  document.querySelector('input[type="file"][accept=".json"]').addEventListener('change', e => restoreFromFile(e.target));
  document.getElementById('backupDownloadBtn').addEventListener('click', downloadBackup);
  document.getElementById('apiTokenCopyBtn').addEventListener('click', copyApiToken);
  document.getElementById('addMachineBtn')?.addEventListener('click', () => openMachineForm(null));
  document.getElementById('machineFormCancelBtn')?.addEventListener('click', closeMachineForm);
  document.getElementById('machineFormSaveBtn')?.addEventListener('click', saveMachineForm);
  document.getElementById('machineFormTestBtn')?.addEventListener('click', testMachineForm);
  document.getElementById('closeScanModalBtn').addEventListener('click', closeScanModal);
  // Tapping the dimmed backdrop (not the modal content itself) closes it —
  // there was no way back out of the flavor wheel on mobile without this.
  document.getElementById('flavorWheelModal')?.addEventListener('click', e => {
    if (e.target.id === 'flavorWheelModal') closeFlavorWheel();
  });
  document.getElementById('annRecipe')?.addEventListener('change', scheduleAutoSave);

  // ── Global click delegation for dynamic content ────────────────────────
  document.body.addEventListener('click', e => {
    const el = e.target.closest('[data-action]');
    if (!el) return;
    const action = el.dataset.action;
    const numId = () => Number(el.dataset.id);
    const strId = () => el.dataset.id;
    switch (action) {
      case 'open-new-bag':       openNewBagForm(numId()); break;
      case 'close-new-bag':      closeNewBagForm(numId()); break;
      case 'save-new-bag':       saveNewBag(numId()); break;
      case 'toggle-bag-history':   toggleBagHistory(numId()); break;
      case 'delete-bag':         deleteBag(Number(el.dataset.beanId), Number(el.dataset.bagId)); break;
      case 'open-stock-edit':    openBeanStockEdit(numId()); break;
      case 'close-stock-edit':   closeBeanStockEdit(); break;
      case 'save-stock-edit':    saveBeanStock(numId()); break;
      case 'toggle-bean-qr':     toggleBeanQR(numId()); break;
      case 'edit-bean':          editBean(numId()); break;
      case 'delete-bean':        deleteBean(numId()); break;
      case 'toggle-bean-active': toggleBeanActive(numId()); break;
      case 'edit-grinder':       editGrinder(numId()); break;
      case 'delete-grinder':     deleteGrinder(numId()); break;
      case 'reset-grinder-burrs': resetGrinderBurrs(numId()); break;
      case 'edit-recipe':        editRecipe(numId()); break;
      case 'delete-recipe':      deleteRecipe(numId()); break;
      case 'remove-recipe-step': removeRecipeStep(Number(el.dataset.idx)); break;
      case 'delete-milk':        deleteMilk(numId()); break;
      case 'restock-milk':       restockMilk(numId()); break;
      case 'edit-profile':          editProfile(numId()); break;
      case 'delete-profile':        deleteMachineProfile(numId()); break;
      case 'remove-profile-phase':  removeProfilePhase(Number(el.dataset.idx)); break;
      case 'create-profile-from-bean': createProfileFromBean(numId()); break;
      case 'restore-shot':       restoreShot(numId()); break;
      case 'perm-delete-shot':   permanentDeleteShot(numId()); break;
      case 'select-drink':       selectDrinkType(strId()); break;
      case 'select-milk':        selectMilkType(strId()); break;
      case 'reload-data':        loadData(); break;
      case 'set-maint-mode':     setMaintMode(el.dataset.task, el.dataset.mode, el.dataset.machineId); break;
      case 'mark-maint-done':    markMaintDone(el.dataset.task, el.dataset.machineId); break;
      case 'open-guided-maint':  openGuidedMaint(el.dataset.task, el.dataset.machineId); break;
      case 'guided-maint-done':  submitGuidedMaint(); break;
      case 'guided-maint-cancel': closeGuidedMaint(); break;
      case 'set-maint-scope':    setMaintScope(el.dataset.scope); break;
      case 'toggle-maint-detail': el.closest('.maint-mini')?.classList.toggle('expanded'); break;
      case 'set-bean-rank-sort': setBeanRankSort(el.dataset.key); break;
      case 'open-flavor-wheel':   openFlavorWheel(numId()); break;
      case 'close-flavor-wheel':  closeFlavorWheel(); break;
      case 'zoom-flavor-wheel':   zoomFlavorWheelTo(strId()); break;
      case 'delete-maint-log':   deleteMaintLogEntry(numId()); break;
      case 'goto-shot':          goToShot(numId()); break;
      case 'toggle-comp-grind':  document.getElementById('grindAdviceComparative')?.classList.toggle('expanded'); break;
      case 'start-dialin':           openDialinWizard(); break;
      case 'start-dialin-from-bean': startDialinFromBean(numId()); break;
      case 'dialin-confirm-shot':    dialinConfirmShot(numId(), el.dataset.match === '1'); break;
      case 'dialin-accept-next':     dialinAcceptNext(); break;
      case 'dialin-override':        dialinOverride(); break;
      case 'dialin-end':             dialinEnd(); break;
      case 'dialin-save-known-grind': dialinSaveKnownGrind(); break;
      case 'dialin-close':           dialinClose(); break;
      case 'start-profile-dialin':      startProfileDialinFromList(numId()); break;
      case 'profile-dialin-symptom':    profileDialinToggleSymptom(el.dataset.symptom); break;
      case 'profile-dialin-confirm-shot': profileDialinConfirmShot(numId(), el.dataset.match === '1'); break;
      case 'profile-dialin-accept-next':  profileDialinAcceptNext(); break;
      case 'profile-dialin-override':     profileDialinOverride(); break;
      case 'profile-dialin-end':          profileDialinEnd(); break;
      case 'profile-dialin-close':        profileDialinClose(); break;
    }
  });

  document.body.addEventListener('change', e => {
    if (e.target.classList?.contains('guided-maint-check')) { updateGuidedMaintDoneState(); return; }
    const el = e.target.closest('[data-action]');
    if (!el) return;
    if (el.dataset.action === 'save-maint-threshold') {
      saveMaintThreshold(el.dataset.task, el.dataset.field, el.value, el.dataset.machineId);
    }
    if (el.dataset.action === 'dialin-grinder-select') {
      dialinGrinderChange();
    }
    if (el.dataset.action === 'switch-machine') {
      switchActiveMachine(el.value);
    }
    if (el.dataset.action === 'dialin-progression-bean-change') {
      setDialinProgressionBean(el.value);
    }
  });

  // ── Init sequence ──────────────────────────────────────────────────────
  applyTranslations();

  initToken().then(async () => {
    // #390 — loadMachines() calls the token-gated /api/machines; it used to
    // fire straight from this handler (before initToken() ever ran), so its
    // X-GLP-Token header was always empty and the request 401ed for any
    // non-Ingress session (Ingress bypasses the token check, which is why
    // this went unnoticed there). S.machines never populated, so the
    // machine switcher stayed hidden and the restored S.activeMachineId had
    // nothing to display itself against. Now runs once the token is ready,
    // same as loadData()/loadLibrary() below.
    loadMachines();
    loadDrinkMenu();
    loadMilkTypes();
    await loadData();
    loadLibrary();
    loadMachineProfileList();
    updateStatus();
    checkForUpdate();
    renderApiTokenCard();
  });

  setInterval(updateStatus, 30000);
  updateMobileShotSidebarVisibility();
  window.addEventListener('resize', updateMobileShotSidebarVisibility);

});
