// Shared detail popover (#1467): one overlay for small title/sub/body details,
// first used by the coffee-year day cells and reused by the score-trend point
// popover (and later statistics slices). On phones it is a bottom sheet; from
// 900px up, when an anchor is given, it becomes a popover floating next to
// that anchor.

import { tHtml } from '../i18n.js';
import { esc, html } from '../utils.js';
import type { Html } from '../utils.js';
import { CLOSE_ICON_SVG } from '../icons.js';
import { attachSheetSwipe, isPhoneSheetWidth } from './sheet-swipe.js';

export interface DetailSheetOptions {
  title: string;
  sub?: string;
  body: Html;
  anchor?: HTMLElement | null;
}

let _returnFocus: HTMLElement | null = null;
let _keyWired = false;

function _host(): HTMLElement | null {
  return typeof document !== 'undefined' ? document.getElementById('detailSheet') : null;
}

function _isDesktop(): boolean {
  return typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && !isPhoneSheetWidth();
}

function _onKeydown(e: KeyboardEvent): void {
  if (e.key !== 'Escape') return;
  e.preventDefault();
  closeDetailSheet();
}

function _wireKeys(): void {
  if (_keyWired || typeof document === 'undefined' || typeof document.addEventListener !== 'function') return;
  document.addEventListener('keydown', _onKeydown);
  _keyWired = true;
}

function _unwireKeys(): void {
  const wired = _keyWired;
  _keyWired = false;
  if (!wired || typeof document === 'undefined' || typeof document.removeEventListener !== 'function') return;
  document.removeEventListener('keydown', _onKeydown);
}

// Place the popover next to its anchor: right of it when it fits, else left,
// vertically centred and clamped 12px inside the viewport.
function _positionPop(sheet: HTMLElement, anchor: HTMLElement): void {
  if (typeof anchor.getBoundingClientRect !== 'function') return;
  const r = anchor.getBoundingClientRect();
  const vw = window.innerWidth || 0;
  const vh = window.innerHeight || 0;
  const w = sheet.offsetWidth || 360;
  const h = sheet.offsetHeight || 300;
  let left = r.right + 12;
  if (left + w > vw - 12) left = r.left - w - 12;
  if (left < 12) left = 12;
  if (left + w > vw - 12) left = Math.max(12, vw - 12 - w);
  let top = r.top + r.height / 2 - h / 2;
  if (top < 12) top = 12;
  if (top + h > vh - 12) top = Math.max(12, vh - 12 - h);
  sheet.style.left = `${Math.round(left)}px`;
  sheet.style.top = `${Math.round(top)}px`;
}

// Opens the overlay, replacing its content in place on a second call. `anchor`
// is the element the desktop popover floats next to — a coffee-year day cell,
// or the trend chart's canvas for a shot point — and is ignored on phone
// widths, where the overlay is always a bottom sheet.
export function openDetailSheet(opts: DetailSheetOptions): void {
  const host = _host();
  if (!host) return;

  // Only the first open captures the return target; a second open replaces the
  // content in place, so restoring must still land on the original element.
  if (!host.classList?.contains?.('open')) {
    _returnFocus = (typeof document !== 'undefined' ? document.activeElement : null) as HTMLElement | null;
  }

  const anchor = opts.anchor ?? null;
  const desktop = _isDesktop() && anchor !== null;

  host.innerHTML = html`
    <div class="lib-sheet-backdrop${desktop ? html` detail-backdrop` : esc('')}"></div>
    <section class="lib-sheet${desktop ? html` detail-pop` : esc('')}" role="dialog" aria-modal="true" aria-labelledby="detailSheetTitle">
      <div class="lib-sheet-grab" aria-hidden="true"></div>
      <div class="detail-sheet-head">
        <div class="detail-sheet-titles">
          <h2 id="detailSheetTitle" class="detail-sheet-title">${esc(opts.title)}</h2>
          ${opts.sub ? html`<p class="detail-sheet-sub">${esc(opts.sub)}</p>` : esc('')}
        </div>
        <button type="button" class="lib-sheet-close detail-sheet-close" aria-label="${tHtml('lib_sheet_close')}">${CLOSE_ICON_SVG}</button>
      </div>
      <div class="detail-sheet-body">${opts.body}</div>
    </section>`;
  host.classList?.add('open');
  if (typeof document !== 'undefined') document.body?.classList?.add('lib-sheet-open');

  const sheet = typeof host.querySelector === 'function' ? host.querySelector<HTMLElement>('.lib-sheet') : null;
  const grab = sheet && typeof sheet.querySelector === 'function' ? sheet.querySelector<HTMLElement>('.lib-sheet-grab') : null;
  const head = sheet && typeof sheet.querySelector === 'function' ? sheet.querySelector<HTMLElement>('.detail-sheet-head') : null;
  if (sheet && grab) attachSheetSwipe(sheet, grab, closeDetailSheet);
  if (sheet && head) attachSheetSwipe(sheet, head, closeDetailSheet);
  if (desktop && sheet && anchor) _positionPop(sheet, anchor);

  const backdrop = typeof host.querySelector === 'function' ? host.querySelector<HTMLElement>('.lib-sheet-backdrop') : null;
  const closeBtn = typeof host.querySelector === 'function' ? host.querySelector<HTMLElement>('.detail-sheet-close') : null;
  backdrop?.addEventListener?.('click', closeDetailSheet);
  closeBtn?.addEventListener?.('click', closeDetailSheet);

  _wireKeys();
  closeBtn?.focus?.();
}

export function closeDetailSheet(): void {
  _unwireKeys();
  const host = _host();
  if (host) {
    host.innerHTML = html``;
    host.classList?.remove('open');
  }
  if (typeof document !== 'undefined') document.body?.classList?.remove('lib-sheet-open');
  const back = _returnFocus;
  _returnFocus = null;
  if (back && typeof back.focus === 'function'
    && typeof document !== 'undefined' && typeof document.contains === 'function' && document.contains(back)) {
    back.focus();
  }
}
