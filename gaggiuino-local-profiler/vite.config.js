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
        // Splits the biggest vendor libraries into their own chunks instead
        // of one ~2MB bundle. #797 verified empirically (Vite 8.2.1, built
        // output inspected directly) that this does not conflict with
        // running behind HA Ingress under a dynamic path prefix: the
        // __vitePreload helper Vite emits for a chunk resolves its URL via
        // `import.meta.resolve(specifier)` (falling back to
        // `new URL(specifier, import.meta.url).href`), both anchored to the
        // *importing module's own URL* — never `document.baseURI` or
        // `location`. Static and dynamic `import()` specifiers resolve the
        // same way, so echarts/topojson-client/qrcode (see their use sites)
        // are dynamic imports, and the first load no longer ships or
        // preloads them. chart.js stays a static import — it's on the
        // startup path (live.js, shots/). zrender is echarts' own rendering
        // dependency and must ship in the same chunk as echarts, not split
        // further. Still needs a live Ingress smoke test before release —
        // this reasoning wasn't wrong before, but it also wasn't checked
        // against actual build output, which is the whole point of #797.
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
