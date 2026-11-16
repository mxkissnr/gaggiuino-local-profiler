// Settings → "Bean freshness" card (#1835, part B; per-roast-level scopes
// #1977): the days that separate the freshness bands and the grams below which
// a bag counts as running low. The global set lives under `bean_freshness`, each
// roast level's override under `bean_freshness_<level>` — the same keys
// utils.ts's freshnessWindows()/resolveFreshnessWindows() and the Go low-stock
// check already read. This module only edits them.
import { setUiPref, getUiPref } from '../ui-prefs.js';
import { t, tHtml } from '../i18n.js';
import {
  DEFAULT_FRESHNESS_WINDOWS,
  DEFAULT_LEVEL_FRESHNESS_WINDOWS,
  LEVEL_FRESHNESS_PREF,
  ROAST_LEVELS,
  freshnessWindows,
  html,
} from '../utils.js';
import type { RoastLevel } from '../utils.js';
import { CHECK_ICON_SVG } from '../icons.js';

/** Mirror of the Go backend's library.DefaultLowStockThresholdG. */
export const DEFAULT_LOW_STOCK_G = 100;

const MAX_DAY = 365;
const MAX_GRAMS = 5000;

export type FreshnessScope = '' | RoastLevel;

export interface BeanFreshnessInputs {
  degasUntil: number;
  peakFrom: number;
  peakUntil: number;
  fadingUntil: number;
  lowStockG: number;
}

export type BeanFreshnessForm = Record<keyof BeanFreshnessInputs, string>;
export type BeanFreshnessFieldErrors = Partial<Record<keyof BeanFreshnessInputs, string>>;

export interface BeanFreshnessParse {
  /** The validated set, or null when any field/ordering check failed. */
  values: BeanFreshnessInputs | null;
  fieldErrors: BeanFreshnessFieldErrors;
  /** The four windows parse but are not strictly ascending. */
  orderError: boolean;
}

export function defaultBeanFreshness(scope: FreshnessScope = ''): BeanFreshnessInputs {
  const windows = scope ? DEFAULT_LEVEL_FRESHNESS_WINDOWS[scope] : DEFAULT_FRESHNESS_WINDOWS;
  return { ...windows, lowStockG: DEFAULT_LOW_STOCK_G };
}

/** A usable low-stock threshold, mirroring the Go side's 1..5000 whole grams. */
function _validGrams(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= MAX_GRAMS;
}

/** The configured set as the app actually applies it (defaults when unusable). */
export function currentBeanFreshness(scope: FreshnessScope = ''): BeanFreshnessInputs {
  const grams = getUiPref<unknown>('bean_low_stock_g');
  return { ...freshnessWindows(scope), lowStockG: _validGrams(grams) ? grams : DEFAULT_LOW_STOCK_G };
}

function _wholeNumber(raw: string): number | null {
  if (!/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) ? n : null;
}

/**
 * Validates the five form fields. The windows must be strictly ascending
 * because freshnessWindows() treats equal bounds as an unusable set and falls
 * back to the defaults as a whole — saving an equal-bound set would silently
 * discard the user's input.
 */
export function parseBeanFreshnessForm(raw: BeanFreshnessForm): BeanFreshnessParse {
  const fieldErrors: BeanFreshnessFieldErrors = {};
  const days = (['degasUntil', 'peakFrom', 'peakUntil', 'fadingUntil'] as const).map(field => {
    const n = _wholeNumber(raw[field]);
    if (n === null || n < 1 || n > MAX_DAY) fieldErrors[field] = 'bf_err_days';
    return n;
  });
  const grams = _wholeNumber(raw.lowStockG);
  if (grams === null || grams < 1 || grams > MAX_GRAMS) fieldErrors.lowStockG = 'bf_err_grams';

  const [degasUntil, peakFrom, peakUntil, fadingUntil] = days;
  if (degasUntil == null || peakFrom == null || peakUntil == null || fadingUntil == null || grams == null) {
    return { values: null, fieldErrors, orderError: false };
  }
  if (!(degasUntil < peakFrom && peakFrom < peakUntil && peakUntil < fadingUntil)) {
    return { values: null, fieldErrors, orderError: true };
  }
  return {
    values: { degasUntil, peakFrom, peakUntil, fadingUntil, lowStockG: grams },
    fieldErrors,
    orderError: false,
  };
}

