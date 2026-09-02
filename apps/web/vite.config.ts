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
  build: {
    outDir: 'dist',
    /**
     * No browser source maps in the deployable artifact.
     *
     * A production `.map` publishes the original TypeScript — component names,
     * comments, route and permission constants, and the shape of every API
     * call — to anyone who opens devtools on the admin panel. It is not a
     * secret leak in the credential sense, and it is a free reconnaissance
     * document for the one surface that administers the installation.
     *
     * `NEXA_WEB_SOURCEMAP=1` turns them back on for a deliberate production
     * debugging build. It has to be explicit: the previous value was a plain
     * `true`, which meant the maps shipped by default and nobody had decided
     * that they should.
     *
     * Development is untouched — `vite dev` serves maps regardless of this,
     * which only governs `vite build`.
     */
    sourcemap: process.env['NEXA_WEB_SOURCEMAP'] === '1',
  },
});
