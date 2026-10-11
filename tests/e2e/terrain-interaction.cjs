// Focused regression check of the real map pointer lifecycle. Run against a
// local dev/build app, or the dev/visual harness. This verifies coordinates,
// physics and touch events; it does not verify the sound by listening.
// PLAYWRIGHT_MODULE=/absolute/path/to/playwright node tests/e2e/terrain-interaction.cjs http://127.0.0.1:5173/
const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || '/opt/node22/lib/node_modules/playwright');
const URL_ = process.argv[2] || 'http://127.0.0.1:5193/dev/visual/index.html?panel=0&play=0&tele=0&music=0';
const torus = (a, b) => Math.abs((a - b) - Math.round(a - b));

(async () => {
  const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(URL_);
    await page.waitForFunction(() => (window.orograph || window.__vis)?.visuals, null, { timeout: 60000 });
    const start = page.locator('[data-action="start"], .og-start button, button:has-text("Start")').first();
    if (await start.count()) await start.click();
    await page.waitForSelector('.start-card', { state: 'hidden', timeout: 20000 });
    await page.evaluate(() => {
      const o = window.__terrainTest = window.orograph || window.__vis;
      o.music?.transport?.stop();
      o.store.set('ui.autoRotate', 0);
      o.store.set('ui.quality', 'low');
      o.visuals.setView('top', false);
      o.visuals.debug.pause();
      window.__terrainTouches = [];
      o.visuals.on('touch', ev => window.__terrainTouches.push(ev));
      o.visuals.debug.advance(0.8);
    });
    const prepare = async (mode, part = 0) => page.evaluate(([mode, part]) => {
      const o = window.__terrainTest;
      o.store.set('ui.selectedPart', part);
      o.store.set('ui.touchMode', mode);
      o.store.set(`parts.${part}.dot.mode`, 0);
      o.store.set(`parts.${part}.params.centerX`, 0.5);
      o.store.set(`parts.${part}.params.centerY`, 0.5);
      o.visuals.debug.advance(0.8);
      window.__terrainTouches.length = 0;
    }, [mode, part]);
    const point = (u, v) => page.evaluate(([u, v]) => window.__terrainTest.visuals.debug.project(u, v), [u, v]);
    const readTouches = () => page.evaluate(() => window.__terrainTouches);
    const pressAt = async (u = 0.22, v = 0.3) => {
      const p = await point(u, v);
      await page.mouse.move(p.x, p.y);
      await page.mouse.down();
      return p;
    };
    const assertRelease = async (mode, part = 0) => {
      const es = await readTouches();
      assert.equal(es[0]?.phase, 'down');
      assert.equal(es.at(-1)?.phase, 'up');
      assert.ok(es.every(e => e.mode === mode && e.part === part));
      assert.equal(es.filter(e => e.phase === 'up').length, 1);
      return es;
    };

    for (const mode of ['strum', 'fx']) {
      await prepare(mode);
      await pressAt();
      const to = await point(0.75, 0.7);
      await page.mouse.move(to.x, to.y, { steps: 5 });
      await page.mouse.up();
      const es = await assertRelease(mode);
      assert.ok(es.some(e => e.phase === 'move'));
      assert.ok(es.some(e => Math.abs(e.u - es[0].u) > 0.05));
      console.log(`PASS actual pointer ${mode} click/drag/release (${es.length} touch events)`);
    }

    await prepare('strum');
    await pressAt();
    await page.evaluate(() => window.__terrainTest.store.set('ui.touchMode', 'fx'));
    await page.mouse.up();
    await assertRelease('strum');
    console.log('PASS mode change releases initiating Strum gesture once');

    await prepare('fx');
    await pressAt();
    await page.evaluate(() => window.__terrainTest.store.set('ui.selectedPart', 1));
    await page.mouse.up();
    await assertRelease('fx', 0);
    console.log('PASS track selection releases FX on its original track');

    for (const change of ['reorder', 'remove']) {
      await prepare('fx');
      await pressAt();
      const before = await readTouches();
      await page.evaluate(change => {
        const o = window.__terrainTest, parts = o.store.get('parts');
        window.__terrainParts = parts;
        o.store.set('parts', change === 'reorder' ? [parts[1], parts[0], ...parts.slice(2)] : parts.slice(1), { source: 'tracks' });
      }, change);
      await page.mouse.up();
      const es = await readTouches(), up = es.at(-1);
      assert.equal(up.phase, 'up');
      assert.equal(up.trackId, before[0].trackId);
      assert.equal(up.part, change === 'reorder' ? 1 : -1);
      assert.equal(es.filter(e => e.phase === 'up').length, 1);
      await page.evaluate(() => window.__terrainTest.store.set('parts', window.__terrainParts, { source: 'tracks' }));
      console.log(`PASS track ${change} ends FX with its stable track ID and current slot`);
    }

    for (const how of ['window blur', 'canvas blur', 'pointer cancel', 'map covered', 'waypoint editing']) {
      await prepare('fx');
      await pressAt();
      await page.evaluate(how => {
        const o = window.__terrainTest;
        if (how === 'window blur') window.dispatchEvent(new Event('blur'));
        else if (how === 'canvas blur') o.visuals.canvas.blur();
        else if (how === 'pointer cancel') window.dispatchEvent(new PointerEvent('pointercancel', { pointerId: 1, pointerType: 'mouse' }));
        else if (how === 'waypoint editing') o.store.set('ui.editWaypoints', 1);
        else o.visuals.setCovered(true);
      }, how);
      await page.mouse.up();
      await assertRelease('fx');
      await page.evaluate(() => { const o = window.__terrainTest; o.visuals.setCovered(false); o.store.set('ui.editWaypoints', 0); });
      console.log(`PASS ${how} releases FX once`);
    }

    await prepare('move');
    await page.evaluate(() => window.__terrainTest.store.set('parts.0.dot.mode', 1));
    let engines = new Set();
    for (const [u, v] of [[0.22, 0.3], [0.78, 0.72]]) {
      await pressAt(u, v);
      const dropped = await page.evaluate(() => { const o = window.__terrainTest; o.visuals.debug.advance(0.64); return o.visuals.debug.simulation(0); });
      await page.mouse.up();
      assert.ok(torus(dropped.u, u) < 0.02 && torus(dropped.v, v) < 0.02, JSON.stringify({ dropped, target: [u, v] }));
      const rolled = await page.evaluate(() => { const o = window.__terrainTest; o.visuals.debug.advance(1.4); return o.visuals.debug.simulation(0); });
      engines.add(rolled.engine);
      assert.equal(rolled.held, false);
      assert.ok(Math.hypot(torus(rolled.u, dropped.u), torus(rolled.v, dropped.v)) > 0.0001);
      console.log(`PASS drop at ${u},${v}, then free terrain motion (${rolled.engine})`);
    }

    await page.evaluate(() => {
      const o = window.__terrainTest;
      o.store.set('parts.0.params.centerX', 0.28);
      o.store.set('parts.0.params.centerY', 0.32);
      o.visuals.debug.advance(0.8);
    });
    const ball = await page.evaluate(() => window.__terrainTest.visuals.debug.dotScreen());
    await page.mouse.move(ball.x, ball.y);
    await page.mouse.down();
    assert.equal(await page.evaluate(() => window.__terrainTest.visuals.debug.simulation(0).held), true);
    const other = await page.evaluate(() => {
      const s = window.__terrainTest.store;
      return [s.get('parts.1.params.centerX'), s.get('parts.1.params.centerY')];
    });
    await page.evaluate(() => window.__terrainTest.store.set('ui.selectedPart', 1));
    await page.mouse.up();
    const switched = await page.evaluate(() => {
      const o = window.__terrainTest;
      return { old: o.visuals.debug.simulation(0), other: [o.store.get('parts.1.params.centerX'), o.store.get('parts.1.params.centerY')] };
    });
    assert.equal(switched.old.held, false);
    assert.deepEqual(switched.other, other);
    console.log('PASS track switch releases old marble without changing new track coordinates');

    // Loading a session during a held drag must keep its incoming coordinates.
    await prepare('move');
    await page.evaluate(() => { const o = window.__terrainTest; o.store.set('parts.0.dot.mode', 1); o.visuals.debug.advance(0.1); });
    const ball2 = await page.evaluate(() => window.__terrainTest.visuals.debug.dotScreen());
    await page.mouse.move(ball2.x, ball2.y);
    await page.mouse.down();
    assert.equal(await page.evaluate(() => window.__terrainTest.visuals.debug.simulation(0).held), true);
    const loaded = await page.evaluate(() => {
      const o = window.__terrainTest, s = o.store.serialize();
      s.parts[0].params.centerX = 0.17; s.parts[0].params.centerY = 0.81;
      o.store.load(s, { source: 'load', replaceTracks: true });
      return { u: o.store.get('parts.0.params.centerX'), v: o.store.get('parts.0.params.centerY'), held: o.visuals.debug.simulation(0).held };
    });
    await page.mouse.up();
    assert.deepEqual(loaded, { u: 0.17, v: 0.81, held: false });
    console.log('PASS session load during a drag preserves incoming coordinates and releases marble');

    await prepare('fx');
    await pressAt();
    await page.evaluate(() => window.__terrainTest.visuals.dispose());
    await page.mouse.up();
    await assertRelease('fx');
    console.log('PASS disposing the map releases FX before removing listeners');
    assert.deepEqual(errors, []);
    console.log(`PASS no page errors; physics exercised: ${[...engines].join(', ')}. Touch events verified; no listening test.`);
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
