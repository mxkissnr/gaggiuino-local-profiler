import { describe, it, expect, vi } from 'vitest';
import type { Chart } from 'chart.js';
import { clearChartOnTouchEnd } from '../public-src/constants.js';

// #1615: the shot chart's canvas is reused for every rebuild (each shot
// selection). clearChartOnTouchEnd() used to add a new touchend listener per
// build, so listeners piled up and each closure kept its destroyed chart
// alive. Now there is one listener per canvas, acting on the current chart.

interface FakeChart {
  canvas: EventTarget | null;
  corsair: { draw: boolean } | undefined;
  tooltip: { setActiveElements: ReturnType<typeof vi.fn> };
  update: ReturnType<typeof vi.fn>;
}

function fakeCanvas(): { canvas: EventTarget; listeners: () => number } {
  const canvas = new EventTarget();
  const add = vi.spyOn(canvas, 'addEventListener');
  return { canvas, listeners: () => add.mock.calls.filter(c => c[0] === 'touchend').length };
}

function fakeChart(canvas: EventTarget): FakeChart {
  return { canvas, corsair: { draw: true }, tooltip: { setActiveElements: vi.fn() }, update: vi.fn() };
}

const register = (chart: FakeChart): void => clearChartOnTouchEnd(chart as unknown as Chart);

describe('clearChartOnTouchEnd (#1615)', () => {
  it('adds one listener per canvas however often the chart is rebuilt, and clears only the current chart', () => {
    const { canvas, listeners } = fakeCanvas();
    const charts = [fakeChart(canvas), fakeChart(canvas), fakeChart(canvas)];
    for (const chart of charts) register(chart);
    expect(listeners()).toBe(1);

    canvas.dispatchEvent(new Event('touchend'));
    const current = charts[2]!;
    expect(current.update).toHaveBeenCalledWith('none');
    expect(current.tooltip.setActiveElements).toHaveBeenCalledWith([], { x: 0, y: 0 });
    expect(current.corsair).toEqual({ draw: false });
    for (const old of charts.slice(0, 2)) expect(old.update).not.toHaveBeenCalled();
  });

  it('leaves a destroyed chart alone until its replacement registers', () => {
    const { canvas } = fakeCanvas();
    const chart = fakeChart(canvas);
    register(chart);
    chart.canvas = null; // what Chart.js destroy() does
    expect(() => canvas.dispatchEvent(new Event('touchend'))).not.toThrow();
    expect(chart.update).not.toHaveBeenCalled();

    const next = fakeChart(canvas);
    register(next);
    canvas.dispatchEvent(new Event('touchend'));
    expect(next.update).toHaveBeenCalledTimes(1);
  });

  it('keeps separate canvases independent', () => {
    const a = fakeCanvas();
    const b = fakeCanvas();
    const chartA = fakeChart(a.canvas);
    const chartB = fakeChart(b.canvas);
    register(chartA);
    register(chartB);
    a.canvas.dispatchEvent(new Event('touchend'));
    expect(chartA.update).toHaveBeenCalledTimes(1);
    expect(chartB.update).not.toHaveBeenCalled();
  });
});
