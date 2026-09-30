// URL import, import-provider settings and barcode/QR scanner sections of the
// Library view, split out of views/library.js. Pure move + type port
// (Part of #1115); no behavior change.
import { S } from '../../state/index.js';
import type { BarcodeDetectorLike } from '../../state/index.js';
import * as timerRegistry from '../../state/timers.js';
import { t } from '../../i18n.js';
import { importFromUrl as apiImportFromUrl, getImportSettings, saveImportSettings } from '../../api/system.js';
import * as libraryApi from '../../api/library.js';
import { esc, html, joinHtml, toIsoDateInput } from '../../utils.js';
import { WARNING_ICON_SVG } from '../../icons.js';
import { parseGlpQrParams } from '../../glp-qr.js';
import * as libraryView from '../library.js';

// Circular with library.js (it re-exports this module): the bean-form helpers
// are only ever called at run time, never read at module load.
const library = libraryView as unknown as {
  openBeanForm: () => void;
  setFormOrigins: (bean: { origins?: { code: string; percent?: number }[]; origin?: string }) => void;
  setFormFlavors: (flavors: string[]) => void;
};

// BarcodeDetector is not in TypeScript's DOM lib yet (see BarcodeDetectorLike
// in state/index.ts); this only types the constructor GLP calls.
declare const BarcodeDetector: new (options: { formats: string[] }) => BarcodeDetectorLike;

// The generated import schema is loose (extraBrewRecipes is Record<string,
// never>[]), so these name the response shape the URL importers actually
// return (go/internal/library import handlers).
interface ImportVariant {
  title?: string;
  price: number;
}

interface ExtraRecipe {
  name: string;
  targetDose_g?: number | null;
  targetYield_g?: number | null;
  targetTime_s?: number | null;
  waterTemp_c?: number | null;
}

interface UrlImportData {
  source?: string | null;
  importedAt?: string | number | null;
  imageUrl?: string | null;
  sourceUrl?: string | null;
  name?: string;
  roaster?: string;
  notes?: string;
  origins?: { code: string; percent?: number }[];
  origin?: string;
  variety?: string;
  process?: string;
  decaf?: boolean;
  flavors?: string[];
  roastType?: string;
  region?: string;
  altitude_m?: number | string;
  importer?: string;
  harvest?: string;
  producer?: string;
  brewTempC?: number | string | null;
  brewRatio?: string;
  brewTimeS?: number | string | null;
  brewNotes?: string;
  price_eur?: number | string;
  importMethod?: string | null;
  duplicateWarning?: { name: string } | null;
  extraBrewRecipes?: ExtraRecipe[] | null;
  variants?: ImportVariant[];
}

interface ImportProvider {
  id: string;
  label: string;
  hostSuffix: string;
  enabled: boolean;
}

interface ImportSettings {
  providers: ImportProvider[];
  customShopifyDomains: string[];
}

// state/index.ts's AppState doesn't declare these three scratch fields (the
// bean form's save path reads them back off S); this section owns them,
// reached through one typed view of S (same pattern as views/library/baskets.ts).
interface ImportState {
  _urlImportImageUrl?: string | null;
  _urlImportExtraRecipes?: ExtraRecipe[] | null;
  _importSettings?: ImportSettings;
}
function _state(): ImportState {
  return S as unknown as ImportState;
}

// Bean-form fields are <input>/<select>/<textarea>; only the shared .value
// (and .checked for the decaf box) API is used.
function _field(id: string): HTMLInputElement {
  return document.getElementById(id) as HTMLInputElement;
}

// ── URL import ────────────────────────────────────────────────────────────
export function toggleUrlImport(): void {
  const row = _field('urlImportRow');
  const visible = row.style.display !== 'none';
  row.style.display = visible ? 'none' : 'flex';
  if (!visible) _field('urlImportInput').focus();
}

