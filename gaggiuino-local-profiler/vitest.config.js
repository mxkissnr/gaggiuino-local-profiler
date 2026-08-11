import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        environment: 'node',
        include: ['test/**/*.test.js'],
        coverage: {
            provider: 'v8',
            reporter: ['text', 'json-summary', 'lcov'],
            // Real measured baseline (2026-08-11): statements 49.31%, branches 44.71%,
            // functions 40.43%, lines 52.38%. Thresholds set slightly below to avoid
            // false-failing on minor variance while still catching real regressions.
            thresholds: {
                statements: 47,
                branches: 42,
                functions: 38,
                lines: 50,
            },
        },
    },
});
