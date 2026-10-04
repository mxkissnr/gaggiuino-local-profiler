// Milk section of the Library view, split out of views/library.js.
// Pure move + type port (Part of #1115); no behavior change.
import { S } from '../../state/index.js';
import { t, tHtml } from '../../i18n.js';
import * as libraryApi from '../../api/library.js';
import { esc, html, joinHtml } from '../../utils.js';
import { CLOSE_ICON_SVG, MILK_ICON_SVG } from '../../icons.js';
import type { Milk } from '../../api/types.js';

// state/index.ts's CoffeeLibrary types the milk collection as Milk[]; this
// section declares just the slice of S it reads (same pattern as
// views/library/baskets.ts).
interface MilkState {
  coffeeLibrary: { milks?: Milk[] };
}
function _state(): MilkState {
  return S;
}

const _el = (id: string): HTMLInputElement => document.getElementById(id) as HTMLInputElement;

export function renderMilkList(): void {
  const el = document.getElementById('milkListUI');
  if (!el) return;
  const milks = _state().coffeeLibrary.milks || [];
  if (!milks.length) { el.innerHTML = html``; return; }
  // codeql[js/xss-through-dom] false positive: esc()/escapeHtml() already applied, see #760
  el.innerHTML = joinHtml(milks.map(m => {
    // The `!` only silences the optional type; it is erased at run time, so a
    // missing stockMl compares false in every branch exactly as the untyped
    // original did (only the displayed number falls back to 0).
    const pct = m.stockMl! > 0 ? Math.min(100, m.stockMl! / 20) : 0; // 2000ml = 100%
    const cls = m.stockMl! <= 0 ? 'empty' : m.stockMl! < 300 ? 'low' : 'ok';
    return html`<div class="lib-milk-item">
      <div class="lib-milk-top">
        <span style="font-size:1.3rem">${m.emoji ? esc(m.emoji) : MILK_ICON_SVG}</span>
        <span class="lib-milk-name">${esc(m.name)}</span>
        <button class="lib-milk-del" data-action="delete-milk" data-id="${esc(m.id)}" title="${tHtml('lib_milk_delete')}">${CLOSE_ICON_SVG}</button>
      </div>
      <div class="lib-milk-stock-bar-wrap">
        <div class="lib-milk-stock-bar ${esc(cls)}" style="width:${esc(pct)}%"></div>
      </div>
      <div class="lib-milk-meta">
        <span><b>${esc(m.stockMl ?? 0)} ml</b> ${esc(t('lib_milk_stock').replace(' (ml)',''))}</span>
        ${m.stockMl! < 300 ? html`<span style="color:${esc(m.stockMl! <= 0 ? '#ef4444' : '#f59e0b')}">${m.stockMl! <= 0 ? tHtml('lib_milk_empty') : tHtml('lib_milk_low')}</span>` : html``}
      </div>
      <div class="lib-milk-restock-row">
        <input class="lib-milk-restock-input" type="number" id="milkRestock_${esc(m.id)}" placeholder="ml" min="0" step="50">
        <button class="lib-btn-sm" data-action="restock-milk" data-id="${esc(m.id)}">${tHtml('lib_milk_restock')}</button>
      </div>
    </div>`;
  }));
}

export function openMilkForm(): void {
  (document.getElementById('milkAddForm') as HTMLElement).classList.add('open');
  (document.getElementById('milkAddTrigger') as HTMLElement).style.display = 'none';
}

export function closeMilkForm(): void {
  (document.getElementById('milkAddForm') as HTMLElement).classList.remove('open');
  (document.getElementById('milkAddTrigger') as HTMLElement).style.display = '';
  ['milkFormName','milkFormEmoji','milkFormStock'].forEach(id => { const el = document.getElementById(id); if (el) (el as HTMLInputElement).value = ''; });
}

export async function saveMilk(): Promise<void> {
  const name    = (document.getElementById('milkFormName') as HTMLInputElement | null)?.value.trim();
  const emoji   = (document.getElementById('milkFormEmoji') as HTMLInputElement | null)?.value.trim() || '🥛';
  const stockMl = parseFloat((document.getElementById('milkFormStock') as HTMLInputElement | null)?.value ?? '') || 0;
  if (!name) return;
  const saved = await libraryApi.createMilk({ name, emoji, stockMl });
  if (!saved) return;
  const lib = _state().coffeeLibrary;
  const milks = lib.milks ?? [];
  lib.milks = milks;
  milks.push(saved);
  closeMilkForm();
  renderMilkList();
}

export async function restockMilk(id: number): Promise<void> {
  const val = parseFloat(_el(`milkRestock_${id}`)?.value ?? '');
  if (!val || val <= 0) return;
  const saved = await libraryApi.restockMilk(id, val);
  if (!saved) return;
  const milks = _state().coffeeLibrary.milks || [];
  const idx = milks.findIndex(m => m.id === id);
  if (idx !== -1) milks[idx] = saved;
  renderMilkList();
}

export async function deleteMilk(id: number): Promise<void> {
  if (!confirm(t('lib_milk_delete') + '?')) return;
  const r = await libraryApi.deleteMilkById(id);
  if (!r.ok) return;
  _state().coffeeLibrary.milks = (_state().coffeeLibrary.milks || []).filter(m => m.id !== id);
  renderMilkList();
}