export async function importFromUrl(): Promise<void> {
  const input = _field('urlImportInput');
  const btn   = document.querySelector<HTMLButtonElement>('#urlImportRow .lib-url-btn')!;
  const url   = input.value.trim();
  if (!url) return;
  btn.textContent = t('lib_url_importing');
  btn.disabled = true;
  try {
    const r = await apiImportFromUrl(url);
    if (r.status === 400) {
      alert(t('lib_url_unsupported'));
      return;
    }
    if (!r.ok) throw new Error();
    const data = await r.json() as UrlImportData;
    const finish = (variant: ImportVariant | null): void => {
      _applyUrlImport(data, variant);
      input.value = '';
      _field('urlImportRow').style.display = 'none';
    };
    if (Array.isArray(data.variants) && data.variants.length > 1) openVariantPicker(data.variants, finish);
    else finish(null);
  } catch {
    alert(t('lib_url_error'));
  } finally {
    btn.textContent = t('lib_url_btn');
    btn.disabled = false;
  }
}

// Shops commonly offer several sizes at different prices — a chosen variant's
// price/weight override the parser's own best-guess price_eur (based on
// Shopify's arbitrary "default" variant) so the price actually matches what
// the user is recording as stock_g.
const BUILTIN_IMPORT_METHODS = new Set(['builtin:kaffeebraun', 'builtin:hoppenworth-ploch', 'builtin:elbgold']);

// Labels the method that produced the pre-filled data so the user knows how
// much to trust it — a built-in shop parser is well-tested, while the
// generic fallbacks (custom Shopify domain, guessed Shopify endpoint,
// JSON-LD, bare OpenGraph tags) are best-effort and worth double-checking.
function _importMethodLabel(method: string | null | undefined, host: string | null | undefined): string | null {
  if (!method) return null;
  if (BUILTIN_IMPORT_METHODS.has(method)) return t('lib_import_method_builtin', host || '');
  if (method === 'custom-shopify')  return t('lib_import_method_custom_shopify', host || '');
  if (method === 'generic-shopify') return t('lib_import_method_generic_shopify', host || '');
  if (method === 'jsonld')          return t('lib_import_method_jsonld', host || '');
  if (method === 'opengraph')       return t('lib_import_method_opengraph', host || '');
  return null;
}

function _renderImportNotice(method: string | null | undefined, host: string | null | undefined): void {
  const el = document.getElementById('beanFormImportNotice');
  if (!el) return;
  const label = _importMethodLabel(method, host);
  if (!label) { el.style.display = 'none'; el.innerHTML = html``; return; }
  const unverified = !BUILTIN_IMPORT_METHODS.has(method!);
  el.innerHTML = html`<div>${esc(label)}</div>${unverified ? html`<div class="lib-import-notice-hint">${esc(t('lib_import_unverified_hint'))}</div>` : html``}`;
  el.style.display = '';
}

// Non-blocking hint that the parsed bean looks like one already in the
// library (same source URL previously imported, or same name+roaster) — the
// user decides whether to still import (e.g. a fresh bag of the same bean).
function _renderDuplicateWarning(duplicateWarning: { name: string } | null | undefined): void {
  const el = document.getElementById('beanFormDuplicateWarning');
  if (!el) return;
  if (!duplicateWarning) { el.style.display = 'none'; el.innerHTML = html``; return; }
  // #811: icon rendered here rather than baked into the translated string.
  // duplicateWarning.name is user/import data — escaped, since this is now innerHTML.
  el.innerHTML = html`${WARNING_ICON_SVG} ${esc(t('lib_import_duplicate_warning', duplicateWarning.name))}`;
  el.style.display = '';
}

