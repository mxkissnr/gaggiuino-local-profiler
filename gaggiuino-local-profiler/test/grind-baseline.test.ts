import { describe, it, expect, beforeAll } from 'vitest';

// Same stubbing approach as suggest-grind-dose.test.js/best-grind-combo.test.js:
// views/shots/utils.js pulls in state.js, which needs localStorage/navigator
// at module load.
let findPreviousShotForBean, isNewestShotForBean, buildGrinderGrindLabel;

beforeAll(async () => {
  Object.defineProperty(globalThis, 'localStorage', {
    value: { getItem: () => null, setItem: () => {} },
    configurable: true, writable: true,
  });
  Object.defineProperty(globalThis, 'navigator', {
    value: { language: 'en' },
    configurable: true, writable: true,
  });
  ({ findPreviousShotForBean, isNewestShotForBean, buildGrinderGrindLabel } = await import('../public-src/views/shots/utils.js'));
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

// #838: the standalone "Letzter Mahlgrad" chip was merged into the
// bean/grinder line's own grind label. These tests prove the STATE CHANGE
// (a previous grind setting existing, or not) actually changes the rendered
// label text, not just that the function runs without throwing.
describe('buildGrinderGrindLabel (#838)', () => {
  // Mirrors public-src/i18n.js's t(): looks a function up by key and calls
  // it with the given args, matching how the real recipe_grinder_grind /
  // recipe_grind_with_baseline templates are invoked.
  const dict = {
    recipe_grinder_grind: (g, s) => (g ? `${g} · grind ${s}` : `Grind ${s}`),
    recipe_grind_with_baseline: (g, s, p) => (g ? `${g} · grind ${s} (last ${p})` : `Grind ${s} (last ${p})`),
  };
  const t = (key, ...args) => dict[key](...args);

  it('shows "(last X)" when the newest shot for a bean has a different previous grind setting', () => {
    const shots = [
      shot(1, 'Bean A', '18', 100),
      shot(2, 'Bean A', '19', 200),
    ];
    const label = buildGrinderGrindLabel(shots, shots[1], true, t);
    expect(label).toContain('(last 18)');
    expect(label).toContain('19');
  });

  it('omits the baseline when there is no previous shot for the bean', () => {
    const shots = [shot(1, 'Bean A', '18', 100)];
    const label = buildGrinderGrindLabel(shots, shots[0], true, t);
    expect(label).not.toContain('last');
    expect(label).toBe('Grind 18');
  });

  it('omits the baseline when this is not the newest shot for the bean (allowBaseline=false, e.g. compare mode)', () => {
    const shots = [
      shot(1, 'Bean A', '18', 100),
      shot(2, 'Bean A', '19', 200),
    ];
    const label = buildGrinderGrindLabel(shots, shots[1], false, t);
    expect(label).not.toContain('last');
    expect(label).toBe('Grind 19');
  });

  it('omits the baseline when viewing an older shot of the same bean', () => {
    const shots = [
      shot(1, 'Bean A', '18', 100),
      shot(2, 'Bean A', '19', 200),
    ];
    const label = buildGrinderGrindLabel(shots, shots[0], true, t);
    expect(label).not.toContain('last');
    expect(label).toBe('Grind 18');
  });
});
