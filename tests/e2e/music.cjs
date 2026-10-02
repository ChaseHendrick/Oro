// End-to-end check of the music module in headless Chromium, using the dev
// harness at dev/music/index.html (real audio engine when it loads, otherwise
// a logging engine on a real AudioContext).
//
//   node tests/e2e/music.cjs                       (starts vite on port 5185 itself)
//   node tests/e2e/music.cjs http://127.0.0.1:5185 (use a server that is already running)
//
// Checks: scene 0 plays, step events arrive in order with correct spacing and
// low callback jitter, notes are never scheduled in the past, the arp plays at
// its rate, Layer mode reaches every unmuted part, Web MIDI connects with the
// permission granted. Screenshot: /tmp/orograph-shots/music/harness.png.
// Exit code 1 on any failure.

const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');

const PORT = 5185;
const ROOT = path.resolve(__dirname, '../..');
const OUT = process.env.SHOTS || '/tmp/orograph-shots/music';
fs.mkdirSync(OUT, { recursive: true });

const failures = [];
const report = {};
const check = (ok, msg) => { console.log((ok ? 'PASS ' : 'FAIL ') + msg); if (!ok) failures.push(msg); };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function reachable(url) {
  return new Promise((resolve) => {
    const req = http.get(url, (res) => { res.resume(); resolve(res.statusCode < 500); });
    req.on('error', () => resolve(false));
    req.setTimeout(1000, () => { req.destroy(); resolve(false); });
  });
}

