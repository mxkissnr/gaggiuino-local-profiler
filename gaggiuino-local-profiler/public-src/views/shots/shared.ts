import { S } from '../../state/index.js';
import type { ShotMeta } from '../../state/index.js';
import type { ShotDatapoints } from '../../utils.js';

// state/index.ts types shot rows as metadata-only ShotMeta (id/timestamp plus
// an index signature); this view reads the annotation/curve fields, so these
// local aliases name them — same pattern as views/shots/utils.ts and
// views/shots/annotation.ts.
interface ShotAnnotationData {
  rating?: number | null;
  coffee?: string | null;
  beanId?: number | null;
  basketId?: number | null;
  puckScreenId?: number | null;
  grinder?: string | null;
  grindSetting?: string | number | null;
  dose?: number | null;
  tds?: number | null;
  notes?: string | null;
  drinkType?: string | null;
  milkType?: number | string | null;
  recipeId?: number | null;
  frozenPortionId?: number | null;
  roastDate?: string | null;
  beanAgeDays?: number | null;
  orderedBy?: { customer?: string; item?: string; variant?: string; note?: string } | null;
}

export interface ShotRow extends ShotMeta {
  profileName?: string | null;
  profile?: { name?: string | null; phases?: unknown[]; [key: string]: unknown } | null;
  nativeId?: number | null;
  duration?: number | null;
  score?: number | null;
  image?: string | null;
  glpFirmwareVersion?: string | null;
  trashedAt?: number;
  hasChartData?: boolean;
  usedBeanTarget?: boolean;
  datapoints?: ShotDatapoints;
  annotation?: ShotAnnotationData | null;
}

// state/index.ts types shot rows as metadata-only ShotMeta; this view reads the
// annotation/curve/profile fields, so the row arrays are re-typed once here
// instead of at every read (same convention as views/shots/annotation.ts).
export function _shots(): ShotRow[] { return S.shots; }

// CoffeeLibrary (state/index.ts) only declares beans/grinders; loadLibrary()
// adds the basket/puck-screen collections this file reads for export labels.
export function _libCollection(name: 'baskets' | 'puckScreens'): Record<string, unknown>[] | undefined {
  return S.coffeeLibrary[name];
}

// #635: baskets/puck screens are pure ID-based library selections (see
// annotation.ts's _renderBasketSelect/_renderPuckScreenSelect) — this
// resolves an annotation's basketId/puckScreenId to the current library
// entry's name for display/export, the same way ann.coffee already carries
// the bean's name directly (no lookup needed there since beans store the
// name on the annotation itself).
export function _equipmentName(list: Record<string, unknown>[] | null | undefined, id: number | null | undefined): string | null {
  if (id == null) return null;
  return ((list || []).find(e => e.id === id)?.name as string | undefined) || null;
}
