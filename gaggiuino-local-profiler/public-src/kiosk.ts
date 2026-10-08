import './tokens.css';
import './kiosk.css';

import { apiFetch } from './api/fetch.js';
import { getMenu, getQueueEta, listOrders, placeOrder } from './api/orders.js';
import type { MenuItem, Order, OrdersSettings, QueueEta } from './api/types.js';
import { CHECK_ICON_SVG, COFFEE_ICON_SVG } from './icons.js';
import { t } from './i18n.js';
import { S } from './state/index.js';
import { THEME_STORAGE_KEY, applyTheme, watchSystemTheme } from './theme.js';
import { esc, html, joinHtml } from './utils.js';
import type { Html } from './utils.js';
import { initToken } from './api/transport.js';
import { etaText, isEinkMode, toggleVariantSelection, variantOrderField } from './kiosk-helpers.js';

// The ordering kiosk (#1267): a second, tablet-facing page that shares the
// app's design system, languages and theme. It is a typed port of the older
// no-JS page (/ui/kiosk now only redirects here) — name step ->
// menu step -> thank-you step, with a live queue panel.
//
// Reused as-is and so deliberately not modified by this slice: api/transport.ts
// (initToken), api/fetch.ts (apiFetch), api/types.ts (MenuItem/Order/QueueEta)
// and i18n.ts (t). The kiosk_* translation keys land separately in #1275.

const QUEUE_POLL_MS = 8000;
const STATUS_POLL_MS = 30000;
const RESET_MS = 6000;
const NAME_MAX = 50;
const NOTE_MAX = 200;

type Step = 'name' | 'menu' | 'thanks';

interface KioskState {
  guestName: string;
  selectedDrink: MenuItem | null;
  selectedVariants: string[];
  menu: MenuItem[];
  resetTimer: ReturnType<typeof setTimeout> | null;
}

const state: KioskState = {
  guestName: '',
  selectedDrink: null,
  selectedVariants: [],
  menu: [],
  resetTimer: null,
};

// The shell is built once into #kiosk, so every lookup below runs after that.
function byId<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`kiosk: missing #${id}`);
  return node as T;
}

function buildShell(root: HTMLElement): void {
  root.innerHTML = html`
    <div class="kiosk-layout">
      <div class="kiosk-main">
        <header class="kiosk-header">
          <h1>${COFFEE_ICON_SVG}<span>${esc(t('kiosk_title'))}</span></h1>
        </header>
        <div id="closedBanner" class="closed-banner" hidden></div>

        <div id="nameStep" class="step">
          <p class="step-prompt">${esc(t('kiosk_name_prompt'))}</p>
          <input id="nameInput" class="name-input" type="text" maxlength="${esc(NAME_MAX)}"
                 autocomplete="off" placeholder="${esc(t('kiosk_name_placeholder'))}">
          <button id="nameNext" class="btn-primary" type="button" disabled>${esc(t('kiosk_next'))}</button>
        </div>

        <div id="menuStep" class="step">
          <div class="menu-header">
            <div id="greeting" class="greeting serif"></div>
            <button id="changeName" class="link-btn" type="button">${esc(t('kiosk_change_name'))}</button>
          </div>
          <div id="drinkGrid" class="drink-grid"></div>
          <div id="variantRow" class="variant-row">
            <label>${esc(t('kiosk_variant_label'))}</label>
            <div id="variantChips" class="variant-chips"></div>
          </div>
          <div class="order-bar">
            <input id="noteInput" class="note-input" type="text" maxlength="${esc(NOTE_MAX)}"
                   placeholder="${esc(t('kiosk_note_placeholder'))}">
            <button id="placeOrder" class="btn-primary" type="button" disabled>${esc(t('kiosk_place_order'))}</button>
          </div>
          <div id="orderError" class="order-error"></div>
        </div>

        <div id="thanksStep" class="step">
          <div class="thanks-icon">${CHECK_ICON_SVG}</div>
          <h2 id="thanksHeading" class="serif"></h2>
          <div id="thanksEta" class="thanks-eta"></div>
        </div>
      </div>

      <aside class="kiosk-queue">
        <h2 class="queue-title">${esc(t('kiosk_queue_title'))}</h2>
        <div id="queueList" class="queue-list"></div>
        <div id="queueEmpty" class="queue-empty" hidden>${esc(t('kiosk_queue_empty'))}</div>
      </aside>
    </div>`;
}

function showStep(step: Step): void {
  byId('nameStep').classList.toggle('active', step === 'name');
  byId('menuStep').classList.toggle('active', step === 'menu');
  byId('thanksStep').classList.toggle('active', step === 'thanks');
}

// ── Menu step ───────────────────────────────────────────────────────────

