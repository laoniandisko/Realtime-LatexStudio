import { defineConfig } from 'vite';
import { studioBridge } from './scripts/latex/studio-bridge.mjs';
import { resolve } from 'node:path';

export default defineConfig({
  plugins: [studioBridge()],
  server: { host: '127.0.0.1', port: 1421, strictPort: true, allowedHosts: ['127.0.0.1', 'localhost'] },
  build: { outDir: 'dist-latex', target: 'es2022', rollupOptions: { input: {home:resolve('home.html'),latex:resolve('latex.html')} } },
  optimizeDeps: { include: ['monaco-editor', 'pdfjs-dist', '@xterm/xterm', '@xterm/addon-fit'] },
  worker: { format: 'es' },
});
