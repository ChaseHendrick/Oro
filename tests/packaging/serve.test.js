import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// electron/*.cjs are CommonJS (Electron main process); load them natively.
const require = createRequire(import.meta.url);
const {
  mimeTypeFor, resolveRequestPath, parseRange, inlineScriptHashes, contentSecurityPolicy, createAppHandler,
} = require('../../electron/serve.cjs');

const HOST = 'orograph';

describe('mimeTypeFor', () => {
  it('maps every type the app ships', () => {
    expect(mimeTypeFor('index.html')).toBe('text/html; charset=utf-8');
    expect(mimeTypeFor('assets/index-abc.js')).toBe('text/javascript; charset=utf-8');
    expect(mimeTypeFor('assets/main.CSS')).toBe('text/css; charset=utf-8');
    expect(mimeTypeFor('rapier_wasm3d_bg.wasm')).toBe('application/wasm');
    expect(mimeTypeFor('icon-512.png')).toBe('image/png');
    expect(mimeTypeFor('favicon.svg')).toBe('image/svg+xml');
    expect(mimeTypeFor('presets.json')).toBe('application/json; charset=utf-8');
    expect(mimeTypeFor('fonts/inter.woff2')).toBe('font/woff2');
    expect(mimeTypeFor('manifest.webmanifest')).toBe('application/manifest+json; charset=utf-8');
  });
  it('falls back to octet-stream for unknown or missing extensions', () => {
    expect(mimeTypeFor('LICENSE')).toBe('application/octet-stream');
    expect(mimeTypeFor('x.unknownext')).toBe('application/octet-stream');
  });
});

describe('resolveRequestPath', () => {
  const root = path.resolve('/srv/orograph/dist');
  const ok = (url) => resolveRequestPath(root, url, HOST);

  it('maps URLs onto files inside the root', () => {
    expect(ok('app://orograph/index.html')).toEqual({ ok: true, filePath: path.join(root, 'index.html') });
    expect(ok('app://orograph/assets/a.js?v=1#x')).toEqual({ ok: true, filePath: path.join(root, 'assets', 'a.js') });
    expect(ok('app://orograph/fonts/My%20Font.woff2').filePath).toBe(path.join(root, 'fonts', 'My Font.woff2'));
  });
  it('serves index.html for the root and for folders', () => {
    expect(ok('app://orograph/').filePath).toBe(path.join(root, 'index.html'));
    expect(ok('app://orograph').filePath).toBe(path.join(root, 'index.html'));
    expect(ok('app://orograph/docs/').filePath).toBe(path.join(root, 'docs', 'index.html'));
  });
  it('blocks every path traversal trick', () => {
    const attacks = [
      'app://orograph/..%2f..%2fetc%2fpasswd',
      'app://orograph/%2e%2e/%2e%2e/etc/passwd',
      'app://orograph/assets/..%2F..%2F..%2Fsecret.txt',
      'app://orograph/..%5c..%5cwindows%5cwin.ini',
      'app://orograph/assets%2f..%2f..%2fpackage.json',
    ];
    for (const url of attacks) {
      const r = ok(url);
      if (r.ok) {
        // URL parsing may already have collapsed the dots; then it must still be inside root.
        expect(path.relative(root, r.filePath).startsWith('..')).toBe(false);
      } else {
        expect(r.status).toBe(403);
      }
    }
    expect(ok('app://orograph/..%2f..%2fetc%2fpasswd')).toEqual({ ok: false, status: 403 });
    expect(ok('app://orograph/..%5c..%5cwindows%5cwin.ini')).toEqual({ ok: false, status: 403 });
  });
  it('rejects malformed escapes, NUL bytes and foreign hosts', () => {
    expect(ok('app://orograph/%E0%A4%A')).toEqual({ ok: false, status: 400 });
    expect(ok('app://orograph/index.html%00.png')).toEqual({ ok: false, status: 400 });
    expect(ok('app://evil/index.html')).toEqual({ ok: false, status: 404 });
    expect(ok('not a url')).toEqual({ ok: false, status: 400 });
  });
});

describe('parseRange', () => {
  it('handles the common single-range forms', () => {
    expect(parseRange(null, 100)).toBe(null);
    expect(parseRange('bytes=0-9', 100)).toEqual({ start: 0, end: 9 });
    expect(parseRange('bytes=90-', 100)).toEqual({ start: 90, end: 99 });
    expect(parseRange('bytes=-10', 100)).toEqual({ start: 90, end: 99 });
    expect(parseRange('bytes=50-500', 100)).toEqual({ start: 50, end: 99 });
    expect(parseRange('bytes=-500', 100)).toEqual({ start: 0, end: 99 });
  });
  it('flags unsatisfiable ranges and ignores ones it does not understand', () => {
    expect(parseRange('bytes=100-', 100)).toEqual({ invalid: true });
    expect(parseRange('bytes=9-3', 100)).toEqual({ invalid: true });
    expect(parseRange('bytes=-0', 100)).toEqual({ invalid: true });
    expect(parseRange('bytes=0-1,5-6', 100)).toBe(null);
    expect(parseRange('items=0-1', 100)).toBe(null);
  });
});

