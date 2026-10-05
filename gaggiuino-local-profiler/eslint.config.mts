import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import { htmlSinkRule } from './eslint-rules/html-sink.mts';

const localPlugin = {
  rules: {
    // #1104 L1.
    'html-sink': htmlSinkRule,
  },
};

export default [
  {
    // go/ is Go, not JS. The transient staged Vite build under
    // internal/webapp/dist/ stays ignored.
    ignores: [
      'public/**', 'node_modules/**', 'docs/**', 'graphify-out/**',
      'go/internal/webapp/dist/**',
      // Deliberately-bad lint fixtures for the rule test; typed by tsc, never
      // linted as project code.
      'test/fixtures/**',
    ],
  },
  {
    // #1104 L1: local rules (eslint-rules/), available to every file.
    plugins: { local: localPlugin },
  },
  js.configs.recommended,
  ...tseslint.config({
    // Root build/test tooling configs (#1270): Node-run TypeScript tooling files,
    // so node globals only (unlike the browser-scoped public-src/ block below).
    files: ['vite.config.ts', 'vitest.config.ts', 'eslint.config.mts', 'eslint-rules/**/*.mts', 'scripts/**/*.mts', 'test/**/*.mts'],
    extends: [...tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      globals: globals.node,
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', ignoreRestSiblings: true }],
    },
  }),
  // TypeScript SPA sources (#1102; the port finished under #1270).
  ...tseslint.config({
    files: ['public-src/**/*.ts'],
    ignores: ['public-src/sw.ts'],
    extends: [...tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      globals: globals.browser,
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', ignoreRestSiblings: true }],
      // #1104 L1: every innerHTML/outerHTML write and insertAdjacentHTML call
      // must carry an Html-branded value; the rule checks the RHS type.
      'local/html-sink': 'error',
    },
  }),
  ...tseslint.config({
    // Service workers (#1270): typed against the WebWorker lib by tsconfig.sw.json,
    // which the root tsconfig.json excludes them from, so an explicit project
    // replaces the project service here.
    files: ['public-src/sw.ts', 'demo/sw/**/*.ts'],
    extends: [...tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      globals: globals.serviceworker,
      parserOptions: { projectService: false, project: './tsconfig.sw.json', tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', ignoreRestSiblings: true }],
    },
  }),
  // The service workers are TypeScript now (#1270): public-src/sw.ts and the
  // demo/sw sources match the service-worker block above and are typechecked
  // by tsconfig.sw.json. test/e2e/smoke.test.mts is ported by the E2E-tooling
  // slice; it matches the test/**/*.mts block above (node globals), not vitest.
  ...tseslint.config({
    files: ['test/**/*.ts'],
    extends: [...tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      globals: { ...globals.node, ...globals.vitest },
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', ignoreRestSiblings: true }],
    },
  }),
  {
    // #1104 L1: the fixture linted by test/html-sink-lint.test.ts. It is globally
    // ignored above, so `eslint .` never sees its deliberate violations; the test
    // re-lints it through the ESLint API with ignore disabled.
    files: ['test/fixtures/**/*.ts'],
    rules: { 'local/html-sink': 'error' },
  },
];
