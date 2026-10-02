// Type declarations for the plain-JS demo-smoke script imported by the Vitest
// suite (test/demo-smoke.test.ts). The script itself stays JavaScript; only the
// pure surface the tests exercise is declared here.
export function contentTypeFor(filePath: string): string;
export function resolveRequestPath(rootDir: string, urlPath: string): string | null;
