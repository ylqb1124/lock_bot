import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import path from 'node:path';

export default defineConfig({
  base: '/app/',
  plugins: [
    vue(),
    {
      name: 'team-route-fallback',
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          const url = new URL(req.url, 'http://localhost');
          if (url.pathname === '/team' || url.pathname === '/team/') {
            req.url = `/app/team${url.search}`;
          }
          next();
        });
      },
    },
  ],
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
