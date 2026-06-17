import { defineConfig } from 'vite';

export default defineConfig({
  root: 'public-src',
  base: './',
  build: {
    outDir: '../public',
    emptyOutDir: true,
    // lib/score.js is shared with the CommonJS backend (module.exports); let the
    // commonjs plugin process it so its named exports resolve in the ESM frontend.
    commonjsOptions: {
      include: [/lib[/\\]score\.js$/, /node_modules/],
      transformMixedEsModules: true,
    },
  },
});
