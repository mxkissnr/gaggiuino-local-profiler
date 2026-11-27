// A library grinder's optional grind scale (#1961, #2225). Pure: no DOM, state or i18n.
// Keep in step with go/internal/grindscale/grindscale.go.
import { findGrinderByName } from './grind-zero.js';
import type { GrinderLike } from './grind-zero.js';

// One part of a dial reading (#2225): the first part counts up without end
// from start, every later part has count values, written as digits or letters.
export interface GrindDialPart {
  count: number | null;
  start?: number;
  labels?: 'number' | 'letter';
}

export interface GrindDial {
  parts: GrindDialPart[];
  min: string;
  max: string;
  stepless: boolean;
  resolution: 1 | 2 | 4;
}

// min, max and step are linear positions: the setting itself on a stepped or
// stepless scale, a count of the smallest unit (tick, click) on a dial. Only
// parseGrind and formatGrind know how a setting is written.
export interface GrindScale {
  type: 'stepped' | 'stepless' | 'dial';
  min: number;
  max: number;
  step: number;
  dial?: GrindDial;
}

const MAX_STEPPED_VALUES = 500;
const MAX_DIAL_PARTS = 3;
const MAX_PART_COUNT = 100;
const MAX_LETTERS = 26;
const EPS = 1e-9;
// The dial the fixed dial-in and advice numbers were sized for.
export const GRIND_REFERENCE_SPAN = 50;

function fitsDecimals(v: number): boolean {
  const r = v * 1000;
  return Math.abs(r - Math.round(r)) < 1e-6;
}

const isWhole = (v: unknown, lo: number, hi: number): v is number =>
  typeof v === 'number' && Number.isInteger(v) && v >= lo && v <= hi;

function parseDialParts(raw: unknown): GrindDialPart[] | null {
  if (!Array.isArray(raw) || raw.length < 2 || raw.length > MAX_DIAL_PARTS) return null;
  const parts: GrindDialPart[] = [];
  for (const [i, p] of raw.entries()) {
    if (!p || typeof p !== 'object') return null;
    const { count, start, labels } = p as Record<string, unknown>;
    if (i === 0) {
      if (count !== null || (labels !== undefined && labels !== 'number')) return null;
      if (start !== undefined && !isWhole(start, 0, 1000)) return null;
      parts.push({ count: null, start: start ?? 0 });
      continue;
    }
    const kind = labels ?? 'number';
    if (kind !== 'number' && kind !== 'letter') return null;
    if (!isWhole(count, 2, kind === 'letter' ? MAX_LETTERS : MAX_PART_COUNT)) return null;
    parts.push({ count, labels: kind });
  }
  return parts;
}

function parseDialScale(raw: Record<string, unknown>): GrindScale | null {
  const parts = parseDialParts(raw.parts);
  const { min, max, stepless, resolution } = raw;
  if (!parts || typeof min !== 'string' || typeof max !== 'string') return null;
  if (stepless !== undefined && typeof stepless !== 'boolean') return null;
  if (resolution !== undefined && resolution !== 1 && resolution !== 2 && resolution !== 4) return null;
  const res = stepless ? (resolution ?? 1) : 1;
  const dial: GrindDial = { parts, min: '', max: '', stepless: stepless === true, resolution: res };
  const draft: GrindScale = { type: 'dial', min: 0, max: Infinity, step: 1 / res, dial };
  const lo = parseGrind(draft, min);
  const hi = parseGrind(draft, max);
  if (lo === null || hi === null || hi <= lo) return null;
  dial.min = formatGrind(draft, lo);
  dial.max = formatGrind(draft, hi);
  return { type: 'dial', min: lo, max: hi, step: 1 / res, dial };
}

export function parseGrindScale(raw: unknown): GrindScale | null {
  if (!raw || typeof raw !== 'object') return null;
  const { type, min, max, step } = raw as Record<string, unknown>;
  if (type === 'dial') return parseDialScale(raw as Record<string, unknown>);
  if (type !== 'stepped' && type !== 'stepless') return null;
  if (typeof min !== 'number' || typeof max !== 'number' || typeof step !== 'number') return null;
  if (!Number.isFinite(min) || !Number.isFinite(max) || !Number.isFinite(step)) return null;
  if (min < 0 || max <= min || step <= 0 || step > max - min) return null;
  if (!fitsDecimals(min) || !fitsDecimals(max) || !fitsDecimals(step)) return null;
  if (type === 'stepped' && (max - min) / step >= MAX_STEPPED_VALUES) return null;
  return { type, min, max, step };
}

// The stored form of a scale: what the grinder form sends and a backup keeps.
export type StoredGrindScale =
  | { type: 'stepped' | 'stepless'; min: number; max: number; step: number }
  | { type: 'dial'; parts: GrindDialPart[]; min: string; max: string; stepless: boolean; resolution: 1 | 2 | 4 };

