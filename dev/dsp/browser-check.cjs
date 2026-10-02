// Round D DSP features in the real app, in a real browser (AudioWorklet):
//   npx vite --port 5191 --strictPort &   node dev/dsp/browser-check.cjs http://127.0.0.1:5191/
// Drives window.orograph (store, engine) the way the UI does, listens at the
// analyser and records the master output while switching quality modes,
// filter types and patches under a held chord, then looks for clicks.
// Exit code 1 on any failure.

const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const fs = require('node:fs');

const URL_ = process.argv[2] || 'http://127.0.0.1:5191/';
const OUT = process.env.SHOTS || '/tmp/orograph-shots/dsp';
fs.mkdirSync(OUT, { recursive: true });
const failures = [];
const check = (ok, msg) => { console.log((ok ? 'PASS ' : 'FAIL ') + msg); if (!ok) failures.push(msg); };

(async () => {
  const browser = await chromium.launch({
    args: ['--autoplay-policy=no-user-gesture-required', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  // a fresh dev server may reload the page once while it optimises dependencies
  for (let attempt = 0; ; attempt++) {
    try {
      await page.goto(URL_, { waitUntil: 'load' });
      await page.waitForFunction(() => window.orograph && window.orograph.store && window.orograph.engine && document.querySelector('#app.is-ready'), null, { timeout: 180000 });
      await new Promise(r => setTimeout(r, 1000));
      await page.evaluate(async () => { await window.orograph.engine.start(); });
      break;
    } catch (e) {
      if (attempt >= 2) throw e;
      console.log('retrying page load: ' + e.message.split('\n')[0]);
    }
  }
  await page.evaluate(() => window.orograph.store.set('ui.quality', 'low', { source: 'test' }));   // keep the GPU out of the way
  await new Promise(r => setTimeout(r, 1500));

  const info = await page.evaluate(() => {
    const o = window.orograph;
    return { mode: o.engine.mode, state: o.engine.context.state, sr: o.engine.context.sampleRate, quality: o.engine.quality };
  });
  check(info.mode === 'worklet', `DSP runs in an AudioWorklet (${info.mode}, ${info.state}, ${info.sr} Hz, quality ${info.quality})`);

  // helpers inside the page
  await page.evaluate(() => {
    const o = window.orograph;
    window.__t = {
      set(path, v) { o.store.set(path, v, { source: 'test' }); },
      sleep(ms) { return new Promise(r => setTimeout(r, ms)); },
      // three snapshots ~80 ms apart, loudest wins: a busy machine can starve
      // the audio thread for a moment, which is not what is being measured
      async listen() {
        const a = o.engine.analyser, buf = new Float32Array(a.fftSize);
        let best = { rms: 0, peak: 0, bad: 0 };
        for (let k = 0; k < 3; k++) {
          a.getFloatTimeDomainData(buf);
          let s = 0, pk = 0, bad = 0;
          for (const v of buf) { if (!Number.isFinite(v)) bad++; else { s += v * v; pk = Math.max(pk, Math.abs(v)); } }
          const r = Math.sqrt(s / buf.length);
          best = { rms: Math.max(best.rms, r), peak: Math.max(best.peak, pk), bad: best.bad + bad };
          await new Promise(res => setTimeout(res, 80));
        }
        return best;
      },
      tele() { return o.engine.telemetry(); },
      chord(on, notes = [52, 59, 64]) { for (const n of notes) (on ? o.engine.noteOn(0, n, 0.85) : o.engine.noteOff(0, n)); },
    };
    o.store.set('ui.selectedPart', 0, { source: 'test' });
  });

  // ---- each Round D voice feature sounds, finite and in range
  const scenarios = [
    ['default', {}],
    ['Even travel on a spirograph', { pathShape: 7, pathOrder: 3, traverse: 1 }],
    ['Ping-pong Scan', { pathShape: 6, direction: 1, size: 0.4 }],
    ['Key>Size -1', { noteSize: -1 }],
    ['Air 0.8, bright', { air: 0.8, airTone: 0.7 }],
    ['Comb filter', { filterType: 5, cutoff: 220, resonance: 0.8, formant: 1 }],
    ['Vowel filter', { filterType: 6, cutoff: 1000, resonance: 0.6, formant: 0.25 }],
  ];
  for (const [name, p] of scenarios) {
    const r = await page.evaluate(async (p) => {
      const t = window.__t;
      for (const [k, v] of Object.entries(p)) t.set(`parts.0.params.${k}`, v);
      t.chord(true);
      await t.sleep(600);
      const l = await t.listen();
      t.chord(false);
      await t.sleep(250);
      for (const k of Object.keys(p)) t.set(`parts.0.params.${k}`, window.orograph.store.get('parts.1.params.' + k));
      return l;
    }, p);
    check(r.bad === 0 && r.rms > 0.003 && r.peak <= 1.0001, `${name}: audible and clean (rms ${r.rms.toFixed(4)}, peak ${r.peak.toFixed(3)})`);
  }

  // ---- telemetry: terrain height, quality, Links (macro -> warp), Steps LFO
  const tl = await page.evaluate(async () => {
    const t = window.__t, o = window.orograph;
    t.set('parts.0.links', [{ src: 5, dst: 'warp', amt: 1, curve: 0 }]);
    t.set('parts.0.params.warp', 0);
    t.set('global.macro1', 0.6);
    t.set('parts.0.mods.cutoff.lfoShape', 6);
    t.set('parts.0.mods.cutoff.lfoRate', 2);
    t.set('parts.0.mods.cutoff.lfoDepth', 0.3);
    await t.sleep(900);
    const seen = [];
    for (let i = 0; i < 25; i++) { const m = t.tele(); if (m) seen.push(m.n.cutoff); await t.sleep(40); }
    const m = t.tele();
    const out = { warp: m.n.warp, th: m.terrainHeight, q: m.quality, cut: [...new Set(seen.map(x => x.toFixed(3)))].length };
    t.set('global.macro1', 0);
    t.set('parts.0.links', o.store.get('parts.1.links'));
    t.set('parts.0.mods.cutoff.lfoDepth', 0);
    return out;
  });
  check(Math.abs(tl.warp - 0.6) < 0.02, `Links: Macro 1 drives Warp through the worklet (n.warp ${tl.warp && tl.warp.toFixed(3)})`);
  check(typeof tl.th === 'number' && Number.isFinite(tl.th), `telemetry carries terrainHeight (${tl.th})`);
  check(tl.q === 'standard', `telemetry carries the DSP's quality (${tl.q})`);
  check(tl.cut >= 3, `Steps LFO moves cutoff in steps (${tl.cut} distinct values in 1 s)`);

  // ---- pressure through a Link, marble from the physics API
  const pr = await page.evaluate(async () => {
    const t = window.__t, o = window.orograph;
    t.set('parts.0.links', [{ src: 2, dst: 'fold', amt: 1, curve: 0 }, { src: 9, dst: 'drive', amt: 0.5, curve: 0 }]);
    t.set('parts.0.params.fold', 0); t.set('parts.0.params.drive', 0);
    t.chord(true, [60]);
    await t.sleep(200);
    o.engine.pressure(0, 0.7);
    o.engine.marble(0, 0.8, 0.2);
    await t.sleep(400);
    const m = t.tele();
    t.chord(false, [60]);
    o.engine.pressure(0, 0);
    o.engine.marble(0, 0, 0);
    t.set('parts.0.links', o.store.get('parts.1.links'));
    return { fold: m.n.fold, drive: m.n.drive };
  });
  check(Math.abs(pr.fold - 0.7) < 0.02, `channel pressure reaches a voice Link (n.fold ${pr.fold.toFixed(3)})`);
  check(Math.abs(pr.drive - 0.4) < 0.03, `marble speed reaches a Link (n.drive ${pr.drive.toFixed(3)})`);

  // ---- quality modes: each one plays, the DSP follows the store setting
  for (const mode of ['eco', 'high', 'pristine', 'raw', 'standard']) {
    const r = await page.evaluate(async (mode) => {
      const t = window.__t;
      t.set('ui.audioQuality', mode);
      t.chord(true);
      await t.sleep(700);
      const l = await t.listen();
      const q = t.tele().quality;
      t.chord(false);
      await t.sleep(250);
      return { ...l, q, eq: window.orograph.engine.quality };
    }, mode);
    check(r.q === mode && r.eq === mode && r.bad === 0 && r.rms > 0.003, `quality ${mode}: DSP reports ${r.q}, rms ${r.rms.toFixed(4)}, peak ${r.peak.toFixed(3)}`);
  }

  // ---- record the master while switching things under a held chord, look for clicks
  const rec = await page.evaluate(async () => {
    const t = window.__t, o = window.orograph;
    t.set('parts.0.params.release', 0.3);
    await o.engine.startRecording();
    await t.sleep(300);
    t.chord(true);
    await t.sleep(600);
    const marks = [];
    const mark = (what) => marks.push([what, o.engine.recordingElapsed()]);
    for (const mode of ['eco', 'high', 'pristine', 'standard']) { mark('quality ' + mode); t.set('ui.audioQuality', mode); await t.sleep(450); }
    for (const ft of [5, 6, 3, 1]) { mark('filter ' + ft); t.set('parts.0.params.filterType', ft); await t.sleep(450); }
    for (const [k, v] of [['pathShape', 4], ['traverse', 1], ['direction', 1], ['unison', 3], ['spread', 0.2], ['unison', 1]]) { mark(`${k} ${v}`); t.set(`parts.0.params.${k}`, v); await t.sleep(450); }
    t.chord(false);
    await t.sleep(700);
    const blob = await o.engine.stopRecording();
    const buf = await o.engine.context.decodeAudioData(await blob.arrayBuffer());
    const x = buf.getChannelData(0);
    // second difference against its local level, outside the note starts/ends
    const n = x.length, d = new Float64Array(n);
    for (let i = 2; i < n; i++) d[i] = x[i] - 2 * x[i - 1] + x[i - 2];
    const ps = new Float64Array(n + 1);
    for (let i = 0; i < n; i++) ps[i + 1] = ps[i] + d[i] * d[i];
    const W = 480, G = 24, sr = buf.sampleRate;
    let worst = 0, at = 0, bad = 0, peak = 0;
    for (let i = 0; i < n; i++) { if (!Number.isFinite(x[i])) bad++; peak = Math.max(peak, Math.abs(x[i])); }
    const from = Math.round(marks[0][1] * sr) - 2000, to = Math.round((marks[marks.length - 1][1] + 0.4) * sr);
    for (let i = Math.max(W + 2, from); i < Math.min(n - W, to); i++) {
      const a = Math.abs(d[i]);
      if (a < 2e-3) continue;
      const e = (ps[i - G] - ps[i - W]) + (ps[i + W] - ps[i + G]);
      const r = a / (Math.sqrt(e / (2 * (W - G))) + 1e-9);
      if (r > worst) { worst = r; at = i / sr; }
    }
    const near = marks.reduce((b, m) => (Math.abs(m[1] - at) < Math.abs(b[1] - at) ? m : b), marks[0]);
    for (const [k] of [['pathShape'], ['traverse'], ['direction'], ['unison'], ['spread'], ['filterType']]) t.set(`parts.0.params.${k}`, o.store.get(`parts.1.params.${k}`));
    return { seconds: n / sr, worst, at, near: `${near[0]} at ${near[1].toFixed(2)} s`, bad, peak };
  });
  check(rec.bad === 0 && rec.peak <= 1.0001, `recorded ${rec.seconds.toFixed(1)} s of master output: finite, peak ${rec.peak.toFixed(3)}`);
  check(rec.worst < 12, `no clicks while switching quality, filter, path, travel and unison under a chord (worst burst ${rec.worst.toFixed(1)}x local level at ${rec.at.toFixed(2)} s, nearest change: ${rec.near})`);

  check(errors.length === 0, `no page errors (${errors.slice(0, 3).join(' | ')})`);
  await page.screenshot({ path: `${OUT}/browser-check.png`, timeout: 10000 }).catch(() => {});
  await browser.close();
  console.log(failures.length ? `\n${failures.length} FAILED` : '\nall passed');
  process.exit(failures.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
