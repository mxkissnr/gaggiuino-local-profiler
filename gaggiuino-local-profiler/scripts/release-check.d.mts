// Type declarations for the plain-JS release-check script imported by
// test/release-check-screenshot-freshness.test.ts. The script itself stays
// JavaScript; only the surface the tests exercise is declared.
export function checkScreenshotFreshness(
    gitRoot: string,
    publicSrcRel: string,
    screenshotsDirRel: string,
): string[];
export function stripJsLikeComments(src: string): string;
export function stripHtmlComments(src: string): string;
export function stripCssComments(src: string): string;
