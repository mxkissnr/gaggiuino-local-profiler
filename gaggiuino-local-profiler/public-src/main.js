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
import { connectEvents, onEvent, EVENTS } from './sse.js';
import { generateBeanQR } from './glp-qr.js';
import { themeColor, THEME_CHANGE_EVENT, onThemeChange, applyChartTheme } from './utils.js';
import { openBackupExportModal, openBackupRestoreModal } from './components/backup-modal.js';

import { renderSidebar, updateSidebarHighlighting, filterShots, setSortMode, sortedShots, updateFlapCounter,
         toggleDesktopSidebar, updateMobileShotSidebarVisibility, selectShot,
         openShotDrawer, closeShotDrawer, handleDrawerTouchStart, handleDrawerTouchEnd,
         handleEdgeSwipeStart, handleEdgeSwipeEnd,
         toggleMonthGroup, setBeanFilter, clearBeanFilter } from './components/sidebar.js';
import { updateStatus, updatePowerButton, toggleMachinePower, triggerSync, exportDevDb, importDevDb,
         handleSyncProgressEvent, handleSyncCompleteEvent } from './components/status.js';
import { checkForUpdate } from './components/update-check.js';
import { switchMode, goToShot } from './components/mode.js';
import { renderBottomNav, renderBottomNavSettings, closeMoreSheet } from './components/bottom-nav.js';

import { getShotData, calcShotScore, loadData, loadTrashData, renderTrash, toggleTrash,
         trashShot, restoreShot, permanentDeleteShot,
         renderAnnotationPanel, renderStars, quickClone, scheduleAutoSave, flushAutoSave, updateDegassing, calcBeanAgeAtShot,
         suggestGrindDoseForBean,
         uploadShotImage, removeShotImage, openShotPhotoLightbox,
         updateView, switchChartTab, updatePQChart,
         openChartFullscreen, closeChartFullscreen, switchFsTab,
         exportCSV, exportAllCSV, exportShot, exportProfile, shareCard,
         loadDrinkMenu, loadMilkTypes, selectDrinkType, selectMilkType,
         selectFrozenPortion, _renderFrozenPortionPills } from './views/shots.js';

// #957: shot curve data is fetched lazily per shot (list rows are
// metadata-only). Views reach the cache through these window globals, same
// as they already do for getShotData / calcShotScore.
import { getShotCurve, ensureCurves, getRawCurve, getCachedShotData,
         primeCurve, evictCurve } from './shot-curves.js';

import { initLiveChart, populateRefSelector, autoApplyRefShot, onRefShotChange, clearReferenceShot,
         connectLiveStream, disconnectLiveStream, setLiveBadge, handleLiveData,
         fetchPreheatData, updatePreheatWidget, fetchLiveData,
         handleLiveSnapshotEvent, handlePreheatUpdateEvent } from './views/live.js';

import { initAnalytics, setTrendWindow, buildCalendar, buildTrendChart, buildBeanStats, buildProfileChart, _renderCalendar,
         setBeanRankSort, setDialinProgressionBean } from './views/analytics.js';

import { loadMaintenanceView, markMaintDone, saveMaintThreshold, setMaintMode, setMaintScope,
         renderMaintenanceDashboard, maintStatusLabel,
         openMaintLogForm, closeMaintLogForm, submitMaintLogEntry, deleteMaintLogEntry,
         openGuidedMaint, closeGuidedMaint, submitGuidedMaint, updateGuidedMaintDoneState } from './views/maintenance.js';
import { loadAchievementsView } from './views/achievements.js';
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
         openFreezeForm, closeFreezeForm, saveFreezePortions, thawPortion, filterShotsByBean,
         openEditFrozenForm, closeEditFrozenForm, saveEditFrozenForm,
         openRecipeForm, closeRecipeForm, editRecipe, saveRecipe, deleteRecipe, renderRecipeList,
         addRecipeStep, removeRecipeStep,
         toggleUrlImport, importFromUrl,
         toggleImportSettings, addCustomShopifyDomain,
         openScanModal, closeScanModal, _runScanLoop, _handleScanResult,
         renderMilkList, openMilkForm, closeMilkForm, saveMilk, restockMilk, deleteMilk,
         renderBasketList, openBasketForm, closeBasketForm, editBasket, saveBasket, deleteBasket, uploadBasketImage,
         renderPuckScreenList, openPuckScreenForm, closePuckScreenForm, editPuckScreen, savePuckScreen, deletePuckScreen, uploadPuckScreenImage
       } from './views/library.js';

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

