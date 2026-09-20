// #zero-point: frontend port of go/internal/library/zero_point_test.go's
// scenarios — same history-lookup convention, inline grinder objects
// instead of a DB round trip, since grind-zero.js is a pure ESM module.
import { describe, it, expect } from 'vitest';
import { currentGrinderZeroPoint, normalizeGrindToNow } from '../public-src/grind-zero.js';

describe('currentGrinderZeroPoint', () => {
  it('is null for a grinder that never tracked a zero point', () => {
    expect(currentGrinderZeroPoint({ name: 'Niche Zero' })).toBeNull();
  });

  it('is the last (most recent) entry, chronologically', () => {
    const grinder = { zeroPointHistory: [{ zeroPoint: 10, since: 1 }, { zeroPoint: 12, since: 2 }] };
    expect(currentGrinderZeroPoint(grinder)).toBe(12);
  });
});

describe('normalizeGrindToNow', () => {
  const grinders = [{
    name: 'Niche Zero',
    zeroPointHistory: [
      { zeroPoint: 42.0, since: 1000 }, // active when the shot was pulled
      { zeroPoint: 44.0, since: 2000 }, // reset after cleaning, now current
    ],
  }];

  it("corrects for drift after cleaning — the shot's relative offset is preserved", () => {
    // Ground at absolute 20 when the zero point was 42 (relative +... -22
    // — doesn't matter, the point is the OFFSET survives): once the
    // current zero point is 44, that same relative setting reads as 22.
    expect(normalizeGrindToNow(grinders, 'Niche Zero', 20, 1500)).toBe(22);
  });

  it('is a no-op when the grinder never tracked a zero point', () => {
    expect(normalizeGrindToNow([{ name: 'DF64' }], 'DF64', 20, 1500)).toBe(20);
  });

  it('is a no-op for an unknown grinder name', () => {
    expect(normalizeGrindToNow(grinders, 'Some Other Grinder', 20, 1500)).toBe(20);
  });

  it('is a no-op for a shot older than any tracked zero point', () => {
    expect(normalizeGrindToNow(grinders, 'Niche Zero', 20, 500)).toBe(20);
  });

  it('is a no-op for null/NaN values', () => {
    expect(normalizeGrindToNow(grinders, 'Niche Zero', null, 1500)).toBeNull();
    expect(normalizeGrindToNow(grinders, 'Niche Zero', NaN, 1500)).toBeNaN();
  });

  it('matches grinder names case-insensitively, trimmed', () => {
    expect(normalizeGrindToNow(grinders, '  niche zero  ', 20, 1500)).toBe(22);
  });
});
