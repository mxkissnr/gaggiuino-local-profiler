import { describe, it, expect, beforeAll, beforeEach } from 'vitest';

// views/shots/utils.js pulls in state.js, which needs localStorage/navigator
// at module load (same stubbing approach as bean-id-resolution-frontend.test.ts).
let calcBeanAgeAtShot: (typeof import('../public-src/views/shots/utils.js'))['calcBeanAgeAtShot'];
let S: (typeof import('../public-src/state/index.js'))['S'];

beforeAll(async () => {
  Object.defineProperty(globalThis, 'localStorage', {
    value: { getItem: () => null, setItem: () => {} },
    configurable: true, writable: true,
  });
  Object.defineProperty(globalThis, 'navigator', {
    value: { language: 'en' },
    configurable: true, writable: true,
  });
  ({ calcBeanAgeAtShot } = await import('../public-src/views/shots/utils.js'));
  ({ S } = await import('../public-src/state/index.js'));
});

interface Bag { openedAt?: number; roastDate?: string }
interface Bean { id: number; name: string; roastDate?: string; bags?: Bag[] }
interface CoffeeLibrary { beans: Bean[]; recipes: unknown[]; grinders: unknown[] }
const state = S as unknown as { coffeeLibrary: CoffeeLibrary | null };

// The shot and the roast date are both built as local midnights, so the day
// count does not depend on the test runner's timezone.
const SHOT_SEC = new Date(2024, 4, 31).getTime() / 1000;

function setBean(roastDate: string, bags: Bag[] = []): void {
  state.coffeeLibrary = { beans: [{ id: 1, name: 'Test Bean', roastDate, bags }], recipes: [], grinders: [] };
}

describe('bean age roast-date parsing (#1402)', () => {
  beforeEach(() => {
    state.coffeeLibrary = { beans: [], recipes: [], grinders: [] };
  });

  it('reads an ISO roast date and its German equivalent the same way', () => {
    setBean('2024-05-01');
    const iso = calcBeanAgeAtShot('Test Bean', SHOT_SEC, 1);
    setBean('01.05.2024');
    const german = calcBeanAgeAtShot('Test Bean', SHOT_SEC, 1);
    expect(iso).toBe(30);
    expect(german).toBe(30);
  });

  it('returns null for a roast date it cannot parse', () => {
    setBean('not-a-date');
    expect(calcBeanAgeAtShot('Test Bean', SHOT_SEC, 1)).toBeNull();
  });

  it("uses the active bag's ISO roast date over the bean default", () => {
    setBean('2020-01-01', [{ id: 1, openedAt: 1, roastDate: '2024-05-01' }]);
    expect(calcBeanAgeAtShot('Test Bean', SHOT_SEC, 1)).toBe(30);
  });
});
