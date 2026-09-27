// Type declarations for the plain-JS demo-fixtures script imported by the
// Vitest suite (test/demo-fixtures.test.ts). The script itself stays
// JavaScript; only the pure surface the tests exercise is declared here.
export function fixtureKey(method: string, urlString: string): string;
export function fixtureFileName(key: string, ext: string): string;
export function extForContentType(contentType: string | null | undefined): string;
export function findLeaks(text: string, extraAllowed?: readonly string[]): string[];
export function parseOpenApiGetPaths(yamlText: string): string[];
