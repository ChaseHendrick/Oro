'use strict';

// Serves the built web app (dist/) to the renderer through the privileged
// `app://orograph/` scheme. Pure Node (no `electron` import) so the path
// resolution, MIME, range and CSP logic are unit-tested in tests/packaging/.
//
// Why a custom scheme instead of file://: file:// pages get an opaque origin, so
// localStorage, Web MIDI permissions, ES module CORS checks and AudioWorklet
// (secure context) all behave badly or differently from the web build.

const path = require('node:path');
const crypto = require('node:crypto');
const fsDefault = require('node:fs');

const MIME_TYPES = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.cjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.flac': 'audio/flac',
  '.m4a': 'audio/mp4',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
});

function mimeTypeFor(filePath) {
  return MIME_TYPES[path.extname(String(filePath)).toLowerCase()] || 'application/octet-stream';
}

// The page only ever needs its own files plus blob:/data: URLs it creates
// itself (AudioWorklet module, recordings, imported images). Remote origins are
// refused so injected markup can never pull in outside code. 'wasm-unsafe-eval'
// is required by Rapier, which compiles WebAssembly from inlined bytes.
const CSP_DIRECTIVES = Object.freeze([
  ["default-src", "'self'"],
  ["script-src", "'self'", "'wasm-unsafe-eval'", 'blob:'],
  ["style-src", "'self'", "'unsafe-inline'"],
  ["img-src", "'self'", 'data:', 'blob:'],
  ["font-src", "'self'", 'data:'],
  ["media-src", "'self'", 'data:', 'blob:'],
  ["connect-src", "'self'", 'data:', 'blob:'],
  ["worker-src", "'self'", 'blob:'],
  ["object-src", "'none'"],
  ["base-uri", "'self'"],
  ["form-action", "'none'"],
  ["frame-ancestors", "'none'"],
]);

const INLINE_SCRIPT_RE = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;

/**
 * sha256 CSP sources for every inline <script> in an HTML document, so a small
 * inline bootstrap (for example a theme pre-paint snippet) keeps working without
 * resorting to 'unsafe-inline'. JSON data blocks are skipped (never executed).
 */
function inlineScriptHashes(html) {
  const hashes = [];
  for (const match of String(html).matchAll(INLINE_SCRIPT_RE)) {
    const attrs = match[1];
    if (/\bsrc\s*=/i.test(attrs)) continue;
    const type = /\btype\s*=\s*["']?([^"'\s>]+)/i.exec(attrs);
    if (type && !/^(module|text\/javascript|application\/javascript)$/i.test(type[1])) continue;
    const digest = crypto.createHash('sha256').update(match[2], 'utf8').digest('base64');
    hashes.push(`'sha256-${digest}'`);
  }
  return [...new Set(hashes)];
}

/** Content-Security-Policy header value for an HTML document. */
function contentSecurityPolicy(html = '') {
  const extra = inlineScriptHashes(html);
  return CSP_DIRECTIVES
    .map(([name, ...sources]) => [name, ...sources, ...(name === 'script-src' ? extra : [])].join(' '))
    .join('; ');
}

/**
 * Map a request URL onto a file under `root`.
 * Returns { ok: true, filePath } or { ok: false, status } (400 bad URL, 403 outside
 * root, 404 wrong host). Never touches the disk.
 */
function resolveRequestPath(root, requestUrl, host) {
  let url;
  try { url = new URL(requestUrl); } catch { return { ok: false, status: 400 }; }
  if (host && url.host !== host) return { ok: false, status: 404 };

  let pathname;
  try { pathname = decodeURIComponent(url.pathname); } catch { return { ok: false, status: 400 }; }
  if (pathname.includes('\0')) return { ok: false, status: 400 };
  if (pathname === '' || pathname.endsWith('/')) pathname += 'index.html';

  // Treat backslashes as separators everywhere so "..\\" cannot slip through on
  // Windows, then make sure the final path is still inside root. Encoded
  // separators (%2F, %5C) are decoded above, so they are covered by this check too.
  const segments = pathname.split(/[\\/]+/).filter(Boolean);
  const base = path.resolve(root);
  const filePath = path.resolve(base, ...segments);
  const rel = path.relative(base, filePath);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return { ok: false, status: 403 };
  return { ok: true, filePath };
}

/**
 * Parse a single-range "Range: bytes=..." header against a file size.
 * Returns null when there is no usable header (serve the whole file),
 * { start, end } (inclusive) for a satisfiable range, or { invalid: true }.
 */
function parseRange(header, size) {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(header).trim());
  if (!m) return null; // multi-range or other units: ignore and send everything
  const [, a, b] = m;
  if (a === '' && b === '') return { invalid: true };
  let start;
  let end;
  if (a === '') {
    const suffix = Number(b);
    if (suffix === 0) return { invalid: true };
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(a);
    end = b === '' ? size - 1 : Math.min(Number(b), size - 1);
  }
  if (start >= size || start > end) return { invalid: true };
  return { start, end };
}

