import basicSsl from '@vitejs/plugin-basic-ssl';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Phones only allow the microphone over HTTPS: `npm run dev:https` serves a self-signed certificate
  // (accept the browser warning once on the phone).
  plugins: process.env.HTTPS ? [basicSsl()] : [],
  server: {
    host: true, // reachable from a phone on the same network
    proxy: { '/ws': { target: 'ws://localhost:8000', ws: true }, '/health': 'http://localhost:8000', '/latency': 'http://localhost:8000' },
    fs: { allow: ['..'] }, // rooms/ lives at the repo root, shared with the backend
  },
  optimizeDeps: { exclude: ['recast-navigation', '@recast-navigation/core', '@recast-navigation/wasm'] },
  test: { environment: 'node' },
});