function renderMenu(): void {
  byId('drinkGrid').innerHTML = joinHtml(state.menu.map(item => {
    const icon: Html = item.emoji ? esc(item.emoji) : COFFEE_ICON_SVG;
    return html`<button type="button" class="drink" data-id="${esc(item.id)}">
      <span class="drink-icon">${icon}</span><span class="drink-name">${esc(item.name)}</span>
    </button>`;
  }));
  byId('drinkGrid').querySelectorAll<HTMLButtonElement>('.drink').forEach(btn => {
    btn.addEventListener('click', () => selectDrink(btn.dataset.id ?? ''));
  });
  renderSelection();
}

function selectDrink(id: string): void {
  state.selectedDrink = state.menu.find(item => item.id === id) ?? null;
  state.selectedVariants = [];
  renderSelection();
}

function renderSelection(): void {
  const selectedId = state.selectedDrink?.id ?? null;
  byId('drinkGrid').querySelectorAll<HTMLButtonElement>('.drink').forEach(btn => {
    btn.classList.toggle('selected', selectedId !== null && btn.dataset.id === selectedId);
  });
  renderVariants();
  byId<HTMLButtonElement>('placeOrder').disabled = state.selectedDrink === null;
}

function renderVariants(): void {
  const variants = state.selectedDrink?.variants ?? [];
  byId('variantRow').classList.toggle('visible', variants.length > 0);
  byId('variantChips').innerHTML = joinHtml(variants.map(variant => {
    const cls = state.selectedVariants.includes(variant) ? 'variant-chip selected' : 'variant-chip';
    return html`<button type="button" class="${esc(cls)}" data-variant="${esc(variant)}">${esc(variant)}</button>`;
  }));
  byId('variantChips').querySelectorAll<HTMLButtonElement>('.variant-chip').forEach(btn => {
    btn.addEventListener('click', () => toggleVariant(btn.dataset.variant ?? ''));
  });
}

function toggleVariant(variant: string): void {
  if (!variant) return;
  state.selectedVariants = toggleVariantSelection(state.selectedVariants, variant);
  renderVariants();
}

// ── Name step ───────────────────────────────────────────────────────────

function onNameInput(): void {
  const value = byId<HTMLInputElement>('nameInput').value.trim();
  byId<HTMLButtonElement>('nameNext').disabled = value.length === 0;
}

function goToMenu(): void {
  const name = byId<HTMLInputElement>('nameInput').value.trim().slice(0, NAME_MAX);
  if (!name) return;
  state.guestName = name;
  byId('greeting').textContent = t('kiosk_greeting', state.guestName);
  showStep('menu');
}

function changeName(): void {
  state.guestName = '';
  state.selectedDrink = null;
  state.selectedVariants = [];
  const input = byId<HTMLInputElement>('nameInput');
  input.value = '';
  byId<HTMLButtonElement>('nameNext').disabled = true;
  renderSelection();
  showStep('name');
  setTimeout(() => { input.focus(); }, 50);
}

// ── Placing an order ────────────────────────────────────────────────────

