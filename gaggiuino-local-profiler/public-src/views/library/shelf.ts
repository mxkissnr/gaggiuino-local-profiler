// Shelf layout for the bean Library view (part 1 of #1329): the pure
// classification and tile markup live here, views/library.ts owns the render
// and click plumbing. Keeping this module DOM-free lets it be unit-tested
// under vitest's node environment.
import type { Html } from '../../utils.js';
import { esc, html, joinHtml, roastAgeDays } from '../../utils.js';
import { tHtml } from '../../i18n.js';
import { SNOWFLAKE_ICON_SVG } from '../../icons.js';
import { countryName } from '../../constants.js';
import { S } from '../../state/index.js';
import type { BagEntry, BeanRow } from './bags.js';
import { classifyBeanBags } from './bags.js';

// Same view of a bean row as views/library.ts's BeanListRow: the bean plus the
// server-computed bean-level stock fields attached on read (#1122).
export type ShelfBean = BeanRow & {
  consumedG?: number | undefined;
  remainingG?: number | null | undefined;
};

export interface ShelfBuckets {
  inUse: ShelfBean[];
  stock: ShelfBean[];
  emptyArchive: ShelfBean[];
}

// A portion is "in the freezer" while it has not been thawed and still has
// count left — a thawed or fully-pulled portion no longer counts as stock.
export function hasFrozenInFreezer(b: ShelfBean): boolean {
  const bags = Array.isArray(b.bags) ? b.bags : [];
  return bags.some(bg => {
    const frozen = Array.isArray(bg.frozenPortions) ? bg.frozenPortions : [];
    return frozen.some(fp => !fp.thawedAt && (fp.remainingCount ?? fp.portionCount ?? 0) > 0);
  });
}

// Three shelves, each keeping the input order:
//   - emptyArchive: archived (enabled === false) or out of stock with nothing
//     left in the freezer;
//   - inUse: the current bag is opened and still has stock (a bag that has
//     been drawn from but not emptied);
//   - stock: everything else, including beans without tracked stock and beans
//     with 0 g open but portions still frozen.
export function classifyBeanShelf(beans: readonly ShelfBean[]): ShelfBuckets {
  const inUse: ShelfBean[] = [];
  const stock: ShelfBean[] = [];
  const emptyArchive: ShelfBean[] = [];
  for (const b of beans) {
    const archived = b.enabled === false;
    const noStock = b.remainingG != null && b.remainingG <= 0;
    if (archived || (noStock && !hasFrozenInFreezer(b))) {
      emptyArchive.push(b);
      continue;
    }
    const { current } = classifyBeanBags(b);
    const drinking = current != null && current.consumed > 0 && current.remaining != null && current.remaining > 0;
    if (drinking) inUse.push(b);
    else stock.push(b);
  }
  return { inUse, stock, emptyArchive };
}

// Up to two initials from the roaster, falling back to the bean name — the
// placeholder drawn when a bean has no photo.
export function beanInitials(source: string): string {
  const words = String(source ?? '').trim().split(/\s+/).filter(Boolean);
  return words.slice(0, 2).map(w => w.charAt(0)).join('').toUpperCase();
}

// A bean's stock summarised for the shelf: the open bag's grams and fill
// level, how many unopened bags wait behind it, and the grams still frozen.
export interface ShelfStock {
  openG: number | null;
  pct: number | null;
  opened: boolean;
  sealedBags: number;
  frozenG: number;
}

export function shelfStock(b: ShelfBean): ShelfStock {
  const { current, upcoming } = classifyBeanBags(b);
  const opened = current != null && current.consumed > 0;
  // The bag the stock line describes: the open one, or the next full one when
  // nothing is open yet. Untracked beans have neither, so openG stays null.
  const shown: BagEntry | null = current ?? upcoming[0] ?? null;
  let openG: number | null = null;
  let pct: number | null = null;
  if (shown && shown.remaining != null) {
    openG = Math.max(0, Math.round(shown.remaining));
    if (shown.stockG != null && shown.stockG > 0) {
      pct = Math.max(0, Math.min(100, Math.round((shown.remaining / shown.stockG) * 100)));
    }
  }
  const sealedBags = current ? upcoming.length : Math.max(0, upcoming.length - 1);

  // Frozen stock is every portion not yet thawed that still has count left.
  let frozenG = 0;
  const bags = Array.isArray(b.bags) ? b.bags : [];
  for (const bg of bags) {
    const portions = Array.isArray(bg.frozenPortions) ? bg.frozenPortions : [];
    for (const fp of portions) {
      if (fp.thawedAt) continue;
      const count = fp.remainingCount ?? fp.portionCount ?? 0;
      if (count > 0) frozenG += count * (fp.portionWeight_g ?? 0);
    }
  }
  frozenG = Math.round(frozenG * 10) / 10;

  return { openG, pct, opened, sealedBags, frozenG };
}

