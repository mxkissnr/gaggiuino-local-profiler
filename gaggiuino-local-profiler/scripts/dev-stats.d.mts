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
