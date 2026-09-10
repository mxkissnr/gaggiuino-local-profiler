// Vitest setup — runs once per test file before the file's own code.
//
// Node 24 ships a built-in `navigator` global (it did not exist in Node 22),
// and it is non-writable/non-configurable, so the `globalThis.navigator ??= …`
// stub that ~20 frontend tests use to pin `navigator.language` silently
// no-ops there — the tests then read the *host* locale (e.g. de-DE) and the
// ones that group/format by locale fail on non-English machines. CI happens
// to run under a C/en locale so it stayed green, but local runs did not.
//
// Force a deterministic navigator here for every test file. `defineProperty`
// (not assignment) is required to replace Node's own non-writable global.
Object.defineProperty(globalThis, 'navigator', {
    value: {
        language: 'en-US',
        languages: ['en-US'],
        userAgent: 'node',
        hardwareConcurrency: 4,
        platform: 'linux',
    },
    configurable: true,
    writable: true,
});
