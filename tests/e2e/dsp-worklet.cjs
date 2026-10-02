// End-to-end check of the DSP worklet bundle in headless Chromium.
//   node tests/e2e/dsp-worklet.cjs
// Starts `vite` on port 5181 unless something already answers there, opens
// dev/dsp/index.html?auto, and verifies that the worklet loads through the
// virtual:worklet bundle, renders offline, plays live (AnalyserNode RMS),
// releases to silence and sends telemetry.
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const { spawn } = require('node:child_process');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const PORT = 5181;
const ROOT = path.resolve(__dirname, '../..');
const SHOTS = '/tmp/orograph-shots/dsp';

function ping() {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: PORT, path: '/dev/dsp/index.html', timeout: 1000 }, (res) => { res.resume(); resolve(res.statusCode === 200); });
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

(async () => {
  let vite = null;
  if (!(await ping())) {
    vite = spawn('npx', ['vite', '--port', String(PORT), '--strictPort'], { cwd: ROOT, stdio: 'ignore', detached: true });
    await waitFor(ping, 30000, 'vite');
  }
  const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  let ok = false;
  try {
    const page = await browser.newPage();
    const consoleErrors = [];
    page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
    page.on('pageerror', (e) => consoleErrors.push(String(e)));
    await page.goto(`http://127.0.0.1:${PORT}/dev/dsp/index.html?auto`);
    fs.mkdirSync(SHOTS, { recursive: true });
    await page.waitForFunction(() => window.__dsp && ['playing', 'releasing', 'done', 'error'].includes(window.__dsp.status), null, { timeout: 30000 });
    await page.waitForTimeout(150);
    await page.screenshot({ path: path.join(SHOTS, 'worklet-harness.png') });
    await page.waitForFunction(() => window.__dsp && (window.__dsp.status === 'done' || window.__dsp.status === 'error'), null, { timeout: 30000 });
    const r = await page.evaluate(() => window.__dsp);
    const live = Math.max(...r.liveRms);
    const report = {
      status: r.status,
      offline: r.offline,
      liveRmsMax: live,
      afterReleaseRms: r.afterRms,
      telemetryMessages: r.tele,
      lastTele: r.lastTele && { activeVoices: r.lastTele.activeVoices, peak: r.lastTele.peak, nKeys: Object.keys(r.lastTele.n).length },
      contextTime: r.contextTime,
      errors: r.errors.concat(consoleErrors),
    };
    console.log(JSON.stringify(report, null, 2));
    const checks = [
      ['finished without errors', r.status === 'done' && report.errors.length === 0],
      ['offline render is finite', r.offline && r.offline.finite],
      ['offline silent before the note', r.offline && r.offline.before === 0],
      ['offline sounds during the note', r.offline && r.offline.during > 0.02],
      ['offline releases to silence', r.offline && r.offline.after < 1e-4],
      ['live audio through the AnalyserNode', live > 0.02],
      ['live release to near silence', r.afterRms < 0.01],
      ['telemetry arrives (~60/s)', r.tele > 40],
    ];
    for (const [name, pass] of checks) console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}`);
    ok = checks.every(([, p]) => p);
  } finally {
    await browser.close();
    if (vite) { try { process.kill(-vite.pid); } catch { vite.kill(); } }
  }
  process.exit(ok ? 0 : 1);
})().catch((err) => { console.error(err); process.exit(1); });
