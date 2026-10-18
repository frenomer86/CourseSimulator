import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { VitePWA } from 'vite-plugin-pwa';
import { fileURLToPath } from 'node:url';

export default defineConfig({
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
      },
    }),
  ],
  resolve: {
    alias: {
      '@content': fileURLToPath(new URL('../../content', import.meta.url)),
      '@data': fileURLToPath(new URL('../../data', import.meta.url)),
    },
  },
  server: {
    fs: { allow: ['../..'] },
    // The API runs separately in development (npm run dev:api); production serves both from one origin.
    proxy: { '/api': { target: 'http://localhost:8787', changeOrigin: false } },
  },
});