async function startServer() {
  const child = spawn('npx', ['vite', '--port', String(PORT), '--strictPort'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  let log = '';
  child.stdout.on('data', d => { log += d; });
  child.stderr.on('data', d => { log += d; });
  for (let i = 0; i < 60; i++) {
    if (await reachable(`http://127.0.0.1:${PORT}/dev/music/index.html`)) return child;
    await sleep(500);
  }
  try { process.kill(-child.pid); } catch { /* already gone */ }
  throw new Error('vite did not start:\n' + log);
}

async function main() {
  let server = null;
  let base = process.argv[2];
  if (!base) {
    server = await startServer();
    base = `http://127.0.0.1:${PORT}`;
  }
  const browser = await chromium.launch({
    args: ['--autoplay-policy=no-user-gesture-required', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
  });
  try {
    const context = await browser.newContext({ viewport: { width: 1200, height: 520 }, deviceScaleFactor: 1 });
    // Chromium 141 rejects even non-sysex requestMIDIAccess unless midi-sysex is granted too.
    await context.grantPermissions(['midi', 'midi-sysex'], { origin: base });
    const page = await context.newPage();
    // Other modules are being edited while this runs; keep Vite's HMR socket
    // from reloading the page halfway through a measurement.
    await page.addInitScript(() => {
      const Real = window.WebSocket;
      window.WebSocket = function (url, protocols) {
        if (protocols === 'vite-hmr' || (Array.isArray(protocols) && protocols.includes('vite-hmr'))) {
          const fake = new EventTarget();
          Object.assign(fake, { readyState: 0, send() {}, close() {}, url: String(url), protocol: 'vite-hmr' });
          return fake;
        }
        return new Real(url, protocols);
      };
      Object.assign(window.WebSocket, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 });
    });
    const errors = [];
    page.on('pageerror', e => errors.push('pageerror: ' + e.message));
    page.on('console', m => {
      if (m.type() !== 'error') return;
      const text = m.text();
      // The harness probes for src/audio/engine.js and falls back when it is not there yet.
      if (/404/.test(text) && /Failed to load resource/.test(text) && !errors.engineProbe) { errors.engineProbe = true; return; }
      errors.push('console: ' + text);
    });

    await page.goto(`${base}/dev/music/index.html`, { waitUntil: 'load' });
    await page.waitForFunction(() => window.harness && (window.harness.ready || window.harness.error), null, { timeout: 30000 });
    const bootError = await page.evaluate(() => window.harness.error || null);
    check(!bootError, 'harness boots' + (bootError ? ': ' + bootError : ''));
    if (bootError) return;
    const kind = await page.evaluate(() => window.harness.kind);
    if (kind === 'real' && errors.engineProbe) errors.push('unexpected 404 while loading the real engine');
    report.engine = kind;
    console.log(`engine: ${kind}`);
    const ctxState = await page.evaluate(async () => { try { await window.harness.engine.start(); } catch {} return window.harness.engine.context.state; });
    check(ctxState === 'running', `audio context running (${ctxState})`);

    // ---- 1. Transport plays scene 0 --------------------------------------------
    await page.evaluate(() => { window.harness.reset(); window.harness.music.transport.play(); });
    await sleep(5000);
    await page.screenshot({ path: `${OUT}/harness.png` });
    const play = await page.evaluate(() => {
      const h = window.harness;
      const tempo = h.store.get('global.tempo');
      const rates = [1, 0.5, 1 / 3, 0.25, 1 / 6, 0.125];
      const parts = [0, 1, 2, 3].map((p) => {
        const seq = h.store.get(`parts.${p}.seq`);
        const ev = h.stats.steps.filter(e => e.part === p);
        let inOrder = true;
        for (let i = 1; i < ev.length; i++) if (ev[i].step !== (ev[i - 1].step + 1) % seq.length) inOrder = false;
        // Spacing of scheduled step times against the grid (swing moves odd 16ths, so compare pairs of steps).
        const spb = 60 / tempo;
        const pairDur = 2 * rates[seq.rate] * spb;
        let maxErr = 0;
        for (let i = 2; i < ev.length; i++) maxErr = Math.max(maxErr, Math.abs((ev[i].time - ev[i - 2].time) - pairDur));
        return { count: ev.length, inOrder, maxGridErrMs: maxErr * 1000 };
      });
      const s = h.summary();
      const late = h.stats.lateness.slice().sort((a, b) => a - b);
      const pct = (q) => late.length ? late[Math.min(late.length - 1, Math.floor(q * late.length))] : 0;
      const notesHeard = h.stats.notes.filter(n => n.on).length;
      const level = h.engine.level ? h.engine.level() : null;
      return { tempo, parts, s, p50: pct(0.5), p95: pct(0.95), notesHeard, level, sources: [...new Set(h.stats.sched.map(x => x.source))] };
    });
    report.transport = play;
    console.log(JSON.stringify(play, null, 1));
    check(play.parts.every(p => p.count >= 4), `every part produced step events (${play.parts.map(p => p.count).join(', ')})`);
    check(play.parts.every(p => p.inOrder), 'step events arrive in order for every part');
    check(play.parts.every(p => p.maxGridErrMs < 0.5), `scheduled step times sit on the grid (max error ${Math.max(...play.parts.map(p => p.maxGridErrMs)).toFixed(4)} ms)`);
    check(play.s.notesScheduled > 20, `notes scheduled while playing (${play.s.notesScheduled})`);
    check(play.s.minLeadMs != null && play.s.minLeadMs > 0, `notes never scheduled in the past (min lead ${play.s.minLeadMs && play.s.minLeadMs.toFixed(1)} ms)`);
    check(play.p95 < 30, `step callbacks close to when heard (p50 ${play.p50.toFixed(2)} ms, p95 ${play.p95.toFixed(2)} ms, max ${play.s.maxLatenessMs.toFixed(2)} ms)`);
    if (kind === 'real') check(play.level > 0.001, `real engine produces output while playing (level ${play.level})`);

    await page.evaluate(() => window.harness.music.transport.stop());
    await sleep(400);

    // ---- 2. Arp produces notes at its rate --------------------------------------
    const arp = await page.evaluate(async () => {
      const h = window.harness;
      h.reset();
      h.store.set('parts.2.arp', { mode: 1, rate: 3, octaves: 2, gate: 0.5, hold: 0 });
      h.music.router.noteOn(2, 60, 0.8);
      h.music.router.noteOn(2, 64, 0.8);
      h.music.router.noteOn(2, 67, 0.8);
      await new Promise(r => setTimeout(r, 1200));
      [60, 64, 67].forEach(n => h.music.router.noteOff(2, n));
      const ons = h.stats.sched.filter(e => e.part === 2 && e.on && e.source === 'arp');
      const times = ons.map(e => e.time);
      const gaps = times.slice(1).map((t, i) => t - times[i]);
      const tempo = h.store.get('global.tempo');
      return { count: ons.length, notes: ons.slice(0, 8).map(e => e.note), gapMs: gaps.length ? gaps.reduce((a, b) => a + b, 0) / gaps.length * 1000 : 0, expectedMs: 0.25 * 60 / tempo * 1000, maxGapErrMs: gaps.length ? Math.max(...gaps.map(g => Math.abs(g - 0.25 * 60 / tempo))) * 1000 : 0 };
    });
    report.arp = arp;
    console.log(JSON.stringify(arp));
    check(arp.count >= 6, `arp plays while the transport is stopped (${arp.count} notes in 1.2 s)`);
    check(JSON.stringify(arp.notes.slice(0, 6)) === JSON.stringify([60, 64, 67, 72, 76, 79]), `arp Up over 2 octaves (${arp.notes.slice(0, 6).join(' ')})`);
    check(arp.maxGapErrMs < 0.5, `arp steps evenly spaced at 1/16 (${arp.gapMs.toFixed(2)} ms, expected ${arp.expectedMs.toFixed(2)} ms)`);

    // ---- 3. Layer mode reaches every unmuted part --------------------------------
    await sleep(400); // let already-scheduled arp notes finish announcing
    const layer = await page.evaluate(async () => {
      const h = window.harness;
      h.reset();
      h.store.set('parts.2.arp.mode', 0);
      h.store.set('global.keyMode', 1);
      h.store.set('parts.1.params.mute', 1);
      h.music.router.noteOn('sel', 72, 0.9);
      await new Promise(r => setTimeout(r, 100));
      h.music.router.noteOff('sel', 72);
      await new Promise(r => setTimeout(r, 50));
      const mine = h.stats.notes.filter(n => n.note === 72 && n.source === 'ui');
      const on = mine.filter(n => n.on).map(n => n.part).sort();
      const off = mine.filter(n => !n.on).map(n => n.part).sort();
      h.store.set('global.keyMode', 0);
      h.store.set('parts.1.params.mute', 0);
      return { on, off };
    });
    report.layer = layer;
    check(JSON.stringify(layer.on) === '[0,2,3]', `Layer mode plays every unmuted part (${layer.on.join(', ')})`);
    check(JSON.stringify(layer.off) === '[0,2,3]', `Layer mode releases the same parts (${layer.off.join(', ')})`);

    // ---- 3b. Real audio: note onsets against scheduled times --------------------
    const canRecord = await page.evaluate(() => typeof window.harness.engine.startRecording === 'function');
    let onsets = null;
    if (canRecord) {
      onsets = await page.evaluate(async () => {
        const h = window.harness;
        const { store, music, engine } = h;
        music.transport.stop();
        await new Promise(r => setTimeout(r, 300));
        // One short blip per 16th on part 1, everything else muted, no swing.
        h.presets.loadPatch(0, 'f-kelp-pizzicato');
        store.batch(() => {
          store.set('global.tempo', 120);
          store.set('global.swing', 0);
          for (let p = 1; p < 4; p++) store.set(`parts.${p}.params.mute`, 1);
          store.set('parts.0.params.decay', 0.05);
          store.set('parts.0.params.sustain', 0);
          store.set('parts.0.params.release', 0.02);
          const seq = store.get('parts.0.seq');
          seq.enabled = 1; seq.rate = 3; seq.length = 16;
          seq.steps = seq.steps.map(st => ({ ...st, on: 1, degree: 0, octave: 0, gate: 0.4, slide: 0, accent: 0, vel: 0.9 }));
          store.set('parts.0.seq', seq);
        });
        await new Promise(r => setTimeout(r, 1500)); // terrains regenerate in the page
        h.reset();
        engine.startRecording();
        music.transport.play();
        await new Promise(r => setTimeout(r, 2600));
        music.transport.stop();
        await new Promise(r => setTimeout(r, 300));
        const blocks = engine.stopRecording();
        const sr = engine.context.sampleRate;
        const t0 = blocks[0].t;
        const n = blocks.reduce((a, b) => a + b.d.length, 0);
        const x = new Float32Array(n);
        let k = 0, gaps = 0;
        for (let i = 0; i < blocks.length; i++) {
          if (i > 0 && Math.abs(blocks[i].t - (blocks[i - 1].t + blocks[i - 1].d.length / sr)) > 0.5 / sr) gaps++;
          x.set(blocks[i].d, k); k += blocks[i].d.length;
        }
        const times = h.stats.sched.filter(e => e.part === 0 && e.on && e.source === 'seq').map(e => e.time);
        let peak = 0;
        for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(x[i]));
        const thr = peak * 0.002;
        const offsets = [];
        for (const T of times) {
          const start = Math.round((T - t0) * sr) - Math.round(0.002 * sr);
          if (start < 0 || start + Math.round(0.03 * sr) >= n) continue;
          // Silence check just before the note, so a tail is never mistaken for an onset.
          let pre = 0;
          for (let i = start - Math.round(0.01 * sr); i < start; i++) pre = Math.max(pre, Math.abs(x[i] || 0));
          if (pre > thr) continue;
          for (let i = start; i < start + Math.round(0.03 * sr); i++) {
            if (Math.abs(x[i]) > thr) { offsets.push((t0 + i / sr - T) * sr); break; }
          }
        }
        offsets.sort((a, b) => a - b);
        const med = offsets[Math.floor(offsets.length / 2)];
        const dev = offsets.map(o => Math.abs(o - med));
        const r1 = (v) => Math.round(v * 10) / 10;
        return { sr, notes: times.length, measured: offsets.length, gaps, medianSamples: r1(med), maxDeviationSamples: r1(Math.max(...dev)), spreadSamples: r1(offsets[offsets.length - 1] - offsets[0]), peak: r1(peak * 1000) / 1000 };
      });
      report.onsets = onsets;
      console.log('onsets: ' + JSON.stringify(onsets));
      check(onsets.measured >= 10, `found note onsets in the real audio (${onsets.measured} of ${onsets.notes})`);
      check(onsets.gaps === 0, 'recording has no dropped render quanta');
      check(onsets.maxDeviationSamples <= 2, `onsets land on their scheduled sample (spread ${onsets.spreadSamples} samples at ${onsets.sr} Hz, constant offset ${onsets.medianSamples} samples)`);
    }

    // ---- 4. Web MIDI with permission ----------------------------------------------
    const midi = await page.evaluate(async () => {
      const m = window.harness.midi;
      let threw = null;
      try { if (m.status !== 'ready') await m.connect(); } catch (err) { threw = String(err); }
      return { supported: m.supported, secure: m.secure, status: m.status, text: m.statusText(), threw, inputs: m.inputs().length, outputs: m.outputs().length };
    });
    report.midi = midi;
    console.log('midi: ' + JSON.stringify(midi));
    // Headless containers usually have no MIDI backend (no ALSA): then the module
    // must report a clear error instead of throwing.
    const midiOk = midi.supported && !midi.threw && (midi.status === 'ready' || (midi.status === 'error' && /could not start/.test(midi.text)));
    check(midiOk, `Web MIDI connect resolves cleanly (${midi.status}: ${midi.text})`);

    // ---- 5. Is file:// a secure context with Web MIDI? -----------------------------
    const filePage = await context.newPage();
    const tmp = path.join(require('node:os').tmpdir(), 'orograph-secure-check.html');
    fs.writeFileSync(tmp, '<!doctype html><title>check</title>');
    await filePage.goto('file://' + tmp);
    const fileCtx = await filePage.evaluate(() => ({ secure: window.isSecureContext, midi: typeof navigator.requestMIDIAccess === 'function' }));
    report.fileUrl = fileCtx;
    console.log(`file:// page: isSecureContext=${fileCtx.secure}, requestMIDIAccess=${fileCtx.midi}`);
    await filePage.close();

    await page.evaluate((list) => window.harness.setChecks(list), [
      { text: `Scene 0 plays (${play.s.steps} steps, ${play.s.notesScheduled} notes)`, pass: play.parts.every(p => p.inOrder) },
      { text: `Step jitter p95 ${play.p95.toFixed(1)} ms`, pass: play.p95 < 30 },
      { text: `Arp ${arp.count} notes, even spacing`, pass: arp.maxGapErrMs < 0.5 },
      { text: `Layer mode reached parts ${layer.on.map(p => p + 1).join(', ')}`, pass: JSON.stringify(layer.on) === '[0,2,3]' },
      ...(onsets ? [{ text: `Audio onsets within ${onsets.maxDeviationSamples} samples of schedule`, pass: onsets.maxDeviationSamples <= 2 }] : []),
      { text: midi.status === 'ready' ? 'Web MIDI ready' : 'Web MIDI: no backend here, reported cleanly', pass: midiOk },
    ]);
    await page.evaluate(() => { window.harness.presets.loadScene(0); window.harness.reset(); window.harness.music.transport.play(); });
    await sleep(1500);
    await page.screenshot({ path: `${OUT}/harness-checks.png` });
    await page.evaluate(() => window.harness.music.transport.stop());

    check(errors.length === 0, 'no page errors' + (errors.length ? ':\n  ' + errors.join('\n  ') : ''));
    fs.writeFileSync(`${OUT}/e2e-report.json`, JSON.stringify(report, null, 2));
  } finally {
    await browser.close();
    if (server) { try { process.kill(-server.pid); } catch { /* already gone */ } }
  }
}

main().then(() => {
  console.log(failures.length ? `\n${failures.length} check(s) failed` : '\nAll music e2e checks passed');
  process.exit(failures.length ? 1 : 0);
}).catch((err) => {
  console.error(err);
  process.exit(1);
});
