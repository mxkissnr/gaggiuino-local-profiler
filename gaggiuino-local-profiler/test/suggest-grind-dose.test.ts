import { describe, it, expect, beforeAll } from 'vitest';
import type { GrindShot } from '../public-src/views/shots/grind.js';

// Same stubbing approach as best-grind-combo.test.ts: grind.ts pulls in
// state/index.ts/i18n.ts which need localStorage/navigator at module load.
let suggestGrindDoseForBean: (typeof import('../public-src/views/shots/grind.js'))['suggestGrindDoseForBean'];

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

const shot = (coffee: string, grinder: string, grindSetting: string, dose: string, score: number | null, timestamp: number): GrindShot => ({
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

// #1954 — once the library names a default grinder, only that grinder's own
// history for the bean may supply a grind setting: another grinder's numbers
// are on a different scale, so prefilling them would be wrong after a switch.
describe('default grinder (#1954)', () => {
  const mixedShot = (coffee: string, grinder: string, grindSetting: string, dose: string, timestamp: number): GrindShot => ({
    timestamp,
    annotation: {
      coffee, grinder, grindSetting, dose,
      beanMix: [{ beanId: 1, coffee, grams: 10 }, { beanId: 2, coffee: 'Bean B', grams: 8 }],
    },
  });

  // Three well-scored shots on each grinder: the old one wins on score, the
  // default one is the only one allowed once isDefault is set.
  const twoGrinderShots = (): GrindShot[] => [
    shot('Bean A', 'Old Grinder', '10', '18', 95, 100),
    shot('Bean A', 'Old Grinder', '10', '18', 96, 200),
    shot('Bean A', 'Old Grinder', '10', '18', 94, 300),
    shot('Bean A', 'New Grinder', '24', '18.2', 88, 400),
    shot('Bean A', 'New Grinder', '24', '18.1', 87, 500),
    shot('Bean A', 'New Grinder', '24', '18.3', 89, 600),
  ];

  it('switches the prefill from the old grinder to the default one', () => {
    const shots = twoGrinderShots();
    const without = suggestGrindDoseForBean('Bean A', { beans: [] }, shots);
    expect(without).toEqual({ grinder: 'Old Grinder', grindSetting: '10', dose: '18.3' });

    const withDefault = suggestGrindDoseForBean(
      'Bean A',
      { beans: [], grinders: [{ name: 'Old Grinder' }, { name: 'New Grinder', isDefault: true }] },
      shots,
    );
    expect(withDefault).toEqual({ grinder: 'New Grinder', grindSetting: '24', dose: '18.3' });
  });

  it('changes nothing when isDefault is false or the library has no grinders key', () => {
    const shots = twoGrinderShots();
    const plain = suggestGrindDoseForBean('Bean A', { beans: [] }, shots);
    expect(suggestGrindDoseForBean('Bean A', { beans: [], grinders: [] }, shots)).toEqual(plain);
    expect(suggestGrindDoseForBean(
      'Bean A',
      { beans: [], grinders: [{ name: 'New Grinder', isDefault: false }] },
      shots,
    )).toEqual(plain);
  });

  it('returns the default grinder with an empty setting when it has no history for the bean', () => {
    const shots = [
      shot('Bean A', 'Old Grinder', '10', '17.5', 95, 100),
      shot('Bean A', 'Old Grinder', '10', '18', 93, 200),
    ];
    const result = suggestGrindDoseForBean(
      'Bean A',
      { beans: [], grinders: [{ name: 'New Grinder', isDefault: true }] },
      shots,
    );
    // The dose is not on a grinder scale, so it still comes from the bean's
    // own last shot.
    expect(result).toEqual({ grinder: 'New Grinder', grindSetting: '', dose: '18' });
  });

  it('takes the known grind setting from the default grinder\'s entry, not the first one', () => {
    const lib = {
      beans: [{
        name: 'Bean A',
        knownGrindSettings: [
          { grinder: 'Old Grinder', grindSetting: '12' },
          { grinder: 'New Grinder', grindSetting: '24' },
        ],
      }],
      grinders: [{ name: 'New Grinder', isDefault: true }],
    };
    expect(suggestGrindDoseForBean('Bean A', lib, [])).toEqual({ grinder: 'New Grinder', grindSetting: '24', dose: '' });
    // Without a default the first entry still wins, exactly as before.
    expect(suggestGrindDoseForBean('Bean A', { beans: lib.beans }, []))
      .toEqual({ grinder: 'Old Grinder', grindSetting: '12', dose: '' });
  });

  it('ignores a newer shot on another grinder with { preferMostRecent: true }', () => {
    const shots = [
      shot('Bean A', 'New Grinder', '24', '18', 80, 100),
      shot('Bean A', 'Old Grinder', '9.5', '18.1', 95, 400),
    ];
    expect(suggestGrindDoseForBean(
      'Bean A',
      { beans: [], grinders: [{ name: 'New Grinder', isDefault: true }] },
      shots,
      { preferMostRecent: true },
    )).toEqual({ grinder: 'New Grinder', grindSetting: '24', dose: '18.1' });
    // Today's behaviour, pinned: the newest shot wins.
    expect(suggestGrindDoseForBean('Bean A', { beans: [] }, shots, { preferMostRecent: true }).grindSetting)
      .toBe('9.5');
  });

  it('never uses a default-grinder shot of another bean or a mixed shot', () => {
    const shots = [
      shot('Bean A', 'Old Grinder', '10', '17.5', 95, 100),
      // Default grinder, but another bean.
      shot('Bean B', 'New Grinder', '24', '19', 95, 200),
      shot('Bean B', 'New Grinder', '24', '19', 95, 300),
      shot('Bean B', 'New Grinder', '24', '19', 95, 400),
      // Default grinder and this bean, but a mix says nothing about this bean.
      mixedShot('Bean A', 'New Grinder', '30', '20', 500),
    ];
    const result = suggestGrindDoseForBean(
      'Bean A',
      { beans: [], grinders: [{ name: 'New Grinder', isDefault: true }] },
      shots,
    );
    expect(result).toEqual({ grinder: 'New Grinder', grindSetting: '', dose: '17.5' });
  });

  it('matches the default grinder name ignoring case and surrounding spaces', () => {
    const shots = [
      shot('Bean A', '  new GRINDER ', '24', '18', 90, 100),
      shot('Bean A', 'Old Grinder', '10', '18', 90, 200),
    ];
    const result = suggestGrindDoseForBean(
      'Bean A',
      { beans: [], grinders: [{ name: '  New Grinder  ', isDefault: true }] },
      shots,
    );
    // The library's spelling wins over the shot's.
    expect(result.grinder).toBe('New Grinder');
    expect(result.grindSetting).toBe('24');
  });
});