// #451: opt-in Brew Guide recipe candidates (e.g. "Milky Espresso") the
// backend surfaced alongside the bean's own brewTempC/brewRatio block —
// rendered as checkboxes, actually created in saveBean() only for whichever
// ones stay checked at save time.
function _renderExtraRecipeCandidates(extraRecipes: ExtraRecipe[] | null | undefined): void {
  const el = document.getElementById('beanFormExtraRecipes');
  if (!el) return;
  if (!Array.isArray(extraRecipes) || !extraRecipes.length) {
    el.style.display = 'none'; el.innerHTML = html``;
    return;
  }
  const sub = (r: ExtraRecipe): string => [
    r.targetDose_g != null && r.targetYield_g != null ? `${r.targetDose_g}g → ${r.targetYield_g}g` : null,
    r.targetTime_s != null ? `${r.targetTime_s}s` : null,
    r.waterTemp_c != null ? `${r.waterTemp_c}°C` : null,
  ].filter(Boolean).join(' · ');
  el.innerHTML = html`<div class="lib-import-extra-recipes-title">${esc(t('lib_import_extra_recipes_title'))}</div>${joinHtml(extraRecipes.map((r, i) => html`
      <label class="lib-import-extra-recipe-row">
        <input type="checkbox" data-extra-recipe-idx="${esc(i)}" checked>
        <span>${esc(r.name)} <span class="lib-import-extra-recipe-sub">${esc(sub(r))}</span></span>
      </label>`))}`;
  el.style.display = '';
}

function _applyUrlImport(data: UrlImportData, variant: ImportVariant | null): void {
  S._urlImportSource    = data.source    || null;
  S._urlImportedAt      = data.importedAt || null;
  _state()._urlImportImageUrl  = data.imageUrl  || null;
  S._urlImportSourceUrl = data.sourceUrl || null;
  library.openBeanForm();
  _state()._urlImportExtraRecipes = Array.isArray(data.extraBrewRecipes) ? data.extraBrewRecipes : null;
  _renderImportNotice(data.importMethod, data.source);
  _renderDuplicateWarning(data.duplicateWarning);
  _renderExtraRecipeCandidates(data.extraBrewRecipes);
  if (data.name)    _field('beanFormName').value    = data.name;
  if (data.roaster) _field('beanFormRoaster').value = data.roaster;
  if (data.notes)   _field('beanFormNotes').value   = data.notes;
  if (Array.isArray(data.origins) && data.origins.length) library.setFormOrigins({ origins: data.origins });
  else if (data.origin) library.setFormOrigins({ origin: data.origin });
  if (data.variety) _field('beanFormVariety').value = data.variety;
  if (data.process) _field('beanFormProcess').value = data.process;
  if (data.decaf)   _field('beanFormDecaf').checked = true;
  if (Array.isArray(data.flavors) && data.flavors.length) library.setFormFlavors(data.flavors);
  if (data.roastType) _field('beanFormRoastType').value = data.roastType;
  if (data.region)    _field('beanFormRegion').value    = data.region;
  if (data.altitude_m) _field('beanFormAltitude').value = String(data.altitude_m);
  if (data.importer)   _field('beanFormImporter').value = data.importer;
  if (data.harvest)    _field('beanFormHarvest').value  = data.harvest;
  // #433: the backend has parsed producer/brew-guide fields for a while —
  // this function just never copied them into the form.
  if (data.producer)   _field('beanFormProducer').value   = data.producer;
  if (data.brewTempC != null) _field('beanFormBrewTemp').value  = String(data.brewTempC);
  if (data.brewRatio)         _field('beanFormBrewRatio').value = data.brewRatio;
  if (data.brewTimeS != null) _field('beanFormBrewTime').value  = String(data.brewTimeS);
  if (data.brewNotes)         _field('beanFormBrewNotes').value = data.brewNotes;
  if (variant) {
    _field('beanFormPrice').value = (variant.price / 100).toFixed(2);
  } else if (data.price_eur) {
    _field('beanFormPrice').value = String(data.price_eur);
  }
}

function openVariantPicker(variants: ImportVariant[], onPick: (variant: ImportVariant) => void): void {
  const row  = document.getElementById('variantPickerRow');
  const list = document.getElementById('variantPickerList');
  const confirmBtn = document.getElementById('variantPickerConfirm');
  if (!row || !list || !confirmBtn) { onPick(variants[0]); return; }
  list.innerHTML = joinHtml(variants.map((v, i) => html`
    <label class="lib-variant-picker-option">
      <input type="radio" name="variantPick" value="${esc(i)}" ${i === 0 ? html`checked` : html``}>
      ${esc(v.title || '?')} — ${esc((v.price / 100).toFixed(2))} €
    </label>`));
  row.style.display = '';
  const handler = (): void => {
    const idx = Number(list.querySelector<HTMLInputElement>('input[name="variantPick"]:checked')?.value || 0);
    row.style.display = 'none';
    confirmBtn.removeEventListener('click', handler);
    onPick(variants[idx]);
  };
  confirmBtn.addEventListener('click', handler);
}

