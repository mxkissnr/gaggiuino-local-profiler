// Type declarations for the plain-JS sync-dev-config script imported by
// test/sync-dev-config.test.ts. The script itself stays JavaScript; only the
// surface the tests exercise is declared.
export interface SyncDevConfigResult {
  text: string;
  added: string[];
  removed: string[];
}

export function syncDevConfig(sourceText: string, targetText: string): SyncDevConfigResult;