export interface ShelfTileOpts {
  muted: boolean;
}

// Shared photo block: the bean's image or its initials placeholder. The
// lib-shelf-img class + data-bean-id let loadBeanThumbnails fill the blob URL.
function shelfBagImage(b: ShelfBean): Html {
  return b.image
    ? html`<img class="lib-shelf-img${esc(b.image === 'png' ? ' is-sticker' : '')}" data-bean-id="${esc(b.id)}" alt="">`
    : html`<span class="lib-shelf-ph" aria-hidden="true">${esc(beanInitials(b.roaster || b.name || ''))}</span>`;
}

// First origin as its localized country name (falling back to the legacy
// singular origin field) — the same display the shelf search matches against.
function originLabel(b: ShelfBean): string {
  const code = (Array.isArray(b.origins) && b.origins[0]?.code) || b.origin;
  return code ? countryName(code, S.currentLang) : '';
}

// Thin stock bar shared by the tile and the row — same look as the full bean
// card's .lib-stock-bar-md (accent fill, red below 15 %).
function shelfStockBar(pct: number | null): Html {
  return pct != null
    ? html`<span class="lib-shelf-bar"><span class="lib-shelf-bar-fill${esc(pct < 15 ? ' low' : '')}" style="width:${esc(pct)}%"></span></span>`
    : esc('');
}

// One bag standing on the shelf. A button so a tap opens the bean's detail
// sheet (views/library.ts wires data-action="open-bean-sheet").
export function renderShelfTile(b: ShelfBean, opts: ShelfTileOpts): Html {
  const { opened, openG, pct, sealedBags, frozenG } = shelfStock(b);
  const archived = b.enabled === false;

  // Up to two decorative copies peek out behind the photo to hint at the
  // unopened bags waiting in the cupboard; the badge carries the count.
  const stack: Html = sealedBags > 0
    ? html`<span class="lib-shelf-stack" aria-hidden="true">${sealedBags > 1 ? html`<span class="lib-shelf-stack-layer"></span>` : esc('')}<span class="lib-shelf-stack-layer"></span></span>`
    : esc('');

  return html`<button type="button" class="lib-shelf-tile${esc(opts.muted ? ' muted' : '')}" data-action="open-bean-sheet" data-id="${esc(b.id)}" aria-haspopup="dialog">
    <span class="lib-shelf-bag">
      ${stack}
      ${shelfBagImage(b)}
      ${sealedBags > 0 ? html`<span class="lib-shelf-sealed-badge">+${esc(sealedBags)}</span>` : esc('')}
      ${opened ? html`<span class="lib-shelf-open-badge">${tHtml('lib_shelf_open_badge')}</span>` : esc('')}
      ${archived ? html`<span class="lib-shelf-archived-tag">${tHtml('lib_shelf_archived_tag')}</span>` : esc('')}
    </span>
    <span class="lib-shelf-name serif-display">${esc(b.name)}</span>
    ${b.roaster ? html`<span class="lib-shelf-roaster">${esc(b.roaster)}</span>` : esc('')}
    ${shelfStockBar(pct)}
    ${openG != null ? html`<span class="lib-shelf-stock-line">${esc(openG)} g${sealedBags > 0 ? html`<span class="lib-shelf-sealed">${tHtml('lib_shelf_full_bags', sealedBags)}</span>` : esc('')}</span>` : esc('')}
    ${frozenG > 0 ? html`<span class="lib-shelf-frozen-line">${SNOWFLAKE_ICON_SVG}${esc(frozenG)} g</span>` : esc('')}
  </button>`;
}

// The compact list-view counterpart: the same button/open-sheet contract as
// the tile, laid out as one 44 px row.
export function renderShelfRow(b: ShelfBean, opts: ShelfTileOpts): Html {
  const { opened, openG, pct, sealedBags, frozenG } = shelfStock(b);
  const origin = originLabel(b);
  const subtitle = [b.roaster, origin].filter((v): v is string => !!v).join(' · ');

  const meta: Html[] = [
    openG != null ? html`<span class="lib-shelf-stock-line">${esc(openG)} g</span>` : esc(''),
    sealedBags > 0 ? html`<span class="lib-shelf-sealed">${tHtml('lib_shelf_full_bags', sealedBags)}</span>` : esc(''),
    frozenG > 0 ? html`<span class="lib-shelf-frozen-line">${SNOWFLAKE_ICON_SVG}${esc(frozenG)} g</span>` : esc(''),
  ];

  return html`<button type="button" class="lib-shelf-row${esc(opts.muted ? ' muted' : '')}" data-action="open-bean-sheet" data-id="${esc(b.id)}" aria-haspopup="dialog">
    <span class="lib-shelf-row-imgwrap">${shelfBagImage(b)}</span>
    <span class="lib-shelf-row-info">
      <span class="lib-shelf-row-titlerow"><span class="lib-shelf-row-name">${esc(b.name)}</span>${opened ? html`<span class="lib-shelf-open-badge">${tHtml('lib_shelf_open_badge')}</span>` : esc('')}</span>
      ${subtitle ? html`<span class="lib-shelf-row-sub">${esc(subtitle)}</span>` : esc('')}
      ${shelfStockBar(pct)}
    </span>
    <span class="lib-shelf-row-meta">${joinHtml(meta)}</span>
  </button>`;
}

