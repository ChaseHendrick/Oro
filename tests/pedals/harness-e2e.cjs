// End-to-end run of the pedal harness (dev/pedals) in headless Chromium.
//   node tests/pedals/harness-e2e.cjs
// Starts vite on port 5196 (HMR off), opens dev/pedals/index.html?auto twice
// (AudioWorklet processors, then the ScriptProcessor fallbacks), prints every
// check and metric, saves screenshots, exits non-zero on any failure.
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const { spawn } = require('node:child_process');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const PORT = 5196;
const ROOT = path.resolve(__dirname, '../..');
const SHOTS = process.env.PEDAL_SHOTS || '/tmp/orograph-shots/pedals';
const ARGS = ['--autoplay-policy=no-user-gesture-required', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist',
  // A fake microphone so openReturn can be exercised without hardware.
  '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'];

function ping() {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: PORT, path: '/dev/pedals/index.html', timeout: 1500 }, (res) => { res.resume(); resolve(res.statusCode === 200); });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

async function runPage(browser, query, label, colorScheme) {
  const page = await browser.newPage({ viewport: { width: 1180, height: 1000 }, colorScheme });
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(`http://127.0.0.1:${PORT}/dev/pedals/index.html?${query}`);
  await page.waitForFunction(() => window.__pedals && ['done', 'error'].includes(window.__pedals.status), null, { timeout: 240000 });
  await page.waitForTimeout(400);
  fs.mkdirSync(SHOTS, { recursive: true });
  const shot = path.join(SHOTS, `${label}.png`);
  await page.screenshot({ path: shot, fullPage: true });
  const r = await page.evaluate(() => ({ status: window.__pedals.status, checks: window.__pedals.checks, metrics: window.__pedals.metrics, errors: window.__pedals.errors }));
  await page.close();
  r.consoleErrors = errors.filter(t => !/AudioContext was not allowed to start/.test(t));
  r.shot = shot;
  return r;
}

(async () => {
  const server = spawn('npx', ['vite', '--config', 'dev/pedals/vite.config.js', '--port', String(PORT), '--strictPort'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  let serverLog = '';
  server.stdout.on('data', d => { serverLog += d; });
  server.stderr.on('data', d => { serverLog += d; });
  let failed = 0;
  try {
    const t0 = Date.now();
    while (!(await ping())) {
      if (Date.now() - t0 > 60000) throw new Error('vite did not start on port ' + PORT + '\n' + serverLog);
      await new Promise(r => setTimeout(r, 300));
    }
    const browser = await chromium.launch({ args: ARGS });
    try {
      for (const [query, label, scheme] of [['auto&media', 'worklet-dark', 'dark'], ['auto&noworklet', 'fallback-light', 'light']]) {
        const r = await runPage(browser, query, label, scheme);
        console.log(`\n=== ${label} (${query}) status: ${r.status} ===`);
        for (const c of r.checks) {
          console.log(`${c.pass ? 'PASS' : c.skip ? 'SKIP' : 'FAIL'}  ${c.name}  ${typeof c.value === 'string' ? c.value : JSON.stringify(c.value)}`);
          // SKIP: only the ScriptProcessor fallback, and only when the browser dropped audio buffers.
          if (!c.pass && !c.skip) failed++;
        }
        const skips = r.checks.filter(c => c.skip).length;
        if (skips && !/noworklet/.test(query)) failed++; // the worklet path never gets a pass for load
        if (skips) console.log(`(${skips} fallback check(s) skipped: the main thread was too busy and audio was dropped)`);
        console.log('metrics', JSON.stringify(r.metrics, null, 1));
        if (r.errors.length || r.consoleErrors.length) { console.log('errors', r.errors, r.consoleErrors); failed++; }
        if (r.status !== 'done') failed++;
        console.log('screenshot', r.shot);
      }
    } finally {
      await browser.close();
    }
  } catch (err) {
    console.error(err);
    failed++;
  } finally {
    try { process.kill(-server.pid, 'SIGTERM'); } catch { try { server.kill('SIGTERM'); } catch { /* gone */ } }
  }
  console.log(failed ? `\n${failed} problem(s)` : '\nall pedal harness checks passed');
  process.exit(failed ? 1 : 0);
})();
