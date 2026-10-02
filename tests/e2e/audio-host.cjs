// End-to-end check of the audio host (src/audio) in headless Chromium.
//   node tests/e2e/audio-host.cjs
// 1. vite dev server on port 5182 (HMR off): dev/audio/index.html?auto (AudioWorklet host)
// 2. the same page with &mode=script (ScriptProcessor fallback)
// 3. the harness built as one file (vite --mode single) opened from file://,
//    where Blob URLs are refused and the data: URL fallback must kick in.
// Prints every check and the measured numbers; exits non-zero on failure.
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const { spawn, spawnSync } = require('node:child_process');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const PORT = 5182;
const ROOT = path.resolve(__dirname, '../..');
const SHOTS = '/tmp/orograph-shots/audio';
const SINGLE_OUT = '/tmp/orograph-single-audio';
const ARGS = ['--autoplay-policy=no-user-gesture-required', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'];

function ping() {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: PORT, path: '/dev/audio/index.html', timeout: 1000 }, (res) => { res.resume(); resolve(res.statusCode === 200); });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

async function waitFor(fn, ms, what) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await fn()) return;
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error('timed out waiting for ' + what);
}

async function runPage(browser, url, label) {
  const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
  const consoleErrors = [];
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('pageerror', (e) => consoleErrors.push(String(e)));
  await page.goto(url);
  await page.waitForFunction(() => window.__audio && ['done', 'error'].includes(window.__audio.status), null, { timeout: 90000 });
  await page.waitForTimeout(200);
  await page.screenshot({ path: path.join(SHOTS, `${label}.png`), fullPage: true });
  const r = await page.evaluate(() => {
    const a = window.__audio;
    return { status: a.status, checks: a.checks, metrics: a.metrics, errors: a.errors, stats: a.stats, longTasks: a.longTasks, terrainEvents: a.terrainEvents.length };
  });
  await page.close();
  // Chromium logs a warning-level message for the suspended AudioContext; only real errors count.
  r.consoleErrors = consoleErrors.filter(t => !/AudioContext was not allowed to start/.test(t));
  return r;
}

function summarise(label, r) {
  console.log(`\n=== ${label} ===`);
  for (const c of r.checks) console.log(`${c.pass ? 'PASS' : 'FAIL'}  ${c.name}  ${JSON.stringify(c.value)}`);
  const st = r.stats || {};
  console.log('metrics', JSON.stringify(r.metrics));
  if (st.fx) console.log('fx', JSON.stringify({ irBuilds: st.fx.irBuilds, maxIrMs: +st.fx.maxIrMs.toFixed(1), maxBufferMs: +st.fx.maxBufferMs.toFixed(1), irLength: st.fx.lastIrLength, delayTime: st.fx.delayTime }));
  if (st.terrain) console.log('terrain', JSON.stringify({ ...st.terrain, maxApplyMs: +st.terrain.maxApplyMs.toFixed(2) }));
  if (st.generator) console.log('generator', JSON.stringify({ ...st.generator, maxJobMs: +st.generator.maxJobMs.toFixed(1), totalJobMs: +st.generator.totalJobMs.toFixed(0), maxInlineBlockMs: +st.generator.maxInlineBlockMs.toFixed(1) }));
  console.log('engine', JSON.stringify({ mode: st.mode, workletVia: st.workletVia, recorder: st.recorder, loadErrors: st.loadErrors, sync: st.sync }));
  console.log('long tasks', JSON.stringify(r.longTasks));
  if (r.errors.length || r.consoleErrors.length) console.log('errors', JSON.stringify({ page: r.errors, console: r.consoleErrors }));
  const extra = [
    ['finished', r.status === 'done'],
    ['no console errors', r.consoleErrors.length === 0],
  ];
  for (const [name, pass] of extra) console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}`);
  return r.checks.every(c => c.pass) && extra.every(([, p]) => p);
}

(async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  // Our own server (no HMR, no watcher: see dev/audio/vite.config.js), never a
  // shared one that could reload the page while other files are being edited.
  if (await ping()) throw new Error(`port ${PORT} is already in use; stop that server first`);
  const vite = spawn('npx', ['vite', '--config', 'dev/audio/vite.config.js', '--port', String(PORT), '--strictPort'], { cwd: ROOT, stdio: 'ignore', detached: true });
  await waitFor(ping, 30000, 'vite');
  const browser = await chromium.launch({ args: ARGS });
  const results = [];
  try {
    const base = `http://127.0.0.1:${PORT}/dev/audio/index.html`;
    const w = await runPage(browser, `${base}?auto`, 'worklet');
    results.push(['dev server, AudioWorklet host', summarise('dev server, AudioWorklet host', w), w]);
    const s = await runPage(browser, `${base}?auto&mode=script`, 'script');
    results.push(['dev server, ScriptProcessor fallback', summarise('dev server, ScriptProcessor fallback', s), s]);

    // Single-file build from file://
    const b = spawnSync('npx', ['vite', 'build', '--config', 'dev/audio/vite.config.js', '--mode', 'single', '--outDir', SINGLE_OUT, '--logLevel', 'warn'], { cwd: ROOT, encoding: 'utf8' });
    if (b.status !== 0) throw new Error('single build failed:\n' + b.stdout + b.stderr);
    const html = path.join(SINGLE_OUT, 'dev/audio/index.html');
    const files = fs.readdirSync(path.dirname(html));
    console.log(`\nsingle build: ${html} (${(fs.statSync(html).size / 1024).toFixed(0)} KB; files next to it: ${files.join(', ')})`);
    const f = await runPage(browser, `file://${html}?auto`, 'single-file');
    const okVia = f.metrics && f.metrics.workletVia === 'data';
    console.log(`${okVia ? 'PASS' : 'FAIL'}  file:// page loaded the worklet through the data: URL fallback (${f.metrics && f.metrics.workletVia})`);
    results.push(['single file from file://', summarise('single file from file://', f) && okVia, f]);
  } finally {
    await browser.close();
    try { process.kill(-vite.pid); } catch { vite.kill(); }
  }
  console.log('\n=== summary ===');
  for (const [name, ok] of results) console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  process.exit(results.every(([, ok]) => ok) ? 0 : 1);
})().catch((err) => { console.error(err); process.exit(1); });
