import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import path from 'node:path';

export default defineConfig({
  base: '/',
  plugins: [vue()],
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, 'src'),
    },
  },
  server: {
    proxy: {
      '/api': 'http://localhost:8900',
      '/lockbot': 'http://localhost:8900',
      '/monquery': 'http://localhost:8900',
    },
  },
});
