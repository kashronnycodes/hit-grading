import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const apiProxyTarget = process.env.VITE_DEV_API_PROXY_TARGET || process.env.VITE_API_BASE_URL || 'http://127.0.0.1:8787';
const disableHmr = process.env.VITE_DISABLE_HMR === 'true';

export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    port: 5173,
    strictPort: true,
    allowedHosts: true,
    hmr: disableHmr ? false : {
      clientPort: 5173
    },
    proxy: {
      '/api': apiProxyTarget,
      '/uploads': apiProxyTarget,
      '/normalized': apiProxyTarget
    }
  }
});
