import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import { htmlSinkRule } from './eslint-rules/html-sink.mts';

const commonRules = {
  'no-unused-vars': ['error', { argsIgnorePattern: '^_', ignoreRestSiblings: true }],
  'no-undef': 'error',
  'require-atomic-updates': 'error',
  'no-implicit-globals': 'error',
  'no-restricted-properties': [
    'warn',
    { property: 'innerHTML', message: 'innerHTML use flagged for review (XSS risk) — warning only, not blocking.' },
  ],
};

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
  {
    files: ['scripts/**/*.js', 'scripts/**/*.mjs'],
    languageOptions: {
      globals: globals.node,
    },
    rules: commonRules,
  },
  {
    files: ['public-src/**/*.js'],
    languageOptions: {
      globals: globals.browser,
    },
    rules: commonRules,
  },
  {
    // Demo service worker sources (#1193): classic scripts copied verbatim
    // into demo-dist/ rather than bundled, so they run in the serviceworker
    // global scope instead of a module or a window.
    files: ['demo/sw/**/*.js'],
    languageOptions: {
      globals: {
        ...globals.serviceworker,
        self: 'readonly',
        clients: 'readonly',
        importScripts: 'readonly',
        caches: 'readonly',
        console: 'readonly',
        fetch: 'readonly',
        Response: 'readonly',
        ReadableStream: 'readonly',
        TextEncoder: 'readonly',
        TextDecoder: 'readonly',
        URL: 'readonly',
        URLSearchParams: 'readonly',
      },
    },
    rules: commonRules,
  },
  // TypeScript sources migrate file-by-file (#1102): scoped to the .ts globs so
  // the type-aware rules don't touch the .js files still in flight.
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
  // by tsconfig.sw.json. test/e2e/smoke.test.mjs is ported in a later #1270
  // slice, so it stays .js here and its classic-JS block still applies.
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
  {
    // test/e2e/*.mjs runs on node:test (Playwright), not vitest — see
    // test:e2e in package.json (#798) — so it gets node globals only, not
    // globals.vitest.
    files: ['test/**/*.mjs'],
    languageOptions: {
      globals: globals.node,
    },
    rules: commonRules,
  },
];
