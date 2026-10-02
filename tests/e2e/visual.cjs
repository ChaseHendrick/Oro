// End-to-end check of the 3D map in headless Chromium (software WebGL).
//   node tests/e2e/visual.cjs            (PORT=5193 by default; set PORT to change)
// Starts vite on the port (dev/visual/vite.config.mjs) unless something
// already answers there, opens the visuals harness (dev/visual/index.html,
// real visuals + real store + fake engine + fake music) and checks: no console
// errors, screenshots in both themes and three views, click-to-place lands
// where the pointer was, dragging the dot, arrow-key nudges, Roll mode moves
// the marble, Drift moves a part that is not selected, reduced motion stops
// auto-rotate, a phone-sized viewport with a tap, and frame times.
// Round D: Explore notes ('extremum' events) and marble telemetry, store
// write tags (physics vs a person), Tour through waypoints, editing waypoints
// on the map (click / drag / right-click / cap of 8), dot-lock badges that
// flash on their step, Shift / Alt / wheel / bracket gestures, the base and
// per-voice orbits, the camera floor, and the Points style.
// Screenshots: /tmp/orograph-shots/visual/e2e-*.png. Exit code 1 on failure.
//
// Software rendering is slow (seconds per frame at high quality), so most
// checks pause the frame loop and step time with visuals.debug.advance().

const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const { spawn } = require('node:child_process');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const PORT = Number(process.env.PORT) || 5193;
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
const shot = (page, name) => page.screenshot({ path: `${SHOTS}/e2e-${name}.png`, timeout: 300000 });
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
    // Software GL on a shared box: only a sanity check that frames keep coming.
    check(s.frames > 0 && s.cpuMsPerFrame < 20000, `${q}: ${s.fpsAvg.toFixed(2)} fps over ${s.frames} frames, ${s.cpuMsPerFrame.toFixed(1)} ms of main-thread time per frame (software GL)`);
    await page.evaluate(() => window.__vis.visuals.debug.pause());
  }

  check(errors.length === 0, 'desktop: no console errors' + (errors.length ? '\n  ' + errors.slice(0, 6).join('\n  ') : ''));
  await context.close();
}

