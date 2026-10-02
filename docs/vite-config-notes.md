# Proposed vite.config.js changes (from packaging)

The packaging module does not edit `vite.config.js`; these are the changes it asks the
integrator to make. Both were verified in a scratch Vite 8 project with
`vite-plugin-singlefile` (normal build unchanged; single build gets an inline favicon
and no dangling links).

## 1. Make the offline single file self-contained

`npm run build:single` produces one HTML file that people download and double-click.
Nothing sits next to it, so the head links to `favicon.svg`, the PNG icons and the web
manifest point at files that do not exist (the browser shows a broken tab icon and logs
a manifest error on `file://`), and Vite copies all of `public/` into `dist-single/` for
no reason.

Add this plugin and `copyPublicDir` to `vite.config.js`:

```js
import fs from 'node:fs';   // alongside the existing imports

// In the one-file offline build there is no folder next to Orograph.html, so
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
```

and in the exported config:

```js
  plugins: [
    workletString(),
    ...(mode === 'single' ? [viteSingleFile({ removeViteModuleLoader: true }), singleFileHead()] : []),
  ],
  build: {
    outDir: mode === 'single' ? 'dist-single' : 'dist',
    copyPublicDir: mode !== 'single',
    // ...existing target / chunkSizeWarningLimit / assetsInlineLimit
  },
```

`root` is the constant `vite.config.js` already defines.

## 2. Nothing else is required for Electron

The desktop shell serves `dist/` exactly as Vite writes it (relative `base: './'`), so the
normal build needs no Electron-specific options. Keep `base: './'`.
