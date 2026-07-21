import { S } from './state.js';
import { TRANSLATIONS } from './constants.js';
import { STAR_ICON_SVG } from './icons.js';

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
  // Shot detail (Chart.js legend, phase tags, grind advice) is rendered to canvas/innerHTML
  // once per shot selection, not scanned by applyTranslations() — must be rebuilt explicitly.
  if (S.currentMode === 'shots' && window.updateView) window.updateView();
  if (S.currentMode === 'analytics' && window.initAnalytics) window.initAnalytics();
  if (S.currentMode === 'library') {
    if (window.renderBeanList) window.renderBeanList();
    if (window.renderGrinderList) window.renderGrinderList();
  }
  if (S.currentMode === 'dialin' && window.renderDialin) window.renderDialin();
}

export function applyTranslations() {
  // Elements with IDs — #411: the rail/bottom-nav/more-sheet nav labels used
  // to live here as direct textContent (with special-casing to preserve a
  // nested live-dot/badge span), but the rail redesign gave every nav
  // button a dedicated data-i18n label span instead, so the generic
  // data-i18n scan below now handles them without clobbering the icon SVG
  // or badge siblings.
  const idMap = {
    sortNewest: 'sort_newest', sortScore: 'sort_score', sortDur: 'sort_duration',
    syncBtn: 'btn_sync',
  };
  for (const [id, key] of Object.entries(idMap)) {
    const el = document.getElementById(id);
    if (el) el.textContent = t(key);
  }
  // sortRating carries a decorative star icon (#417) that plain textContent
  // can't hold — same pattern setSortMode() (sidebar.js) uses when this
  // button is the active sort.
  const sortRatingEl = document.getElementById('sortRating');
  if (sortRatingEl) sortRatingEl.innerHTML = `${STAR_ICON_SVG} ${t('sort_rating')}`;
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
