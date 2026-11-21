// #1853: the Live tab's reference list labelled a mixed shot with its primary
// bean only, hiding the rest of the mix. It names every bean, while a
// single-bean shot keeps its plain coffee name. #2153: the list moved from a
// dropdown into the reference chip's sheet (refShotChoices).
import { describe, it, expect, beforeEach } from 'vitest';

const g = globalThis as unknown as Record<string, unknown>;
g.localStorage ??= { getItem: () => null, setItem: () => {}, removeItem: () => {} };
g.navigator ??= { language: 'en-US' };

const { S } = await import('../public-src/state/index.js');
const { refShotChoices } = await import('../public-src/views/live.js');

describe('Live reference list bean names (#1853)', () => {
  beforeEach(() => {
    S.currentLang = 'en';
    S.refShotId = null;
  });

  const choiceFor = (id: number): { title: string; sub: string } => {
    const choice = refShotChoices().find(c => c.id === id);
    if (!choice) throw new Error(`no reference choice for shot ${id}`);
    return choice;
  };

  it('names every bean of a mixed shot', () => {
    S.shots = [{
      id: 1,
      timestamp: 1700000000,
      hasChartData: true,
      profile: { name: 'Espresso' },
      annotation: {
        coffee: 'Ethiopia Guji',
        beanId: 1,
        beanMix: [
          { beanId: 1, coffee: 'Ethiopia Guji', grams: 10 },
          { beanId: 2, coffee: 'Brazil Santos', grams: 8 },
        ],
      },
    }];

    expect(choiceFor(1).sub).toContain('Ethiopia Guji + Brazil Santos');
    expect(choiceFor(1).title).toContain('Espresso');
  });

  it('leaves a single-bean shot on its plain coffee name', () => {
    S.shots = [{
      id: 2,
      timestamp: 1700000000,
      hasChartData: true,
      profile: { name: 'Espresso' },
      annotation: { coffee: 'Colombia Huila', beanId: 3 },
    }];

    expect(choiceFor(2).sub).toContain('Colombia Huila');
    expect(choiceFor(2).sub).not.toContain(' + ');
  });
});
