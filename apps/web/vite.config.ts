import react from '@vitejs/plugin-react';
import process from 'node:process';
import { defineConfig } from 'vite';

const apiTarget = process.env.LINGOWEAVE_API_URL ?? 'http://127.0.0.1:4310';

export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': { target: apiTarget, changeOrigin: false },
    },
  },
  preview: {
    port: 4173,
    strictPort: true,
    proxy: {
      '/api': { target: apiTarget, changeOrigin: false },
    },
  },
});
