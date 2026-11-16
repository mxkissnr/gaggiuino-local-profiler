// #1958: offers once to archive a stock-tracked bean that has run out. Never
// archives on its own. One check, fed by every path that can change stock (see
// renderBeanList). Offers go through #1956's popup queue, one at a time.
import { S } from '../../state/index.js';
import { t } from '../../i18n.js';
import * as libraryApi from '../../api/library.js';
import { getUiPref, setUiPref, uiPrefsInSync } from '../../ui-prefs.js';
import { enqueuePopup } from '../../components/popup-queue.js';
import { showToast } from '../../components/toast.js';
import { _beanList } from './bean-shared.js';
import type { BeanListRow } from './bean-shared.js';
import { hasFrozenInFreezer } from './shelf.js';
import * as libraryView from '../library.js';

// Circular with views/library.ts on purpose (it re-exports this module): the
// namespace is read only at call time, the same pattern as bean-sheet.ts.

export const OFFER_ARMED_PREF = 'bean_empty_offer.armed';
export const OFFER_TOAST_MS = 10000;
const POPUP_ID = 'bean-empty-offer';
const MAX_NAME_CHARS = 24;

let _started = false;
let _baselining = false;

/** The bag id to offer for, or null when this bean is not due an offer. */
export function emptyOfferKey(b: BeanListRow, includeArchived = false): number | null {
  if ((b.enabled === false && !includeArchived) || b.remainingG == null || b.remainingG > 0) return null;
  if (hasFrozenInFreezer(b)) return null;
  let newestId = -1;
  let newestUnweighed = false;
  for (const bg of Array.isArray(b.bags) ? b.bags : []) {
    if (typeof bg.id !== 'number' || bg.id <= newestId) continue;
    newestId = bg.id;
    newestUnweighed = bg.remainingG == null;
  }
  if (newestId >= 0 && newestUnweighed) return null;
  const key = newestId >= 0 ? newestId : 0;
  return typeof b.emptyOfferBagId === 'number' && b.emptyOfferBagId >= key ? null : key;
}

function _nextDue(): { bean: BeanListRow; key: number } | null {
  for (const bean of _beanList()) {
    const key = emptyOfferKey(bean);
    if (key !== null) return { bean, key };
  }
  return null;
}

// The public demo's service worker discards writes and answers with a stub, so
// nothing can be recorded there.
function _inPublicDemo(): boolean {
  return 'serviceWorker' in navigator
    && navigator.serviceWorker.controller?.scriptURL.endsWith('/demo-sw.js') === true;
}

function _armed(): boolean {
  return getUiPref<unknown>(OFFER_ARMED_PREF) === true;
}

async function _write(bean: BeanListRow, payload: { enabled?: false; emptyOfferBagId: number }): Promise<void> {
  const saved = await libraryApi.saveBean(bean.id, payload);
  const idx = _beanList().findIndex(b => b.id === bean.id);
  if (idx !== -1) _beanList()[idx] = saved;
}

/** Marks beans as resolved without offering; a failure retries at the next check. */
async function _record(beans: readonly BeanListRow[], arm: boolean): Promise<void> {
  if (_baselining) return;
  _baselining = true;
  try {
    for (const bean of [...beans]) {
      const key = emptyOfferKey(bean, true);
      if (key !== null) await _write(bean, { emptyOfferBagId: key });
    }
    if (arm) setUiPref(OFFER_ARMED_PREF, true);
  } catch (e) {
    console.error('[GLP] recording empty beans failed:', e);
  } finally {
    _baselining = false;
  }
}

async function _settle(bean: BeanListRow, key: number, archive: boolean): Promise<void> {
  try {
    await _write(bean, archive ? { enabled: false, emptyOfferBagId: key } : { emptyOfferBagId: key });
  } catch {
    if (archive) showToast(t('error_generic', ''));
    return;
  }
  if (archive) showToast(t('lib_archived_toast'));
  libraryView.renderBeanList();
}

function _shortName(name: string): string {
  const chars = Array.from(name);
  return chars.length > MAX_NAME_CHARS ? `${chars.slice(0, MAX_NAME_CHARS).join('')}…` : name;
}

function _show(done: () => void): void {
  const next = _nextDue();
  if (!next) { done(); return; }
  const { bean, key } = next;
  showToast(t('bean_empty_offer_toast', _shortName(String(bean.name ?? ''))), {
    duration: OFFER_TOAST_MS,
    action: { label: t('lib_btn_archive'), onClick: () => { void _settle(bean, key, true); } },
    onHide: how => {
      if (how === 'timeout') void _settle(bean, key, false);
      done();
    },
  });
}

/** Compares the library with what was already offered. Cheap and idempotent. */
export function checkEmptyBeanOffer(): void {
  if (!_started || S.isDemo || !uiPrefsInSync() || _inPublicDemo()) return;
  const beans = _beanList();
  if (!_armed()) {
    if (beans.length) void _record(beans, true);
    return;
  }
  // An archived empty bean counts as resolved, so restoring it does not offer it straight back.
  const archived = beans.filter(b => b.enabled === false && emptyOfferKey(b, true) !== null);
  if (archived.length) void _record(archived, false);
  if (!_nextDue()) return;
  enqueuePopup({ id: POPUP_ID, isDue: () => _armed() && _nextDue() !== null, show: _show });
}

/** Boot entry point, once the popup queue and the library are ready. */
export function startEmptyBeanOffers(): void {
  _started = true;
  checkEmptyBeanOffer();
}
