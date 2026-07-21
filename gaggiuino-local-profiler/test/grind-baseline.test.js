import { describe, it, expect, beforeAll } from 'vitest';

// Same stubbing approach as suggest-grind-dose.test.js/best-grind-combo.test.js:
// views/shots/utils.js pulls in state.js, which needs localStorage/navigator
// at module load.
let findPreviousShotForBean, isNewestShotForBean;

beforeAll(async () => {
  Object.defineProperty(globalThis, 'localStorage', {
    value: { getItem: () => null, setItem: () => {} },
    configurable: true, writable: true,
  });
  Object.defineProperty(globalThis, 'navigator', {
    value: { language: 'en' },
    configurable: true, writable: true,
  });
  ({ findPreviousShotForBean, isNewestShotForBean } = await import('../public-src/views/shots/utils.js'));
});

const shot = (id, coffee, grindSetting, timestamp) => ({
  id, timestamp, annotation: { coffee, grindSetting },
});

describe('findPreviousShotForBean (#429)', () => {
  it('returns the most recent earlier shot with the same bean', () => {
    const shots = [
      shot(1, 'Bean A', '18', 100),
      shot(2, 'Bean A', '18.5', 200),
      shot(3, 'Bean B', '20', 250),
      shot(4, 'Bean A', '19', 300),
    ];
    const prev = findPreviousShotForBean(shots, shots[3]);
    expect(prev.id).toBe(2);
  });

  it('ignores shots from a different bean', () => {
    const shots = [shot(1, 'Bean B', '20', 100), shot(2, 'Bean A', '18', 200)];
    expect(findPreviousShotForBean(shots, shots[1])).toBeNull();
  });

  it('returns null when the shot has no bean annotated', () => {
    const shots = [shot(1, '', '18', 100), shot(2, '', '19', 200)];
    expect(findPreviousShotForBean(shots, shots[1])).toBeNull();
  });

  it('returns null for the first-ever shot of a bean', () => {
    const shots = [shot(1, 'Bean A', '18', 100)];
    expect(findPreviousShotForBean(shots, shots[0])).toBeNull();
  });

  it('is case-insensitive on the bean name', () => {
    const shots = [shot(1, 'bean a', '18', 100), shot(2, 'Bean A', '19', 200)];
    expect(findPreviousShotForBean(shots, shots[1]).id).toBe(1);
  });
});

describe('isNewestShotForBean (#429)', () => {
  it('is true for the most recent shot of a bean', () => {
    const shots = [shot(1, 'Bean A', '18', 100), shot(2, 'Bean A', '19', 200)];
    expect(isNewestShotForBean(shots, shots[1])).toBe(true);
  });

  it('is false when a later shot exists for the same bean', () => {
    const shots = [shot(1, 'Bean A', '18', 100), shot(2, 'Bean A', '19', 200)];
    expect(isNewestShotForBean(shots, shots[0])).toBe(false);
  });

  it('ignores other beans when deciding newest', () => {
    const shots = [shot(1, 'Bean A', '18', 100), shot(2, 'Bean B', '19', 500)];
    expect(isNewestShotForBean(shots, shots[0])).toBe(true);
  });

  it('is false without a bean annotated', () => {
    const shots = [shot(1, '', '18', 100)];
    expect(isNewestShotForBean(shots, shots[0])).toBe(false);
  });
});