import { loadMachines, openMachineForm, closeMachineForm, saveMachineForm, testMachineForm, switchActiveMachine, renderMachinesList,
         onThemeCustomColorAChange, onThemeCustomColorBChange, onThemeGradientToggleChange, onMachineTypeChange } from './components/machines-settings.js';

import { openSetupWizard, closeSetupWizard, setupWizardGetStarted, setupWizardSkipToDemo,
         shouldOpenSetupWizard } from './views/setup-wizard.js';

import { handleTopbarLiveSnapshotEvent, handleTopbarPreheatUpdateEvent,
         handleTopbarMachineIconClick, closeEasterEggPanel,
         bindEasterEggPanelEscape } from './components/topbar-machine-icon.js';

import { loadMqttSettings, renderMqttSettingsCard, setMqttTransport, saveMqttSettings, applyMqttToMachine } from './components/mqtt-settings.js';

import { loadNotifySettingsCard, saveNotifySettings } from './components/notify-settings.js';

import { loadShotDefaultsSettingsCard, saveShotDefaultsSettings } from './components/shot-defaults-settings.js';

import { renderWhatsNewCard } from './components/whats-new.js';
import { attachAutocomplete } from './components/autocomplete.js';

import { BEAN_ICON_SVG } from './icons.js';

// ── Toast helper ──────────────────────────────────────────────────────────
function showToast(msg, duration = 3000) {
  let el = document.getElementById('glpToast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'glpToast';
    el.style.cssText = [
      'position:fixed', 'bottom:24px', 'left:50%', 'transform:translateX(-50%)',
      // #814: was a hardcoded #27272a/#e4e4e7 — a dark chip on a light page.
      `background:${themeColor('--raised', '#27272a')}`, `color:${themeColor('--gray-200', '#e4e4e7')}`,
      'padding:10px 20px', 'border-radius:8px',
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
// Shows the token once the session holds one. #803: when expose_api_port is
// off, a direct-port session (no Ingress) never gets a token at all — this
// card then shows an explanation instead of just disappearing, since a
// silently-hidden card here is exactly what would leave someone setting up
// the installable PWA or a direct-URL Order Card with no idea why. A session
// that reached Settings via Ingress is unaffected either way (Ingress always
// gets a token, expose_api_port or not) and still shows the token normally.
function renderApiTokenCard() {
  const card = document.getElementById('apiTokenCard');
  const valueEl = document.getElementById('apiTokenValue');
  const rowEl = document.getElementById('apiTokenRow');
  const noticeEl = document.getElementById('apiTokenPortClosedNotice');
  if (!card || !valueEl) return;
  if (S.glpToken) {
    valueEl.textContent = S.glpToken;
    card.style.display = '';
    if (rowEl) rowEl.style.display = '';
    if (noticeEl) noticeEl.style.display = 'none';
    return;
  }
  if (S.apiPortExposed === false) {
    card.style.display = '';
    if (rowEl) rowEl.style.display = 'none';
    if (noticeEl) noticeEl.style.display = '';
    return;
  }
  card.style.display = 'none';
}

function copyApiToken() {
  if (!S.glpToken) return;
  navigator.clipboard?.writeText(S.glpToken)
    .then(() => showToast(t('settings_api_token_copied')))
    .catch(() => {});
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
    window.dispatchEvent(new CustomEvent(THEME_CHANGE_EVENT));  // #814, see _applyTheme
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
  updateMobileShotSidebarVisibility,
  selectShot,
  setBeanFilter,
  clearBeanFilter,

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
  // #957 curve cache
  getShotCurve,
  ensureCurves,
  getRawCurve,
  getShotDataById: getCachedShotData,
  primeCurve,
  evictCurve,
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
  scheduleAutoSave,
  flushAutoSave,
  selectDrinkType,
  selectMilkType,
  selectFrozenPortion,
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

  // achievements view (#812)
  loadAchievementsView,

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
  openFreezeForm,
  closeFreezeForm,
  saveFreezePortions,
  thawPortion,
  filterShotsByBean,
  openEditFrozenForm,
  closeEditFrozenForm,
  saveEditFrozenForm,
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
  renderBasketList,
  openBasketForm,
  closeBasketForm,
  editBasket,
  saveBasket,
  deleteBasket,
  renderPuckScreenList,
  openPuckScreenForm,
  closePuckScreenForm,
  editPuckScreen,
  savePuckScreen,
  deletePuckScreen,

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
      if (!name || !S.coffeeLibrary) { if (hintEl) hintEl.style.display = 'none'; _renderFrozenPortionPills(null, Date.now(), null); return; }

      const bean = S.coffeeLibrary.beans?.find(b => b.name === name);
      if (!bean) { if (hintEl) hintEl.style.display = 'none'; _renderFrozenPortionPills(null, Date.now(), null); return; }

      // Prefill grinder/grind setting/dose from this bean's own history
      // (best scored combo, then known-good grind, then its last shot) —
      // never the literal previous shot, which may have used a different bean.
      const suggested = suggestGrindDoseForBean(name, S.coffeeLibrary, S.shots, { beanId: bean.id });
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

      // Bean changed — the frozen-portion choices (if any) belong to the
      // previously selected bean's bag, never carry over. Reset to unset.
      _renderFrozenPortionPills(name, shotMs, null);

      // Show bean age hint
      const ageDays = calcBeanAgeAtShot(name, shot?.timestamp, bean.id);
      if (hintEl && ageDays != null) {
        hintEl.innerHTML = `${BEAN_ICON_SVG} ${t('bean_age_at_shot', ageDays)}`;
        hintEl.style.display = '';
      } else if (hintEl) {
        hintEl.style.display = 'none';
      }
    });
  }

  bindEasterEggPanelEscape();

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
    // #814: Chart.js resolves its colours once, at construction. Setting the
    // theme attribute repaints everything CSS controls but leaves every chart
    // already on screen with the previous theme's legend, ticks and grid, so
    // the views holding a live Chart instance need telling.
    window.dispatchEvent(new CustomEvent(THEME_CHANGE_EVENT));
  };
  // #814: one listener for every live Chart instance. Charts resolve their
  // chrome colours at construction, so without this a chart already on screen
  // keeps the previous theme's legend/ticks/grid until something else happens
  // to rebuild it. Listed explicitly rather than discovered, so a new chart
  // added later shows up as a missing entry here rather than silently keeping
  // stale colours.
  onThemeChange(() => {
    for (const key of ['chart', 'pqChart', 'fsChart', 'liveChart', 'trendChart',
                       'profileBarChart', 'profilePreviewChart', 'doseDistChart',
                       'ratioDistChart', 'timeOfDayChart', 'dialinProgressionChart']) {
      applyChartTheme(S[key]);
    }
  });

  _applyTheme(localStorage.getItem('glp_theme') || 'dark');

  const _savedAccent = localStorage.getItem('glp_accent_theme') || 'amber';
  document.documentElement.dataset.accent = _savedAccent;
  document.querySelectorAll('.accent-swatch').forEach(b =>
    b.classList.toggle('active', b.dataset.accent === _savedAccent));

  // ── Static element wiring ──────────────────────────────────────────────
  document.getElementById('collapseBtn').addEventListener('click', toggleDesktopSidebar);
  document.getElementById('expandSidebarBtn').addEventListener('click', toggleDesktopSidebar);
  // #969: filterShots() does 3 full DOM passes over the shot list; on a
  // large history that's too much work to redo synchronously on every
  // keystroke. Debounce so a fast typist only pays for it once per pause.
  let _searchDebounce = null;
  document.getElementById('shotSearch').addEventListener('input', e => {
    const value = e.target.value;
    clearTimeout(_searchDebounce);
    _searchDebounce = setTimeout(() => filterShots(value), 150);
  });
  document.getElementById('sortNewest').addEventListener('click', () => setSortMode('newest'));
  document.getElementById('sortScore').addEventListener('click', () => setSortMode('score'));
  document.getElementById('sortRating').addEventListener('click', () => setSortMode('rating'));
  document.getElementById('sortDur').addEventListener('click', () => setSortMode('duration'));
  document.getElementById('trash-toggle').addEventListener('click', toggleTrash);
  document.getElementById('powerBtn').addEventListener('click', toggleMachinePower);
  // #914: mobile topbar duplicate of #powerBtn -- see index.html comment.
  document.getElementById('railPowerBtn').addEventListener('click', toggleMachinePower);
  document.getElementById('syncBtn').addEventListener('click', triggerSync);
  document.getElementById('onboardingDemoBtn').addEventListener('click', loadDemoData);
  document.getElementById('glpDemoEndBtn').addEventListener('click', endDemo);
  // ── Desktop topbar nav (#424) — same ids as the old #rail/#mode-bar
  // buttons, just relocated+restyled markup, so switchMode()'s active-state
  // toggling and status.js's live/orders visibility gating both keep
  // working unchanged.
  document.getElementById('btnLive').addEventListener('click', () => switchMode('live'));
  document.getElementById('btnShots').addEventListener('click', () => switchMode('shots'));
  document.getElementById('btnAnalytics').addEventListener('click', () => switchMode('analytics'));
  document.getElementById('btnDialin').addEventListener('click', () => switchMode('dialin'));
  document.getElementById('btnLibrary').addEventListener('click', () => switchMode('library'));
  document.getElementById('btnMaintenance').addEventListener('click', () => switchMode('maintenance'));
  document.getElementById('btnAchievements').addEventListener('click', () => switchMode('achievements'));
  document.getElementById('btnOrders').addEventListener('click', () => switchMode('orders'));
  document.getElementById('btnSettings').addEventListener('click', () => switchMode('settings'));

  // ── Mobile burger drawer (#425) — additive shot-list access from any
  // view; the bottom-nav Shots-primary-screen flow below is unaffected.
  document.getElementById('mobileDrawerBtn').addEventListener('click', openShotDrawer);
  document.getElementById('sidebar-drawer-backdrop').addEventListener('click', closeShotDrawer);
  document.getElementById('sidebar').addEventListener('touchstart', handleDrawerTouchStart, { passive: true });
  document.getElementById('sidebar').addEventListener('touchend', handleDrawerTouchEnd, { passive: true });
  // #682: edge-swipe-to-open is bound to `document`, not #sidebar -- the
  // sidebar is transformed off-screen while closed and therefore can't
  // receive touch events itself.
  document.addEventListener('touchstart', handleEdgeSwipeStart, { passive: true });
  document.addEventListener('touchend', handleEdgeSwipeEnd, { passive: true });

  // ── Bottom navigation (#403, #443, mobile) ───────────────────────────────
  // #431: Shots opens the shot detail directly (latest/last-selected shot) —
  // the shot list is no longer reachable from here at all, only via the
  // burger drawer (#425's openShotDrawer, wired above). #443: which
  // destinations land in the bar vs. the "Mehr" sheet, and their click
  // wiring, is now built by renderBottomNav() (components/bottom-nav.js)
  // from the user's glp_bottom_nav_config — only the static backdrop needs
  // wiring here.
  renderBottomNav();
  renderBottomNavSettings();
  renderWhatsNewCard();
  document.getElementById('more-sheet-backdrop').addEventListener('click', closeMoreSheet);
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
  document.getElementById('annPhotoPickBtn').addEventListener('click', () => document.getElementById('annPhotoInput').click());
  document.getElementById('annPhotoInput').addEventListener('change', function () { uploadShotImage(this); });
  document.getElementById('annPhotoRemoveBtn').addEventListener('click', removeShotImage);
  document.getElementById('annPhotoThumb').addEventListener('click', openShotPhotoLightbox);
  // #430: no more explicit Save button — auto-save on input, flushed
  // immediately on blur (leaving the field) and on page hide/mode-switch
  // (below) so a pending debounced save is never silently dropped.
  ['annCoffee','annGrinder','annGrindSetting','annDose','annTds','annNotes'].forEach(id => {
    const el = document.getElementById(id);
    el.addEventListener('input', scheduleAutoSave);
    el.addEventListener('blur', flushAutoSave);
  });
  attachAutocomplete(document.getElementById('annGrinder'), () => S.coffeeLibrary.grinders.map(g => g.name));
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushAutoSave();
    // #733: the 30s setInterval(updateStatus, ...) below gets throttled by
    // the browser while the tab is backgrounded -- a shot import that both
    // starts and finishes while the tab is hidden can end up with zero
    // polls landing while it was still active, so status.js's per-machine
    // _lastSyncProgress map never records it as "seen active" and the
    // completion toast never fires. Forcing one immediate poll on refocus
    // catches an import that's still running by then; one that already
    // finished fully in the background is a case no client-side poll can
    // retroactively catch (nothing else was watching either).
    //
    // #734 review: must pass S.activeMachineId through, same as
    // applyActiveMachineChange() does (#464) -- an unscoped call hits the
    // default machine's /api/status and overwrites #railMachineName/
    // #railStatusDot even when a non-default machine is the active
    // selection, undoing #464's fix via this new trigger.
    if (document.visibilityState === 'visible') updateStatus(S.activeMachineId);
  });
  document.getElementById('topbarMachineIcon').addEventListener('click', handleTopbarMachineIconClick);
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
  document.getElementById('libTabBaskets').addEventListener('click', () => switchLibTab('baskets'));
  document.getElementById('libTabPuckScreens').addEventListener('click', () => switchLibTab('puckscreens'));
  document.getElementById('closeBasketFormBtn').addEventListener('click', closeBasketForm);
  document.getElementById('saveBasketBtn').addEventListener('click', saveBasket);
  document.getElementById('basketAddTrigger').addEventListener('click', openBasketForm);
  document.getElementById('basketFormImagePickBtn').addEventListener('click', () => document.getElementById('basketFormImage').click());
  document.getElementById('basketFormImage').addEventListener('change', function () {
    if (S.basketEditId) uploadBasketImage(S.basketEditId, this);
  });
  document.getElementById('closePuckScreenFormBtn').addEventListener('click', closePuckScreenForm);
  document.getElementById('savePuckScreenBtn').addEventListener('click', savePuckScreen);
  document.getElementById('puckScreenAddTrigger').addEventListener('click', openPuckScreenForm);
  document.getElementById('puckScreenFormImagePickBtn').addEventListener('click', () => document.getElementById('puckScreenFormImage').click());
  document.getElementById('puckScreenFormImage').addEventListener('change', function () {
    if (S.puckScreenEditId) uploadPuckScreenImage(S.puckScreenEditId, this);
  });
  document.getElementById('annBasket').addEventListener('change', scheduleAutoSave);
  document.getElementById('annPuckScreen').addEventListener('change', scheduleAutoSave);
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
  document.getElementById('dialinCount').addEventListener('change', e => {
    localStorage.setItem('glp_dialin_count', e.target.value);
    renderDialin();
  });
  document.querySelectorAll('.theme-btn').forEach(btn => {
    // eslint-disable-next-line no-undef -- setTheme is assigned onto window above (Object.assign), resolves as a global at runtime
    btn.addEventListener('click', () => setTheme(btn.dataset.themeVal));
  });
  document.querySelectorAll('.accent-swatch').forEach(btn => {
    // eslint-disable-next-line no-undef -- setAccentTheme is assigned onto window above (Object.assign), resolves as a global at runtime
    btn.addEventListener('click', () => setAccentTheme(btn.dataset.accent));
  });
  document.querySelectorAll('.lang-option-btn').forEach(btn => {
    btn.addEventListener('click', () => setLang(btn.dataset.lang));
  });
  // Cancel/confirm handlers are wired fresh by openBackupExportModal()/
  // openBackupRestoreModal() every time the modal opens (see
  // components/backup-modal.js) -- no separate wiring needed here, same
  // convention #scanModal uses (its "Schließen" button is wired once, in
  // main.js, but this modal's actions depend on which flow opened it).
  document.getElementById('backupRestoreInput').addEventListener('change', e => openBackupRestoreModal(e.target));
  document.getElementById('backupDownloadBtn').addEventListener('click', openBackupExportModal);
  document.getElementById('devExportDbBtn')?.addEventListener('click', exportDevDb);
  document.getElementById('devImportDbInput')?.addEventListener('change', e => {
    importDevDb(e.target.files[0]);
    e.target.value = '';
  });
  document.getElementById('apiTokenCopyBtn').addEventListener('click', copyApiToken);
  document.getElementById('addMachineBtn')?.addEventListener('click', () => openMachineForm(null));
  document.getElementById('machineFormCancelBtn')?.addEventListener('click', closeMachineForm);
  document.getElementById('machineFormSaveBtn')?.addEventListener('click', saveMachineForm);
  document.getElementById('machineFormTestBtn')?.addEventListener('click', testMachineForm);
  document.getElementById('restartSetupWizardBtn')?.addEventListener('click', () => openSetupWizard());
  document.getElementById('setupWizardModal')?.addEventListener('click', e => {
    if (e.target.id === 'setupWizardModal') closeSetupWizard();
  });
  document.getElementById('machineFormType')?.addEventListener('change', onMachineTypeChange);
  document.getElementById('machineThemeCustomA')?.addEventListener('input', onThemeCustomColorAChange);
  document.getElementById('machineThemeCustomB')?.addEventListener('input', onThemeCustomColorBChange);
  document.getElementById('machineThemeGradientToggle')?.addEventListener('change', onThemeGradientToggleChange);
  document.querySelectorAll('#mqttTransportToggle [data-mqtt-transport]').forEach(btn => {
    btn.addEventListener('click', () => setMqttTransport(btn.dataset.mqttTransport));
  });
  document.getElementById('mqttSaveBtn')?.addEventListener('click', saveMqttSettings);
  document.getElementById('mqttApplyToMachineBtn')?.addEventListener('click', applyMqttToMachine);
  document.getElementById('notifySettingsSaveBtn')?.addEventListener('click', saveNotifySettings);
  document.getElementById('shotDefaultsSaveBtn')?.addEventListener('click', saveShotDefaultsSettings);
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
      case 'toggle-month-group':  toggleMonthGroup(strId()); break;
      case 'delete-bag':         deleteBag(Number(el.dataset.beanId), Number(el.dataset.bagId)); break;
      case 'open-stock-edit':    openBeanStockEdit(numId()); break;
      case 'close-stock-edit':   closeBeanStockEdit(); break;
      case 'save-stock-edit':    saveBeanStock(numId()); break;
      case 'open-freeze-form':   openFreezeForm(numId()); break;
      case 'close-freeze-form':  closeFreezeForm(numId()); break;
      case 'save-freeze-form':   saveFreezePortions(numId()); break;
      case 'thaw-portion':       thawPortion(Number(el.dataset.beanId), Number(el.dataset.portionId)); break;
      case 'open-edit-frozen-form':  openEditFrozenForm(Number(el.dataset.portionId)); break;
      case 'close-edit-frozen-form': closeEditFrozenForm(Number(el.dataset.portionId)); break;
      case 'save-edit-frozen-form':  saveEditFrozenForm(numId(), Number(el.dataset.portionId)); break;
      case 'filter-by-bean':     filterShotsByBean(numId()); break;
      case 'clear-bean-filter':  clearBeanFilter(); break;
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
      case 'edit-basket':        editBasket(numId()); break;
      case 'delete-basket':      deleteBasket(numId()); break;
      case 'edit-puckscreen':    editPuckScreen(numId()); break;
      case 'delete-puckscreen':  deletePuckScreen(numId()); break;
      case 'edit-profile':          editProfile(numId()); break;
      case 'delete-profile':        deleteMachineProfile(numId()); break;
      case 'remove-profile-phase':  removeProfilePhase(Number(el.dataset.idx)); break;
      case 'create-profile-from-bean': createProfileFromBean(numId()); break;
      case 'restore-shot':       restoreShot(numId()); break;
      case 'perm-delete-shot':   permanentDeleteShot(numId()); break;
      case 'select-drink':       selectDrinkType(strId()); break;
      case 'select-milk':        selectMilkType(strId()); break;
      case 'select-frozen-portion': selectFrozenPortion(strId()); break;
      case 'reload-data':        loadData(); break;
      // #807: the "why is this empty" notices (in-view block and app-wide
      // banner, components/api-port-notice.js) both link here.
      case 'goto-settings':      switchMode('settings'); break;
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
      case 'setup-wizard-close':          closeSetupWizard(); break;
      case 'setup-wizard-get-started':    setupWizardGetStarted(); break;
      case 'setup-wizard-skip-demo':      setupWizardSkipToDemo(); break;
      case 'close-easter-egg':            closeEasterEggPanel(); break;
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
    // #735: opened once at app bootstrap, not per view-switch -- sync
    // progress must keep updating regardless of which view/tab is
    // currently open, same reasoning as the 30s updateStatus() interval
    // below. Needs S.glpToken to already be populated (for the ?token=
    // fallback EventSource itself can't send as a header), hence after
    // initToken() resolves. `onFallback` is a no-op here -- the PR 2
    // follow-up (Live view over the same stream) extends it.
    onEvent(EVENTS.SYNC_PROGRESS, handleSyncProgressEvent);
    onEvent(EVENTS.SYNC_COMPLETE, handleSyncCompleteEvent);
    // #736: Live view telemetry/preheat push -- same bootstrap-time wiring
    // as the sync-progress events above.
    onEvent(EVENTS.LIVE_SNAPSHOT, handleLiveSnapshotEvent);
    onEvent(EVENTS.PREHEAT_UPDATE, handlePreheatUpdateEvent);
    // #837: the topbar's ambient machine icon -- a second, independent
    // listener for the same two event types (see components/
    // topbar-machine-icon.js's module doc comment for why it doesn't just
    // reuse live.js's own handlers).
    onEvent(EVENTS.LIVE_SNAPSHOT, handleTopbarLiveSnapshotEvent);
    onEvent(EVENTS.PREHEAT_UPDATE, handleTopbarPreheatUpdateEvent);
    connectEvents(() => {});

    // #390 — loadMachines() calls the token-gated /api/machines; it used to
    // fire straight from this handler (before initToken() ever ran), so its
    // X-GLP-Token header was always empty and the request 401ed for any
    // non-Ingress session (Ingress bypasses the token check, which is why
    // this went unnoticed there). S.machines never populated, so the
    // machine switcher stayed hidden and the restored S.activeMachineId had
    // nothing to display itself against. Now runs once the token is ready,
    // same as loadData()/loadLibrary() below.
    const machinesPromise = loadMachines();
    loadMqttSettings();
    loadNotifySettingsCard();
    loadDrinkMenu();
    loadMilkTypes();
    // Awaited (unlike the two loads above): loadData() below can render the
    // annotation panel for the initially-selected shot synchronously once
    // it resolves (updateView() -> renderAnnotationPanel()), which reads
    // S.shotDefaults directly — on a slow connection, firing this
    // unawaited could let that first render see S.shotDefaults still null
    // with nothing to re-render it once the fetch actually completes.
    await loadShotDefaultsSettingsCard();
    // #700: same class of bug as above — renderAnnotationPanel() also reads
    // S.coffeeLibrary.baskets/puckScreens (via _renderBasketSelect/
    // _renderPuckScreenSelect). Firing loadLibrary() unawaited let the first
    // render of the initially-selected shot run against an empty library,
    // so Basket/Puck Screen showed "No basket"/"No puck screen" until the
    // user navigated to another shot and back (which re-runs the render
    // after loadLibrary() had since resolved).
    await loadLibrary();
    await loadData();
    // #733: same class of bug as #700 above, one level removed — renderMachinesList()
    // (inside loadMachines()) computes each machine's shot count from S.allShots, but
    // loadMachines() was fired unawaited before loadData() populated S.allShots, so the
    // very first render always saw an empty shot list and nothing ever re-rendered it
    // once the real shots arrived. Re-render once both are guaranteed to be ready.
    await machinesPromise;
    renderMqttSettingsCard();
    renderMachinesList();
    loadMachineProfileList();
    // #750: awaited (was fire-and-forget) so the installId comparison inside
    // updateStatus() -> syncInstallId() has a chance to clear a stale
    // setup-wizard-completed flag before the shouldOpenSetupWizard() check
    // below runs -- see setup-wizard.js's syncInstallId() comment.
    await updateStatus();
    checkForUpdate();
    renderApiTokenCard();
    // #744: first-run setup wizard — auto-opens once S.machines is actually
    // known (after machinesPromise resolves), not before, so a returning
    // multi-machine user never sees a false-positive flash of it.
    if (shouldOpenSetupWizard(S.machines)) openSetupWizard();
  });

  setInterval(updateStatus, 30000);
  updateMobileShotSidebarVisibility();
  let _lastViewportWidth = window.innerWidth;
  window.addEventListener('resize', () => {
    // Mobile virtual keyboards (Android Chrome etc.) fire a resize event on
    // open/close because viewport *height* changes — width stays the same.
    // updateMobileShotSidebarVisibility() force-closes the burger drawer
    // whenever width is still <=768, so that spurious resize was slamming
    // the drawer shut the instant a user focused #shotSearch and the
    // keyboard opened. Real breakpoint-relevant resizes (device rotation,
    // desktop window drag across 768px) always change width, so gate on
    // that instead of reacting to every resize blindly.
    const width = window.innerWidth;
    if (width === _lastViewportWidth) return;
    _lastViewportWidth = width;
    updateMobileShotSidebarVisibility();
  });

});
