import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

export default defineConfig({
  plugins: [react()],

  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },

  server: {
    host: '0.0.0.0',
    port: 2233,
    strictPort: true,
    allowedHosts: [
      'localhost',
      '127.0.0.1',
      'payroll.s2aconsultant.com',
    ],
  },

  preview: {
    host: '0.0.0.0',
    port: 2233,
    strictPort: true,
    allowedHosts: [
      'localhost',
      '127.0.0.1',
      'payroll.s2aconsultant.com',
    ],
  },

  build: {
    outDir: 'dist',
    sourcemap: false,
    rollupOptions: {
      output: {
        manualChunks: {
          react: ['react', 'react-dom', 'react-router-dom'],
          charts: ['recharts'],
          query: ['@tanstack/react-query', 'axios'],
        },
      },
    },
  },
});