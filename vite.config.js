import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';
import { build as esbuild } from 'esbuild';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const root = path.dirname(fileURLToPath(import.meta.url));

// Bundles an AudioWorklet entry (and everything it imports) into one classic
// script string, exposed as `import code from 'virtual:worklet:src/dsp/worklet.js'`.
// The audio engine turns the string into a Blob URL for audioWorklet.addModule(),
// which works the same in `vite dev`, normal builds, the single-file build, and Electron.
function workletString() {
  const PREFIX = 'virtual:worklet:';
  return {
    name: 'orograph-worklet-string',
    resolveId(id) {
      if (id.startsWith(PREFIX)) return '\0' + id;
      return null;
    },
    async load(id) {
      if (!id.startsWith('\0' + PREFIX)) return null;
      const entry = path.resolve(root, id.slice(PREFIX.length + 1));
      const result = await esbuild({
        entryPoints: [entry],
        bundle: true,
        write: false,
        format: 'iife',
        target: 'es2020',
        minify: process.env.NODE_ENV === 'production',
        metafile: true,
      });
      for (const input of Object.keys(result.metafile.inputs)) this.addWatchFile(path.resolve(root, input));
      return `export default ${JSON.stringify(result.outputFiles[0].text)};`;
    },
  };
}

// In the one-file offline build there is no folder next to the HTML file, so
// inline the SVG favicon and drop links that would point at missing files.
function singleFileHead() {
  return {
    name: 'orograph-single-file-head',
    transformIndexHtml: {
      order: 'post',
      handler(html) {
        const svg = fs.readFileSync(path.resolve(root, 'public/favicon.svg'));
        const dataUri = `data:image/svg+xml;base64,${svg.toString('base64')}`;
        return html.replace(/<link\b[^>]*\brel="(icon|apple-touch-icon|manifest)"[^>]*>\s*/g, (tag, rel) =>
          rel === 'icon' && /favicon\.svg/.test(tag) ? tag.replace(/href="[^"]*"/, `href="${dataUri}"`) : '');
      },
    },
  };
}

export default defineConfig(({ mode }) => ({
  base: './',
  plugins: [
    workletString(),
    ...(mode === 'single' ? [viteSingleFile({ removeViteModuleLoader: true }), singleFileHead()] : []),
  ],
  build: {
    outDir: mode === 'single' ? 'dist-single' : 'dist',
    copyPublicDir: mode !== 'single',
    target: 'es2022',
    chunkSizeWarningLimit: 4000,
    assetsInlineLimit: mode === 'single' ? 100_000_000 : 4096,
  },
  server: { host: '127.0.0.1', port: 5173 },
  test: {
    include: ['tests/**/*.test.js'],
    environment: 'node',
    // Offline audio renders take a few seconds on a busy machine or CI runner;
    // a slow pass is not a failure (a hung test still is, after 30 s).
    testTimeout: 30000,
  },
}));