// ── Shelf search / filter / sort (#1329 part 2) ───────────────────────────
// Pure helpers shared by views/library.ts's toolbar and the unit tests. The
// module stays DOM-free; the toolbar owns the actual inputs.
export type ShelfFilter = 'all' | 'espresso' | 'filter' | 'decaf';
export type ShelfSort = 'fresh' | 'name' | 'remaining';
export type ShelfView = 'shelf' | 'list';

export interface ShelfPrefs {
  query: string;
  filter: ShelfFilter;
  sort: ShelfSort;
  view: ShelfView;
}

export const SHELF_PREFS_KEY = 'glp.libShelf';
export const DEFAULT_SHELF_PREFS: ShelfPrefs = { query: '', filter: 'all', sort: 'fresh', view: 'shelf' };

// Origin codes plus their localized display names (e.g. BR -> "Brazil"), so a
// query matches either what the user typed in the picker or what they see.
function originTerms(b: ShelfBean): string[] {
  const origins = Array.isArray(b.origins) && b.origins.length
    ? b.origins
    : (b.origin ? [{ code: b.origin }] : []);
  const terms: string[] = [];
  for (const o of origins) {
    if (!o.code) continue;
    terms.push(o.code);
    terms.push(countryName(o.code, S.currentLang));
  }
  return terms;
}

export function matchesShelfQuery(b: ShelfBean, query: string): boolean {
  const q = String(query ?? '').trim().toLowerCase();
  if (!q) return true;
  const haystack = [b.name, b.roaster, b.origin, ...originTerms(b)]
    .filter((v): v is string => typeof v === 'string')
    .join(' ')
    .toLowerCase();
  return haystack.includes(q);
}

export function matchesShelfFilter(b: ShelfBean, filter: ShelfFilter): boolean {
  switch (filter) {
    case 'espresso': return b.roastType === 'espresso' || b.roastType === 'omni';
    case 'filter':   return b.roastType === 'filter' || b.roastType === 'omni';
    case 'decaf':    return b.decaf === true;
    default:         return true;
  }
}

function shelfRoastAge(b: ShelfBean): number | null {
  const { current } = classifyBeanBags(b);
  return roastAgeDays(current?.bg.roastDate || b.roastDate);
}

// Returns a new array; the input is never mutated. Array.prototype.sort is
// stable per spec, so equal keys keep the classifier's order.
export function sortShelf(beans: readonly ShelfBean[], sort: ShelfSort): ShelfBean[] {
  const out = [...beans];
  if (sort === 'name') {
    return out.sort((a, b) => String(a.name ?? '').localeCompare(String(b.name ?? '')));
  }
  if (sort === 'remaining') {
    return out.sort((a, b) => {
      const ar = a.remainingG ?? null;
      const br = b.remainingG ?? null;
      if (ar == null && br == null) return 0;
      if (ar == null) return 1;
      if (br == null) return -1;
      return br - ar;
    });
  }
  return out.sort((a, b) => {
    const aa = shelfRoastAge(a);
    const ba = shelfRoastAge(b);
    if (aa == null && ba == null) return 0;
    if (aa == null) return 1;
    if (ba == null) return -1;
    return aa - ba;
  });
}

// Only filter/sort/view survive a reload — a stale query would silently hide
// beans.
export function loadShelfPrefs(): ShelfPrefs {
  try {
    const raw = localStorage.getItem(SHELF_PREFS_KEY);
    if (!raw) return { ...DEFAULT_SHELF_PREFS };
    const parsed = JSON.parse(raw) as Partial<ShelfPrefs>;
    const filter: ShelfFilter = parsed.filter === 'espresso' || parsed.filter === 'filter' || parsed.filter === 'decaf'
      ? parsed.filter : 'all';
    const sort: ShelfSort = parsed.sort === 'name' || parsed.sort === 'remaining' ? parsed.sort : 'fresh';
    const view: ShelfView = parsed.view === 'list' ? 'list' : 'shelf';
    return { query: '', filter, sort, view };
  } catch {
    return { ...DEFAULT_SHELF_PREFS };
  }
}

export function saveShelfPrefs(prefs: ShelfPrefs): void {
  try {
    localStorage.setItem(SHELF_PREFS_KEY, JSON.stringify({ filter: prefs.filter, sort: prefs.sort, view: prefs.view }));
  } catch {
    // Private-mode/quota failures just mean the prefs don't persist.
  }
}
