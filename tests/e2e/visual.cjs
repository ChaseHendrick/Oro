// End-to-end check of the 3D map in headless Chromium (software WebGL).
//   node tests/e2e/visual.cjs
// Starts vite on port 5183 (dev/visual/vite.config.mjs) unless something
// already answers there, opens the visuals harness (dev/visual/index.html,
// real visuals + real store + fake engine) and checks: no console errors,
// screenshots in both themes and three views, click-to-place lands where the
// pointer was, dragging the dot, arrow-key nudges, Roll mode moves the marble,
// Drift moves a part that is not selected, reduced motion stops auto-rotate,
// a phone-sized viewport with a tap, and frame times.
// Screenshots: /tmp/orograph-shots/visual/e2e-*.png. Exit code 1 on failure.
//
// Software rendering is slow (seconds per frame at high quality), so most
// checks pause the frame loop and step time with visuals.debug.advance().

const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const { spawn } = require('node:child_process');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const PORT = 5183;
const ROOT = path.resolve(__dirname, '../..');
const SHOTS = process.env.SHOTS || '/tmp/orograph-shots/visual';
const BASE = `http://127.0.0.1:${PORT}/dev/visual/index.html`;
const ARGS = ['--autoplay-policy=no-user-gesture-required', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'];

const failures = [];
const results = {};
const check = (ok, msg) => { console.log((ok ? 'PASS ' : 'FAIL ') + msg); if (!ok) failures.push(msg); };

function ping() {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: PORT, path: '/dev/visual/index.html', timeout: 1500 }, (res) => { res.resume(); resolve(res.statusCode === 200); });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

async function waitFor(fn, ms, what) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await fn()) return;
    await new Promise(r => setTimeout(r, 250));
  }
  throw new Error('timed out waiting for ' + what);
}

async function open(browser, query, contextOpts = {}) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1, ...contextOpts });
  const page = await context.newPage();
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  await page.goto(`${BASE}?panel=0&${query}`);
  await page.waitForFunction(() => window.__vis && window.__vis.ready, null, { timeout: 90000 });
  return { context, page, errors };
}

const center = (page, part = 0) => page.evaluate((p) => [
  window.__vis.store.get(`parts.${p}.params.centerX`), window.__vis.store.get(`parts.${p}.params.centerY`)], part);
const torus = (a, b) => { const d = a - b; return Math.abs(d - Math.round(d)); };
const shot = (page, name) => page.screenshot({ path: `${SHOTS}/e2e-${name}.png`, timeout: 180000 });
const advance = (page, s) => page.evaluate((s) => window.__vis.visuals.debug.advance(s), s);

