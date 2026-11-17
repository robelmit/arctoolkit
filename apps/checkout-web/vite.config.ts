import path from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Two pages, built to static files the checkout server serves from memory. Nothing is inlined as a data: URI,
// so the pages' content security policy can allow 'self' and nothing else.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { '@': path.resolve(import.meta.dirname, './src') },
  },
  build: {
    assetsInlineLimit: 0,
    rollupOptions: {
      input: {
        pay: path.resolve(import.meta.dirname, 'pay.html'),
        dashboard: path.resolve(import.meta.dirname, 'dashboard.html'),
      },
    },
  },
});
