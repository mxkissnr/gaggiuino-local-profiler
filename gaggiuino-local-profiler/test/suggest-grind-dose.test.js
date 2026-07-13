import { describe, it, expect, beforeAll } from 'vitest';

// Same stubbing approach as best-grind-combo.test.js: grind.js pulls in
// state.js/i18n.js which need localStorage/navigator at module load.
let suggestGrindDoseForBean;

beforeAll(async () => {
  Object.defineProperty(globalThis, 'localStorage', {
    value: { getItem: () => null, setItem: () => {} },
    configurable: true, writable: true,
  });
  Object.defineProperty(globalThis, 'navigator', {
    value: { language: 'en' },
    configurable: true, writable: true,
  });
  ({ suggestGrindDoseForBean } = await import('../public-src/views/shots/grind.js'));
});

const shot = (coffee, grinder, grindSetting, dose, score, timestamp) => ({
  timestamp,
  annotation: { coffee, grinder, grindSetting, dose },
  score,
});

describe('suggestGrindDoseForBean', () => {
  it('returns empty strings for an unknown bean with no history', () => {
    const result = suggestGrindDoseForBean('Nonexistent Bean', { beans: [] }, []);
    expect(result).toEqual({ grinder: '', grindSetting: '', dose: '' });
  });

  it('prefers the best-scoring historical combo (>=3 samples) over anything else', () => {
    const shots = [
      shot('Bean A', 'Niche Zero', '18', '18', 95, 300),
      shot('Bean A', 'Niche Zero', '18', '18.2', 93, 200),
      shot('Bean A', 'Niche Zero', '18', '17.9', 97, 100),
    ];
    const lib = { beans: [{ name: 'Bean A', knownGrindSettings: [{ grinder: 'DF64', grindSetting: '20 fine' }] }] };
    const result = suggestGrindDoseForBean('Bean A', lib, shots);
    expect(result.grinder).toBe('Niche Zero');
    expect(result.grindSetting).toBe('18');
    // Dose always comes from the most recent shot with this bean, regardless
    // of which shots fed the best-combo aggregate.
    expect(result.dose).toBe('18');
  });

  it('falls back to knownGrindSettings when there are not enough scored shots for a combo', () => {
    const shots = [
      shot('Bean A', 'Niche Zero', '18', '18', 95, 200),
      shot('Bean A', 'Niche Zero', '18', '18', 93, 100),
    ];
    const lib = { beans: [{ name: 'Bean A', knownGrindSettings: [{ grinder: 'DF64', grindSetting: '20 fine' }] }] };
    const result = suggestGrindDoseForBean('Bean A', lib, shots);
    expect(result.grinder).toBe('DF64');
    expect(result.grindSetting).toBe('20 fine');
    // Dose still comes from the bean's actual last shot, not knownGrindSettings
    // (which doesn't track dose at all).
    expect(result.dose).toBe('18');
  });

  it('falls back to the bean\'s own last shot when it has no combo or knownGrindSettings', () => {
    const shots = [
      shot('Bean A', 'Niche Zero', '18', '17', null, 100),
      shot('Bean B', 'DF64', '22', '19', null, 200), // different bean, must be ignored
    ];
    const lib = { beans: [{ name: 'Bean A' }] };
    const result = suggestGrindDoseForBean('Bean A', lib, shots);
    expect(result).toEqual({ grinder: 'Niche Zero', grindSetting: '18', dose: '17' });
  });

  it('ignores shots from a different bean entirely', () => {
    const shots = [
      shot('Bean B', 'DF64', '22', '19', 90, 300),
      shot('Bean B', 'DF64', '22', '19', 92, 200),
      shot('Bean B', 'DF64', '22', '19', 88, 100),
    ];
    const result = suggestGrindDoseForBean('Bean A', { beans: [] }, shots);
    expect(result).toEqual({ grinder: '', grindSetting: '', dose: '' });
  });
});
