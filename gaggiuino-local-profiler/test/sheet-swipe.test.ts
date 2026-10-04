import { describe, it, expect } from 'vitest';
import { shouldDismissSheet } from '../public-src/components/sheet-swipe.js';

describe('shouldDismissSheet (#1374)', () => {
  it('dismisses a long drag even when it is slow', () => {
    expect(shouldDismissSheet(80, 1000)).toBe(true);
    expect(shouldDismissSheet(120, 500)).toBe(true);
  });

  it('dismisses a short but quick flick', () => {
    expect(shouldDismissSheet(30, 40)).toBe(true); // 0.75 px/ms
    expect(shouldDismissSheet(24, 40)).toBe(true); // exactly the 0.6 px/ms floor
  });

  it('keeps a short slow drag', () => {
    expect(shouldDismissSheet(30, 200)).toBe(false);
    expect(shouldDismissSheet(24, 50)).toBe(false); // 0.48 px/ms
  });

  it('never dismisses an upward move', () => {
    expect(shouldDismissSheet(-80, 10)).toBe(false);
    expect(shouldDismissSheet(-1, 1)).toBe(false);
  });

  it('keeps a tiny tap and guards a zero duration', () => {
    expect(shouldDismissSheet(0, 5)).toBe(false);
    expect(shouldDismissSheet(5, 0)).toBe(false);
  });
});
