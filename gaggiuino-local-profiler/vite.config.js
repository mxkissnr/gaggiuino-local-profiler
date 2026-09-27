import { defineConfig } from 'vite';
import { cpSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

// Demo mode (#1193) builds the SPA for GitHub Pages: static output in
// ../demo-dist, the entry point swapped for the service-worker bootstrap, and
// the worker + recorded fixtures copied next to the bundle so the whole
// directory is self-contained. The normal build is untouched.
function demoServiceWorker() {
  let projectRoot = '';
  let outDir = '';
  return {
    name: 'glp-demo-service-worker',
    configResolved(config) {
      projectRoot = dirname(config.root);
      outDir = config.build.outDir;
    },
    transformIndexHtml(html) {
      return html.replace('src="./main.ts"', 'src="./demo/boot.ts"');
    },
    closeBundle() {
      const fixtures = join(projectRoot, 'demo', 'fixtures');
      if (!existsSync(join(fixtures, 'manifest.json'))) {
        this.error('demo/fixtures/manifest.json is missing — run `npm run demo:fixtures` first');
      }
      for (const file of ['demo-sw.js', 'sw-core.js']) {
        cpSync(join(projectRoot, 'demo', 'sw', file), join(outDir, file));
      }
      cpSync(fixtures, join(outDir, 'fixtures'), { recursive: true });
    },
  };
}

export default defineConfig(({ mode }) => {
  const demo = mode === 'demo';
  return {
    root: 'public-src',
    base: './',
    plugins: demo ? [demoServiceWorker()] : [],
    build: {
      outDir: demo ? '../demo-dist' : '../public',
      emptyOutDir: true,
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
  };
});
