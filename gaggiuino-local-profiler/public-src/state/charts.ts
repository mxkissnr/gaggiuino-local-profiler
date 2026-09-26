import type { Chart } from 'chart.js';
import { S } from './index.js';

// Every long-lived Chart.js instance occupies one named slot on S. The old
// code repeated `if (S.x) { S.x.destroy(); S.x = null; }` before each
// `new Chart(...)`; routing those through this registry keeps the "destroy
// before re-create" convention in one place.
//
// Note for callers rebuilding a chart on the same canvas: call dispose()
// before `new Chart(...)` (the argument is evaluated before set() runs, and
// Chart.js refuses to hand out a canvas that still has a chart on it).
export type ChartName =
  | 'chart'
  | 'liveChart'
  | 'pqChart'
  | 'fsChart'
  | 'trendChart'
  | 'profileBarChart'
  | 'doseDistChart'
  | 'ratioDistChart'
  | 'timeOfDayChart'
  | 'dialinProgressionChart'
  | 'profilePreviewChart';

export function get(name: ChartName): Chart | null {
  return S[name];
}

export function dispose(name: ChartName): void {
  const chart = S[name];
  if (!chart) return;
  S[name] = null;
  chart.destroy();
}

export function set(name: ChartName, chart: Chart | null): Chart | null {
  dispose(name);
  S[name] = chart;
  return chart;
}
