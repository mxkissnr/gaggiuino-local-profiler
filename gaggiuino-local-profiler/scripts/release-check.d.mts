// Type declarations for the plain-JS release-check script imported by the
// test/release-check-*.test.ts suites. The script itself stays JavaScript;
// only the surface the tests exercise is declared.
export function checkScreenshotFreshness(
    gitRoot: string,
    publicSrcRel: string,
    screenshotsDirRel: string,
): string[];
export function stripJsLikeComments(src: string): string;
export function stripHtmlComments(src: string): string;
export function stripCssComments(src: string): string;
export function checkAcceptanceProtocol(
    markdown: string,
    version: string | null,
): string[];
export function checkChangelogFragments(fragmentsDir: string): string[];
