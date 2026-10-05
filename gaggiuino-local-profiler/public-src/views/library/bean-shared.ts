import type { Basket, Milk, PuckScreen, Recipe } from '../../api/types.js';
import type { BeanRow } from './bags.js';
import { S } from '../../state/index.js';

// ── Typed views of S ──────────────────────────────────────────────────────
// state/index.ts types library rows as opaque LibraryRow records; this view
// owns the bean shape plus the bag-level fields the backend attaches on read,
// reached through one typed view of the same array/state (same pattern as
// views/library/bags.ts).
export type BeanListRow = BeanRow & {
  consumedG?: number | undefined;
  remainingG?: number | null | undefined;
};

export function _beanList(): BeanListRow[] {
  return S.coffeeLibrary.beans as BeanListRow[];
}

// A bean origin chip (blend-capable) — mirrors the flavor chips. The schema
// documents the weight as `pct`; the runtime payload carries `percent`.
export interface OriginChip { code?: string | undefined; percent?: number | undefined }
export interface OriginBean { origins?: OriginChip[] | undefined; origin?: string | undefined }

type BeanFormExtraRecipe = Record<string, unknown>;

interface LibraryState {
  coffeeLibrary: {
    recipes?: Recipe[] | undefined;
    milks?: Milk[] | undefined;
    baskets?: Basket[] | undefined;
    puckScreens?: PuckScreen[] | undefined;
  };
  _urlImportImageUrl?: string | null;
  _urlImportExtraRecipes?: BeanFormExtraRecipe[] | null;
}
export function _state(): LibraryState { return S; }

// Every form field read/written here is an <input>/<select>; the shared
// .value/.checked API is all that is used (same helper as grinders.ts).
export function _field(id: string): HTMLInputElement {
  return document.getElementById(id) as HTMLInputElement;
}
export function _el(id: string): HTMLElement {
  return document.getElementById(id) as HTMLElement;
}
