import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

/**
 * Offline shell: after the build, list every emitted asset in precache.json and
 * stamp sw.js with a build id so phones pick up new versions.
 */
function precache(): Plugin {
  let outDir = 'dist';
  return {
    name: 'manar-precache',
    apply: 'build',
    configResolved(c) {
      outDir = path.resolve(c.root, c.build.outDir);
    },
    writeBundle(_opts, bundle) {
      const files = Object.keys(bundle)
        .filter((f) => /\.(js|css|svg|png|webmanifest|woff2)$/.test(f))
        .map((f) => `/${f}`)
        .sort();
      const icons3d = fs.existsSync(path.join(outDir, 'icons3d')) ? fs.readdirSync(path.join(outDir, 'icons3d')).map((f) => `/icons3d/${f}`) : [];
      const urls = ['/', ...files, ...icons3d, '/icons/icon.svg', '/icons/icon-192.png', '/manifest.webmanifest'];
      const id = crypto.createHash('sha256').update(urls.join('\n')).digest('hex').slice(0, 12);
      fs.writeFileSync(path.join(outDir, 'precache.json'), JSON.stringify({ id, urls: [...new Set(urls)] }));
      const sw = path.join(outDir, 'sw.js');
      fs.writeFileSync(sw, fs.readFileSync(sw, 'utf8').replaceAll('__BUILD_ID__', id));
    },
  };
}

/** pdf.js data files (fonts, character maps, decoders) served from /pdfjs/ for the PDF viewer. */
function pdfjsAssets(): Plugin {
  const src = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../node_modules/pdfjs-dist');
  const dirs = ['cmaps', 'standard_fonts', 'wasm', 'iccs'];
  return {
    name: 'manar-pdfjs-assets',
    writeBundle(opts) {
      const out = path.join(opts.dir ?? 'dist', 'pdfjs');
      for (const d of dirs) fs.cpSync(path.join(src, d), path.join(out, d), { recursive: true });
    },
    configureServer(server) {
      server.middlewares.use('/pdfjs', (req, res, next) => {
        const f = path.join(src, decodeURIComponent((req.url ?? '').split('?')[0]));
        if (!f.startsWith(src) || !dirs.some((d) => f.startsWith(path.join(src, d))) || !fs.existsSync(f)) return next();
        res.end(fs.readFileSync(f));
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), precache(), pdfjsAssets()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': { target: 'http://127.0.0.1:7470', ws: true, changeOrigin: false },
    },
  },
  build: {
    target: 'es2022',
    sourcemap: false,
    chunkSizeWarningLimit: 400,
  },
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}'],
    setupFiles: ['src/test-setup.ts'],
  },
});
