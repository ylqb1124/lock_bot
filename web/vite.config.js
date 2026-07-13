import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import path from 'node:path';

export default defineConfig({
  base: '/app/',
  plugins: [vue()],
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, 'src'),
      '@legacy': path.resolve(import.meta.dirname, '..'),
    },
  },
  server: {
    proxy: {
      '/lockbot': 'http://localhost:8900',
      '/monquery': 'http://localhost:8900',
    },
  },
});
