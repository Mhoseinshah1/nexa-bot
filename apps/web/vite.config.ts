import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      // The admin SPA talks to the API over HTTP only. It never imports server
      // code — CI asserts that @nexa/core-side packages are absent from its
      // production dependency tree.
      '/api': { target: 'http://127.0.0.1:3000', changeOrigin: true },
      '/health': { target: 'http://127.0.0.1:3000', changeOrigin: true },
    },
  },
  build: { outDir: 'dist', sourcemap: true },
});