// ── Import provider settings ────────────────────────────────────────────────
export async function toggleImportSettings(): Promise<void> {
  const row = _field('importSettingsRow');
  const visible = row.style.display !== 'none';
  row.style.display = visible ? 'none' : 'flex';
  if (!visible) await _loadAndRenderImportSettings();
}

async function _loadAndRenderImportSettings(): Promise<void> {
  const r = await getImportSettings();
  if (!r.ok) return;
  const data = await r.json() as ImportSettings;
  _state()._importSettings = data;
  _renderImportSettingsPanel(data);
}

function _renderImportSettingsPanel(data: ImportSettings): void {
  const providersEl = _field('importSettingsProviders');
  const customEl    = _field('importSettingsCustomList');
  providersEl.innerHTML = joinHtml(data.providers.map(p => html`
    <label class="lib-import-settings-provider">
      <input type="checkbox" data-provider-id="${esc(p.id)}" ${p.enabled ? html`checked` : html``}>
      ${esc(p.label)} <span class="lib-import-settings-host">(${esc(p.hostSuffix)})</span>
    </label>`));
  providersEl.querySelectorAll<HTMLInputElement>('input[type="checkbox"]').forEach(cb => {
    cb.addEventListener('change', () => { void _saveProviderToggle(cb.dataset.providerId!, cb.checked); });
  });
  customEl.innerHTML = data.customShopifyDomains.length
    ? joinHtml(data.customShopifyDomains.map(d => html`
        <div class="lib-import-settings-domain">
          <span>${esc(d)}</span>
          <button class="lib-import-settings-remove" data-domain="${esc(d)}" aria-label="${esc(t('lib_import_settings_remove'))}">×</button>
        </div>`))
    : html`<div class="lib-form-hint">${esc(t('lib_import_settings_none'))}</div>`;
  customEl.querySelectorAll<HTMLButtonElement>('.lib-import-settings-remove').forEach(btn => {
    btn.addEventListener('click', () => { void _removeCustomShopifyDomain(btn.dataset.domain!); });
  });
}

async function _saveProviderToggle(providerId: string, enabled: boolean): Promise<void> {
  const current = _state()._importSettings || { providers: [], customShopifyDomains: [] };
  const disabledProviders = current.providers
    .map(p => p.id === providerId ? { ...p, enabled } : p)
    .filter(p => !p.enabled)
    .map(p => p.id);
  const r = await saveImportSettings({ disabledProviders, customShopifyDomains: current.customShopifyDomains });
  if (r.ok) await _loadAndRenderImportSettings();
}

export async function addCustomShopifyDomain(): Promise<void> {
  const input = _field('importSettingsDomainInput');
  const domain = input.value.trim();
  if (!domain) return;
  const current = _state()._importSettings || { providers: [], customShopifyDomains: [] };
  const domains = [...new Set([...current.customShopifyDomains, domain])];
  const r = await saveImportSettings({ customShopifyDomains: domains });
  if (r.ok) {
    input.value = '';
    await _loadAndRenderImportSettings();
  } else {
    alert(t('lib_import_settings_invalid_domain'));
  }
}

async function _removeCustomShopifyDomain(domain: string): Promise<void> {
  const current = _state()._importSettings || { providers: [], customShopifyDomains: [] };
  const domains = current.customShopifyDomains.filter(d => d !== domain);
  const r = await saveImportSettings({ customShopifyDomains: domains });
  if (r.ok) await _loadAndRenderImportSettings();
}