async function desktop(browser) {
  const { context, page, errors } = await open(browser, 'quality=high');
  const boot = await page.evaluate(() => window.__vis.bootMs);
  results.bootMs = Math.round(boot);
  check(boot < 20000, `harness boots (createVisuals ${Math.round(boot)} ms in software GL)`);
  await page.evaluate(() => window.__vis.visuals.debug.pause());

  // Canvas semantics
  const a11y = await page.evaluate(() => {
    const c = window.__vis.visuals.canvas;
    return { role: c.getAttribute('role'), label: c.getAttribute('aria-label') || '', tab: c.tabIndex };
  });
  check(a11y.role === 'application' && a11y.label.length > 40 && a11y.tab === 0, 'canvas has role=application, an aria-label and is focusable');

  // Dark theme, orbit + top, high quality
  let st = await advance(page, 2);
  check(st.themeT === 0, 'starts in the dark theme');
  await shot(page, 'dark-orbit-high');
  results.drawCalls = st.drawCalls; results.triangles = st.triangles;
  await page.evaluate(() => window.__vis.visuals.setView('top'));
  st = await advance(page, 1.5);
  check(st.view === 'top', 'setView("top") animates to the top view');
  await shot(page, 'dark-top-high');
  check(await page.evaluate(() => window.__vis.store.get('ui.view')) === 'top', 'setView keeps ui.view in step');

  // Light theme
  await page.evaluate(() => { window.__setTheme('light'); window.__vis.visuals.setView('orbit'); });
  st = await advance(page, 1.5);
  check(st.themeT === 1, `theme change reaches the light look (themeT ${st.themeT})`);
  await shot(page, 'light-orbit-high');
  await page.evaluate(() => window.__vis.visuals.setView('top'));
  await advance(page, 1.5);
  await shot(page, 'light-top-high');
  await page.evaluate(() => window.__vis.visuals.setView('low'));
  await advance(page, 1.5);
  await shot(page, 'light-low-high');

  // Render styles (medium quality keeps this quick)
  await page.evaluate(() => { window.__setTheme('dark'); window.__vis.store.set('ui.quality', 'medium'); window.__vis.visuals.setView('orbit'); });
  for (const style of ['wire', 'contour', 'heat']) {
    await page.evaluate((s) => window.__vis.store.set('ui.renderStyle', s), style);
    await advance(page, 1.2);
    await shot(page, `dark-${style}`);
  }
  await page.evaluate(() => window.__vis.store.set('ui.renderStyle', 'relief'));
  await advance(page, 0.5);

  // Click the land: the dot glides to exactly the clicked spot.
  const target = { u: 0.71, v: 0.33 };
  const pt = await page.evaluate((t) => window.__vis.visuals.debug.project(t.u, t.v), target);
  await page.mouse.click(pt.x, pt.y);
  await advance(page, 1);
  let c = await center(page);
  const clickErr = Math.hypot(torus(c[0], target.u), torus(c[1], target.v));
  results.clickError = +clickErr.toFixed(5);
  check(clickErr < 0.006, `click places the dot at the clicked spot (${c.map(v => v.toFixed(4))} vs ${target.u}, ${target.v}; error ${clickErr.toFixed(5)})`);
  await shot(page, 'dark-after-click');

  // Drag the dot itself to another spot; it follows the pointer exactly.
  const dot = await page.evaluate(() => { const d = window.__vis.visuals.debug.dot(); return window.__vis.visuals.debug.project(d.u, d.v); });
  const dst = { u: 0.45, v: 0.6 };
  const dp = await page.evaluate((t) => window.__vis.visuals.debug.project(t.u, t.v), dst);
  await page.mouse.move(dot.x, dot.y);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) {
    await page.mouse.move(dot.x + (dp.x - dot.x) * i / 10, dot.y + (dp.y - dot.y) * i / 10);
    await advance(page, 1 / 30);
  }
  await page.mouse.up();
  await advance(page, 0.3);
  c = await center(page);
  const dragErr = Math.hypot(torus(c[0], dst.u), torus(c[1], dst.v));
  results.dragError = +dragErr.toFixed(4);
  check(dragErr < 0.03, `dragging the dot moves it with the pointer (${c.map(v => v.toFixed(3))} vs ${dst.u}, ${dst.v})`);

  // Keyboard: arrows nudge (Shift = fine).
  await page.focus('canvas.og-canvas');
  const k0 = await center(page);
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Shift+ArrowDown');
  const k1 = await center(page);
  check(Math.abs(torus(k1[0], k0[0]) - 0.01) < 1e-6 && Math.abs(torus(k1[1], k0[1]) - 0.0025) < 1e-6, `arrow keys nudge the dot (${k0.map(v => v.toFixed(4))} -> ${k1.map(v => v.toFixed(4))})`);

  // Roll: the marble rolls downhill (Rapier, lazily loaded).
  await page.evaluate(() => { window.__vis.store.set('parts.0.params.centerX', 0.31, { source: 'ui' }); window.__vis.store.set('parts.0.params.centerY', 0.27, { source: 'ui' }); window.__vis.store.set('parts.0.dot.mode', 1, { source: 'ui' }); });
  await page.waitForFunction(() => window.__vis.visuals.debug.stats().physics[0] === 'rapier', null, { timeout: 30000 }).catch(() => {});
  const r0 = await center(page);
  st = await advance(page, 2);
  const r1 = await center(page);
  const rolled = Math.hypot(torus(r1[0], r0[0]), torus(r1[1], r0[1]));
  results.rollEngine = st.physics[0];
  results.rollDistance2s = +rolled.toFixed(4);
  check(st.physics[0] === 'rapier', `Roll mode uses Rapier (${st.physics[0]})`);
  check(rolled > 0.01, `Roll mode: the marble moved ${rolled.toFixed(3)} in 2 s`);
  await shot(page, 'dark-roll');

  // Drift on a part that is not selected writes its centre too.
  const d0 = await page.evaluate(() => { window.__vis.store.set('parts.2.dot.mode', 2, { source: 'ui' }); window.__vis.store.set('parts.2.dot.driftSpeed', 1, { source: 'ui' }); return [window.__vis.store.get('parts.2.params.centerX'), window.__vis.store.get('parts.2.params.centerY')]; });
  await advance(page, 2);
  const d1 = await center(page, 2);
  const drifted = Math.hypot(torus(d1[0], d0[0]), torus(d1[1], d0[1]));
  check(drifted > 0.02, `Drift moves an unselected part (${drifted.toFixed(3)} in 2 s)`);

  // Part switch: the view follows the selected part.
  await page.evaluate(() => window.__vis.store.set('ui.selectedPart', 1));
  st = await advance(page, 1);
  check(st.selectedPart === 1, 'selecting another part swaps the map to it');
  await shot(page, 'dark-part2');

  // Idle auto-rotate kicks in after a few quiet seconds.
  await page.evaluate(() => window.__vis.visuals.setView('orbit'));
  st = await advance(page, 8);
  check(st.autoRotate === true, 'gentle auto-rotate starts when idle in the orbit view');

  // Frame rate with the real loop running (software GL: only a sanity check).
  for (const q of ['low', 'medium', 'high']) {
    await page.evaluate((q) => { window.__vis.store.set('ui.quality', q); window.__vis.visuals.debug.resume(); }, q);
    await page.waitForTimeout(1500);                       // settle after the switch
    await page.evaluate(() => window.__vis.visuals.debug.resetStats());
    await page.waitForTimeout(q === 'high' ? 12000 : 8000);
    const s = await page.evaluate(() => window.__vis.visuals.debug.stats());
    results[`fps_${q}_1280x800`] = +s.fpsAvg.toFixed(2);
    results[`jsMsPerFrame_${q}`] = +s.cpuMsPerFrame.toFixed(1);
    check(s.frames > 0 && s.cpuMsPerFrame < 4000, `${q}: ${s.fpsAvg.toFixed(2)} fps over ${s.frames} frames, ${s.cpuMsPerFrame.toFixed(1)} ms of main-thread time per frame (software GL)`);
    await page.evaluate(() => window.__vis.visuals.debug.pause());
  }

  check(errors.length === 0, 'desktop: no console errors' + (errors.length ? '\n  ' + errors.slice(0, 6).join('\n  ') : ''));
  await context.close();
}

