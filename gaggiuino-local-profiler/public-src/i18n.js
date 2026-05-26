import { S } from './state.js';
import { TRANSLATIONS } from './constants.js';

export function t(key, ...args) {
  const val = TRANSLATIONS[S.currentLang]?.[key] ?? TRANSLATIONS.de?.[key] ?? key;
  return typeof val === 'function' ? val(...args) : val;
}

export function setLang(lang) {
  if (!TRANSLATIONS[lang]) return;
  S.currentLang = lang;
  localStorage.setItem('glp_lang', lang);
  applyTranslations();
  // Lazy imports to avoid circular deps — call via window assignments set in main.js
  if (window.renderSidebar) window.renderSidebar();
  if (S.currentMode === 'analytics' && window.initAnalytics) window.initAnalytics();
  if (S.currentMode === 'library') {
    if (window.renderBeanList) window.renderBeanList();
    if (window.renderGrinderList) window.renderGrinderList();
  }
  if (S.currentMode === 'dialin' && window.renderDialin) window.renderDialin();
}

export function applyTranslations() {
  // Elements with IDs
  const idMap = {
    btnShots: 'nav_shots', btnAnalytics: 'nav_analytics', btnLibrary: 'nav_library',
    btnDialin: 'nav_dialin', btnSettings: 'nav_settings',
    sortNewest: 'sort_newest', sortScore: 'sort_score', sortRating: 'sort_rating', sortDur: 'sort_duration',
    syncBtn: 'btn_sync',
  };
  for (const [id, key] of Object.entries(idMap)) {
    const el = document.getElementById(id);
    if (el) el.textContent = t(key);
  }
  // Live button: preserve inner dot span
  const btnLive = document.getElementById('btnLive');
  if (btnLive) {
    const dot = btnLive.querySelector('.live-dot');
    btnLive.textContent = t('nav_live');
    if (dot) btnLive.prepend(dot);
  }
  // Maintenance button: preserve badge span
  const btnMaint = document.getElementById('btnMaintenance');
  if (btnMaint) {
    const badge = btnMaint.querySelector('.maint-badge');
    btnMaint.textContent = t('nav_maintenance');
    if (badge) btnMaint.appendChild(badge);
  }
  // Orders button: preserve badge span
  const btnOrd = document.getElementById('btnOrders');
  if (btnOrd) {
    const badge = btnOrd.querySelector('.maint-badge');
    btnOrd.textContent = t('nav_orders');
    if (badge) btnOrd.appendChild(badge);
  }
  // Search placeholder
  const searchEl = document.getElementById('shotSearch');
  if (searchEl) searchEl.placeholder = t('search_placeholder');
  // Sync time — only replace if it shows the "no sync" sentinel
  const stEl = document.getElementById('syncTime');
  if (stEl) {
    const allNoSync = Object.values(TRANSLATIONS).map(tr => tr.no_sync);
    if (allNoSync.includes(stEl.textContent)) stEl.textContent = t('no_sync');
  }
  // Active language button in settings view
  document.querySelectorAll('.lang-option-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.lang === S.currentLang);
  });
  // data-i18n elements
  document.querySelectorAll('[data-i18n]').forEach(el => {
    el.textContent = t(el.dataset.i18n);
  });
  document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
    el.placeholder = t(el.dataset.i18nPlaceholder);
  });
  document.querySelectorAll('[data-i18n-title]').forEach(el => {
    el.title = t(el.dataset.i18nTitle);
  });
  document.querySelectorAll('[data-i18n-html]').forEach(el => {
    el.innerHTML = t(el.dataset.i18nHtml);
  });
}
