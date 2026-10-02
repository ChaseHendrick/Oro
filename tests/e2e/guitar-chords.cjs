// Real Web Audio tracking, router output and mode changes with generated input.
// PLAYWRIGHT_MODULE can point to a local Playwright install on another machine.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || '/opt/node22/lib/node_modules/playwright');
const assert = require('node:assert/strict');
const target = process.argv[2] || 'http://127.0.0.1:5190/';

(async () => {
  const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(target);
    await page.waitForFunction(() => window.orograph?.store);
    await page.getByRole('button', { name: /Start/ }).first().click();
    await page.waitForSelector('.start-card', { state: 'hidden' });

    const results = await page.evaluate(async () => {
      const o = window.orograph;
      const { createGuitarInput } = await import('/src/pedals/guitar.js');
      const { createGuitarNotes } = await import('/src/pedals/guitar-notes.js');
      const { loadPedalWorklets } = await import('/src/pedals/worklet-loader.js');
      const { strum } = await import('/tests/pedals/signals.js');
      const sleep = ms => new Promise(r => setTimeout(r, ms));
      const out = [];
      for (const worklet of [true, false]) {
        // A separate context guarantees the second path has no loaded processors.
        const ctx = new AudioContext({ sampleRate: 48000 });
        await ctx.resume();
        if (worklet) {
          const loaded = await loadPedalWorklets(ctx);
          if (!loaded.ok) throw new Error('Worklet failed: ' + loaded.reason);
        }
        const input = ctx.createGain();
        const guitar = createGuitarInput(ctx, input, { guitarMode: 'chords' });
        if (guitar.via !== (worklet ? 'worklet' : 'script')) throw new Error('Wrong audio path: ' + guitar.via);
        const driver = createGuitarNotes({ store: o.store, router: o.music.router, engine: o.engine });
        driver.configure({ enabled: true, guitarMode: 'chords', target: 'sel' });
        const events = [];
        for (const type of ['noteOn', 'noteOff', 'bend', 'level']) guitar.on(type, e => {
          driver.handle({ ...e, type });
          if (type !== 'level') events.push({ ...e, type });
        });
        const signal = strum([48, 52, 55], { sampleRate: ctx.sampleRate, start: 0.1, duration: 1.4, spread: 0.012 });
        const buffer = ctx.createBuffer(1, signal.length, ctx.sampleRate);
        buffer.copyToChannel(signal, 0);
        const src = ctx.createBufferSource();
        src.buffer = buffer;
        src.connect(input);
        src.start(ctx.currentTime + 0.1);
        const until = ctx.currentTime + 0.8;
        while (ctx.currentTime < until) await sleep(20);
        const heard = [...new Set(events.filter(e => e.type === 'noteOn').map(e => e.note))].sort((a, b) => a - b);
        const a = o.engine.analyser;
        const samples = new Float32Array(a.fftSize);
        a.getFloatTimeDomainData(samples);
        let peak = 0;
        for (const x of samples) { if (!Number.isFinite(x)) throw new Error('Non-finite synth output'); peak = Math.max(peak, Math.abs(x)); }
        const analysisMode = guitar.chordAnalysisMode;
        const analysisDropouts = guitar.analysisDropouts;
        // Switching while the chord rings must release all old notes at once.
        guitar.configure({ guitarMode: 'single' });
        const switchUntil = ctx.currentTime + 0.05;
        while (ctx.currentTime < switchUntil) await sleep(10);
        const offs = [...new Set(events.filter(e => e.type === 'noteOff').map(e => e.note))].sort((a, b) => a - b);
        driver.dispose();
        guitar.dispose();
        try { src.stop(); } catch {}
        await ctx.close();
        out.push({ path: worklet ? 'worklet' : 'fallback', heard, offs, peak, analysisMode, analysisDropouts });
      }
      o.ui.openSettings('pedals');
      return out;
    });
    for (const r of results) {
      assert.equal(r.analysisMode, 'worker', `${r.path}: chord analysis uses Worker`);
      assert.equal(r.analysisDropouts, 0, `${r.path}: no dropped analysis blocks`);
      assert.deepEqual(r.heard, [48, 52, 55], `${r.path}: known C major triad`);
      assert.deepEqual(r.offs, r.heard, `${r.path}: mode switch releases every chord note`);
      assert(r.peak > 0.001 && r.peak <= 1.001, `${r.path}: finite audible synth output`);
      console.log('PASS', JSON.stringify(r));
    }
    await page.getByRole('button', { name: 'Guitar plays notes', exact: true }).click();
    await page.getByRole('radio', { name: 'Chords', exact: true }).click();
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('orograph.pedals')).guitarMode), 'chords');
    await page.reload();
    await page.waitForFunction(() => window.orograph?.store);
    await page.evaluate(() => window.orograph.ui.openSettings('pedals'));
    assert.equal(await page.getByRole('radio', { name: 'Chords', exact: true }).getAttribute('aria-checked'), 'true');
    assert.deepEqual(errors, [], 'no browser errors');
    console.log('PASS Chords setting persists across reload');
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