function _inputValue(id: string): string {
  return (document.getElementById(id) as HTMLInputElement | null)?.value.trim() ?? '';
}

/** Which window set the card is editing; anything unknown means the global set. */
function _selectedScope(): FreshnessScope {
  const el = document.getElementById('bfLevel') as HTMLSelectElement | null;
  const value = el?.value ?? '';
  return (ROAST_LEVELS as readonly string[]).includes(value) ? value as RoastLevel : '';
}

/** The ui-prefs key holding a scope's window set. */
export function freshnessPrefKey(scope: FreshnessScope): string {
  return scope ? LEVEL_FRESHNESS_PREF[scope] : 'bean_freshness';
}

function _readForm(): BeanFreshnessForm {
  return {
    degasUntil: _inputValue('bfDegasUntil'),
    peakFrom: _inputValue('bfPeakFrom'),
    peakUntil: _inputValue('bfPeakUntil'),
    fadingUntil: _inputValue('bfFadingUntil'),
    lowStockG: _inputValue('bfLowStock'),
  };
}

function _fillForm(values: BeanFreshnessInputs): void {
  const set = (id: string, value: number): void => {
    const el = document.getElementById(id) as HTMLInputElement | null;
    if (el) el.value = String(value);
  };
  set('bfDegasUntil', values.degasUntil);
  set('bfPeakFrom', values.peakFrom);
  set('bfPeakUntil', values.peakUntil);
  set('bfFadingUntil', values.fadingUntil);
  set('bfLowStock', values.lowStockG);
}

// The low-stock grams are one global threshold, not part of a level's window
// set (#1977): a level scope edits only the four days, so the grams row is
// hidden there instead of pretending to belong to the scope. Saving or
// resetting a level must never rewrite the user's global grams.
function _syncLowStockRow(scope: FreshnessScope): void {
  const row = document.getElementById('bfLowStockRow');
  if (row) row.style.display = scope ? 'none' : '';
}

function _renderErrors(errors: BeanFreshnessFieldErrors, orderError: boolean): void {
  const messages = Object.values(errors).filter((key): key is string => Boolean(key)).map(key => t(key));
  if (orderError) messages.push(t('bf_err_order'));
  const el = document.getElementById('bfError');
  if (!el) return;
  el.textContent = messages.join(' ');
  el.style.display = messages.length ? '' : 'none';
}

/** Fills the card from the current stored set; no-op when the card is absent. */
export function renderBeanFreshnessSettings(): void {
  if (!document.getElementById('beanFreshnessCard')) return;
  _fillForm(currentBeanFreshness(_selectedScope()));
  _syncLowStockRow(_selectedScope());
  _renderErrors({}, false);
}

/** Refills the day fields after the scope picker changed (global ↔ a level). */
export function refreshBeanFreshnessScope(): void {
  if (!document.getElementById('beanFreshnessCard')) return;
  _fillForm(currentBeanFreshness(_selectedScope()));
  _syncLowStockRow(_selectedScope());
  _renderErrors({}, false);
}

export function saveBeanFreshnessSettings(): void {
  const scope = _selectedScope();
  const parse = parseBeanFreshnessForm(_readForm());
  _renderErrors(parse.fieldErrors, parse.orderError);
  if (!parse.values) return;
  const { degasUntil, peakFrom, peakUntil, fadingUntil, lowStockG } = parse.values;
  setUiPref(freshnessPrefKey(scope), { degasUntil, peakFrom, peakUntil, fadingUntil });
  if (!scope) setUiPref('bean_low_stock_g', lowStockG);
  _fillForm(parse.values);
  // Bean cards render their freshness badge off the windows; the shot list and
  // the annotation tracker pick the new bands up on their next render.
  window.renderBeanList?.();
  const btn = document.getElementById('bfSaveBtn');
  if (btn) {
    btn.innerHTML = html`${CHECK_ICON_SVG} ${tHtml('bf_saved')}`;
    setTimeout(() => { btn.textContent = t('bf_save'); }, 2000);
  }
}

/** Restores the built-in windows for the selected scope and saves right away. */
export function resetBeanFreshnessSettings(): void {
  const scope = _selectedScope();
  const defaults = defaultBeanFreshness(scope);
  // A level reset restores only that level's four days; the global low-stock
  // grams stay whatever the user set them to.
  _fillForm(scope ? { ...defaults, lowStockG: currentBeanFreshness('').lowStockG } : defaults);
  saveBeanFreshnessSettings();
}
