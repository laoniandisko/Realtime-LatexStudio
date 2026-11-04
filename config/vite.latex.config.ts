import { defineConfig } from 'vite';
import { studioBridge } from '../scripts/latex/studio-bridge.mjs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../', import.meta.url));
const entryRoot = resolve(repoRoot, 'src/latex/entry');

export default defineConfig({
  root: entryRoot,
  cacheDir: resolve(repoRoot, 'node_modules/.vite'),
  envDir: repoRoot,
  publicDir: resolve(repoRoot, 'public'),
  resolve: { alias: { '/src/latex': resolve(repoRoot, 'src/latex') } },
  plugins: [studioBridge()],
  server: { host: '127.0.0.1', port: 1421, strictPort: true, allowedHosts: ['127.0.0.1', 'localhost'], fs: { allow: [repoRoot] } },
  build: { outDir: resolve(repoRoot, 'dist-latex'), emptyOutDir: true, target: 'es2022', rollupOptions: { input: {home:resolve(entryRoot,'home.html'),latex:resolve(entryRoot,'latex.html')} } },
  optimizeDeps: { include: ['monaco-editor', 'pdfjs-dist', '@xterm/xterm', '@xterm/addon-fit'] },
  worker: { format: 'es' },
});