describe('content security policy', () => {
  it('locks the page to its own origin but allows what the app needs', () => {
    const csp = contentSecurityPolicy('<html></html>');
    expect(csp).toContain("default-src 'self'");
    expect(csp).toMatch(/script-src 'self' 'wasm-unsafe-eval' blob:(;|$)/);
    expect(csp).toContain("worker-src 'self' blob:");
    expect(csp).toContain("object-src 'none'");
    expect(csp).not.toContain("'unsafe-eval'");
    expect(csp).not.toMatch(/script-src[^;]*'unsafe-inline'/);
    expect(csp).not.toMatch(/https?:/);
  });
  it('hashes inline scripts exactly and skips external or data scripts', () => {
    const body = "document.documentElement.dataset.theme='dark';";
    const html = `<head><script>${body}</script><script type="module" src="./assets/x.js"></script>
      <script type="application/json">{"a":1}</script><script type="module">${body}</script></head>`;
    const expected = `'sha256-${createHash('sha256').update(body).digest('base64')}'`;
    expect(inlineScriptHashes(html)).toEqual([expected]);
    expect(contentSecurityPolicy(html)).toContain(`script-src 'self' 'wasm-unsafe-eval' blob: ${expected}`);
  });
});

describe('createAppHandler', () => {
  let root;
  let handler;
  const logs = [];
  const req = (p, init) => new Request(`app://orograph${p}`, init);

  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'orograph-serve-'));
    fs.mkdirSync(path.join(root, 'assets'));
    fs.writeFileSync(path.join(root, 'index.html'), '<!doctype html><script>window.x=1</script><p>hi</p>');
    fs.writeFileSync(path.join(root, 'assets', 'app.js'), 'export const x = 1;\n');
    fs.writeFileSync(path.join(root, 'assets', 'tiny.wasm'), Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]));
    fs.writeFileSync(path.join(root, 'assets', 'clip.wav'), Buffer.from('0123456789'));
    fs.writeFileSync(path.join(path.dirname(root), 'outside-secret.txt'), 'secret');
    handler = createAppHandler({ root, host: 'orograph', log: (m) => logs.push(m) });
  });
  afterAll(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(path.join(path.dirname(root), 'outside-secret.txt'), { force: true });
  });

  it('serves html with a CSP that allows its own inline script', async () => {
    const res = await handler(req('/'));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
    const hash = createHash('sha256').update('window.x=1').digest('base64');
    expect(res.headers.get('content-security-policy')).toContain(`'sha256-${hash}'`);
    expect(await res.text()).toContain('<p>hi</p>');
  });
  it('serves scripts and wasm with the right MIME types', async () => {
    const js = await handler(req('/assets/app.js'));
    expect(js.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
    expect(js.headers.get('x-content-type-options')).toBe('nosniff');
    expect(js.headers.get('content-security-policy')).toBe(null);
    const wasm = await handler(req('/assets/tiny.wasm'));
    expect(wasm.headers.get('content-type')).toBe('application/wasm');
    expect(new Uint8Array(await wasm.arrayBuffer())).toEqual(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));
  });
  it('answers range requests for media', async () => {
    const res = await handler(req('/assets/clip.wav', { headers: { Range: 'bytes=2-5' } }));
    expect(res.status).toBe(206);
    expect(res.headers.get('content-range')).toBe('bytes 2-5/10');
    expect(await res.text()).toBe('2345');
    const bad = await handler(req('/assets/clip.wav', { headers: { Range: 'bytes=50-' } }));
    expect(bad.status).toBe(416);
  });
  it('supports HEAD and rejects other methods', async () => {
    const head = await handler(req('/assets/app.js', { method: 'HEAD' }));
    expect(head.status).toBe(200);
    expect(head.headers.get('content-length')).toBe('20');
    expect(await head.text()).toBe('');
    const post = await handler(req('/assets/app.js', { method: 'POST', body: 'x' }));
    expect(post.status).toBe(405);
  });
  it('never serves files outside the build folder', async () => {
    const res = await handler(req('/..%2foutside-secret.txt'));
    expect(res.status).toBe(403);
    expect(await res.text()).not.toContain('secret');
  });
  it('returns 404 for missing files and other hosts', async () => {
    expect((await handler(req('/assets/missing.js'))).status).toBe(404);
    expect((await handler(new Request('app://elsewhere/index.html'))).status).toBe(404);
  });
  it('turns read errors into a 500 instead of throwing', async () => {
    const broken = {
      promises: {
        stat: async () => ({ isFile: () => true, isDirectory: () => false }),
        readFile: async () => { throw new Error('EACCES'); },
      },
    };
    const seen = [];
    const h = createAppHandler({ root, host: 'orograph', fs: broken, log: (m) => seen.push(m) });
    const res = await h(req('/assets/app.js'));
    expect(res.status).toBe(500);
    expect(seen.join('\n')).toContain('EACCES');
  });
  it('explains how to build when dist is missing', async () => {
    const missing = createAppHandler({ root: path.join(root, 'no-such-dist'), host: 'orograph' });
    const res = await missing(req('/index.html'));
    expect(res.status).toBe(503);
    expect(await res.text()).toContain('npm run build');
    expect((await missing(req('/assets/app.js'))).status).toBe(404);
  });
});
