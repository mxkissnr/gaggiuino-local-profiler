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

// #638/#641/#643/#648: four bugs, same root cause -- code reading
// opts.machine_host/opts.switch_entity directly instead of going through the
// registry facade (lib/machines/registry.js's hostFor/switchEntityFor/
// baseUrlFor/apiUrlFor). Blocks the pattern from reappearing outside the
// three files that legitimately read options.json: the facade itself, the
// URL-normalizer helpers it wraps, and the options.json-adoption pass.
const machineConfigSourceOfTruthRule = {
  'no-restricted-syntax': [
    'error',
    {
      selector: "MemberExpression[property.name='machine_host']",
      message: "Machine config comes from registry.hostFor()/baseUrlFor()/apiUrlFor(); options.json is a tracked input, not a source of truth (#638/#641/#643/#648).",
    },
    {
      selector: "MemberExpression[property.name='switch_entity']",
      message: "Machine config comes from registry.switchEntityFor(); options.json is a tracked input, not a source of truth (#638/#641/#643/#648).",
    },
  ],
};

// #679: resolveMachine() and requireSettingsProxySupport() were each
// copy-pasted into a second file instead of shared (the same precursor
// shape as #638/#641/#643/#648) -- now consolidated into
// lib/machines/registry.js and routes/machine-control.js respectively.
// Blocks either from being re-declared anywhere else so a future round
// can't silently reintroduce a second copy.
const noDuplicateHelpersRule = {
  'no-restricted-syntax': [
    'error',
    {
      selector: "FunctionDeclaration[id.name='resolveMachine']",
      message: 'resolveMachine() lives in lib/machines/registry.js — import it from there instead of redeclaring (#679).',
    },
    {
      selector: "FunctionDeclaration[id.name='requireSettingsProxySupport']",
      message: 'requireSettingsProxySupport() lives in routes/machine-control.js — import it from there instead of redeclaring (#679).',
    },
  ],
};

module.exports = [
  {
    ignores: ['public/**', 'node_modules/**', 'docs/**', 'graphify-out/**'],
  },
  js.configs.recommended,
  {
    files: ['eslint.config.js'],
    languageOptions: {
      globals: globals.node,
    },
  },
  {
    files: ['lib/**/*.js', 'routes/**/*.js', 'server.js', 'scripts/**/*.js', 'scripts/**/*.mjs'],
    languageOptions: {
      globals: globals.node,
    },
    rules: commonRules,
  },
  {
    files: ['lib/**/*.js', 'routes/**/*.js', 'server.js'],
    ignores: ['lib/machines/registry.js', 'lib/data.js', 'lib/machines/options-adoption.js'],
    languageOptions: {
      globals: globals.node,
    },
    rules: machineConfigSourceOfTruthRule,
  },
  {
    files: ['lib/**/*.js', 'routes/**/*.js', 'server.js'],
    ignores: ['lib/machines/registry.js', 'routes/machine-control.js'],
    languageOptions: {
      globals: globals.node,
    },
    rules: noDuplicateHelpersRule,
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
