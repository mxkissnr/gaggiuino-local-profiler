// Type declarations for the plain-JS changelog-collect script imported by
// test/changelog-collect.test.ts. The script itself stays JavaScript; only the
// pure surface the tests exercise is declared here.
export interface ChangelogFragment {
  name: string;
  content: string;
}

export function collectChangelog(
  changelogText: string,
  fragments: readonly ChangelogFragment[],
): string;