async function reducedMotion(browser) {
  const { context, page, errors } = await open(browser, 'quality=low', { reducedMotion: 'reduce', viewport: { width: 800, height: 500 } });
  await page.evaluate(() => window.__vis.visuals.debug.pause());
  const st = await advance(page, 8);
  check(st.reducedMotion === true && st.autoRotate === false, 'prefers-reduced-motion: no auto-rotate');
  check(errors.length === 0, 'reduced motion: no console errors' + (errors.length ? '\n  ' + errors.join('\n  ') : ''));
  await context.close();
}

async function phone(browser) {
  const { context, page, errors } = await open(browser, 'quality=medium', { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  await page.evaluate(() => window.__vis.visuals.debug.pause());
  await advance(page, 2);
  await shot(page, 'phone-dark');
  await page.evaluate(() => window.__setTheme('light'));
  await advance(page, 1.5);
  await shot(page, 'phone-light');
  const target = { u: 0.62, v: 0.71 };
  const pt = await page.evaluate((t) => window.__vis.visuals.debug.project(t.u, t.v), target);
  await page.touchscreen.tap(pt.x, pt.y);
  await advance(page, 1);
  const c = await center(page);
  const err = Math.hypot(torus(c[0], target.u), torus(c[1], target.v));
  check(err < 0.01, `phone: a tap places the dot (${c.map(v => v.toFixed(3))}, error ${err.toFixed(4)})`);
  const hud = await page.evaluate(() => {
    const m = document.querySelector('.og-hud-minimap');
    const r = m.getBoundingClientRect();
    return { w: r.width, right: r.right, vw: innerWidth, overflow: document.documentElement.scrollWidth > innerWidth + 1 };
  });
  check(hud.w >= 80 && hud.w <= 140 && hud.right <= hud.vw && !hud.overflow, `phone: minimap fits (${hud.w}px) and nothing overflows`);
  check(errors.length === 0, 'phone: no console errors' + (errors.length ? '\n  ' + errors.join('\n  ') : ''));
  await context.close();
}

(async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  let vite = null;
  if (!(await ping())) {
    vite = spawn('npx', ['vite', '--config', 'dev/visual/vite.config.mjs', '--port', String(PORT), '--strictPort'], { cwd: ROOT, stdio: 'ignore', detached: true });
    await waitFor(ping, 40000, 'vite on ' + PORT);
  }
  const browser = await chromium.launch({ args: ARGS });
  try {
    for (const run of [desktop, reducedMotion, phone]) {
      try { await run(browser); } catch (e) { check(false, `${run.name}: crashed: ${e.message}`); }
    }
  } finally {
    await browser.close();
    if (vite) { try { process.kill(-vite.pid); } catch { /* already gone */ } }
  }
  console.log('\nresults ' + JSON.stringify(results));
  console.log(failures.length ? `\n${failures.length} failure(s)` : '\nall checks passed');
  process.exit(failures.length ? 1 : 0);
})();