async function roundD(browser) {
  const { context, page, errors } = await open(browser, 'quality=low&play=0', { viewport: { width: 960, height: 600 } });
  const ev = (f, a) => page.evaluate(f, a);
  const adv = (s, step) => ev(([s, step]) => window.__vis.visuals.debug.advance(s, step), [s, step || 1 / 30]);
  await ev(() => { const v = window.__vis.visuals; v.debug.pause(); v.setView('top', false); v.debug.advance(1); });
  const P = (k) => ev((k) => window.__vis.store.get('parts.0.params.' + k), k);

  // ---- events API
  const api = await ev(() => {
    const v = window.__vis.visuals;
    let n = 0;
    const off = v.on('extremum', () => n++);
    const ok = typeof off === 'function' && typeof v.off === 'function' && typeof v.setMusic === 'function';
    off();
    return { ok, styles: typeof v.setRenderStyle, pal: v.palettes().length };
  });
  check(api.ok && api.styles === 'function' && api.pal >= 4, 'visuals.on/off/setMusic, setRenderStyle and palettes() exist');

  // ---- Explore: notes at peaks and valleys, marble telemetry, physics tags
  const ex = await ev(() => {
    const s = window.__vis.store, v = window.__vis.visuals;
    const metas = new Set();
    const off = s.subscribe('parts.0.params', (p, val, m) => { if (/center/.test(p)) metas.add(JSON.stringify(m)); });
    s.set('parts.0.dot.exploreRate', 0.9, { source: 'ui' });
    s.set('parts.0.dot.mode', 3, { source: 'ui' });
    const n0 = window.__vis.events.length, m0 = window.__vis.engine.marbles[0].n;
    v.debug.advance(15, 1 / 30);
    off();
    const evs = window.__vis.events.slice(n0);
    const m = window.__vis.engine.marbles[0];
    return {
      n: evs.length, kinds: [...new Set(evs.map(e => e.kind))], parts: [...new Set(evs.map(e => e.part))],
      ranges: evs.every(e => e.height >= -1 && e.height <= 1 && e.x >= 0 && e.x < 1 && e.y >= 0 && e.y < 1),
      marbles: m.n - m0, speed: m.speed, height: m.height, metas: [...metas], engine: v.debug.stats().physics[0],
      notes: window.__vis.music.notes.length,
    };
  });
  results.exploreEvents15s = ex.n;
  check(ex.n >= 4 && ex.kinds.includes('peak') && ex.kinds.includes('valley') && ex.ranges && ex.parts.join() === '0',
    `Explore: ${ex.n} peak/valley events in 15 s (${ex.kinds.join(', ')}), heights and spots in range`);
  check(ex.marbles >= 380 && ex.marbles <= 520 && ex.speed >= 0 && ex.speed <= 1 && ex.height >= -1 && ex.height <= 1,
    `Explore: engine.marble() about 30 times a second (${ex.marbles} in 15 s, last speed ${ex.speed.toFixed(2)}, height ${ex.height.toFixed(2)})`);
  check(ex.metas.length === 1 && ex.metas[0] === '{"source":"physics","user":false}', `simulated moves are tagged physics (${ex.metas.join(' ')})`);
  await shot(page, 'explore-top');

  // ---- a person's drag is tagged visual + user
  await ev(() => { const s = window.__vis.store; s.set('parts.0.dot.mode', 0, { source: 'ui' }); s.set('parts.0.params.centerX', 0.5, { source: 'ui' }); s.set('parts.0.params.centerY', 0.5, { source: 'ui' }); window.__vis.visuals.debug.advance(0.5); });
  await ev(() => { window.__metas = new Set(); window.__offM = window.__vis.store.subscribe('parts.0.params', (p, v, m) => { if (/center/.test(p)) window.__metas.add(JSON.stringify(m)); }); });
  let d = await ev(() => window.__vis.visuals.debug.dotScreen());
  await page.mouse.move(d.x, d.y); await page.mouse.down();
  for (let i = 1; i <= 5; i++) { await page.mouse.move(d.x + i * 10, d.y + i * 6); await adv(1 / 30); }
  await page.mouse.up();
  const dragMetas = await ev(() => { window.__offM(); return [...window.__metas]; });
  check(dragMetas.length === 1 && dragMetas[0] === '{"source":"visual","user":true}', `a drag is tagged visual + user (${dragMetas.join(' ')})`);

  // ---- gestures on the dot
  await adv(0.3);
  d = await ev(() => window.__vis.visuals.debug.dotScreen());
  const c0 = [await P('centerX'), await P('centerY')];
  const s0 = await P('size');
  await page.keyboard.down('Shift');
  await page.mouse.move(d.x, d.y); await page.mouse.down();
  for (let i = 1; i <= 5; i++) await page.mouse.move(d.x, d.y - i * 8);
  await page.mouse.up();
  await page.keyboard.up('Shift');
  const s1 = await P('size');
  const c1 = [await P('centerX'), await P('centerY')];
  check(s1 > s0 + 0.03 && c1[0] === c0[0] && c1[1] === c0[1], `Shift-drag on the dot sets Size (${s0} -> ${s1}) without moving it`);
  await adv(0.2);
  d = await ev(() => window.__vis.visuals.debug.dotScreen());
  const r0 = await P('rotate');
  await page.keyboard.down('Alt');
  await page.mouse.move(d.x, d.y); await page.mouse.down();
  await page.mouse.move(d.x + 40, d.y);
  for (let i = 1; i <= 9; i++) { const a = (i / 9) * Math.PI / 2; await page.mouse.move(d.x + 40 * Math.cos(a), d.y + 40 * Math.sin(a)); }
  await page.mouse.up();
  await page.keyboard.up('Alt');
  const r1 = await P('rotate');
  const turned = ((r1 - r0) % 360 + 360) % 360;
  check(turned > 80 && turned < 100, `Alt-drag around the dot sets Rotate (${r0} -> ${r1})`);
  await adv(0.2);
  d = await ev(() => window.__vis.visuals.debug.dotScreen());
  const w0 = await P('size');
  const cam0 = await ev(() => window.__vis.visuals.debug.camera());
  await page.mouse.move(d.x, d.y);
  await page.mouse.wheel(0, 100);
  await page.waitForTimeout(150);
  const w1 = await P('size');
  const cam1 = await ev(() => window.__vis.visuals.debug.camera());
  check(w1 < w0 && Math.hypot(cam1.x - cam0.x, cam1.y - cam0.y, cam1.z - cam0.z) < 1e-6, `wheel over the dot sets Size (${w0} -> ${w1}) instead of zooming`);
  await page.focus('canvas.og-canvas');
  const b0 = await P('size');
  await page.keyboard.press(']');
  const b1 = await P('size');
  await page.keyboard.press('[');
  await page.keyboard.press('[');
  const b2 = await P('size');
  check(b1 > b0 && b2 < b1, `[ and ] set Size when the map has focus (${b0} -> ${b1} -> ${b2})`);

  // ---- Tour: editing waypoints on the map, then travelling them
  await ev(() => { const s = window.__vis.store; s.set('parts.0.params.size', 0.2, { source: 'ui' }); s.set('global.tempo', 120, { source: 'ui' }); s.set('parts.0.dot.mode', 4, { source: 'ui' }); s.set('ui.editWaypoints', 1, { source: 'ui' }); window.__vis.visuals.debug.advance(0.3); });
  const spots = [[0.25, 0.3], [0.72, 0.28], [0.7, 0.72], [0.3, 0.7]];
  for (const [u, v] of spots) {
    const pt = await ev(([u, v]) => window.__vis.visuals.debug.project(u, v), [u, v]);
    await page.mouse.click(pt.x, pt.y);
    await adv(0.05);
  }
  let wps = await ev(() => window.__vis.store.get('parts.0.dot.waypoints'));
  const placed = wps.length === 4 && wps.every((w, i) => Math.hypot(torus(w.x, spots[i][0]), torus(w.y, spots[i][1])) < 0.01);
  check(placed, `edit mode: clicks add waypoints where clicked (${wps.map(w => `${w.x.toFixed(2)},${w.y.toFixed(2)}`).join(' ')})`);
  const p2 = await ev(() => window.__vis.visuals.debug.waypoint(1));
  const t2 = await ev(() => window.__vis.visuals.debug.project(0.6, 0.15));
  await page.mouse.move(p2.x, p2.y); await page.mouse.down();
  for (let i = 1; i <= 8; i++) await page.mouse.move(p2.x + (t2.x - p2.x) * i / 8, p2.y + (t2.y - p2.y) * i / 8);
  await page.mouse.up();
  wps = await ev(() => window.__vis.store.get('parts.0.dot.waypoints'));
  check(wps.length === 4 && Math.hypot(torus(wps[1].x, 0.6), torus(wps[1].y, 0.15)) < 0.01, `edit mode: dragging a waypoint moves it (${wps[1].x.toFixed(3)}, ${wps[1].y.toFixed(3)})`);
  await adv(0.5);
  await shot(page, 'tour-edit-dark');
  const p3 = await ev(() => window.__vis.visuals.debug.waypoint(2));
  await page.mouse.click(p3.x, p3.y, { button: 'right' });
  wps = await ev(() => window.__vis.store.get('parts.0.dot.waypoints'));
  check(wps.length === 3, `edit mode: right-click deletes a waypoint (${wps.length} left)`);
  for (let i = 0; i < 7; i++) {
    const pt = await ev((i) => window.__vis.visuals.debug.project(0.08 + i * 0.12, 0.5), i);
    await page.mouse.click(pt.x, pt.y);
  }
  wps = await ev(() => window.__vis.store.get('parts.0.dot.waypoints'));
  check(wps.length === 8, `edit mode: at most 8 waypoints (${wps.length})`);
  const tour = await ev(() => {
    const s = window.__vis.store, v = window.__vis.visuals;
    s.set('ui.editWaypoints', 0, { source: 'ui' });
    s.set('parts.0.dot.waypoints', [{ x: 0.25, y: 0.3, beats: 1 }, { x: 0.72, y: 0.28, beats: 1 }, { x: 0.7, y: 0.72, beats: 2 }], { source: 'ui' });
    s.set('parts.0.dot.mode', 0, { source: 'ui' });
    s.set('parts.0.dot.mode', 4, { source: 'ui' });
    v.debug.advance(1, 1 / 60);                    // 2 beats at 120 bpm: on waypoint 3
    const a = [s.get('parts.0.params.centerX'), s.get('parts.0.params.centerY')];
    v.debug.advance(1.5, 1 / 60);                  // 5 beats: one loop (4) + 1 -> waypoint 2
    const b = [s.get('parts.0.params.centerX'), s.get('parts.0.params.centerY')];
    return { a, b, m: v.debug.markers(), engine: v.debug.stats().physics[0] };
  });
  const ea = Math.hypot(torus(tour.a[0], 0.7), torus(tour.a[1], 0.72)), eb = Math.hypot(torus(tour.b[0], 0.72), torus(tour.b[1], 0.28));
  check(tour.engine === 'tour' && ea < 0.02 && eb < 0.02, `Tour lands on its waypoints on the beat (errors ${ea.toFixed(4)}, ${eb.toFixed(4)})`);
  check(tour.m.waypoints === 3 && tour.m.route > 40, `Tour shows numbered pins and the dashed route (${tour.m.waypoints} pins, ${tour.m.route} route points)`);

  // ---- dot locks: badges, and a flash when the sequencer plays a locked step
  const locks = await ev(async () => {
    const s = window.__vis.store, v = window.__vis.visuals, m = window.__vis.music;
    s.set('parts.0.dot.mode', 0, { source: 'ui' });
    window.__vis.setLocks(s, 0);
    v.debug.advance(0.2);
    let got = null;
    const off = m.transport.on('step', (e) => { if (e.lock && !got) got = e; });
    m.transport.play();
    for (let i = 0; i < 60 && !got; i++) await new Promise(r => setTimeout(r, 50));
    m.transport.stop();
    off();
    v.debug.advance(0.05);
    return { m: v.debug.markers(), got };
  });
  check(locks.m.locks === 4 && locks.got && locks.got.lock, `dot-lock badges for the locked steps (${locks.m.locks}) and the step events carry the lock`);
  await shot(page, 'locks-dark');

  // ---- orbits: base orbit under modulation, per-voice orbits with Key>Size
  const orbits = await ev(async () => {
    const s = window.__vis.store, v = window.__vis.visuals;
    s.set('parts.0.seq.enabled', 0, { source: 'ui' });
    window.__vis.engine.setPlaying(true);
    s.set('parts.0.mods.size', { ...s.get('parts.0.mods.size'), lfoDepth: 0.4, lfoRate: 0.3 });
    let base = 0;
    for (let i = 0; i < 4; i++) { await new Promise(r => setTimeout(r, 700)); v.debug.advance(0.5, 1 / 15); if (v.debug.orbits().base) base++; }
    s.set('parts.0.mods.size', { ...s.get('parts.0.mods.size'), lfoDepth: 0 });
    s.set('parts.0.params.noteSize', -0.8, { source: 'ui' });
    let voices = 0;
    for (let i = 0; i < 4; i++) { await new Promise(r => setTimeout(r, 500)); v.debug.advance(0.5, 1 / 15); if (v.debug.orbits().voices) voices++; }
    s.set('parts.0.params.noteSize', 0, { source: 'ui' });
    await new Promise(r => setTimeout(r, 300));
    v.debug.advance(1.5, 1 / 15);
    const after = v.debug.orbits();
    window.__vis.engine.setPlaying(false);
    return { base, voices, after };
  });
  check(orbits.base >= 3, `the thin base orbit shows while an LFO moves Size (${orbits.base} of 4 looks)`);
  check(orbits.voices >= 3 && !orbits.after.voices && !orbits.after.base, `per-voice orbits show when Key>Size makes voices differ, and hide again (${orbits.voices} of 4)`);

  // ---- the camera never goes under the land
  const cam = await ev(() => {
    const v = window.__vis.visuals;
    v.setView('orbit', false);
    v.debug.setCamera(0.4, -3, 4.7);
    v.debug.advance(0.1);
    return v.debug.markers();
  });
  check(cam.cameraClearance >= 0.85 && cam.cameraPolar <= 1.401, `camera stays above the land (clearance ${cam.cameraClearance.toFixed(2)}, polar ${cam.cameraPolar.toFixed(3)})`);

  // ---- Points style, both themes
  await ev(() => { const v = window.__vis.visuals; window.__vis.store.set('ui.renderStyle', 'points'); v.setView('orbit', false); v.debug.advance(1); });
  await shot(page, 'points-dark');
  await ev(() => { window.__setTheme('light'); window.__vis.visuals.debug.advance(1.5); });
  await shot(page, 'points-light');
  await ev(() => { const s = window.__vis.store; s.set('ui.renderStyle', 'relief'); window.__setTheme('light'); window.__vis.setTour(s, 0); window.__vis.setLocks(s, 0); s.set('parts.0.dot.mode', 4, { source: 'ui' }); window.__vis.visuals.setView('top', false); window.__vis.visuals.debug.advance(2); });
  await shot(page, 'tour-locks-light');

  check(errors.length === 0, 'Round D: no console errors' + (errors.length ? '\n  ' + errors.slice(0, 6).join('\n  ') : ''));
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
    const only = process.env.ONLY ? process.env.ONLY.split(',') : null;
    for (const run of [desktop, roundD, reducedMotion, phone]) {
      if (only && !only.includes(run.name)) continue;
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
