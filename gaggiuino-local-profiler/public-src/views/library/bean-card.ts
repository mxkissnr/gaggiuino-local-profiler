import { t } from '../../i18n.js';
import * as libraryApi from '../../api/library.js';
import { isoDateInputToMs } from '../../utils.js';
import { generateBeanQR } from '../../glp-qr.js';
import { classifyBeanBags } from './bags.js';
import { _beanList, _field, _el } from './bean-shared.js';
import * as libraryView from '../library.js';

// Circular with library.ts (it re-exports this module): only ever touched at
// call time, never read at module load.
const library = libraryView;

// qrcode ships no type declarations; name the one call this view makes.
interface QrCodeModule {
  toCanvas(canvas: HTMLCanvasElement, text: string, options: {
    width: number; margin: number; errorCorrectionLevel: string;
    color: { dark: string; light: string };
  }): Promise<unknown>;
}

export function openNewBagForm(id: number): void {
  const form = document.getElementById(`newBagForm${id}`);
  if (form) form.style.display = '';
}

export function closeNewBagForm(id: number): void {
  const form = document.getElementById(`newBagForm${id}`);
  if (form) form.style.display = 'none';
}

export async function deleteBag(beanId: number, bagId: number): Promise<void> {
  const bean = _beanList().find(b => b.id === beanId);
  const bags = Array.isArray(bean?.bags) ? bean?.bags : [];
  if (!bean || bags.length <= 1) return;
  const { current } = classifyBeanBags(bean);
  if (current?.bg.id === bagId) return;
  if (!confirm(t('lib_bag_delete_confirm'))) return;
  const saved = await libraryApi.deleteBeanBag(beanId, bagId);
  if (!saved) return;
  const idx = _beanList().findIndex(b => b.id === beanId);
  if (idx !== -1) _beanList()[idx] = saved;
  library.renderBeanList();
}

export async function saveNewBag(id: number): Promise<void> {
  const roastDate   = _field(`newBagRoastDate${id}`)?.value.trim() || '';
  const stock_g     = parseFloat(_field(`newBagStock${id}`)?.value) || null;
  const batchNumber = _field(`newBagBatchNumber${id}`)?.value.trim() || '';
  const saved = await libraryApi.addBeanBag(id, { roastDate, stock_g, batchNumber });
  if (!saved) return;
  const idx = _beanList().findIndex(b => b.id === id);
  if (idx !== -1) _beanList()[idx] = saved;
  library.renderBeanList();
}

export function openFreezeForm(id: number): void {
  _el(`freezeForm${id}`).style.display = '';
}

export function closeFreezeForm(id: number): void {
  _el(`freezeForm${id}`).style.display = 'none';
}

// Freezes a portion of the active bag: grams move into a dated frozen pool
// (see bag.frozenPortions in the schema) but stay counted in stock_g — the
// freeze doesn't consume anything, it just pauses that portion's own
// freshness clock (frozenPortionAgeDays(), utils.js, #477 — the bag's own
// badge is never affected by this) until it's thawed.
// frozenAt (#472) comes from the form's date picker (defaults to today, but
// editable for logging a portion frozen in the past) rather than always
// being "now".
export async function saveFreezePortions(id: number): Promise<void> {
  const portionCount    = parseInt(_field(`freezePortionCount${id}`)?.value, 10);
  const portionWeight_g = parseFloat(_field(`freezePortionWeight${id}`)?.value);
  const frozenAt = isoDateInputToMs(_field(`freezeDate${id}`)?.value) ?? Date.now();
  if (!(portionCount > 0) || !(portionWeight_g > 0)) return;
  const saved = await libraryApi.freezeBeanPortions(id, { portionCount, portionWeight_g, frozenAt });
  if (!saved) return;
  const idx = _beanList().findIndex(b => b.id === id);
  if (idx !== -1) _beanList()[idx] = saved;
  library.renderBeanList();
}