export function storedGrindScale(scale: GrindScale): StoredGrindScale {
  if (!scale.dial) return { type: scale.type === 'stepped' ? 'stepped' : 'stepless', min: scale.min, max: scale.max, step: scale.step };
  const { parts, min, max, stepless, resolution } = scale.dial;
  return { type: 'dial', parts, min, max, stepless, resolution };
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

function scaleDecimals(scale: GrindScale): number {
  return Math.max(decimalsOf(scale.min), decimalsOf(scale.step));
}

function roundTo(scale: GrindScale, v: number): number {
  const p = 10 ** scaleDecimals(scale);
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

// A whole-string number, comma accepted; null for anything else ("33 clicks", "1.2.3").
export function numericGrind(text: string): number | null {
  const trimmed = text.trim();
  return /^\d+(?:[.,]\d+)?$/.test(trimmed) ? parseFloat(trimmed.replace(',', '.')) : null;
}

// The position a dial reading names, null when it is not one ("8.7" on six
// ticks, a letter out of range, a fraction finer than the resolution).
function parseDial(dial: GrindDial, input: string): number | null {
  let text = input.trim().toUpperCase();
  let fraction = 0;
  const comma = text.indexOf(',');
  if (comma >= 0) {
    const digits = text.slice(comma + 1);
    if (!dial.stepless || !/^\d+$/.test(digits)) return null;
    fraction = Number(`0.${digits}`);
    text = text.slice(0, comma);
  }
  const head = /^\d+/.exec(text);
  const first = dial.parts[0];
  if (!head || !first) return null;
  let pos = Number(head[0]) - (first.start ?? 0);
  if (pos < 0) return null;
  let rest = text.slice(head[0].length);
  for (const [i, part] of dial.parts.entries()) {
    if (i === 0) continue;
    const count = part.count ?? 0;
    let value = 0;
    if (part.labels === 'letter') {
      if (rest === '') return null;
      value = rest.charCodeAt(0) - 65;
      rest = rest.slice(1);
    } else if (rest !== '') {
      const m = /^\.(\d+)/.exec(rest);
      if (!m?.[1]) return null;
      let digits = m[1];
      rest = rest.slice(m[0].length);
      // "8.25" on a stepless dial with six ticks is tick 2 and a half: "8.2,5".
      const width = String(count - 1).length;
      if (i === dial.parts.length - 1 && dial.stepless && comma < 0 && digits.length > width) {
        fraction = Number(`0.${digits.slice(width)}`);
        digits = digits.slice(0, width);
      }
      value = Number(digits);
    }
    if (value < 0 || value >= count) return null;
    pos = pos * count + value;
  }
  if (rest !== '') return null;
  const scaled = fraction * dial.resolution;
  if (fraction >= 1 || Math.abs(scaled - Math.round(scaled)) > EPS) return null;
  return pos + fraction;
}

// The position a setting names, null when it is not one. Not range-checked.
export function parseGrind(scale: GrindScale, text: string): number | null {
  return scale.dial ? parseDial(scale.dial, text) : numericGrind(text);
}

// How a position is written on this scale: every stepped part, so 8.0 keeps
// its .0, a stepless dial's fraction after a comma ("8.2,5").
export function formatGrind(scale: GrindScale, v: number): string {
  const dial = scale.dial;
  if (!dial) return roundTo(scale, v).toFixed(scaleDecimals(scale));
  const steps = Math.round(Math.max(0, v) * dial.resolution);
  let whole = Math.floor(steps / dial.resolution);
  const fraction = (steps - whole * dial.resolution) / dial.resolution;
  let tail = '';
  for (let i = dial.parts.length - 1; i > 0; i--) {
    const part = dial.parts[i];
    const count = part?.count ?? 1;
    const digit = whole % count;
    whole = Math.floor(whole / count);
    tail = (part?.labels === 'letter' ? String.fromCharCode(65 + digit) : `.${digit}`) + tail;
  }
  const head = String(whole + (dial.parts[0]?.start ?? 0)) + tail;
  return fraction > 0 ? `${head},${String(fraction).slice(2)}` : head;
}

// A setting's position on this scale, or without a scale the first number in
// the free text ("Setting 3.5" -> 3.5), as grind advice always read it. A
// dial has no free-text fallback: "8.3" there is not the number 8.3.
export function grindPosition(scale: GrindScale | null | undefined, value: string | number | null | undefined): number | null {
  // Only null/undefined and empty/whitespace strings mean "no value" — a
  // grind setting of 0 is a real setting and must survive.
  if (value === null || value === undefined) return null;
  if (scale?.dial) return parseDial(scale.dial, String(value));
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (value.trim() === '') return null;
  const captured = /(\d+(?:[.,]\d+)?)/.exec(value)?.[1];
  return captured !== undefined ? parseFloat(captured.replace(',', '.')) : null;
}

// Every valid setting, in the one stored format.
export function grindValues(scale: GrindScale): string[] {
  return Array.from({ length: valueCount(scale) }, (_, i) => formatGrind(scale, roundTo(scale, scale.min + i * scale.step)));
}

// The stored form of typed input, '' for an empty input, null when it is not valid.
export function normalizeGrindInput(scale: GrindScale, text: string): string | null {
  if (text.trim() === '') return '';
  const v = parseGrind(scale, text);
  if (v === null || !inGrindRange(scale, v)) return null;
  const snapped = snapGrind(scale, v);
  return Math.abs(v - snapped) > EPS ? null : formatGrind(scale, snapped);
}

// A suggested setting on this scale, '' when it cannot be one.
export function prefillGrind(scale: GrindScale, v: number | null): string {
  return v === null || !inGrindRange(scale, v) ? '' : formatGrind(scale, snapGrind(scale, v));
}
