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

// ── Shared Chart.js option fragments (#1622) ──────────────────────────────
// Blocks that were byte-for-byte identical between the shot charts
// (views/shots/charts.ts) and the live chart (views/live.ts). The value is
// resolved per render (#814), so the theme colour is passed in, never baked
// into a module constant. Anything that differs per chart (tooltips, scales,
// legend layout) stays local to its view.

/** The base options every shot chart repeats: fill the container, no
 *  animation. Callers spread this and add their own plugins/scales. */
export function chartBaseOptions(): {
  responsive: boolean;
  maintainAspectRatio: boolean;
  animation: boolean;
} {
  return { responsive: true, maintainAspectRatio: false, animation: false };
}

/** The theme-resolved legend label style shared by the P·Q, fullscreen and
 *  live charts (`textColor` is `chartColors().text`). */
export function chartLegendLabels(textColor: string): {
  color: string;
  font: { family: string };
} {
  return { color: textColor, font: { family: 'Figtree' } };
}
