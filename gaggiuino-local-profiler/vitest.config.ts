import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        environment: 'node',
        include: ['test/**/*.test.{js,ts}'],
        setupFiles: ['test/setup.ts'],
        coverage: {
            provider: 'v8',
            reporter: ['text', 'json-summary', 'lcov'],
            // Frontend-only suite (the Node backend and its tests were removed
            // in 3.0.0, #1028). The denominator is dominated by large view
            // modules (library.js, analytics.js, shots/index.js) that the
            // targeted DOM tests only exercise in part.
            // `npm run coverage:ratchet` (each minor release, #1560) raises
            // these to the measured value minus 1 point. They never go down.
            thresholds: {
                autoUpdate: process.env.COVERAGE_RATCHET
                    ? (measured: number, previous: number) => Math.max(previous, Math.floor(measured) - 1)
                    : false,
                statements: 50,
                branches: 42,
                functions: 36,
                lines: 53,
            },
        },
    },
});
