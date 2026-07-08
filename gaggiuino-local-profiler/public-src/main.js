import './style.css';

// One-time cleanup for the v1.102.0 service worker (reverted in v1.102.1):
// a client that already registered it keeps it active indefinitely — the
// server no longer trying to re-register does nothing for those clients.
// Unregistering unconditionally on every load self-heals them; safe to run
// even for clients that never had one (getRegistrations() is then empty).
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.getRegistrations()
    .then(regs => Promise.all(regs.map(r => r.unregister())))
    .catch(() => {});
}

import { S } from './state.js';
import { initToken, apiFetch } from './api.js';
import { t, setLang, applyTranslations } from './i18n.js';
import { generateBeanQR } from './glp-qr.js';

import { renderSidebar, updateSidebarHighlighting, filterShots, setSortMode, sortedShots, updateFlapCounter,
         toggleDesktopSidebar, openSidebar, closeSidebar, toggleSidebar, collapseSidebarOnMobile, selectShot,
         toggleMonthGroup } from './components/sidebar.js';
import { updateStatus, updatePowerButton, toggleMachinePower, triggerSync } from './components/status.js';
import { checkForUpdate } from './components/update-check.js';
import { switchMode, goToShot } from './components/mode.js';

import { getShotData, calcShotScore, loadData, loadTrashData, renderTrash, toggleTrash,
         trashShot, restoreShot, permanentDeleteShot,
         renderAnnotationPanel, renderStars, quickClone, saveAnnotation, scheduleAutoSave, updateDegassing, calcBeanAgeAtShot,
         uploadShotImage, removeShotImage, openShotPhotoLightbox,
         updateView, switchChartTab, updatePQChart,
         openChartFullscreen, closeChartFullscreen, switchFsTab,
         exportCSV, exportAllCSV, exportShot, exportProfile, shareCard, restoreFromFile, downloadBackup,
         loadDrinkMenu, loadMilkTypes, selectDrinkType, selectMilkType } from './views/shots.js';

import { initLiveChart, populateRefSelector, autoApplyRefShot, onRefShotChange, clearReferenceShot,
         connectLiveStream, disconnectLiveStream, setLiveBadge, handleLiveData,
         fetchPreheatData, updatePreheatWidget, fetchLiveData } from './views/live.js';

import { initAnalytics, setTrendWindow, buildCalendar, buildTrendChart, buildBeanStats, buildProfileChart, _renderCalendar } from './views/analytics.js';

import { loadMaintenanceView, markMaintDone, saveMaintThreshold, setMaintMode,
         renderMaintenanceCards, maintStatusLabel, _buildMaintCard,
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
         openBeanForm, closeBeanForm, editBean, saveBean, deleteBean, uploadBeanImage,
         openGrinderForm, closeGrinderForm, editGrinder, saveGrinder, deleteGrinder, uploadGrinderImage,
         toggleBeanQR,
         toggleBagHistory, openNewBagForm, closeNewBagForm, saveNewBag, deleteBag,
         openBeanStockEdit, closeBeanStockEdit, saveBeanStock,
         openRecipeForm, closeRecipeForm, editRecipe, saveRecipe, deleteRecipe, renderRecipeList,
         addRecipeStep, removeRecipeStep,
         toggleUrlImport, importFromUrl,
         toggleImportSettings, addCustomShopifyDomain,
         openScanModal, closeScanModal, _runScanLoop, _handleScanResult,
         renderMilkList, openMilkForm, closeMilkForm, saveMilk, restockMilk, deleteMilk } from './views/library.js';

import { renderDialin } from './views/dialin.js';

import { loadDemoData, endDemo } from './components/onboarding.js';

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

  // ── Static element wiring ──────────────────────────────────────────────
  document.getElementById('sidebarToggle').addEventListener('click', toggleSidebar);
  document.getElementById('collapseBtn').addEventListener('click', toggleDesktopSidebar);
  document.getElementById('expandSidebarBtn').addEventListener('click', toggleDesktopSidebar);
  document.getElementById('mobileMenuBtn').addEventListener('click', openSidebar);
  document.getElementById('sidebar-backdrop').addEventListener('click', closeSidebar);
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
  document.getElementById('btnLive').addEventListener('click', () => switchMode('live'));
  document.getElementById('btnShots').addEventListener('click', () => switchMode('shots'));
  document.getElementById('btnAnalytics').addEventListener('click', () => switchMode('analytics'));
  document.getElementById('btnDialin').addEventListener('click', () => switchMode('dialin'));
  document.getElementById('btnLibrary').addEventListener('click', () => switchMode('library'));
  document.getElementById('btnMaintenance').addEventListener('click', () => switchMode('maintenance'));
  document.getElementById('btnOrders').addEventListener('click', () => switchMode('orders'));
  document.getElementById('btnSettings').addEventListener('click', () => switchMode('settings'));
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
      case 'toggle-bean-qr':     toggleBeanQR(numId()); break;
      case 'edit-bean':          editBean(numId()); break;
      case 'delete-bean':        deleteBean(numId()); break;
      case 'edit-grinder':       editGrinder(numId()); break;
      case 'delete-grinder':     deleteGrinder(numId()); break;
      case 'edit-recipe':        editRecipe(numId()); break;
      case 'delete-recipe':      deleteRecipe(numId()); break;
      case 'remove-recipe-step': removeRecipeStep(Number(el.dataset.idx)); break;
      case 'delete-milk':        deleteMilk(numId()); break;
      case 'restock-milk':       restockMilk(numId()); break;
      case 'restore-shot':       restoreShot(numId()); break;
      case 'perm-delete-shot':   permanentDeleteShot(numId()); break;
      case 'select-drink':       selectDrinkType(strId()); break;
      case 'select-milk':        selectMilkType(strId()); break;
      case 'reload-data':        loadData(); break;
      case 'set-maint-mode':     setMaintMode(el.dataset.task, el.dataset.mode); break;
      case 'mark-maint-done':    markMaintDone(el.dataset.task); break;
      case 'open-guided-maint':  openGuidedMaint(el.dataset.task); break;
      case 'guided-maint-done':  submitGuidedMaint(); break;
      case 'guided-maint-cancel': closeGuidedMaint(); break;
      case 'open-flavor-wheel':   openFlavorWheel(numId()); break;
      case 'close-flavor-wheel':  closeFlavorWheel(); break;
      case 'zoom-flavor-wheel':   zoomFlavorWheelTo(strId()); break;
      case 'delete-maint-log':   deleteMaintLogEntry(numId()); break;
      case 'goto-shot':          goToShot(numId()); break;
      case 'toggle-comp-grind':  document.getElementById('grindAdviceComparative')?.classList.toggle('expanded'); break;
    }
  });

  document.body.addEventListener('change', e => {
    if (e.target.classList?.contains('guided-maint-check')) { updateGuidedMaintDoneState(); return; }
    const el = e.target.closest('[data-action]');
    if (!el) return;
    if (el.dataset.action === 'save-maint-threshold') {
      saveMaintThreshold(el.dataset.task, el.dataset.field, el.value);
    }
  });

  // ── Init sequence ──────────────────────────────────────────────────────
  applyTranslations();

  initToken().then(() => {
    loadDrinkMenu();
    loadMilkTypes();
    loadData();
    loadLibrary();
    updateStatus();
    checkForUpdate();
    renderApiTokenCard();
  });

  setInterval(updateStatus, 30000);
  collapseSidebarOnMobile();

});
