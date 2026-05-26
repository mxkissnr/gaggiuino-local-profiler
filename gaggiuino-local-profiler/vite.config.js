import { defineConfig } from 'vite';

export default defineConfig({
  root: 'public-src',
  build: {
    outDir: '../public',
    emptyOutDir: false,
  },
});