function textResponse(status, message) {
  return new Response(message, {
    status,
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'X-Content-Type-Options': 'nosniff' },
  });
}

function missingBuildPage(root) {
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Orograph</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#120e2b;color:#f3ecff;
font:16px/1.5 system-ui,sans-serif}main{max-width:34rem;padding:2rem}code{color:#ff9a6b}</style></head>
<body><main><h1>Orograph has not been built yet</h1>
<p>The desktop shell could not find the web app in <code>${esc(root)}</code>.</p>
<p>From the project folder run <code>npm run build</code>, then start the app again.</p></main></body></html>`;
}

/**
 * Build a `protocol.handle` handler that serves files from `root`.
 * `fs` is injectable for tests; it needs promises.stat and promises.readFile
 * (Electron's patched fs reads straight out of app.asar).
 */
function createAppHandler({ root, host, fs = fsDefault, log = () => {} }) {
  const base = path.resolve(root);

  async function serve(request) {
    const method = request.method || 'GET';
    if (method !== 'GET' && method !== 'HEAD') {
      const res = textResponse(405, 'Method not allowed');
      res.headers.set('Allow', 'GET, HEAD');
      return res;
    }

    const resolved = resolveRequestPath(base, request.url, host);
    if (!resolved.ok) {
      log(`refused ${request.url} (${resolved.status})`);
      return textResponse(resolved.status, resolved.status === 403 ? 'Forbidden' : 'Not found');
    }

    let filePath = resolved.filePath;
    let stat;
    try {
      stat = await fs.promises.stat(filePath);
      if (stat.isDirectory()) {
        filePath = path.join(filePath, 'index.html');
        stat = await fs.promises.stat(filePath);
      }
    } catch {
      stat = null;
    }

    if (!stat || !stat.isFile()) {
      const isEntry = path.relative(base, filePath) === 'index.html';
      const rootMissing = isEntry && !(await fs.promises.stat(base).then((s) => s.isDirectory(), () => false));
      if (rootMissing) {
        const html = missingBuildPage(base);
        return new Response(html, {
          status: 503,
          headers: { 'Content-Type': MIME_TYPES['.html'], 'Content-Security-Policy': contentSecurityPolicy(html) },
        });
      }
      log(`not found ${request.url}`);
      return textResponse(404, 'Not found');
    }

    const type = mimeTypeFor(filePath);
    const headers = {
      'Content-Type': type,
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
      'Accept-Ranges': 'bytes',
    };

    let body = await fs.promises.readFile(filePath);
    if (type.startsWith('text/html')) {
      headers['Content-Security-Policy'] = contentSecurityPolicy(body.toString('utf8'));
    }

    const size = body.length;
    const range = parseRange(request.headers && request.headers.get('range'), size);
    let status = 200;
    if (range && range.invalid) {
      return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
    }
    if (range) {
      body = body.subarray(range.start, range.end + 1);
      headers['Content-Range'] = `bytes ${range.start}-${range.end}/${size}`;
      status = 206;
    }
    headers['Content-Length'] = String(body.length);
    return new Response(method === 'HEAD' ? null : body, { status, headers });
  }

  // A thrown error would surface in the page as an opaque network failure; answer
  // with a real 500 and keep the reason in the main-process log instead.
  return async function handleAppRequest(request) {
    try {
      return await serve(request);
    } catch (err) {
      log(`error serving ${request.url}: ${err && err.message}`);
      return textResponse(500, 'Internal error');
    }
  };
}

module.exports = {
  MIME_TYPES,
  CSP_DIRECTIVES,
  mimeTypeFor,
  inlineScriptHashes,
  contentSecurityPolicy,
  resolveRequestPath,
  parseRange,
  missingBuildPage,
  createAppHandler,
};
