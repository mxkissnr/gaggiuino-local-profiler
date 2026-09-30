const js = require('@eslint/js');
const globals = require('globals');
const tseslint = require('typescript-eslint');

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

module.exports = [
  {
    // go/ is Go, not JS — except the browser scripts under
    // internal/web/static/ (the no-JS /ui/ fallback pages, embedded via
    // assets.go), which are linted by the dedicated block below. The
    // minified vendor bundles next to them, and the transient staged Vite
    // build under internal/webapp/dist/, stay ignored.
    ignores: [
      'public/**', 'node_modules/**', 'docs/**', 'graphify-out/**',
      'go/internal/web/static/vendor/**', 'go/internal/webapp/dist/**',
    ],
  },
  js.configs.recommended,
  {
    files: ['eslint.config.js', 'vite.config.js', 'vitest.config.js'],
    languageOptions: {
      globals: globals.node,
    },
    rules: commonRules,
  },
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
    extends: [...tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      globals: globals.browser,
      parserOptions: {
        projectService: true,
        tsconfigRootDir: __dirname,
      },
    },
    rules: {
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', ignoreRestSiblings: true }],
    },
  }),
  {
    // go/internal/web/static/**: hand-written browser scripts embedded via
    // internal/web/assets.go and loaded by the no-JS /ui/ fallback pages —
    // same runtime as public-src/, hence browser globals.
    files: ['go/internal/web/static/**/*.js'],
    languageOptions: {
      globals: globals.browser,
    },
    rules: commonRules,
  },
  {
    files: ['test/**/*.js'],
    languageOptions: {
      globals: { ...globals.node, ...globals.vitest },
    },
    rules: commonRules,
  },
  ...tseslint.config({
    files: ['test/**/*.ts'],
    extends: [...tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      globals: { ...globals.node, ...globals.vitest },
      parserOptions: {
        projectService: true,
        tsconfigRootDir: __dirname,
      },
    },
    rules: {
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', ignoreRestSiblings: true }],
    },
  }),
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
