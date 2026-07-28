import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        environment: 'node',
        include: ['test/**/*.test.js'],
        coverage: {
            provider: 'v8',
            reporter: ['text', 'json-summary', 'lcov'],
            // Real measured baseline (2026-07-28): statements 41.21%, branches 38.37%,
            // functions 33.68%, lines 43.87%. Thresholds set slightly below to avoid
            // false-failing on minor variance while still catching real regressions.
            thresholds: {
                statements: 40,
                branches: 37,
                functions: 32,
                lines: 42,
            },
        },
    },
});
