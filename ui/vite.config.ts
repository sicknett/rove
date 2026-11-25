import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { readFileSync } from 'node:fs';

// One version for the whole app: the shell's (shell/Cargo.toml), which the installer uses too.
const version = /^version\s*=\s*"([^"]+)"/m.exec(readFileSync(new URL('../shell/Cargo.toml', import.meta.url), 'utf8'))?.[1] ?? '0.0.0';

export default defineConfig({
  plugins: [react()],
  define: { __APP_VERSION__: JSON.stringify(version) },
  base: '/',
  server: { port: 5199, strictPort: true },
  build: { outDir: 'dist', emptyOutDir: true, target: 'es2022', assetsInlineLimit: 0 },
});
