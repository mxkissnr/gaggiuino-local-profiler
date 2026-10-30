import type { ShotAnnotation } from '../api/types.js';

// Bean mix (#1837): a shot whose dose came from several beans. The annotation
// carries `beanMix`, a 2-4 entry array of per-bean shares, next to the usual
// top-level coffee/beanId naming its primary bean (the part with the most
// grams). Mirrors go/internal/shots/bean_mix.go: the same 2-part minimum, the
// same "skip a malformed part, keep the rest" rule, and the same label.
//
// Mixed shots have no single bean to learn from, so every per-bean statistic
// and grind suggestion asks isBeanMix() first and skips them; overall shot
// counts, kg and scores keep counting them.

/** One bean's share of a mixed shot's dose — openapi.yaml's AnnotationBean. */
export interface BeanMixPartInput {
  beanId?: number | null | undefined;
  coffee?: string | null | undefined;
  grams?: number | null | undefined;
}

/**
 * The annotation fields the mix helpers read. openapi.yaml documents `beanMix`
 * (#1837), but schema.gen.ts has not been regenerated for it yet, so the field
 * is named here; `coffee` keeps the generated Annotation schema's type.
 */
export type BeanMixAnnotation = {
  // `| undefined` keeps the view-local annotation aliases (which spell it out
  // for exactOptionalPropertyTypes) assignable here.
  coffee?: ShotAnnotation['coffee'] | null | undefined;
  beanMix?: readonly BeanMixPartInput[] | null | undefined;
};

/** A well-formed part: a named bean and the grams it contributed. */
export interface BeanMixPart {
  beanId: number | null;
  coffee: string;
  grams: number;
}

const MIN_PARTS = 2;

// Array.isArray() types its argument as any[] in the narrowed branch, which
// would make every read below an unsafe-any access; this keeps the elements
// typed.
function _isPartList(v: unknown): v is readonly BeanMixPartInput[] {
  return Array.isArray(v);
}

/** Grams as the label shows them: "18 g", "10.5 g" — no trailing zeros. */
function _grams(n: number): string {
  return `${Number.isInteger(n) ? n : Math.round(n * 10) / 10} g`;
}

/**
 * The annotation's mix parts, or null when it describes no usable mix —
 * absent, not an array, or fewer than two well-formed parts (a single-bean
 * shot never has one). A malformed entry (no coffee name, non-positive grams)
 * is skipped rather than failing the whole mix, matching the Go helper.
 */
export function beanMix(ann: BeanMixAnnotation | null | undefined): BeanMixPart[] | null {
  const raw = ann?.beanMix;
  if (!_isPartList(raw) || raw.length < MIN_PARTS) return null;
  const parts: BeanMixPart[] = [];
  for (const entry of raw) {
    const coffee = (entry.coffee ?? '').trim();
    const grams = entry.grams;
    if (!coffee || typeof grams !== 'number' || !Number.isFinite(grams) || grams <= 0) continue;
    const beanId = typeof entry.beanId === 'number' && Number.isInteger(entry.beanId) ? entry.beanId : null;
    parts.push({ beanId, coffee, grams });
  }
  return parts.length >= MIN_PARTS ? parts : null;
}

/** Whether the annotation describes a mixed shot. */
export function isBeanMix(ann: BeanMixAnnotation | null | undefined): boolean {
  return beanMix(ann) !== null;
}

/**
 * The annotation's bean label: "A + B" for a mixed shot ("A 10 g + B 8 g" with
 * withGrams), the plain coffee name for a single-bean shot.
 */
export function beanLabel(ann: BeanMixAnnotation | null | undefined, withGrams = false): string {
  const parts = beanMix(ann);
  if (!parts) return ann?.coffee ?? '';
  return parts
    .map(p => (withGrams ? `${p.coffee} ${_grams(p.grams)}` : p.coffee))
    .join(' + ');
}
