import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        environment: 'node',
        include: ['test/**/*.test.js'],
        coverage: {
            provider: 'v8',
            reporter: ['text', 'json-summary', 'lcov'],
            // Real measured baseline (2026-08-31): statements 54.24%, branches 47.14%,
            // functions 43.57%, lines 57.78%. Thresholds set slightly below to avoid
            // false-failing on minor variance while still catching real regressions.
            thresholds: {
                statements: 52,
                branches: 45,
                functions: 41,
                lines: 55,
            },
        },
    },
});
