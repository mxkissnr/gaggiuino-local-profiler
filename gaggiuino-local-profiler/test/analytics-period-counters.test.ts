import { describe, it, expect, beforeAll, beforeEach } from 'vitest';

// Same headless harness as analytics-bean-shelf.test.ts / analytics-world-map-race.test.ts:
// analytics.js pulls in state.js/i18n.js (localStorage/navigator at module load) and
// reads window.calcShotScore at runtime. vitest's node environment has no browser
// globals, so stub the minimum through a loose view of globalThis.
type Analytics = typeof import('../public-src/views/analytics.js');
let buildBeanShelf: Analytics['buildBeanShelf'];
let buildTrendChart: Analytics['buildTrendChart'];
let buildRecipeSummary: Analytics['buildRecipeSummary'];
let buildSummaryKpis: Analytics['buildSummaryKpis'];
let buildWorldMap: Analytics['buildWorldMap'];
let setAnalyticsFilter: Analytics['setAnalyticsFilter'];
type State = typeof import('../public-src/state/index.js');
let S: State['S'];

interface ShotRow {
  id: number;
  timestamp: number;
  score: number | null;
  annotation: { coffee?: string | null; beanId?: number | null };
}

// Only the fields the builders read/write headlessly; the app compiles against
// the real DOM, so this fake needs the runtime shape, not the full interface.
interface FakeEl {
  textContent: string;
  innerHTML: string;
  open: boolean;
  style: { display: string };
  parentElement: FakeEl | null;
  addEventListener: () => void;
}

const g = globalThis as unknown as Record<string, unknown>;
const els: Record<string, FakeEl> = {};

function fakeEl(): FakeEl {
  return { textContent: '', innerHTML: '', open: false, style: { display: '' }, parentElement: null, addEventListener: () => {} };
}

const NOW = Math.floor(Date.now() / 1000);
const DAY = 86400;

const shot = (o: { timestamp: number; score?: number | null; coffee?: string }): ShotRow => ({
  id: o.timestamp,
  timestamp: o.timestamp,
  score: o.score ?? null,
  annotation: { coffee: o.coffee ?? 'Bean' },
});

beforeAll(async () => {
  g.localStorage ??= { getItem: () => null, setItem: () => {} };
  g.navigator ??= { language: 'en-US' };
  g.window = {
    calcShotScore: (s: ShotRow): number | null => s.score,
    getShotData: () => ({}),
    addEventListener: () => {},
    removeEventListener: () => {},
  };
  g.document = {
    getElementById: (id: string): FakeEl | null => els[id] ?? null,
    querySelectorAll: (): FakeEl[] => [],
    contains: (): boolean => false,
    createElement: (): FakeEl => fakeEl(),
  };
  ({ buildBeanShelf, buildTrendChart, buildRecipeSummary, buildSummaryKpis, buildWorldMap, setAnalyticsFilter } =
    await import('../public-src/views/analytics.js'));
  ({ S } = await import('../public-src/state/index.js'));
});

beforeEach(() => {
  for (const key of Object.keys(els)) delete els[key];
  S.shots = [];
  S.machines = [];
  S.activeMachineId = null;
  S.coffeeLibrary = { beans: [], grinders: [] };
});

describe('analytics period counters (#1496)', () => {
  it('the bean shelf counter carries the count and the period, and follows the filter', () => {
    els.beanShelf = fakeEl();
    els.beanShelfCount = fakeEl();
    S.shots = [
      shot({ timestamp: NOW - DAY, score: 90, coffee: 'A' }),
      shot({ timestamp: NOW - 2 * DAY, score: 88, coffee: 'A' }),
      shot({ timestamp: NOW - 10 * DAY, score: 80, coffee: 'B' }),
    ] as unknown as typeof S.shots;

    setAnalyticsFilter({ days: 30 });
    buildBeanShelf();
    expect(els.beanShelfCount.textContent).toBe('2 beans · 30 days');

    setAnalyticsFilter({ days: 7 });
    expect(els.beanShelfCount.textContent).toBe('1 bean · 7 days');
  });

  it('leaves the bean shelf counter empty when there are no rows', () => {
    els.beanShelf = fakeEl();
    els.beanShelfCount = fakeEl();
    setAnalyticsFilter({ days: 30 });
    buildBeanShelf();
    expect(els.beanShelfCount.textContent).toBe('');
  });

  it('the trend counter shows the period, and the 7-day average in the long view', () => {
    els.trendCounter = fakeEl();
    const chart = fakeEl();
    chart.parentElement = fakeEl();
    els.trendChart = chart;
    S.shots = [shot({ timestamp: NOW - DAY, score: 90, coffee: 'A' })] as unknown as typeof S.shots;

    setAnalyticsFilter({ days: 30 });
    buildTrendChart();
    expect(els.trendCounter.textContent).toBe('30 days');

    setAnalyticsFilter({ days: 90 });
    buildTrendChart();
    expect(els.trendCounter.textContent).toBe('7-day average · 90 days');
  });

  it('the recipe and world map counters show the period only', async () => {
    els.recipeRows = fakeEl();
    els.recipeCard = fakeEl();
    els.recipeCount = fakeEl();
    els.worldMapCount = fakeEl();
    els.worldMapWrap = fakeEl();

    setAnalyticsFilter({ days: 30 });
    buildRecipeSummary();
    expect(els.recipeCount.textContent).toBe('30 days');

    await buildWorldMap();
    expect(els.worldMapCount.textContent).toBe('30 days');
  });
});

describe('analytics verdict machine scope (#1496)', () => {
  function scoreShots(): void {
    S.shots = [
      shot({ timestamp: NOW - DAY, score: 90, coffee: 'A' }),
      shot({ timestamp: NOW - 2 * DAY, score: 88, coffee: 'A' }),
    ] as unknown as typeof S.shots;
  }

  beforeEach(() => {
    els.verdictTitle = fakeEl();
    els.verdictSub = fakeEl();
    els.verdictScore = fakeEl();
    scoreShots();
  });

  it('names "All machines" with two registered machines and no active one', () => {
    S.machines = [{ id: 1, name: 'Alpha' }, { id: 2, name: 'Beta' }];
    S.activeMachineId = 'all';
    buildSummaryKpis();
    expect(els.verdictSub.textContent).toContain('All machines');
  });

  it('names the active machine when one is selected', () => {
    S.machines = [{ id: 1, name: 'Alpha' }, { id: 2, name: 'Beta' }];
    S.activeMachineId = 2;
    buildSummaryKpis();
    expect(els.verdictSub.textContent).toContain('· Beta');
    expect(els.verdictSub.textContent).not.toContain('Alpha');
  });

  it('falls back to "#<id>" when the active machine has no name', () => {
    S.machines = [{ id: 1, name: 'Alpha' }, { id: 2 }];
    S.activeMachineId = 2;
    buildSummaryKpis();
    expect(els.verdictSub.textContent).toContain('· #2');
  });

  it('adds no machine part with a single machine', () => {
    S.machines = [{ id: 1, name: 'Alpha' }];
    S.activeMachineId = 1;
    buildSummaryKpis();
    expect(els.verdictSub.textContent).not.toContain('Alpha');
    expect(els.verdictSub.textContent).not.toContain('All machines');
  });
});
