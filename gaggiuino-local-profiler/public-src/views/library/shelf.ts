// Shelf layout for the bean Library view (part 1 of #1329): the pure
// classification and tile markup live here, views/library.ts owns the render
// and click plumbing. Keeping this module DOM-free lets it be unit-tested
// under vitest's node environment.
import type { Html } from '../../utils.js';
import { esc, html } from '../../utils.js';
import { tHtml } from '../../i18n.js';
import { SNOWFLAKE_ICON_SVG } from '../../icons.js';
import type { BeanRow } from './bags.js';
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

export interface ShelfTileOpts {
  muted: boolean;
  expanded?: boolean | undefined;
}

// One bag standing on the shelf. A button so a tap expands the full bean card
// below the grid (views/library.ts wires data-action="toggle-shelf-bean").
export function renderShelfTile(b: ShelfBean, opts: ShelfTileOpts): Html {
  const { current } = classifyBeanBags(b);
  const expanded = opts.expanded === true;
  const archived = b.enabled === false;
  const frozen = hasFrozenInFreezer(b);

  let ring: Html = esc('');
  if (current && current.stockG != null && current.stockG > 0 && current.remaining != null) {
    const pct = Math.max(0, Math.min(100, Math.round((current.remaining / current.stockG) * 100)));
    ring = html`<span class="lib-shelf-ring${esc(pct < 15 ? ' low' : '')}" style="--p:${esc(pct)}" title="${esc(pct)}%"></span>`;
  }

  const bag: Html = b.image
    ? html`<img class="lib-shelf-img" data-bean-id="${esc(b.id)}" alt="">`
    : html`<span class="lib-shelf-ph" aria-hidden="true">${esc(beanInitials(b.roaster || b.name || ''))}</span>`;

  return html`<button type="button" class="lib-shelf-tile${esc(opts.muted ? ' muted' : '')}" data-action="toggle-shelf-bean" data-id="${esc(b.id)}" aria-expanded="${esc(expanded ? 'true' : 'false')}">
    <span class="lib-shelf-bag">
      ${bag}
      ${ring}
      ${frozen ? html`<span class="lib-shelf-frozen">${SNOWFLAKE_ICON_SVG}</span>` : esc('')}
      ${archived ? html`<span class="lib-shelf-archived-tag">${tHtml('lib_shelf_archived_tag')}</span>` : esc('')}
    </span>
    <span class="lib-shelf-name serif-display">${esc(b.name)}</span>
    ${b.roaster ? html`<span class="lib-shelf-roaster">${esc(b.roaster)}</span>` : esc('')}
  </button>`;
}
