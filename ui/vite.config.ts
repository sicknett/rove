import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  define: { __APP_VERSION__: JSON.stringify(process.env.npm_package_version ?? '0.1.0') },
  base: '/',
  server: { port: 5199, strictPort: true },
  build: { outDir: 'dist', emptyOutDir: true, target: 'es2022', assetsInlineLimit: 0 },
});