// ── Barcode / QR scanner ──────────────────────────────────────────────────
export async function openScanModal(): Promise<void> {
  if (!('BarcodeDetector' in window)) {
    alert(t('scan_not_supported'));
    return;
  }
  const modal  = document.getElementById('scanModal') as HTMLElement;
  const video  = document.getElementById('scanVideo') as HTMLVideoElement;
  const status = document.getElementById('scanStatus') as HTMLElement;
  status.textContent = t('scan_searching');
  status.className = '';
  modal.classList.add('open');
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
    timerRegistry.set('_scanStream', stream);
    video.srcObject = stream;
  } catch {
    status.textContent = t('scan_error');
    status.className = 'error';
    return;
  }
  S._scanActive   = true;
  timerRegistry.set('_scanDetector', new BarcodeDetector({ formats: ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'qr_code', 'data_matrix'] }));
  void _runScanLoop();
}

export function closeScanModal(): void {
  S._scanActive = false;
  timerRegistry.dispose('_scanStream');
  (document.getElementById('scanModal') as HTMLElement).classList.remove('open');
  (document.getElementById('scanVideo') as HTMLVideoElement).srcObject = null;
}

export async function _runScanLoop(): Promise<void> {
  const video  = document.getElementById('scanVideo') as HTMLVideoElement;
  const status = document.getElementById('scanStatus') as HTMLElement;
  while (S._scanActive) {
    await new Promise(r => setTimeout(r, 300));
    if (!S._scanActive) break;
    try {
      const codes = await timerRegistry.get('_scanDetector')!.detect(video);
      if (!codes.length) continue;
      const raw = codes[0].rawValue;
      // eslint-disable-next-line require-atomic-updates -- this loop-exit flag is idempotent; closeScanModal() setting it concurrently to the same false value is harmless
      S._scanActive = false;
      await _handleScanResult(raw, status);
    } catch { /* frame not ready yet */ }
  }
}

export async function _handleScanResult(raw: string, status: HTMLElement): Promise<void> {
  const glp = parseGlpQrParams(raw);
  if (glp) {
    closeScanModal();
    library.openBeanForm();
    if (glp.name)      _field('beanFormName').value      = glp.name;
    if (glp.roaster)   _field('beanFormRoaster').value   = glp.roaster;
    if (glp.roastDate) _field('beanFormRoastDate').value = toIsoDateInput(glp.roastDate);
    if (glp.notes)     _field('beanFormNotes').value     = glp.notes;
    status.textContent = t('scan_glp_imported');
    status.className = 'found';
    return;
  }
  // EAN/UPC → Open Food Facts, via the backend proxy: the CSP's connect-src
  // is locked to 'self' (deliberate hardening, see go/internal/auth's CSP), so a direct
  // browser fetch to world.openfoodfacts.org is always blocked. The proxy
  // (go/internal/library (barcode scan)) distinguishes "not found" (404) from any other
  // failure so this can show a specific message instead of one silent
  // catch-all error.
  status.textContent = t('scan_searching');
  try {
    const r = await libraryApi.scanBarcode(raw);
    if (r.status === 404) {
      status.textContent = t('scan_not_found');
      status.className = 'error';
      await new Promise(res => setTimeout(res, 1800));
      closeScanModal();
      library.openBeanForm();
      return;
    }
    if (!r.ok) throw new Error(`scan lookup failed: ${r.status}`);
    const { name, roaster, notes } = await r.json() as { name?: string; roaster?: string; notes?: string };
    status.textContent = t('scan_found', name || raw);
    status.className = 'found';
    await new Promise(res => setTimeout(res, 1000));
    closeScanModal();
    library.openBeanForm();
    if (name)    _field('beanFormName').value    = name;
    if (roaster) _field('beanFormRoaster').value = roaster;
    if (notes)   _field('beanFormNotes').value   = notes;
  } catch (e) {
    console.error('Barcode scan lookup failed:', e);
    status.textContent = t('scan_error');
    status.className = 'error';
    await new Promise(res => setTimeout(res, 1800));
    closeScanModal();
    library.openBeanForm();
  }
}
