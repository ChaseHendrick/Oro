// Exercises the complete built app with a generated MediaStream in place of hardware.
// Works with a hosted web build and with the standalone offline HTML file.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || '/opt/node22/lib/node_modules/playwright');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const path = require('node:path');
const target = process.argv[2] || pathToFileURL(path.resolve('dist-single/index.html')).href;

(async () => {
  const { strum } = await import('../pedals/signals.js');
  const signal = Array.from(strum([48, 52, 55], { sampleRate: 48000, start: 0.1, duration: 1.6, spread: 0.012 }));
  const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(target);
    await page.waitForFunction(() => window.orograph?.store);
    await page.getByRole('button', { name: /Start/ }).first().click();
    await page.waitForSelector('.start-card', { state: 'hidden' });
    await page.evaluate(() => window.orograph.ui.openSettings('pedals'));
    await page.getByRole('button', { name: 'Guitar plays notes', exact: true }).click();
    await page.getByRole('radio', { name: 'Chords', exact: true }).click();
    const result = await page.evaluate(async data => {
      const o = window.orograph;
      const ctx = o.engine.context;
      const destination = ctx.createMediaStreamDestination();
      const original = navigator.mediaDevices.getUserMedia;
      navigator.mediaDevices.getUserMedia = async () => destination.stream;
      const buffer = ctx.createBuffer(1, data.length, 48000);
      buffer.copyToChannel(Float32Array.from(data), 0);
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(destination);
      const events = [];
      const off = o.engine.pedals.on('guitarNote', e => events.push({ ...e }));
      try {
        await o.engine.pedals.setReturn({ enabled: true, layout: 'stereo', level: 0 });
        await o.engine.pedals.setGuitar({ notes: true, guitarMode: 'chords', channel: 0, gateDb: -50 });
        source.start(ctx.currentTime + 0.15);
        const end = ctx.currentTime + 1.1;
        const wall = performance.now();
        while (ctx.currentTime < end && performance.now() - wall < 10000) await new Promise(r => setTimeout(r, 20));
        const heard = [...new Set(events.filter(e => e.type === 'noteOn').map(e => e.note))].sort((a, b) => a - b);
        const held = [...o.music.router.heldNotes('sel')].sort((a, b) => a - b);
        await o.engine.pedals.setReturn({ enabled: false });
        const remaining = [...o.music.router.heldNotes('sel')];
        const driverRemaining = o.ui.ctx.pedals.status().guitar.notes.soundingNotes;
        const stopped = events.some(e => e.type === 'stop');
        return { heard, held, remaining, driverRemaining, stopped, sampleRate: ctx.sampleRate };
      } finally {
        off();
        try { source.stop(); } catch {}
        source.disconnect();
        navigator.mediaDevices.getUserMedia = original;
      }
    }, signal);
    assert.deepEqual(result.heard, [48, 52, 55], 'built app detects the generated triad');
    assert.deepEqual(result.held, result.heard, 'the real note router holds the full chord');
    assert.equal(result.stopped, true, 'closing the return notifies the note driver');
    assert.deepEqual(result.remaining, [], 'closing the return releases routed notes');
    assert.deepEqual(result.driverRemaining, [], 'closing the return clears the driver');
    assert.deepEqual(errors, [], 'no browser errors');
    console.log('PASS built app chord input and return close', JSON.stringify(result));
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
