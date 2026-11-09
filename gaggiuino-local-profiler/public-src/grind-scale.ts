// A library grinder's optional grind scale (#1961). Pure: no DOM, state or i18n.
// Keep in step with go/internal/grindscale/grindscale.go.
import { findGrinderByName } from './grind-zero.js';
import type { GrinderLike } from './grind-zero.js';

export interface GrindScale {
  type: 'stepped' | 'stepless';
  min: number;
  max: number;
  step: number;
}

const MAX_STEPPED_VALUES = 500;
const EPS = 1e-9;
// The dial the fixed dial-in and advice numbers were sized for.
export const GRIND_REFERENCE_SPAN = 50;

function fitsDecimals(v: number): boolean {
  const r = v * 1000;
  return Math.abs(r - Math.round(r)) < 1e-6;
}

export function parseGrindScale(raw: unknown): GrindScale | null {
  if (!raw || typeof raw !== 'object') return null;
  const { type, min, max, step } = raw as Record<string, unknown>;
  if (type !== 'stepped' && type !== 'stepless') return null;
  if (typeof min !== 'number' || typeof max !== 'number' || typeof step !== 'number') return null;
  if (!Number.isFinite(min) || !Number.isFinite(max) || !Number.isFinite(step)) return null;
  if (min < 0 || max <= min || step <= 0 || step > max - min) return null;
  if (!fitsDecimals(min) || !fitsDecimals(max) || !fitsDecimals(step)) return null;
  if (type === 'stepped' && (max - min) / step >= MAX_STEPPED_VALUES) return null;
  return { type, min, max, step };
}

export function scaleForGrinder(grinders: readonly { name?: unknown; scale?: unknown }[] | undefined, name: string | null | undefined): GrindScale | null {
  // Annotated, not asserted: the cast only restated the type the annotation gives.
  const grinder: (GrinderLike & { scale?: unknown }) | null = findGrinderByName(grinders as GrinderLike[] | undefined, name);
  return grinder ? parseGrindScale(grinder.scale) : null;
}

function decimalsOf(v: number): number {
  const text = String(v);
  const dot = text.indexOf('.');
  return dot < 0 ? 0 : text.length - dot - 1;
}

function roundTo(scale: GrindScale, v: number): number {
  const p = 10 ** Math.max(decimalsOf(scale.min), decimalsOf(scale.step));
  return Math.round(v * p) / p;
}

function valueCount(scale: GrindScale): number {
  return Math.floor((scale.max - scale.min) / scale.step + EPS) + 1;
}

export function inGrindRange(scale: GrindScale, v: number): boolean {
  return v >= scale.min && v <= scale.max;
}

// The valid setting nearest to v.
export function snapGrind(scale: GrindScale, v: number): number {
  if (v <= scale.min) return scale.min;
  const last = roundTo(scale, scale.min + (valueCount(scale) - 1) * scale.step);
  if (v >= last) return last;
  return roundTo(scale, scale.min + Math.round((v - scale.min) / scale.step) * scale.step);
}

// Without a scale the old fixed 0.6 applies.
export function grindOnTarget(scale: GrindScale | null, diff: number): boolean {
  const tolerance = scale ? Math.max(1.2 * scale.step, 0.6 * (scale.max - scale.min) / GRIND_REFERENCE_SPAN) : 0.6;
  return Math.abs(diff) < tolerance;
}

// Every valid setting, in the one stored number format.
export function grindValues(scale: GrindScale): string[] {
  return Array.from({ length: valueCount(scale) }, (_, i) => String(roundTo(scale, scale.min + i * scale.step)));
}

// A whole-string number, comma accepted; null for anything else ("33 clicks", "1.2.3").
export function numericGrind(text: string): number | null {
  const trimmed = text.trim();
  return /^\d+(?:[.,]\d+)?$/.test(trimmed) ? parseFloat(trimmed.replace(',', '.')) : null;
}

// The stored form of typed input, '' for an empty input, null when it is not valid.
export function normalizeGrindInput(scale: GrindScale, text: string): string | null {
  if (text.trim() === '') return '';
  const v = numericGrind(text);
  if (v === null || !inGrindRange(scale, v)) return null;
  const snapped = snapGrind(scale, v);
  return Math.abs(v - snapped) > EPS ? null : String(snapped);
}

// A suggested setting on this scale, '' when it cannot be one.
export function prefillGrind(scale: GrindScale, v: number | null): string {
  return v === null || !inGrindRange(scale, v) ? '' : String(snapGrind(scale, v));
}
