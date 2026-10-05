import { defineConfig } from 'vite';
import type { Plugin } from 'vite';
import { cpSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Demo mode (#1193) builds the SPA for GitHub Pages: static output in
// ../demo-dist, the entry point swapped for the service-worker bootstrap, and
// the worker + recorded fixtures copied next to the bundle so the whole
// directory is self-contained. The normal build is untouched.
function demoServiceWorker(): Plugin {
  let projectRoot = '';
  let outDir = '';
  return {
    name: 'glp-demo-service-worker',
    configResolved(config) {
      // build.outDir stays the raw root-relative string in the resolved config,
      // so resolve it the same way Vite does — against the (absolute) root.
      const root = resolve(config.root);
      projectRoot = dirname(root);
      outDir = resolve(root, config.build.outDir);
    },
    transformIndexHtml: {
      order: 'pre',
      handler: html => html.replace('src="./main.ts"', 'src="./demo/boot.ts"'),
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

// App-shell service worker (#1270): public-src/sw.ts bundled to sw.js at the
// output root, unhashed — main.ts registers 'sw.js' and a worker's scope is
// its own directory. It imports nothing, so the emitted chunk is a classic
// script with no import/export; no SPA module may import it.
function appServiceWorker(): Plugin {
  return {
    name: 'glp-app-service-worker',
    apply: 'build',
    buildStart() {
      this.emitFile({ type: 'chunk', id: fileURLToPath(new URL('./public-src/sw.ts', import.meta.url)), fileName: 'sw.js' });
    },
  };
}

export default defineConfig(({ mode }) => {
  const demo = mode === 'demo';
  return {
    root: 'public-src',
    base: './',
    plugins: demo ? [appServiceWorker(), demoServiceWorker()] : [appServiceWorker()],
    build: {
      outDir: demo ? '../demo-dist' : '../public',
      emptyOutDir: true,
      rollupOptions: {
        // Two entry points (#1267): the SPA and its kiosk page. Without an
        // explicit input Vite would build only public-src/index.html and drop
        // kiosk.html, so both pages are listed here.
        input: {
          index: fileURLToPath(new URL('./public-src/index.html', import.meta.url)),
          kiosk: fileURLToPath(new URL('./public-src/kiosk.html', import.meta.url)),
        },
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
