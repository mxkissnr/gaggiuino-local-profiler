import { afterEach, vi } from 'vitest';

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

// Several tests call vi.useFakeTimers() without a try/finally, so a failing
// assertion there would otherwise leave the fake clock installed for the rest
// of the file and make later tests flaky. Hand the real clock back between
// every test, whatever the previous one did.
afterEach(() => {
    vi.useRealTimers();
});
