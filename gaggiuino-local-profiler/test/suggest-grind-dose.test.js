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

  // #389 — "↩ Letzten" (quickClone) must prefill the grind actually last
  // used for this bean, not the statistically best-scoring combo.
  describe('with { preferMostRecent: true }', () => {
    it('prefers the bean\'s most recently annotated shot over a qualifying best-combo', () => {
      const shots = [
        // Best-combo candidate: 3 well-scored shots all at grind 18.
        shot('Bean A', 'Niche Zero', '18', '18', 95, 100),
        shot('Bean A', 'Niche Zero', '18', '18.2', 93, 200),
        shot('Bean A', 'Niche Zero', '18', '17.9', 97, 300),
        // Most recent shot for this bean used a different grind — this is
        // what "Letzten" should prefill.
        shot('Bean A', 'Niche Zero', '19.5', '18.1', 80, 400),
      ];
      const result = suggestGrindDoseForBean('Bean A', { beans: [] }, shots, { preferMostRecent: true });
      expect(result.grindSetting).toBe('19.5');
      expect(result.grinder).toBe('Niche Zero');
      expect(result.dose).toBe('18.1');
    });

    it('falls back to the best-combo/knownGrindSettings priority when the most recent shot has no grindSetting', () => {
      const shots = [
        shot('Bean A', 'Niche Zero', '18', '18', 95, 100),
        shot('Bean A', 'Niche Zero', '18', '18.2', 93, 200),
        shot('Bean A', 'Niche Zero', '18', '17.9', 97, 300),
        { timestamp: 400, annotation: { coffee: 'Bean A', dose: '18' } }, // no grindSetting recorded
      ];
      const result = suggestGrindDoseForBean('Bean A', { beans: [] }, shots, { preferMostRecent: true });
      expect(result.grindSetting).toBe('18');
      expect(result.grinder).toBe('Niche Zero');
    });

    it('does not change the default (non-flagged) call\'s best-combo-first behavior', () => {
      const shots = [
        shot('Bean A', 'Niche Zero', '18', '18', 95, 100),
        shot('Bean A', 'Niche Zero', '18', '18.2', 93, 200),
        shot('Bean A', 'Niche Zero', '18', '17.9', 97, 300),
        shot('Bean A', 'Niche Zero', '19.5', '18.1', 80, 400),
      ];
      const result = suggestGrindDoseForBean('Bean A', { beans: [] }, shots);
      expect(result.grindSetting).toBe('18'); // best combo, not the most recent shot's 19.5
    });
  });
});
