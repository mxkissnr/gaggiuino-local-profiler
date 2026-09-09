const js = require('@eslint/js');
const globals = require('globals');

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
    ignores: ['public/**', 'node_modules/**', 'docs/**', 'graphify-out/**', 'go/**'],
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
    files: ['test/**/*.js'],
    languageOptions: {
      globals: { ...globals.node, ...globals.vitest },
    },
    rules: commonRules,
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
