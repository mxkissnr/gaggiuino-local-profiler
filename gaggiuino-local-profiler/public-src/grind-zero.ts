// #zero-point: mirrors go/internal/library/zero_point.go's RelativeGrindSetting
// exactly (same history-lookup convention: the last zeroPointHistory entry
// whose `since` <= the shot's own timestamp is the value that was active
// when it was pulled) so backend and frontend can never drift apart on
// which zero point applied when. The backend never sees more than one
// shot's own annotation payload at save time — this client-side copy is
// what lets grind.js's suggestion/comparison logic normalize an entire
// bean's shot history against S.coffeeLibrary.grinders in one pass.

interface ZeroPointEntry { zeroPoint: number; since: number }

// Grinder rows come from state/index.ts's LibraryRow (Record<string, unknown>),
// so this names only the fields read here — same shape-file pattern as
// GrindBean/GrindLibrary in views/shots/grind.ts.
export interface GrinderLike {
  name?: string | null;
  zeroPointHistory?: ZeroPointEntry[];
}

export function findGrinderByName(grinders: GrinderLike[] | undefined, name: string | null | undefined): GrinderLike | null {
  const key = name?.trim().toLowerCase();
  if (!key) return null;
  return (grinders || []).find(g => g.name?.trim().toLowerCase() === key) || null;
}

// The most recently activated zero point — the last entry, chronologically.
// null for a grinder that has never had one set (feature inactive for it).
export function currentGrinderZeroPoint(grinder: GrinderLike | null | undefined): number | null {
  const history = grinder?.zeroPointHistory;
  if (!Array.isArray(history) || !history.length) return null;
  const sorted = [...history].sort((a, b) => a.since - b.since);
  const last = sorted[sorted.length - 1];
  return last ? last.zeroPoint : null;
}

// The zero point active at timestampMs. null when timestampMs predates the
// grinder's very first recorded zero point — nothing to correct against.
function zeroPointAtTime(grinder: GrinderLike | null | undefined, timestampMs: number): number | null {
  const history = grinder?.zeroPointHistory;
  if (!Array.isArray(history) || !history.length) return null;
  let value: number | null = null;
  for (const e of [...history].sort((a, b) => a.since - b.since)) {
    if (e.since > timestampMs) break;
    value = e.zeroPoint;
  }
  return value;
}

// Normalizes a historical grind-setting value to what it would read on the
// grinder TODAY — e.g. after a cleaning reset the zero point, a shot ground
// at absolute 20 when the zero point was 42 reads as 22 once the current
// zero point is 44, preserving its relative offset. Returns value unchanged
// (the raw recorded number) when the grinder never tracked a zero point, or
// value/shotTimestampMs is missing/NaN — the feature is opt-in and inert
// until a zero point exists to correct against.
export function normalizeGrindToNow(grinders: GrinderLike[] | undefined, grinderName: string | null | undefined, value: number | null | undefined, shotTimestampMs: number | null | undefined): number | null | undefined {
  if (value == null || Number.isNaN(value) || shotTimestampMs == null) return value;
  const grinder = findGrinderByName(grinders, grinderName);
  if (!grinder) return value;
  const nowZP  = currentGrinderZeroPoint(grinder);
  const thenZP = zeroPointAtTime(grinder, shotTimestampMs);
  if (nowZP == null || thenZP == null) return value;
  return value - thenZP + nowZP;
}
