import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        environment: 'node',
        include: ['test/**/*.test.js'],
        setupFiles: ['test/setup.js'],
        coverage: {
            provider: 'v8',
            reporter: ['text', 'json-summary', 'lcov'],
            // Frontend-only suite (the Node backend and its tests were removed
            // in 3.0.0, #1028). Real measured baseline (2026-09-09):
            // statements 36.19%, branches 32.17%, functions 27.06%,
            // lines 37.84% — the denominator is dominated by large view
            // modules (library.js, analytics.js, shots/index.js) that the
            // targeted DOM tests only exercise in part. Thresholds set a few
            // points below to absorb minor variance while still catching a
            // real regression.
            thresholds: {
                statements: 34,
                branches: 30,
                functions: 25,
                lines: 35,
            },
        },
    },
});
