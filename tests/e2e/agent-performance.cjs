// Local built-app regression: agent receipts, score persistence, and measured
// audio output. No listening or reference-clip match is claimed.
// PLAYWRIGHT_MODULE=/path/to/playwright node tests/e2e/agent-performance.cjs URL
const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || '/opt/node22/lib/node_modules/playwright');
const URL_ = process.argv[2] || 'http://127.0.0.1:5191/';

(async () => {
  const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(URL_);
    await page.waitForFunction(() => window.oro && window.orograph?.visuals, null, { timeout: 60000 });
    if (await page.locator('.start-card button').count()) await page.locator('.start-card button').click();
    else await page.mouse.click(20, 20);
    await page.evaluate(() => window.oro.start());
    await page.waitForSelector('.start-card', { state: 'hidden' });
    const validation = await page.evaluate(() => {
      const o = window.orograph, api = window.oro;
      o.music.transport.stop();
      api.show('scope'); // reduce GPU load while testing sound and persistence
      const id = api.tracks().tracks[0].id;
      const before = JSON.stringify(o.store.serialize());
      const bad = [api.set(id, { cutoff: 1200, typo: 1 }), api.dot(id, { x: 0.2, mode: 'wrong' }), api.pattern(id, [0, { degree: NaN }]), api.addTrack({ patch: 'missing patch' })];
      return { version: api.appVersion, bad: bad.map(r => ({ ok: r.ok, error: r.error })), unchanged: JSON.stringify(o.store.serialize()) === before, help: api.help().methods.length, audio: api.state().audio };
    });
    assert.ok(validation.bad.every(r => r.ok === false && r.error));
    assert.equal(validation.unchanged, true);
    assert.equal(validation.audio, 'running');
    if (process.env.ORO_EXPECTED_VERSION) assert.equal(validation.version, process.env.ORO_EXPECTED_VERSION);
    console.log('PASS built agent discovery and invalid calls leave the session unchanged', JSON.stringify(validation));

    const bridge = await page.evaluate(async () => {
      let serial = 0;
      const call = (type, args) => new Promise((resolve, reject) => {
        const id = `e2e-${++serial}`;
        const cleanup = () => { clearTimeout(timer); window.removeEventListener('message', receive); };
        const receive = e => {
          if (e.source !== window || e.origin !== location.origin || e.data?.source !== 'oro' || e.data.id !== id) return;
          cleanup(); resolve(e.data);
        };
        const timer = setTimeout(() => { cleanup(); reject(new Error(`Bridge timeout: ${type}`)); }, 5000);
        window.addEventListener('message', receive);
        window.postMessage({ source: 'oro-agent', id, type, args }, location.origin);
      });
      const help = await call('help', []);
      const denied = await call('setGlobal', [{ tempo: 112 }]);
      const url = new URL(location.href); url.searchParams.set('agent', '1'); history.replaceState(null, '', url);
      const malformed = await call('setGlobal', { tempo: 112 });
      const inherited = await call('toString', []);
      const before = JSON.stringify(window.orograph.store.serialize());
      const invalid = await call('set', [0, { cutoff: 1200, typo: 1 }]);
      return { help: help.ok, denied: { ok: denied.ok, fix: denied.fix }, malformed: { ok: malformed.ok, error: malformed.error }, inherited: inherited.ok, invalid: { ok: invalid.ok, error: invalid.error, fix: invalid.fix, receipt: invalid.receipt?.ok }, unchanged: JSON.stringify(window.orograph.store.serialize()) === before };
    });
    assert.equal(bridge.help, true);
    assert.equal(bridge.denied.ok, false);
    assert.match(bridge.denied.fix, /agent=1/);
    assert.equal(bridge.malformed.ok, false);
    assert.match(bridge.malformed.error, /array/);
    assert.equal(bridge.inherited, false);
    assert.equal(bridge.invalid.ok, false);
    assert.equal(bridge.invalid.receipt, false);
    assert.ok(bridge.invalid.error && bridge.invalid.fix && bridge.unchanged);
    console.log('PASS real postMessage bridge discovery, opt-in gate, allowlist, argument and atomic error receipts', JSON.stringify(bridge));

    const sound = await page.evaluate(async () => {
      const o = window.orograph, api = window.oro;
      const wait = ms => new Promise(r => setTimeout(r, ms));
      const checked = r => { if (!r?.ok) throw new Error(JSON.stringify(r)); return r; };
      const id = api.tracks().tracks[0].id;
      checked(api.loadPatch(id, 'Basalt Bass'));
      checked(api.set(id, { level: 0.8, attack: 0.01, decay: 0.1, sustain: 0.8, release: 0.05, cutoff: 5000, resonance: 0.1, delaySend: 0, reverbSend: 0 }));
      checked(api.select(id));
      await wait(250);
      const a = o.engine.analyser;
      const sample = () => {
        const wave = new Float32Array(a.fftSize); a.getFloatTimeDomainData(wave);
        const freq = new Float32Array(a.frequencyBinCount); a.getFloatFrequencyData(freq);
        let sum = 0, peak = 0, bad = 0, total = 0, weighted = 0;
        for (const v of wave) { if (!Number.isFinite(v)) bad++; sum += v * v; peak = Math.max(peak, Math.abs(v)); }
        for (let i = 1; i < freq.length; i++) { const power = Number.isFinite(freq[i]) ? 10 ** (freq[i] / 10) : 0; total += power; weighted += power * i * o.engine.context.sampleRate / a.fftSize; }
        return { rms: Math.sqrt(sum / wave.length), peak, bad, centroid: weighted / Math.max(1e-20, total) };
      };
      api.touch({ x: 0.23, y: 0.71, mode: 'strum', phase: 'down' });
      await wait(160);
      const strum = sample();
      api.touch({ x: 0.23, y: 0.71, mode: 'strum', phase: 'up' });
      await wait(500);
      api.note(id, 'A3', { dur: 3, vel: 0.9 });
      api.touch({ x: 0.05, y: 0.5, mode: 'fx', phase: 'down' });
      await wait(250);
      const left = sample();
      api.touch({ x: 0.95, y: 0.5, mode: 'fx', phase: 'move' });
      await wait(250);
      const right = sample();
      api.touch({ x: 0.95, y: 0.5, mode: 'fx', phase: 'up' });
      await wait(400);
      const released = sample();
      api.panic();
      return { strum, left, right, released };
    });
    for (const s of Object.values(sound)) { assert.equal(s.bad, 0); assert.ok(s.rms > 0.0005); assert.ok(s.peak <= 1.0001); }
    assert.ok(Math.abs(sound.left.centroid - sound.right.centroid) > 10, JSON.stringify(sound));
    console.log('PASS Strum produces finite nonzero audio; FX sweep changes measured spectral centroid; release remains finite', JSON.stringify(sound));

    const persisted = await page.evaluate(async () => {
      const o = window.orograph, api = window.oro;
      const wait = ms => new Promise(r => setTimeout(r, ms));
      const id = api.tracks().tracks[0].id;
      const before = o.store.serialize();
      const played = api.play('title Local preservation\nbpm 120\nbars 4\nviolin A4 0 12 0.7\n');
      if (!played.ok) throw new Error(JSON.stringify(played));
      api.set(id, { cutoff: 2400 });
      await wait(450);
      o.store.set('parts.0.name', 'Preserved live edit', { source: 'ui' });
      api.setGlobal({ tempo: 144 });
      // Active motion can keep resetting the 600 ms quiet-time debounce;
      // autosave's 2 s max-wait guarantees a save even during performance.
      const editedAt = performance.now();
      let savedState;
      do {
        await wait(100);
        savedState = JSON.parse(localStorage.getItem('orograph.session.v1'));
      } while ((savedState?.parts[0]?.name !== 'Preserved live edit' || savedState?.global.tempo !== 144) && performance.now() - editedAt < 5000);
      const saveWaitMs = performance.now() - editedAt;
      const saved = JSON.parse(localStorage.getItem('orograph.session.v1'));
      const clean = o.music.score.cleanState(o.store.serialize());
      const stationaryState = state => {
        const copy = JSON.parse(JSON.stringify(state));
        // Moving dots advance between the autosave timer and this read. All
        // other persisted fields must match the score-cleaned live session.
        for (const part of copy.parts) { delete part.params.centerX; delete part.params.centerY; }
        return JSON.stringify(copy);
      };
      api.stop();
      const after = o.store.serialize();
      api.undo();
      const undo = o.store.serialize();
      api.redo();
      const redo = o.store.serialize();
      return { saveWaitMs, beforeName: before.parts[0].name, beforeAttack: before.parts[0].params.attack, after: { name: after.parts[0].name, cutoff: after.parts[0].params.cutoff, attack: after.parts[0].params.attack, tempo: after.global.tempo }, saved: { name: saved.parts[0].name, cutoff: saved.parts[0].params.cutoff, attack: saved.parts[0].params.attack, tempo: saved.global.tempo }, cleanMatchesSaved: stationaryState(clean) === stationaryState(saved), undo: { name: undo.parts[0].name, tempo: undo.global.tempo }, redo: { name: redo.parts[0].name, cutoff: redo.parts[0].params.cutoff, attack: redo.parts[0].params.attack, tempo: redo.global.tempo }, borrowing: o.music.score.borrowing() };
    });
    assert.deepEqual(persisted.after, { name: 'Preserved live edit', cutoff: 2400, attack: persisted.beforeAttack, tempo: 144 });
    assert.deepEqual(persisted.saved, persisted.after);
    assert.equal(persisted.cleanMatchesSaved, true, JSON.stringify(persisted));
    assert.deepEqual(persisted.redo, persisted.after);
    assert.equal(persisted.borrowing, false);
    console.log('PASS built score stop, real localStorage autosave, undo and redo preserve ordinary live edits', JSON.stringify(persisted));
    await page.reload();
    await page.waitForFunction(() => window.oro, null, { timeout: 60000 });
    const reloaded = await page.evaluate(() => ({ name: window.orograph.store.get('parts.0.name'), cutoff: window.oro.get('parts.0.params.cutoff').value, tempo: window.oro.state().tempo }));
    assert.deepEqual(reloaded, { name: 'Preserved live edit', cutoff: 2400, tempo: 144 });
    console.log('PASS reload restores the edited session', JSON.stringify(reloaded));
    assert.deepEqual(errors, []);
    console.log('PASS no page errors. Signals measured in headless Chromium; no listening/reference comparison.');
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