async function submitOrder(): Promise<void> {
  const drink = state.selectedDrink;
  if (!drink) return;
  const placeBtn = byId<HTMLButtonElement>('placeOrder');
  const errorEl = byId('orderError');
  placeBtn.disabled = true;
  errorEl.textContent = '';
  try {
    const res = await placeOrder({
      item: drink.name,
      customer: state.guestName,
      note: byId<HTMLInputElement>('noteInput').value.trim(),
      ...variantOrderField(state.selectedVariants),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      errorEl.textContent = res.status === 429
        ? t('kiosk_rate_limited')
        : (body?.error ?? t('kiosk_order_failed'));
      placeBtn.disabled = false;
      return;
    }
    onOrderPlaced((await res.json()) as Order);
  } catch {
    errorEl.textContent = t('kiosk_connection_failed');
    placeBtn.disabled = false;
  }
}

function onOrderPlaced(order: Order): void {
  byId('thanksHeading').textContent = t('kiosk_thanks', state.guestName);
  byId('thanksEta').textContent = '';
  showStep('thanks');
  byId<HTMLInputElement>('noteInput').value = '';
  state.selectedDrink = null;
  state.selectedVariants = [];
  renderSelection();

  void refreshThanksEta(order.id);
  void refreshQueue();
  scheduleReset();
}

async function refreshThanksEta(orderId: string): Promise<void> {
  try {
    const eta = await getQueueEta();
    const position = eta.positions[orderId];
    byId('thanksEta').textContent = position ? t('kiosk_ready_in', position.suggestedEta) : '';
  } catch { /* best-effort — the confirmation shows regardless */ }
}

function scheduleReset(): void {
  if (state.resetTimer !== null) clearTimeout(state.resetTimer);
  state.resetTimer = setTimeout(() => {
    resetToName();
  }, RESET_MS);
}

function resetToName(): void {
  state.guestName = '';
  state.selectedDrink = null;
  state.selectedVariants = [];
  const input = byId<HTMLInputElement>('nameInput');
  input.value = '';
  byId<HTMLButtonElement>('nameNext').disabled = true;
  renderSelection();
  showStep('name');
  input.focus();
}

// ── Queue panel ─────────────────────────────────────────────────────────

function renderQueue(orders: Order[], eta: QueueEta | null): void {
  const active = orders.filter(o => o.status === 'pending' || o.status === 'accepted');
  byId('queueList').innerHTML = joinHtml(active.map(o => {
    const item = state.menu.find(m => m.name === o.item);
    const icon: Html = item?.emoji ? esc(item.emoji) : COFFEE_ICON_SVG;
    const status = o.status === 'accepted' ? t('kiosk_status_accepted') : t('kiosk_status_pending');
    const cls = o.status === 'accepted' ? 'queue-row accepted' : 'queue-row';
    return html`<div class="${esc(cls)}">
      <span class="queue-icon">${icon}</span>
      <span class="queue-meta">
        <span class="queue-name">${esc(o.customer || '?')}</span>
        <span class="queue-item">${esc(o.item)} · ${esc(status)}</span>
      </span>
      <span class="queue-eta">${esc(etaText(o, eta, Date.now()))}</span>
    </div>`;
  }));
  byId('queueEmpty').hidden = active.length > 0;
}

async function refreshQueue(): Promise<void> {
  const orders = await listOrders().catch(() => [] as Order[]);
  const eta = await getQueueEta().catch(() => null);
  renderQueue(orders, eta);
}

// ── Open/closed + menu reload ───────────────────────────────────────────

type SettingsProbe =
  | { kind: 'ok'; settings: OrdersSettings }
  | { kind: 'disabled' }
  | { kind: 'error' };

// apiFetchJson cannot tell the kiosk's "feature disabled" 404 apart from a
// real failure, so this one probe stays on apiFetch to read the status.
async function probeSettings(): Promise<SettingsProbe> {
  const r = await apiFetch('api/orders/settings');
  if (r.status === 404) return { kind: 'disabled' };
  if (!r.ok) return { kind: 'error' };
  return { kind: 'ok', settings: (await r.json()) as OrdersSettings };
}

function setBanner(text: string | null): void {
  const banner = byId('closedBanner');
  banner.textContent = text ?? '';
  banner.hidden = text === null;
}

async function checkOpenAndLoadMenu(): Promise<void> {
  try {
    const probe = await probeSettings();
    if (probe.kind === 'disabled') { setBanner(t('kiosk_disabled')); return; }
    if (probe.kind === 'error') { setBanner(t('kiosk_connection_failed')); return; }
    setBanner(probe.settings.enabled === false ? t('kiosk_closed') : null);
    state.menu = await getMenu();
    renderMenu();
  } catch {
    setBanner(t('kiosk_connection_failed'));
  }
}

// ── Bootstrap ───────────────────────────────────────────────────────────

function wireStaticControls(): void {
  const nameInput = byId<HTMLInputElement>('nameInput');
  nameInput.addEventListener('input', onNameInput);
  nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') goToMenu(); });
  byId<HTMLButtonElement>('nameNext').addEventListener('click', goToMenu);
  byId<HTMLButtonElement>('changeName').addEventListener('click', changeName);
  byId<HTMLButtonElement>('placeOrder').addEventListener('click', () => { void submitOrder(); });
}

// The stored theme, or 'auto' when it is unset or storage is unavailable.
function storedTheme(): string {
  try {
    return localStorage.getItem(THEME_STORAGE_KEY) || 'auto';
  } catch {
    return 'auto';
  }
}

async function bootstrap(): Promise<void> {
  const root = document.getElementById('kiosk');
  if (!root) return;

  applyTheme(storedTheme());
  watchSystemTheme();

  if (isEinkMode(location.search)) document.documentElement.classList.add('eink');
  document.documentElement.lang = S.currentLang;

  buildShell(root);
  wireStaticControls();
  showStep('name');

  await initToken();
  await checkOpenAndLoadMenu();
  await refreshQueue();
  setInterval(() => { void refreshQueue(); }, QUEUE_POLL_MS);
  setInterval(() => { void checkOpenAndLoadMenu(); }, STATUS_POLL_MS);
  setTimeout(() => { byId<HTMLInputElement>('nameInput').focus(); }, 100);
}

if (typeof document !== 'undefined' && document.getElementById('kiosk')) void bootstrap();
