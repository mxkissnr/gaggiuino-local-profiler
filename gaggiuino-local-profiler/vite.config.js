import { defineConfig } from 'vite';

export default defineConfig({
  root: 'public-src',
  base: './',
  build: {
    outDir: '../public',
    emptyOutDir: false,
  },
});
