import { defineConfig, loadEnv } from 'vite';
import { pppoeApiPlugin } from './src/server/vite-plugin.js';

export default defineConfig(({ mode }) => {
  const env = { ...loadEnv(mode, process.cwd(), ''), ...process.env };
  const allowedDevHosts = [...new Set(String(env.DEV_ALLOWED_HOSTS ?? '')
    .split(',').map((host) => host.trim().toLowerCase()).filter(Boolean))];
  if (allowedDevHosts.some((host) => /[*/:]/.test(host) || host.startsWith('.'))) {
    throw new Error('DEV_ALLOWED_HOSTS accepts exact hostnames only; wildcard, scheme, and port entries are not allowed.');
  }
  return {
    base: './',
    plugins: [pppoeApiPlugin(env)],
    build: {
      outDir: 'dist',
      emptyOutDir: true,
    },
    server: {
      port: 4173,
      strictPort: true,
      ...(allowedDevHosts.length ? { allowedHosts: allowedDevHosts } : {}),
    },
  };
});
