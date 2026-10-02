// Full-app smoke test: boots the real Orograph (vite dev server or a built
// file), starts audio, and checks the things a player would notice first.
//
//   node tests/e2e/app-smoke.cjs http://127.0.0.1:5190/          (dev server)
//   node tests/e2e/app-smoke.cjs file:///abs/path/dist-single/index.html
//
// Screenshots land in /tmp/orograph-shots/app/. Exit code 1 on any failure.

const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const fs = require('node:fs');

const URL_ = process.argv[2] || 'http://127.0.0.1:5190/';
const OUT = process.env.SHOTS || '/tmp/orograph-shots/app';
fs.mkdirSync(OUT, { recursive: true });

const failures = [];
const check = (ok, msg) => { console.log((ok ? 'PASS ' : 'FAIL ') + msg); if (!ok) failures.push(msg); };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function run(viewport, theme, tag) {
  const browser = await chromium.launch({
    args: ['--autoplay-policy=no-user-gesture-required', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
  });
  const context = await browser.newContext({ viewport, colorScheme: theme, deviceScaleFactor: 1 });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

  await page.goto(URL_, { waitUntil: 'load' });
  await page.waitForFunction(() => window.orograph && window.orograph.store, null, { timeout: 30000 });
  await sleep(1500);
  await page.screenshot({ path: `${OUT}/${tag}-1-start.png` });

  // Start audio the way a person would: click the start button if present, else anywhere.
  const startBtn = page.locator('[data-action="start"], .og-start button, button:has-text("Start")').first();
  if (await startBtn.count()) await startBtn.click({ timeout: 5000 }).catch(() => {});
  else await page.mouse.click(viewport.width / 2, viewport.height / 2);
  await sleep(800);

  const state = await page.evaluate(() => {
    const o = window.orograph;
    return {
      ctx: o.engine && o.engine.context ? o.engine.context.state : 'none',
      mode: o.engine && o.engine.mode,
      theme: document.documentElement.dataset.theme,
      parts: o.store.get('parts').length,
      overflowX: document.documentElement.scrollWidth > window.innerWidth + 1,
    };
  });
  check(state.ctx === 'running', `${tag}: audio context running (${state.ctx}, ${state.mode})`);
  check(state.theme === theme, `${tag}: resolved theme is ${theme} (got ${state.theme})`);
  check(!state.overflowX, `${tag}: no horizontal page overflow`);

  // Play a chord through the router and measure output level at the analyser.
  const level = await page.evaluate(async () => {
    const o = window.orograph;
    const notes = [57, 60, 64];
    notes.forEach(n => o.music.router.noteOn('sel', n, 0.9));
    await new Promise(r => setTimeout(r, 700));
    const a = o.engine.analyser;
    const buf = new Float32Array(a.fftSize);
    a.getFloatTimeDomainData(buf);
    let sum = 0, peak = 0, bad = 0;
    for (const v of buf) { if (!Number.isFinite(v)) bad++; sum += v * v; peak = Math.max(peak, Math.abs(v)); }
    notes.forEach(n => o.music.router.noteOff('sel', n));
    return { rms: Math.sqrt(sum / buf.length), peak, bad };
  });
  check(level.bad === 0, `${tag}: no NaN/Inf at the output`);
  check(level.rms > 0.005, `${tag}: chord is audible (rms ${level.rms.toFixed(4)}, peak ${level.peak.toFixed(3)})`);
  check(level.peak <= 1.0001, `${tag}: output within full scale`);

  // Click the 3D map and expect the dot to move.
  const before = await page.evaluate(() => {
    const s = window.orograph.store; const p = s.get('ui.selectedPart');
    return [s.get(`parts.${p}.params.centerX`), s.get(`parts.${p}.params.centerY`)];
  });
  const canvas = page.locator('[data-viewport] canvas').first();
  if (await canvas.count()) {
    const box = await canvas.boundingBox();
    await page.mouse.click(box.x + box.width * 0.62, box.y + box.height * 0.62);
    await sleep(900);
    const after = await page.evaluate(() => {
      const s = window.orograph.store; const p = s.get('ui.selectedPart');
      return [s.get(`parts.${p}.params.centerX`), s.get(`parts.${p}.params.centerY`)];
    });
    const moved = Math.hypot(after[0] - before[0], after[1] - before[1]);
    check(moved > 0.01, `${tag}: clicking the map moves the dot (${before.map(v => v.toFixed(3))} -> ${after.map(v => v.toFixed(3))})`);
  } else {
    check(false, `${tag}: 3D canvas present`);
  }

  // Start the transport for a moment and make sure steps advance.
  const steps = await page.evaluate(async () => {
    const o = window.orograph; let n = 0;
    const off = o.music.transport.on ? o.music.transport.on('step', () => n++) : null;
    o.music.transport.play();
    await new Promise(r => setTimeout(r, 2000));
    o.music.transport.stop();
    if (typeof off === 'function') off();
    return n;
  });
  check(steps > 4, `${tag}: sequencer steps advance while playing (${steps} step events in 2 s)`);
  await page.screenshot({ path: `${OUT}/${tag}-2-played.png` });

  check(errors.length === 0, `${tag}: no console errors` + (errors.length ? '\n  ' + errors.slice(0, 8).join('\n  ') : ''));
  await browser.close();
}

(async () => {
  const runs = [
    [{ width: 1440, height: 900 }, 'dark', 'desktop-dark'],
    [{ width: 1440, height: 900 }, 'light', 'desktop-light'],
    [{ width: 390, height: 844 }, 'dark', 'phone-dark'],
    [{ width: 390, height: 844 }, 'light', 'phone-light'],
  ];
  for (const [vp, theme, tag] of runs) {
    try { await run(vp, theme, tag); } catch (e) { check(false, `${tag}: crashed: ${e.message}`); }
  }
  console.log(failures.length ? `\n${failures.length} failure(s)` : '\nall checks passed');
  process.exit(failures.length ? 1 : 0);
})();
