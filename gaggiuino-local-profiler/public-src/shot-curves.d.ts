// Type shim for the not-yet-migrated shot-curves.js (TypeScript migration
// package A5, #1115). Only the symbols consumed by converted view modules are
// declared; delete this file once the module is converted.
import type { ShotDatapoints, ShotSeries } from './utils.js';

export function getShotCurve(id: number | null | undefined): Promise<ShotDatapoints>;
export function ensureCurves(ids: Iterable<number | null | undefined> | null | undefined): Promise<void>;
export function primeCurve(id: number | null | undefined, datapoints: ShotDatapoints | null | undefined): void;
export function evictCurve(id: number | null | undefined): void;
export function hasCurve(id: number): boolean;
export function getRawCurve(id: number | null | undefined): ShotDatapoints | null;
export function getCachedShotData(id: number | null | undefined): ShotSeries | null;
