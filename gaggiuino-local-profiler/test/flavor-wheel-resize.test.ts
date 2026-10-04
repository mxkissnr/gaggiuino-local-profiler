import { describe, it, expect, beforeEach, vi } from 'vitest';

interface ChartStub {
  dispose(): void;
  setOption(): void;
  dispatchAction(): void;
  off(): void;
  on(): void;
  resize(): void;
  resizeCalls: number;
}

const { charts } = vi.hoisted(() => ({ charts: [] as ChartStub[] }));

// The resize path only needs init() to hand back a chart whose resize() calls
// we can count — no real 370 kB chunk and no canvas.
vi.mock('echarts', () => ({
  init: () => {
    const chart: ChartStub = {
      dispose: () => {},
      setOption: () => {},
      dispatchAction: () => {},
      off: () => {},
      on: () => {},
      resizeCalls: 0,
      resize() { this.resizeCalls += 1; },
    };
    charts.push(chart);
    return chart;
  },
}));

class FakeResizeObserver {
  static instances: FakeResizeObserver[] = [];
  callback: ResizeObserverCallback;
  observed: Element[] = [];
  disconnected = false;
  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
    FakeResizeObserver.instances.push(this);
  }
  observe(el: Element): void { this.observed.push(el); }
  unobserve(): void {}
  disconnect(): void { this.disconnected = true; }
}

// flavor-wheel.js's import chain reads localStorage at module load — stub the
// minimum browser globals (same pattern as the other frontend tests).
const g = globalThis as unknown as Record<string, unknown>;
g.localStorage ??= { getItem: () => null, setItem: () => {} };
g.navigator ??= { language: 'en-US' };

const { renderFlavorWheel, disposeFlavorWheel } = await import('../public-src/components/flavor-wheel.js');

class FakeEl {
  innerHTML = '';
  style: Record<string, string> = {};
}

const asEl = (el: FakeEl): HTMLElement => el as unknown as HTMLElement;

describe('flavour wheel resize observer (#1381)', () => {
  beforeEach(() => {
    charts.length = 0;
    FakeResizeObserver.instances.length = 0;
    g.ResizeObserver = FakeResizeObserver;
  });

  it('resizes the chart when the container changes size', async () => {
    const container = new FakeEl();
    const rendered = await renderFlavorWheel(asEl(container), ['Jasmin'], 'en', null);
    expect(rendered).toBe(true);

    const observer = FakeResizeObserver.instances[0];
    expect(observer).toBeDefined();
    expect(observer?.observed).toContain(container);

    const chart = charts[charts.length - 1];
    expect(chart?.resizeCalls).toBe(0);
    observer?.callback([], observer as unknown as ResizeObserver);
    expect(chart?.resizeCalls).toBe(1);
  });

  it('disconnects the observer when the wheel is disposed', async () => {
    await renderFlavorWheel(asEl(new FakeEl()), ['Jasmin'], 'en', null);
    const observer = FakeResizeObserver.instances[0];
    expect(observer?.disconnected).toBe(false);

    disposeFlavorWheel();
    expect(observer?.disconnected).toBe(true);
  });

  it('disconnects the previous observer before a re-init', async () => {
    await renderFlavorWheel(asEl(new FakeEl()), ['Jasmin'], 'en', null);
    const first = FakeResizeObserver.instances[0];
    await renderFlavorWheel(asEl(new FakeEl()), ['Jasmin'], 'en', null);

    expect(FakeResizeObserver.instances).toHaveLength(2);
    expect(first?.disconnected).toBe(true);
  });
});
