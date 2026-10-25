import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * The customer Mini App (Round 9, C5). Served by the API under `/miniapp/` — the document
 * at `/miniapp/<botInstanceId>/`, the hashed assets at `/miniapp/assets/`, the webfont at
 * `/miniapp/fonts/` — so every URL the build writes is rooted there.
 *
 * The webfont is the Web Admin's own file: `publicDir` points at `apps/web/public`, so the
 * one self-hosted Vazirmatn ships in both builds and is never a second copy in git.
 */
export default defineConfig({
  base: '/miniapp/',
  publicDir: '../web/public',
  plugins: [react()],
  server: {
    port: 5174,
    proxy: {
      '/miniapp/api': { target: 'http://127.0.0.1:3000', changeOrigin: true },
    },
  },
  build: {
    outDir: 'dist',
    // No browser source maps in the artifact, as for the Web Admin.
    sourcemap: process.env['NEXA_WEB_SOURCEMAP'] === '1',
  },
});
