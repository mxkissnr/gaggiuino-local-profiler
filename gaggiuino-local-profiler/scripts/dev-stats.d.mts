// Type declarations for the plain-JS dev-stats script imported by the Vitest
// suite (test/dev-stats-*.test.ts). The script itself stays JavaScript; only
// the surface the tests exercise is declared.
export function isAiCoAuthor(name: string): boolean;
export function billingTypeFor(model: string): 'subscription' | 'api-billed';
export function historyScope(
  dir: string,
  runGit?: (dir: string, args: string) => string,
): '--remotes=origin' | 'HEAD';
export function monthsSinceStart(firstDateStr: string | null | undefined, today?: Date): number;
export function clusterIntoSessions(timestampsMs: number[]): number;
export function subscriptionCostSentence(
  monthsCount: number,
  firstDate: string | null | undefined,
  costUsd: number,
): string;
export interface BarChartItem {
  label: string;
  value: number;
  color?: string;
}
export interface BarChartLegendEntry {
  label: string;
  color: string;
}
export function barChartSVG(
  title: string,
  items: BarChartItem[],
  options?: { theme?: 'light' | 'dark'; legend?: BarChartLegendEntry[] | null },
): string | null;
export function chartPictureHTML(base: string, alt: string): string;
export function modelVendor(model: string): 'claude' | 'deepseek' | 'other';
export function modelDisplayLabel(model: string): string;
export function modelBreakdownData(
  counts: Record<string, number>,
  theme?: 'light' | 'dark',
): { items: Required<BarChartItem>[]; legend: BarChartLegendEntry[] };
