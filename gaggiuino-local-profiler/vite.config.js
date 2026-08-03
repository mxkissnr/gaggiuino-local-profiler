import { defineConfig } from 'vite';

export default defineConfig({
  root: 'public-src',
  base: './',
  build: {
    outDir: '../public',
    emptyOutDir: true,
    // lib/score.js, lib/machines/theme-presets.js and lib/whats-new.js are
    // shared with the CommonJS backend (module.exports); let the commonjs
    // plugin process them so their named exports resolve in the ESM frontend.
    commonjsOptions: {
      include: [/lib[/\\]score\.js$/, /lib[/\\]machines[/\\]theme-presets\.js$/, /lib[/\\]whats-new\.js$/, /node_modules/],
      transformMixedEsModules: true,
    },
  },
});
