// state.js is still JavaScript (the state split is package A2b); only the slice
// i18n.ts reads is declared here so this module can be checked meanwhile.
// @ts-expect-error -- state.js is untyped until package A2b (state split) converts it
import { S as _S } from './state.js';
import { TRANSLATIONS } from './constants.js';
import { STAR_ICON_SVG } from './icons.js';

const S = _S as { currentLang: string; currentMode: string };

// Cross-module entry points main.js wires onto `window` (kept off direct
// imports to avoid circular deps); declared so the calls below stay typed.
declare global {
  interface Window {
    t?: (key: string, ...args: unknown[]) => string;
    renderSidebar?: () => void;
    updateView?: () => void;
    initAnalytics?: () => void;
    renderBeanList?: () => void;
    renderGrinderList?: () => void;
    renderDialin?: () => void;
  }
}

// A translated entry: static text, or a formatter for parameterised strings.
// Formatters take per-key argument tuples, so their parameters can't be typed
// more precisely through this shared alias than `any[]`.
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- formatter signatures are per-key; t() forwards the caller's args verbatim
export type TranslationValue = string | ((...args: any[]) => string);

// Canonical dictionary shape, anchored to the en locale (t()'s fallback
// source). Indexable by string so dynamic keys (data-i18n attributes) work.
export interface Translations {
  [key: string]: TranslationValue | undefined;
}

function dictionary(lang: string): Translations | undefined {
  return TRANSLATIONS[lang] as Translations | undefined;
}

export function t(key: string, ...args: unknown[]): string {
  // Falls back to English, not German, for a key missing in the active
  // language's file — S.currentLang is already validated against
  // TRANSLATIONS at startup (see state.js), so this only ever fires for an
  // individual key that's out of sync across the 6 language files.
  const val = dictionary(S.currentLang)?.[key] ?? dictionary('en')?.[key] ?? key;
  return typeof val === 'function' ? val(...args) : val;
}

export function setLang(lang: string): void {
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

export function applyTranslations(): void {
  // Elements with IDs — #411: the rail/bottom-nav/more-sheet nav labels used
  // to live here as direct textContent (with special-casing to preserve a
  // nested live-dot/badge span), but the rail redesign gave every nav
  // button a dedicated data-i18n label span instead, so the generic
  // data-i18n scan below now handles them without clobbering the icon SVG
  // or badge siblings.
  const idMap: Record<string, string> = {
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
  const searchEl = document.getElementById('shotSearch') as HTMLInputElement | null;
  if (searchEl) searchEl.placeholder = t('search_placeholder');
  // Sync time — only replace if it shows the "no sync" sentinel
  const stEl = document.getElementById('syncTime');
  if (stEl) {
    const allNoSync = Object.values(TRANSLATIONS).map(tr => (tr as Translations | undefined)?.no_sync);
    const current = stEl.textContent;
    if (current !== null && allNoSync.includes(current)) stEl.textContent = t('no_sync');
  }
  // Active language button in settings view
  document.querySelectorAll<HTMLElement>('.lang-option-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.lang === S.currentLang);
  });
  // data-i18n elements
  document.querySelectorAll<HTMLElement>('[data-i18n]').forEach(el => {
    const key = el.dataset.i18n;
    if (key) el.textContent = t(key);
  });
  document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('[data-i18n-placeholder]').forEach(el => {
    const key = el.dataset.i18nPlaceholder;
    if (key) el.placeholder = t(key);
  });
  document.querySelectorAll<HTMLElement>('[data-i18n-title]').forEach(el => {
    const key = el.dataset.i18nTitle;
    if (key) el.title = t(key);
  });
  document.querySelectorAll<HTMLElement>('[data-i18n-html]').forEach(el => {
    const key = el.dataset.i18nHtml;
    if (key) el.innerHTML = t(key);
  });
}
