import { defineConfig, loadEnv } from 'vite';
import { pppoeApiPlugin } from './src/server/vite-plugin.js';

export default defineConfig(({ mode }) => {
  const env = { ...loadEnv(mode, process.cwd(), ''), ...process.env };
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
    },
  };
});
