import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const api = process.env.API_URL ?? 'http://localhost:8787';
// Demo build (pnpm build:demo): relative asset paths so it runs as a static page anywhere.
const demo = process.env.VITE_DEMO === '1';

export default defineConfig({
  base: demo ? './' : '/',
  plugins: [react(), tailwindcss()],
  server: {
    host: true,
    allowedHosts: ['.localhost', 'localhost'],
    proxy: { '/api': { target: api, changeOrigin: false }, '/media': { target: api } },
  },
  preview: { proxy: { '/api': api, '/media': api } },
  build: {
    target: 'es2020',
    outDir: demo ? 'dist-demo' : 'dist',
    cssCodeSplit: true,
    // Never publish source maps: they expose the app's source and API structure.
    // SOURCEMAP=hidden builds them for an error tracker upload; check-bundle deletes them before deploy.
    sourcemap: process.env.SOURCEMAP === 'hidden' ? 'hidden' : false,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules/react') || id.includes('node_modules/scheduler')) return 'react';
          if (id.includes('node_modules/react-router')) return 'router';
          return undefined;
        },
      },
    },
  },
});
