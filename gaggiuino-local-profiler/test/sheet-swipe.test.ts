import { describe, it, expect } from 'vitest';
import {
  allowsBodyDrag,
  dismissDistance,
  recentVelocity,
  rubberBand,
  shouldDismissSheet,
} from '../public-src/components/sheet-swipe.js';

type Sample = { t: number; y: number };

describe('shouldDismissSheet (#1374/#1488)', () => {
  it('dismisses a drag past a quarter of the height', () => {
    // 800px tall sheet: threshold is min(200, 80) = 80px.
    expect(dismissDistance(800)).toBe(80);
    expect(shouldDismissSheet(80, 800, 0)).toBe(true);
    expect(shouldDismissSheet(200, 800, 0)).toBe(true);
    expect(shouldDismissSheet(79, 800, 0)).toBe(false);
  });

  it('uses a quarter of the height for a short sheet', () => {
    // 100px tall sheet: threshold is min(25, 80) = 25px.
    expect(dismissDistance(100)).toBe(25);
    expect(shouldDismissSheet(25, 100, 0)).toBe(true);
    expect(shouldDismissSheet(24, 100, 0)).toBe(false);
  });

  it('dismisses a short but recent fast flick', () => {
    expect(shouldDismissSheet(10, 800, 0.5)).toBe(true);
    expect(shouldDismissSheet(10, 800, 0.6)).toBe(true);
    expect(shouldDismissSheet(10, 800, 0.49)).toBe(false);
  });

  it('never dismisses an upward move, even a fast one', () => {
    expect(shouldDismissSheet(-80, 800, 1)).toBe(false);
    expect(shouldDismissSheet(-1, 100, 5)).toBe(false);
  });

  it('keeps a tiny tap', () => {
    expect(shouldDismissSheet(0, 800, 0)).toBe(false);
    expect(shouldDismissSheet(5, 800, 0)).toBe(false);
  });
});

describe('recentVelocity (#1488)', () => {
  it('measures only the last 100ms of samples', () => {
    const samples: Sample[] = [
      { t: 0, y: 0 },
      { t: 400, y: 400 }, // outside the window for t=500
      { t: 450, y: 425 },
      { t: 500, y: 450 },
    ];
    // 50px over 100ms (from t=400 to t=500) = 0.5 px/ms, not 450/500.
    expect(recentVelocity(samples)).toBeCloseTo(0.5, 5);
  });

  it('reads a slow start followed by a fast flick as fast', () => {
    const samples: Sample[] = [
      { t: 0, y: 0 },
      { t: 900, y: 10 },
      { t: 950, y: 40 },
      { t: 1000, y: 90 },
    ];
    // Last window: 80px over 100ms = 0.8 px/ms, though total is 0.09 px/ms.
    expect(recentVelocity(samples)).toBeCloseTo(0.8, 5);
  });

  it('returns 0 without two distinct timestamps', () => {
    expect(recentVelocity([])).toBe(0);
    expect(recentVelocity([{ t: 0, y: 0 }])).toBe(0);
    expect(recentVelocity([{ t: 5, y: 0 }, { t: 5, y: 40 }])).toBe(0);
  });
});

describe('rubberBand (#1488)', () => {
  it('damps an upward pull and never exceeds 24px', () => {
    expect(rubberBand(0)).toBe(0);
    expect(rubberBand(-5)).toBe(0);
    expect(rubberBand(10)).toBe(-5);
    expect(rubberBand(1000)).toBe(-24);
  });
});

describe('allowsBodyDrag (#1488)', () => {
  it('allows a downward drag from the top of the content', () => {
    expect(allowsBodyDrag(0, 10, false)).toBe(true);
  });

  it('refuses when the content is scrolled', () => {
    expect(allowsBodyDrag(5, 10, false)).toBe(false);
  });

  it('refuses an upward move', () => {
    expect(allowsBodyDrag(0, -10, false)).toBe(false);
    expect(allowsBodyDrag(0, 0, false)).toBe(false);
  });

  it('refuses an interactive target', () => {
    expect(allowsBodyDrag(0, 10, true)).toBe(false);
  });
});
