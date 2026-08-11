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
    rollupOptions: {
      output: {
        // Splits the biggest statically-imported vendor libraries into their
        // own chunks instead of one ~2MB bundle. Deliberately NOT route-level
        // lazy-loading (no dynamic import()) — the app runs behind HA
        // Ingress under a dynamic path prefix, and `base: './'` above only
        // makes the *entry* script's own relative URL ingress-safe. These
        // vendor chunks stay statically imported by the entry module, so the
        // browser resolves them as ordinary ES module specifiers relative to
        // the importing script's URL — the exact same resolution the entry
        // script itself already relies on — rather than at runtime relative
        // to the current document location the way a dynamic import() chunk
        // would. zrender is echarts' own rendering dependency and must ship
        // in the same chunk as echarts, not split further.
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined;
          if (id.includes('echarts') || id.includes('zrender')) return 'vendor-echarts';
          if (id.includes('chart.js')) return 'vendor-chartjs';
          if (id.includes('topojson-client') || id.includes('topojson')) return 'vendor-topojson';
          if (id.includes('qrcode')) return 'vendor-qrcode';
          return undefined;
        },
      },
    },
  },
});
