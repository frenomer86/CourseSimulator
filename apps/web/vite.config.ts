import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { VitePWA } from 'vite-plugin-pwa';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string };

export default defineConfig({
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icon.svg'],
      manifest: {
        name: 'CS Virtual Lab',
        short_name: 'CS Lab',
        description: 'Practise every Computer Science practical in your browser.',
        theme_color: '#0f6e56',
        background_color: '#eef1f4',
        display: 'standalone',
        start_url: '/',
        icons: [{ src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any maskable' }],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,json,woff2}'],
        // The Python runtime (Pyodide) is fetched from the CDN on first use and then kept, so labs work offline.
        runtimeCaching: [
          {
            urlPattern: /^https:\/\/cdn\.jsdelivr\.net\/pyodide\//,
            handler: 'CacheFirst',
            options: { cacheName: 'pyodide', expiration: { maxEntries: 60, maxAgeSeconds: 365 * 24 * 3600 }, cacheableResponse: { statuses: [0, 200] } },
          },
        ],
      },
    }),
  ],
  resolve: {
    alias: {
      '@content': fileURLToPath(new URL('../../content', import.meta.url)),
      '@data': fileURLToPath(new URL('../../data', import.meta.url)),
      '@docs': fileURLToPath(new URL('../../docs', import.meta.url)),
    },
  },
  // Workers import shared packages, so they are built as modules (all target browsers support this).
  worker: { format: 'es' },
  server: {
    fs: { allow: ['../..'] },
    // The API runs separately in development (npm run dev:api); production serves both from one origin.
    proxy: { '/api': { target: 'http://localhost:8787', changeOrigin: false, ws: true } },
  },
});