// Thaws one portion (#472) from a frozen-portion batch's remaining count —
// e.g. pulling a single 18.5g vacuum-sealed portion out before a shot,
// leaving the rest still frozen. The batch only stamps thawedAt (and its
// badge switches to the closed-out "thawed" style) once remainingCount
// reaches 0 server-side.
export async function thawPortion(beanId: number, portionId: number): Promise<void> {
  const saved = await libraryApi.thawBeanPortion(beanId, { portionId, count: 1 });
  if (!saved) return;
  const idx = _beanList().findIndex(b => b.id === beanId);
  if (idx !== -1) _beanList()[idx] = saved;
  library.renderBeanList();
}

export function openEditFrozenForm(portionId: number): void {
  const el = document.getElementById(`editFrozenForm${portionId}`);
  if (el) el.style.display = '';
}

export function closeEditFrozenForm(portionId: number): void {
  const el = document.getElementById(`editFrozenForm${portionId}`);
  if (el) el.style.display = 'none';
}

// Corrects a frozen-portion entry after the fact (#472) — wrong count,
// weight, or freeze date entered when it was first frozen. Raising
// remainingCount back above 0 on an already-thawed batch re-opens it
// (server clears thawedAt); this is the only place that can happen from.
export async function saveEditFrozenForm(beanId: number, portionId: number): Promise<void> {
  const remainingCount  = parseInt(_field(`editFrozenRemaining${portionId}`)?.value, 10);
  const portionWeight_g = parseFloat(_field(`editFrozenWeight${portionId}`)?.value);
  const frozenAt = isoDateInputToMs(_field(`editFrozenDate${portionId}`)?.value);
  const body: Record<string, number> = {};
  if (Number.isFinite(remainingCount)) body.remainingCount = remainingCount;
  if (portionWeight_g > 0) body.portionWeight_g = portionWeight_g;
  if (frozenAt != null) body.frozenAt = frozenAt;
  const saved = await libraryApi.adjustFrozenPortion(beanId, { portionId, ...body });
  if (!saved) return;
  const idx = _beanList().findIndex(b => b.id === beanId);
  if (idx !== -1) _beanList()[idx] = saved;
  library.renderBeanList();
}

export function toggleBeanQR(id: number): void {
  const wrap = _el(`beanQR${id}`);
  if (!wrap) return;
  if (wrap.style.display !== 'none') { wrap.style.display = 'none'; return; }
  const bean = _beanList().find(b => b.id === id);
  if (!bean) return;
  wrap.style.display = 'flex';
  const canvas = _el(`beanQRCanvas${id}`) as HTMLCanvasElement;
  const label = wrap.querySelector('.bean-qr-label');
  // qrcode is a dynamic import now (#797) — the label doubles as a loading
  // indicator while its chunk downloads, restored once the canvas is drawn
  // (or the attempt fails).
  if (label) label.textContent = t('bean_qr_loading');
  // toCanvas() with no callback returns a Promise — without this .catch(),
  // a rejection (e.g. QR data-capacity exceeded by a long notes field) was
  // an unhandled rejection: the canvas stayed silently blank, no error ever
  // reached the user.
  // @ts-expect-error -- qrcode ships no type declarations
  const qrModule = import('qrcode') as Promise<{ default: QrCodeModule }>;
  qrModule.then(({ default: QRCode }) =>
    // #814: this was drawn INVERTED — dark: '#e4e4e7' on light: '#18181b' means
    // light modules on a dark ground, to match the dark theme. The QR spec
    // assumes dark-on-light, and while many scanners cope with inversion,
    // plenty of older and simpler ones do not: a code that fails to scan on
    // someone's phone is a functional defect, not a theming preference.
    // Fixed polarity in both themes, deliberately NOT theme-aware.
    QRCode.toCanvas(canvas, generateBeanQR(bean), { width: 140, margin: 2, errorCorrectionLevel: 'L', color: { dark: '#000000', light: '#ffffff' } })
  ).then(() => {
    if (label) label.textContent = t('bean_qr_label');
  }).catch(() => {
    wrap.style.display = 'none';
    if (label) label.textContent = t('bean_qr_label');
    alert(t('bean_qr_error'));
  });
}
