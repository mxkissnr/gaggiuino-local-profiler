// #1853: the Live tab's reference dropdown labelled a mixed shot with its
// primary bean only, hiding the rest of the mix. It now names every bean,
// while a single-bean shot keeps its plain coffee name.
import { describe, it, expect, beforeEach } from 'vitest';

const g = globalThis as unknown as Record<string, unknown>;
g.localStorage ??= { getItem: () => null, setItem: () => {}, removeItem: () => {} };
g.navigator ??= { language: 'en-US' };

const { S } = await import('../public-src/state/index.js');
const { populateRefSelector } = await import('../public-src/views/live.js');

interface FakeOption {
  value: string;
  textContent: string;
  selected: boolean;
}

function makeSelect() {
  const attrs = new Map<string, string>();
  const options: FakeOption[] = [];
  return {
    value: '',
    options,
    setAttribute: (k: string, v: string) => { attrs.set(k, v); },
    getAttribute: (k: string) => attrs.get(k),
    // The selector clears itself with an innerHTML write before rebuilding.
    set innerHTML(_v: string) { options.length = 0; },
    appendChild: (o: FakeOption) => { options.push(o); return o; },
  };
}

function makeOption(): FakeOption {
  return { value: '', textContent: '', selected: false };
}

describe('Live reference dropdown bean names (#1853)', () => {
  let select: ReturnType<typeof makeSelect>;

  beforeEach(() => {
    select = makeSelect();
    g.document = {
      getElementById: (id: string) => (id === 'refShotSelect' ? select : null),
      createElement: makeOption,
    };
    S.currentLang = 'en';
    S.refShotId = null;
  });

  const optionFor = (id: number): string =>
    select.options.find(o => o.value === String(id))!.textContent;

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

    populateRefSelector();

    expect(optionFor(1)).toContain('— Ethiopia Guji + Brazil Santos');
  });

  it('leaves a single-bean shot on its plain coffee name', () => {
    S.shots = [{
      id: 2,
      timestamp: 1700000000,
      hasChartData: true,
      profile: { name: 'Espresso' },
      annotation: { coffee: 'Colombia Huila', beanId: 3 },
    }];

    populateRefSelector();

    expect(optionFor(2)).toContain('— Colombia Huila');
    expect(optionFor(2)).not.toContain(' + ');
  });
});
