// Deep end-to-end bug hunt for the whole Orograph app, driven like a demanding
// player would drive it, in headless Chromium.
//
//   node tests/e2e/app-deep.cjs                  starts `npx vite --port 5197 --strictPort` itself
//   node tests/e2e/app-deep.cjs http://127.0.0.1:5197/   uses a server that is already running
//
// Options (environment variables):
//   ONLY=patches,scenes      run only these sections (names are printed in the section headers)
//   SKIP=soak,single         skip these sections
//   SOAK_SECONDS=90          length of the soak (default 90)
//   SHOTS=/tmp/...           screenshot folder (default /tmp/orograph-shots/deep)
//
// Every check prints PASS or FAIL with its numbers; the exit code is 1 when any
// check fails. Findings are written up in docs/BUGS.md.

const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const zlib = require('node:zlib');

const ROOT = path.resolve(__dirname, '../..');
const PORT = 5197;
const OUT = process.env.SHOTS || '/tmp/orograph-shots/deep';
const SINGLE_DIR = '/tmp/og-single-tests';
const SOAK_SECONDS = Math.max(5, Number(process.env.SOAK_SECONDS) || 90);
const ONLY = (process.env.ONLY || '').split(',').map(s => s.trim()).filter(Boolean);
const SKIP = (process.env.SKIP || '').split(',').map(s => s.trim()).filter(Boolean);
fs.mkdirSync(OUT, { recursive: true });

const ARGS = ['--autoplay-policy=no-user-gesture-required', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist',
  // Only for the soak's heap numbers: lets the page call gc() and report exact heap sizes.
  '--js-flags=--expose-gc', '--enable-precise-memory-info'];

const results = { pass: 0, fail: 0, skip: 0, failures: [] };
let current = '';
function check(ok, msg, extra) {
  const line = `${ok ? 'PASS' : 'FAIL'} [${current}] ${msg}`;
  console.log(line + (!ok && extra ? `\n       ${String(extra).split('\n').join('\n       ')}` : ''));
  if (ok) results.pass++; else { results.fail++; results.failures.push(line); }
  return ok;
}
/** A check that cannot run in this environment (reported, not counted as a failure). */
function skip(msg, why) {
  console.log(`SKIP [${current}] ${msg} (${why})`);
  results.skip++;
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const fmt = (v, d = 4) => (typeof v === 'number' && Number.isFinite(v) ? v.toFixed(d) : String(v));
const want = (name) => (!ONLY.length || ONLY.includes(name)) && !SKIP.includes(name);

// ------------------------------------------------------------------ server

function reachable(url) {
  return new Promise((resolve) => {
    const req = http.get(url, (res) => { res.resume(); resolve(res.statusCode < 500); });
    req.on('error', () => resolve(false));
    req.setTimeout(1500, () => { req.destroy(); resolve(false); });
  });
}

async function startServer() {
  const child = spawn('npx', ['vite', '--port', String(PORT), '--strictPort'], { cwd: ROOT, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  child.stdout.on('data', d => { log += d; });
  child.stderr.on('data', d => { log += d; });
  for (let i = 0; i < 80; i++) {
    if (await reachable(`http://127.0.0.1:${PORT}/`)) return child;
    await sleep(250);
  }
  try { process.kill(-child.pid); } catch { /* gone */ }
  throw new Error('vite did not start:\n' + log);
}

function stopServer(child) {
  if (!child) return;
  try { process.kill(-child.pid, 'SIGTERM'); } catch { /* already gone */ }
}

// ------------------------------------------------------------------ page scripts

// Other people edit the source while this runs: keep Vite's HMR socket from
// reloading the page in the middle of a measurement.
function blockHmr() {
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
}

// Measurement helpers, available as window.__t once the app has booted.
function pageHelpers() {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  let buf = null;
  const T = {
    sleep,
    teleAt: 0,
    longTasks: [],
    sample() {
      const a = window.orograph.engine.analyser;
      if (!buf || buf.length !== a.fftSize) buf = new Float32Array(a.fftSize);
      a.getFloatTimeDomainData(buf);
      let s = 0, pk = 0, bad = 0;
      for (let i = 0; i < buf.length; i++) {
        const v = buf[i];
        if (!Number.isFinite(v)) { bad++; continue; }
        s += v * v;
        const av = v < 0 ? -v : v;
        if (av > pk) pk = av;
      }
      return { rms: Math.sqrt(s / buf.length), peak: pk, bad };
    },
    /** Max RMS / peak and the NaN count over `ms` milliseconds. */
    async watch(ms, every = 20) {
      const r = { rms: 0, minRms: Infinity, peak: 0, bad: 0, n: 0 };
      const t0 = performance.now();
      do {
        const s = T.sample();
        r.rms = Math.max(r.rms, s.rms); r.minRms = Math.min(r.minRms, s.rms); r.peak = Math.max(r.peak, s.peak); r.bad += s.bad; r.n++;
        await sleep(every);
      } while (performance.now() - t0 < ms);
      return r;
    },
    /** Polls until RMS rises above `thr`; returns how long it took (or ms = -1). */
    async waitAudible(maxMs, thr = 0.002) {
      const r = { ms: -1, rms: 0, peak: 0, bad: 0 };
      const t0 = performance.now();
      while (performance.now() - t0 < maxMs) {
        const s = T.sample();
        r.rms = Math.max(r.rms, s.rms); r.peak = Math.max(r.peak, s.peak); r.bad += s.bad;
        if (s.rms > thr) { r.ms = performance.now() - t0; break; }
        await sleep(15);
      }
      // Keep listening a little longer for the peak and any NaN.
      const tail = await T.watch(60);
      r.rms = Math.max(r.rms, tail.rms); r.peak = Math.max(r.peak, tail.peak); r.bad += tail.bad;
      return r;
    },
    /** Polls until RMS falls below `thr` for 3 reads in a row; returns ms (or -1) and the last RMS. */
    async waitQuiet(maxMs, thr = 0.001) {
      const t0 = performance.now();
      let run = 0, last = 0;
      while (performance.now() - t0 < maxMs) {
        last = T.sample().rms;
        run = last < thr ? run + 1 : 0;
        if (run >= 3) return { ms: performance.now() - t0, rms: last };
        await sleep(25);
      }
      return { ms: -1, rms: last };
    },
    voices() {
      const t = window.orograph.engine.telemetry();
      return t && Array.isArray(t.activeVoices) ? t.activeVoices.slice() : null;
    },
    async frames(n = 2) { for (let i = 0; i < n; i++) await new Promise(r => requestAnimationFrame(r)); },
    /**
     * Resolves after the UI's next frame task has run (src/ui/frame.js). Every
     * DOM write the UI scheduled before this call has happened by then, so a DOM
     * check right after it sees the app's current rendering. Software rendering
     * on a busy machine can be down to about one frame a second, hence the wait.
     */
    async uiTick(maxMs = 30000) {
      const frame = await import('/src/ui/frame.js');
      return Promise.race([new Promise(r => frame.schedule(() => r(true))), sleep(maxMs).then(() => false)]);
    },
    /** Animation frames per second actually delivered to the page over `ms`. */
    async fps(ms = 2000) {
      let n = 0, go = true;
      const f = () => { n++; if (go) requestAnimationFrame(f); };
      requestAnimationFrame(f);
      await sleep(ms);
      go = false;
      return n / (ms / 1000);
    },
    async waitVoicesZero(maxMs) {
      const t0 = performance.now();
      while (performance.now() - t0 < maxMs) {
        const v = T.voices();
        if (v && v.every(x => x === 0) && performance.now() - T.teleAt < 200) return { ms: performance.now() - t0, voices: v };
        await sleep(30);
      }
      return { ms: -1, voices: T.voices() };
    },
    install() {
      const o = window.orograph;
      o.engine.on('tele', () => { T.teleAt = performance.now(); });
      try {
        new PerformanceObserver((list) => { for (const e of list.getEntries()) T.longTasks.push({ t: e.startTime, d: e.duration }); })
          .observe({ type: 'longtask', buffered: true });
      } catch { /* longtask not supported */ }
    },
  };
  window.__t = T;
}

// Fake Web MIDI with an Akai MPC on two ports, installed before the app loads.
function fakeMidi() {
  const mk = (id, name, type) => {
    const port = {
      id, name, manufacturer: 'Akai Professional', type, version: '1.0', state: 'connected', connection: 'open',
      onmidimessage: null, onstatechange: null, sent: [],
      open() { return Promise.resolve(port); }, close() { return Promise.resolve(port); },
      addEventListener() {}, removeEventListener() {},
    };
    if (type === 'output') {
      port.send = (data, ts) => { port.sent.push({ data: Array.from(data), ts: ts == null ? null : ts, at: performance.now() }); };
      port.clear = () => {};
    }
    return port;
  };
  const inputs = new Map([['mpc-in-1', mk('mpc-in-1', 'MPC MIDI 1', 'input')], ['mpc-in-2', mk('mpc-in-2', 'MPC MIDI 2', 'input')]]);
  const outputs = new Map([['mpc-out-1', mk('mpc-out-1', 'MPC MIDI 1', 'output')], ['mpc-out-2', mk('mpc-out-2', 'MPC MIDI 2', 'output')]]);
  const access = { inputs, outputs, sysexEnabled: false, onstatechange: null, addEventListener() {}, removeEventListener() {} };
  window.__fakeMidi = {
    access, requests: 0,
    fire(id, bytes, ts) {
      const p = inputs.get(id);
      if (p && typeof p.onmidimessage === 'function') p.onmidimessage({ data: Uint8Array.from(bytes), timeStamp: ts == null ? performance.now() : ts });
      return !!(p && p.onmidimessage);
    },
  };
  const request = function () { window.__fakeMidi.requests++; return Promise.resolve(access); };
  try { Object.defineProperty(Navigator.prototype, 'requestMIDIAccess', { configurable: true, writable: true, value: request }); } catch { /* ignore */ }
  try { Object.defineProperty(navigator, 'requestMIDIAccess', { configurable: true, writable: true, value: request }); } catch { /* ignore */ }
  if (navigator.permissions && navigator.permissions.query) {
    const orig = navigator.permissions.query.bind(navigator.permissions);
    navigator.permissions.query = (d) => (d && d.name === 'midi'
      ? Promise.resolve({ state: 'granted', name: 'midi', onchange: null, addEventListener() {}, removeEventListener() {} })
      : orig(d));
  }
}

async function openApp(browser, url, { theme = 'dark', viewport = { width: 1100, height: 720 }, midi = false, hmr = true, context = null } = {}) {
  const ctx = context || await browser.newContext({ viewport, colorScheme: theme, deviceScaleFactor: 1, acceptDownloads: true });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  if (hmr) await page.addInitScript(blockHmr);
  if (midi) await page.addInitScript(fakeMidi);
  await page.addInitScript(pageHelpers);
  const t0 = Date.now();
  await page.goto(url, { waitUntil: 'load', timeout: 180000 });
  await waitBoot(page);
  return { page, context: ctx, errors, bootMs: Date.now() - t0 };
}

async function waitBoot(page) {
  await page.waitForFunction(() => window.orograph && window.orograph.store && window.orograph.ui && document.querySelector('#app.is-ready'), null, { timeout: 180000 });
  await page.evaluate(() => window.__t.install());
}

async function startAudio(page) {
  const btn = page.locator('[data-action="start"]');
  if (await btn.count()) await btn.first().click({ timeout: 5000, force: true }).catch(() => {});
  await page.evaluate(() => window.orograph.engine.start());
  await sleep(300);
  // Mouse focus left on a button would take Space for itself; start from the page.
  await page.evaluate(() => { if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur(); });
  return page.evaluate(() => window.orograph.engine.context.state);
}

// Cheaper 3D frames for the sections that test sound, not visuals (SwiftShader is slow).
const lowQuality = (page) => page.evaluate(() => window.orograph.store.set('ui.quality', 'low', { source: 'test' }));

const errorCheck = (errors, from, label) => {
  const list = errors.slice(from);
  check(list.length === 0, `${label}: no console errors (${list.length})`, list.slice(0, 6).join('\n'));
};

// ------------------------------------------------------------------ file helpers

/** Minimal 8-bit grayscale PNG encoder (zlib from Node), for the image import. */
function grayPng(w, h, fn) {
  const raw = Buffer.alloc((w + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w + 1)] = 0;
    for (let x = 0; x < w; x++) raw[y * (w + 1) + 1 + x] = Math.max(0, Math.min(255, Math.round(fn(x / w, y / h) * 255)));
  }
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (b) => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 0; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

/** WAV header facts from a buffer: { channels, sampleRate, bits, frames, seconds } or { error }. */
function parseWav(buf) {
  if (buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') return { error: 'not a RIFF/WAVE file' };
  let off = 12, fmt = null, dataSize = null;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    if (id === 'fmt ') fmt = { format: buf.readUInt16LE(off + 8), channels: buf.readUInt16LE(off + 10), sampleRate: buf.readUInt32LE(off + 12), bits: buf.readUInt16LE(off + 22) };
    if (id === 'data') { dataSize = Math.min(size, buf.length - off - 8); break; }
    off += 8 + size + (size & 1);
  }
  if (!fmt || dataSize == null) return { error: 'missing fmt or data chunk' };
  const frames = dataSize / (fmt.channels * fmt.bits / 8);
  return { ...fmt, frames, seconds: frames / fmt.sampleRate };
}

// ------------------------------------------------------------------ sections

async function sectionBoot(browser, base) {
  current = 'boot';
  const { page, errors, bootMs, context } = await openApp(browser, base, { viewport: { width: 1440, height: 900 } });
  const info = await page.evaluate(() => {
    const o = window.orograph;
    return { keys: Object.keys(o), mode: o.engine.mode, state: o.engine.context.state, patches: o.presets.patches().length, scenes: o.presets.scenes().length };
  });
  check(['store', 'engine', 'visuals', 'music', 'presets', 'midi'].every(k => info.keys.includes(k)), `window.orograph exposes store, engine, visuals, music, presets, midi (${info.keys.join(', ')})`);
  check(bootMs < 20000, `app boots in under 20 s (${bootMs} ms)`);
  const state = await startAudio(page);
  check(state === 'running', `audio starts from the Start button (${state}, ${info.mode})`);
  check(info.patches > 0 && info.scenes > 0, `factory library loaded (${info.patches} patches, ${info.scenes} scenes)`);
  errorCheck(errors, 0, 'boot');
  await page.screenshot({ path: `${OUT}/boot.png` });
  await context.close();
}

async function sectionPatches(browser, base) {
  current = 'patches';
  const { page, errors, context } = await openApp(browser, base);
  await startAudio(page);
  await page.evaluate(() => window.orograph.store.set('ui.quality', 'low', { source: 'test' }));
  const res = [];
  for (let part = 0; part < 4; part++) {
    const chunk = await page.evaluate(async (part) => {
      const o = window.orograph, T = window.__t;
      o.music.transport.stop();
      o.store.batch(() => { for (let p = 0; p < 4; p++) { o.store.set(`parts.${p}.params.mute`, 0); o.store.set(`parts.${p}.params.solo`, 0); o.store.set(`parts.${p}.arp.mode`, 0); } });
      o.store.set('ui.selectedPart', part, { source: 'test' });
      const list = o.presets.patches().filter(p => p.factory);
      const out = [];
      for (const p of list) {
        o.engine.panic();
        o.music.router.allNotesOff();
        await T.sleep(30);
        const ok = o.presets.loadPatch(part, p.id);
        const attack = Number(o.store.get(`parts.${part}.params.attack`)) || 0;
        const maxMs = Math.min(6000, Math.max(700, attack * 1300 + 500));
        o.engine.noteOn(part, 60, 0.9);
        const a = await T.waitAudible(maxMs, 0.002);
        o.engine.noteOff(part, 60);
        // The part tab repaints on the UI's next frame task (checked on every fifth patch and the last).
        const idx = list.indexOf(p);
        let shown;
        if (idx % 5 === 0 || idx === list.length - 1) {
          await T.uiTick();
          shown = (document.querySelectorAll('.part-tab .part-patch')[part] || {}).textContent;
        }
        out.push({ part, name: p.name, ok, maxMs, ...a, stored: o.store.get(`parts.${part}.patchName`), shown });
      }
      o.engine.panic();
      return out;
    }, part);
    res.push(...chunk);
  }
  const bad = res.filter(r => r.bad > 0);
  const silent = res.filter(r => r.ms < 0);
  const loud = res.filter(r => r.peak > 1.0001);
  const notLoaded = res.filter(r => !r.ok || r.stored !== r.name);
  const checkedTabs = res.filter(r => r.shown !== undefined);
  const notShown = checkedTabs.filter(r => r.shown !== r.name);
  const slowest = res.slice().sort((a, b) => b.ms - a.ms)[0];
  check(res.length >= 4 * 40, `loaded ${res.length} patch x part combinations`);
  check(notLoaded.length === 0, `every patch loads and sets patchName (${notLoaded.length} did not)`, notLoaded.slice(0, 8).map(r => `part ${r.part} ${r.name} -> ${r.stored}`).join('\n'));
  check(bad.length === 0, `no NaN/Inf at the output for any patch (${bad.length} with NaN)`, bad.slice(0, 8).map(r => `part ${r.part} ${r.name}: ${r.bad} bad samples`).join('\n'));
  check(silent.length === 0, `every patch is audible on a test note C4 (${silent.length} silent)`, silent.slice(0, 12).map(r => `part ${r.part} ${r.name}: max rms ${fmt(r.rms)} within ${r.maxMs} ms`).join('\n'));
  check(loud.length === 0, `every patch stays within full scale (max peak ${fmt(Math.max(...res.map(r => r.peak)))})`, loud.slice(0, 8).map(r => `part ${r.part} ${r.name}: peak ${fmt(r.peak)}`).join('\n'));
  check(notShown.length === 0, `the part tab shows the loaded patch's name (${checkedTabs.length} checked, ${notShown.length} mismatches)`, notShown.slice(0, 8).map(r => `part ${r.part + 1}: shows "${r.shown}", loaded "${r.name}"`).join('\n'));
  console.log(`       slowest to sound: ${slowest && slowest.name} on part ${slowest && slowest.part + 1}, ${fmt(slowest && slowest.ms, 0)} ms; quietest: ${res.slice().sort((a, b) => a.rms - b.rms).slice(0, 3).map(r => `${r.name} ${fmt(r.rms)}`).join(', ')}`);
  errorCheck(errors, 0, 'patch sweep');
  await context.close();
}

async function sectionScenes(browser, base) {
  current = 'scenes';
  const { page, errors, context } = await openApp(browser, base);
  await startAudio(page);
  await lowQuality(page);
  const scenes = await page.evaluate(() => window.orograph.presets.scenes().filter(s => s.factory).map(s => ({ id: s.id, name: s.name })));
  for (const sc of scenes) {
    const before = errors.length;
    const r = await page.evaluate(async (id) => {
      const o = window.orograph, T = window.__t;
      o.music.transport.stop();
      o.engine.panic();
      o.music.router.allNotesOff();
      await T.sleep(50);
      o.presets.loadScene(id);
      await Promise.race([o.engine.whenTerrainsReady(), T.sleep(4000)]);
      const tempo = o.store.get('global.tempo');
      const steps = [0, 0, 0, 0];
      const notes = [0, 0, 0, 0];
      const offStep = o.music.transport.on('step', (e) => { steps[e.part]++; });
      const offNote = o.music.router.on('sched', (e) => { if (e.on) notes[e.part]++; });
      const seqOn = [0, 1, 2, 3].map(p => !!o.store.get(`parts.${p}.seq.enabled`));
      const arpOn = [0, 1, 2, 3].map(p => o.store.get(`parts.${p}.arp.mode`) > 0);
      const rates = [0, 1, 2, 3].map(p => o.store.get(`parts.${p}.seq.rate`));
      const barsMs = 2 * 4 * 60000 / tempo;
      const lt0 = T.longTasks.length;
      o.music.transport.play();
      const play = await T.watch(barsMs + 80, 25);
      o.music.transport.stop();
      const stall = Math.max(0, ...T.longTasks.slice(lt0).map(x => x.d));
      offStep(); offNote();
      const releases = [0, 1, 2, 3].map(p => Number(o.store.get(`parts.${p}.params.release`)) || 0);
      const maxRelease = Math.max(...releases);
      await T.sleep(1000);
      const after1s = { voices: T.voices(), rms: T.sample().rms };
      const settle = await T.waitVoicesZero(Math.max(0, maxRelease * 1000 + 500));
      const quiet = await T.waitQuiet(maxRelease * 1000 + 9000, 0.001);
      return { tempo, barsMs, steps, notes, seqOn, arpOn, rates, play, maxRelease, after1s, settle, quiet, stall, name: o.presets.scenes().find(s => s.id === id).name };
    }, sc.id);
    const label = `"${sc.name}"`;
    const expected = r.rates.map(rate => Math.floor(8 / [1, 0.5, 1 / 3, 0.25, 1 / 6, 0.125][rate]));
    // The transport skips steps it can no longer play on time after a main-thread
    // stall (by design). Only a shortfall without a stall counts as a failure.
    const stepOk = r.steps.every((n, p) => n >= expected[p] * 0.85) || (r.stall > 150 && r.steps.every(n => n > 0));
    check(stepOk, `${label}: steps advance over 2 bars at ${r.tempo} bpm (${r.steps.join('/')} step events, expected about ${expected.join('/')}; longest main-thread task ${fmt(r.stall, 0)} ms)`);
    const anySeq = r.seqOn.some(Boolean);
    check(!anySeq || r.notes.reduce((a, b) => a + b, 0) > 0, `${label}: sequencer plays notes (${r.notes.join('/')} note-ons per part, seq on ${r.seqOn.map(Number).join('')})`);
    check(r.play.bad === 0, `${label}: output finite while playing (${r.play.bad} bad samples)`);
    check(r.play.rms > 0.005, `${label}: audible while playing (max rms ${fmt(r.play.rms)})`);
    check(r.play.peak <= 1.0001, `${label}: under full scale while playing (peak ${fmt(r.play.peak)})`);
    check(r.settle.ms >= 0, `${label}: no stuck notes: every voice ends within 1 s + the longest release (${fmt(r.maxRelease, 2)} s) after stop (voices 1 s after stop ${JSON.stringify(r.after1s.voices)}, then ${JSON.stringify(r.settle.voices)})`);
    check(r.quiet.ms >= 0, `${label}: output returns to silence after stop, effect tails included (rms 1 s after stop ${fmt(r.after1s.rms)}, then quiet ${fmt(r.quiet.ms / 1000, 2)} s after the voices ended, last rms ${fmt(r.quiet.rms, 5)})`);
    errorCheck(errors, before, label);
  }
  await page.screenshot({ path: `${OUT}/scenes.png` });
  await context.close();
}

async function sectionStress(browser, base) {
  current = 'stress';
  const { page, errors, context } = await openApp(browser, base);
  await startAudio(page);
  await lowQuality(page);

  // Rapid patch switching while a chord is held, on every part, with the transport running.
  let before = errors.length;
  const rapid = await page.evaluate(async () => {
    const o = window.orograph, T = window.__t;
    o.presets.loadScene(0);
    await Promise.race([o.engine.whenTerrainsReady(), T.sleep(4000)]);
    o.store.set('ui.selectedPart', 0, { source: 'test' });
    const chord = [48, 55, 60, 64, 67];
    for (let p = 0; p < 4; p++) for (const n of chord) o.music.router.noteOn(p, n, 0.85, 'test');
    o.music.transport.play();
    const watch = T.watch(2600, 20);
    for (let i = 0; i < 60; i++) {
      o.presets.nextPatch(i % 4, i % 3 === 0 ? -1 : 1);
      await T.sleep(40);
    }
    const w = await watch;
    o.music.transport.stop();
    for (let p = 0; p < 4; p++) for (const n of chord) o.music.router.noteOff(p, n, 'test');
    const maxRelease = Math.max(...[0, 1, 2, 3].map(p => Number(o.store.get(`parts.${p}.params.release`)) || 0));
    await T.sleep(300);
    const held = [0, 1, 2, 3].map(p => [...o.music.router.heldNotes(p)].length);
    const settle = await T.waitVoicesZero(maxRelease * 1000 + 1500);
    return { w, maxRelease, settle, held };
  });
  check(rapid.w.bad === 0, `rapid patch switching (60 switches in 2.4 s, chords held on 4 parts): output finite (${rapid.w.bad} bad samples, peak ${fmt(rapid.w.peak)})`);
  check(rapid.w.peak <= 1.0001, `rapid patch switching: under full scale (peak ${fmt(rapid.w.peak)})`);
  check(rapid.held.every(n => n === 0), `rapid patch switching: router holds nothing after the keys are released (${rapid.held.join('/')})`);
  check(rapid.settle.ms >= 0, `rapid patch switching: no stuck voices after release (longest release ${fmt(rapid.maxRelease, 2)} s, voices ${JSON.stringify(rapid.settle.voices)})`);
  errorCheck(errors, before, 'rapid patch switching');

  // Poly/Mono/Legato switching under held notes.
  before = errors.length;
  const modes = await page.evaluate(async () => {
    const o = window.orograph, T = window.__t;
    o.engine.panic();
    const chord = [57, 60, 64];
    for (const n of chord) o.music.router.noteOn(0, n, 0.8, 'test');
    for (let i = 0; i < 12; i++) { o.store.set('parts.0.params.polyMode', i % 3, { source: 'test' }); await T.sleep(60); }
    for (const n of chord) o.music.router.noteOff(0, n, 'test');
    o.store.set('parts.0.params.polyMode', 0, { source: 'test' });
    const rel = Number(o.store.get('parts.0.params.release')) || 0;
    return { rel, settle: await T.waitVoicesZero(rel * 1000 + 1500) };
  });
  check(modes.settle.ms >= 0, `voice mode switching (Poly/Mono/Legato x12 under a held chord) leaves no stuck voices (${JSON.stringify(modes.settle.voices)})`);
  errorCheck(errors, before, 'voice mode switching');

  // All four parts at once, everything loud: the output must stay under full scale.
  before = errors.length;
  const full = await page.evaluate(async () => {
    const o = window.orograph, T = window.__t;
    o.engine.panic();
    o.presets.loadScene(0);
    await Promise.race([o.engine.whenTerrainsReady(), T.sleep(4000)]);
    o.store.batch(() => {
      o.store.set('global.masterVolume', 1, { source: 'test' });
      for (let p = 0; p < 4; p++) {
        o.store.set(`parts.${p}.params.level`, 1, { source: 'test' });
        o.store.set(`parts.${p}.params.unison`, 4, { source: 'test' });
        o.store.set(`parts.${p}.params.mute`, 0, { source: 'test' });
        o.store.set(`parts.${p}.params.solo`, 0, { source: 'test' });
        o.store.set(`parts.${p}.seq.enabled`, 1, { source: 'test' });
      }
    });
    const ceiling = o.store.get('global.ceiling');
    o.music.transport.play();
    const chord = [36, 43, 48, 55, 60, 64, 67, 72];
    for (let p = 0; p < 4; p++) for (const n of chord) o.engine.noteOn(p, n, 1);
    const w = await T.watch(3000, 20);
    const voices = T.voices();
    o.music.transport.stop();
    o.engine.panic();
    o.music.router.allNotesOff();
    return { w, voices, ceiling, limit: Math.pow(10, ceiling / 20) };
  });
  check(full.w.bad === 0, `all 4 parts at once (8-note chords, unison 4, level 1, volume 1, sequencers on): output finite (${full.w.bad} bad samples)`);
  check(full.w.peak < 1.0, `all 4 parts at once: under full scale (peak ${fmt(full.w.peak)}, ceiling ${full.ceiling} dB = ${fmt(full.limit)})`);
  check(full.w.peak <= full.limit + 0.01, `all 4 parts at once: peak respects the ceiling (${fmt(full.w.peak)} <= ${fmt(full.limit)})`);
  check(full.w.rms > 0.05, `all 4 parts at once: loud and present (max rms ${fmt(full.w.rms)}, voices ${JSON.stringify(full.voices)})`);
  errorCheck(errors, before, 'all parts at once');

  // Every terrain and every path selected live while the transport plays.
  before = errors.length;
  const live = await page.evaluate(async () => {
    const o = window.orograph, T = window.__t;
    const { TERRAIN_NAMES, PATH_NAMES } = await import('/src/dsp/catalog.js');
    o.presets.loadScene(0);
    await Promise.race([o.engine.whenTerrainsReady(), T.sleep(4000)]);
    o.store.set('ui.selectedPart', 0, { source: 'test' });
    o.store.set('parts.0.params.morph', 0, { source: 'test' });
    o.engine.noteOn(0, 57, 0.8);
    o.music.transport.play();
    const sum = (t) => { if (!t || !t.data) return null; let s = 0; for (let i = 0; i < t.data.length; i += 97) s += t.data[i]; return s; };
    const terr = [];
    for (let i = 0; i < TERRAIN_NAMES.length; i++) {
      const prev = sum(o.engine.getTerrain(0, 'A'));
      o.store.set('parts.0.params.terrainA', i, { source: 'test' });
      await Promise.race([o.engine.whenTerrainsReady(), T.sleep(2500)]);
      const w = await T.watch(220, 20);
      const t = o.engine.getTerrain(0, 'A');
      let bad = 0, lo = Infinity, hi = -Infinity;
      if (t && t.data) for (const v of t.data) { if (!Number.isFinite(v)) bad++; else { if (v < lo) lo = v; if (v > hi) hi = v; } }
      terr.push({ i, name: TERRAIN_NAMES[i], ...w, tableBad: bad, flat: !(hi - lo > 1e-3), changed: sum(t) !== prev, size: t && t.size });
    }
    o.store.set('parts.0.params.terrainA', 0, { source: 'test' });
    const paths = [];
    for (let i = 0; i < PATH_NAMES.length; i++) {
      o.store.set('parts.0.params.pathShape', i, { source: 'test' });
      const w = await T.watch(200, 20);
      paths.push({ i, name: PATH_NAMES[i], ...w });
    }
    o.store.set('parts.0.params.pathShape', 0, { source: 'test' });
    o.music.transport.stop();
    o.engine.noteOff(0, 57);
    o.engine.panic();
    return { terr, paths };
  });
  const tBad = live.terr.filter(t => t.bad > 0 || t.tableBad > 0 || t.peak > 1.0001);
  check(tBad.length === 0, `every terrain (${live.terr.length}) selected live: finite tables and output, under full scale`, tBad.map(t => `${t.name}: bad ${t.bad}, table bad ${t.tableBad}, peak ${fmt(t.peak)}`).join('\n'));
  const tFlat = live.terr.filter(t => t.flat && !/import|user/i.test(t.name));
  check(tFlat.length === 0, `every procedural terrain produces a non-flat table`, tFlat.map(t => t.name).join(', '));
  const tSilent = live.terr.filter(t => t.rms < 0.002 && !/import|user/i.test(t.name));
  check(tSilent.length === 0, `every procedural terrain is audible while playing (quietest ${live.terr.slice().sort((a, b) => a.rms - b.rms).slice(0, 3).map(t => `${t.name} ${fmt(t.rms)}`).join(', ')})`, tSilent.map(t => `${t.name}: rms ${fmt(t.rms)}`).join('\n'));
  const pBad = live.paths.filter(p => p.bad > 0 || p.peak > 1.0001);
  check(pBad.length === 0, `every path (${live.paths.length}) selected live: finite and under full scale`, pBad.map(p => `${p.name}: bad ${p.bad}, peak ${fmt(p.peak)}`).join('\n'));
  const pSilent = live.paths.filter(p => p.rms < 0.002);
  check(pSilent.length === 0, `every path is audible while playing`, pSilent.map(p => `${p.name}: rms ${fmt(p.rms)}`).join('\n'));
  errorCheck(errors, before, 'terrains and paths');
  await context.close();
}

async function sectionExtremes(browser, base) {
  current = 'extremes';
  const { page, errors, context } = await openApp(browser, base);
  await startAudio(page);
  await lowQuality(page);
  const r = await page.evaluate(async () => {
    const o = window.orograph, T = window.__t;
    const P = await import('/src/core/params.js');
    o.music.transport.stop();
    o.presets.loadScene(0);
    await Promise.race([o.engine.whenTerrainsReady(), T.sleep(4000)]);
    o.store.set('ui.selectedPart', 0, { source: 'test' });
    o.store.batch(() => { for (let p = 0; p < 4; p++) o.store.set(`parts.${p}.seq.enabled`, 0, { source: 'test' }); });
    const chord = [36, 60, 79];
    const hold = () => { for (const n of chord) o.engine.noteOn(0, n, 0.9); };
    const release = () => { for (const n of chord) o.engine.noteOff(0, n); };
    hold();
    const out = [];
    const probe = async (scope, def, value) => {
      const path = scope === 'part' ? `parts.0.params.${def.id}` : `global.${def.id}`;
      o.store.set(path, value, { source: 'test' });
      if (def.regen) await Promise.race([o.engine.whenTerrainsReady(), T.sleep(1500)]);
      const w = await T.watch(140, 20);
      out.push({ scope, id: def.id, value, ...w });
    };
    for (const def of P.PART_PARAMS) {
      const base = o.store.get(`parts.0.params.${def.id}`);
      const lo = def.curve === 'bipow' ? -def.max : def.min;
      await probe('part', def, lo);
      await probe('part', def, def.max);
      o.store.set(`parts.0.params.${def.id}`, base, { source: 'test' });
    }
    for (const def of P.GLOBAL_PARAMS) {
      const base = o.store.get(`global.${def.id}`);
      await probe('global', def, def.min);
      await probe('global', def, def.max);
      o.store.set(`global.${def.id}`, base, { source: 'test' });
    }
    // Everything at once: all part params at max, then at min, then wild modulation.
    const saved = o.store.serialize();
    const combos = [];
    const allTo = async (label, pick) => {
      o.store.batch(() => { for (const def of P.PART_PARAMS) if (def.id !== 'mute' && def.id !== 'solo') o.store.set(`parts.0.params.${def.id}`, pick(def), { source: 'test' }); });
      await Promise.race([o.engine.whenTerrainsReady(), T.sleep(2000)]);
      release(); hold();
      combos.push({ label, ...(await T.watch(500, 20)) });
    };
    await allTo('all part params at max', d => d.max);
    await allTo('all part params at min', d => (d.curve === 'bipow' ? -d.max : d.min));
    let seed = 12345;
    const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
    for (let k = 0; k < 6; k++) await allTo(`random patch ${k + 1}`, d => P.fromNorm(d, rnd()));
    o.store.batch(() => {
      for (const id of P.MOD_PARAM_IDS) {
        o.store.set(`parts.0.mods.${id}`, { ...o.store.get(`parts.0.mods.${id}`), lfoShape: 4, lfoRate: 30, lfoSync: 0, lfoDepth: 1, envDepth: -1 }, { source: 'test' });
      }
    });
    release(); hold();
    combos.push({ label: 'every modulation at full depth, 30 Hz S&H', ...(await T.watch(800, 20)) });
    // Back to normal: is the engine still alive (a NaN in the limiter would leave it silent)?
    release();
    o.engine.panic();
    o.store.load(saved, { source: 'test' });
    o.presets.loadPatch(0, o.presets.patches()[0].id);
    await Promise.race([o.engine.whenTerrainsReady(), T.sleep(3000)]);
    await T.sleep(200);
    o.engine.noteOn(0, 60, 0.9);
    const after = await T.waitAudible(1500, 0.002);
    o.engine.noteOff(0, 60);
    return { out, combos, after, ceiling: o.store.get('global.ceiling') };
  });
  const bad = r.out.filter(x => x.bad > 0);
  const loud = r.out.filter(x => x.peak > 1.0001);
  check(r.out.length > 100, `swept ${r.out.length} single-parameter extremes (each part and global parameter at min and max)`);
  check(bad.length === 0, `no NaN/Inf with any single parameter at its min or max (${bad.length})`, bad.slice(0, 12).map(x => `${x.scope}.${x.id} = ${x.value}: ${x.bad} bad samples`).join('\n'));
  check(loud.length === 0, `output under full scale at every single extreme (max peak ${fmt(Math.max(...r.out.map(x => x.peak)))})`, loud.slice(0, 12).map(x => `${x.scope}.${x.id} = ${x.value}: peak ${fmt(x.peak)}`).join('\n'));
  for (const c of r.combos) check(c.bad === 0 && c.peak <= 1.0001, `${c.label}: finite and bounded (bad ${c.bad}, peak ${fmt(c.peak)}, rms ${fmt(c.rms)})`);
  check(r.after.ms >= 0 && r.after.bad === 0, `the engine still plays normally after the extremes (rms ${fmt(r.after.rms)}, ${fmt(r.after.ms, 0)} ms to sound)`);
  errorCheck(errors, 0, 'extremes');
  await context.close();
}

async function sectionPersistence(browser, base) {
  current = 'persistence';
  const context = await browser.newContext({ viewport: { width: 1100, height: 720 }, colorScheme: 'dark', acceptDownloads: true });
  const { page, errors } = await openApp(browser, base, { context });
  await startAudio(page);

  // ---- theme toggle and persistence
  const t0 = await page.evaluate(() => ({ pref: window.orograph.store.get('ui.theme'), theme: document.documentElement.dataset.theme }));
  check(t0.pref === 'system' && t0.theme === 'dark', `first launch follows the system theme (pref ${t0.pref}, resolved ${t0.theme})`);
  await page.evaluate(() => { window.__themeEvents = []; window.addEventListener('orograph:theme', e => window.__themeEvents.push(e.detail.theme)); });
  const themeBtn = page.locator('.theme-btn');
  await themeBtn.click({ force: true });
  await sleep(100);
  await themeBtn.click({ force: true });
  await sleep(250);
  const t1 = await page.evaluate(() => ({ pref: window.orograph.store.get('ui.theme'), theme: document.documentElement.dataset.theme, stored: localStorage.getItem('orograph.theme'), events: window.__themeEvents.slice(), bg: getComputedStyle(document.body).backgroundColor }));
  check(t1.pref === 'light' && t1.theme === 'light', `two clicks on the theme button: System -> Dark -> Light (pref ${t1.pref}, resolved ${t1.theme})`);
  check(t1.stored === 'light', `theme preference saved in localStorage (${t1.stored})`);
  check(t1.events.includes('light'), `orograph:theme event announces the change (${t1.events.join(', ')})`);

  // ---- settings (device preferences)
  await page.keyboard.press(',');
  await sleep(250);
  const settingsOpen = await page.evaluate(() => window.orograph.store.get('ui.settingsOpen'));
  check(settingsOpen === 1, `"," opens Settings (ui.settingsOpen ${settingsOpen})`);
  const seg = page.locator('[role=dialog] .seg-btn[data-value="low"]').first();
  await seg.waitFor({ state: 'visible', timeout: 30000 }).catch(() => {});
  if (await seg.count()) await seg.click({ timeout: 10000, force: true }).catch(() => {});
  await sleep(200);
  await page.evaluate(() => {
    const o = window.orograph;
    o.store.set('ui.renderStyle', 'contour', { source: 'test' });
    o.store.set('ui.audioQuality', 'eco', { source: 'test' });
    o.ui.ctx.prefs.set('reduceMotion', 'on');
  });
  await page.keyboard.press('Escape');
  await sleep(150);
  const settingsClosed = await page.evaluate(() => window.orograph.store.get('ui.settingsOpen'));
  check(settingsClosed === 0, `Esc closes Settings (ui.settingsOpen ${settingsClosed})`);

  // ---- session: change a few things the autosave should keep
  const change = await page.evaluate(async () => {
    const o = window.orograph;
    const pick = o.presets.patches().filter(p => p.factory)[7];
    o.presets.loadPatch(2, pick.id);
    o.store.set('parts.1.params.cutoff', 1234, { source: 'test' });
    o.store.set('global.tempo', 97, { source: 'test' });
    o.store.set('global.scaleRoot', 2, { source: 'test' });
    o.store.set('parts.3.seq.steps.5.on', 1, { source: 'test' });
    o.store.set('parts.3.seq.steps.5.degree', 4, { source: 'test' });
    o.store.set('parts.0.params.centerX', 0.137, { source: 'test' });
    o.store.set('ui.selectedPart', 2, { source: 'test' });
    await new Promise(r => setTimeout(r, 1200));
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem('orograph.session.v1')); } catch { /* none */ }
    const moving = [0, 1, 2, 3].filter(p => o.store.get(`parts.${p}.dot.mode`) > 0);
    return { patch: pick.name, savedTempo: saved && saved.global && saved.global.tempo, quality: o.store.get('ui.quality'), moving, dotModes: [0, 1, 2, 3].map(p => o.store.get(`parts.${p}.dot.mode`)) };
  });
  check(change.savedTempo === 97, `session autosaved to localStorage within 1.2 s (saved tempo ${change.savedTempo}; parts with a moving dot: ${change.moving.map(p => p + 1).join(', ') || 'none'})`);
  check(change.quality === 'low', `Visual quality "Low" button sets ui.quality (${change.quality})`);

  const before = errors.length;
  await page.reload({ waitUntil: 'load', timeout: 180000 });
  await waitBoot(page);
  const back = await page.evaluate(() => {
    const o = window.orograph, s = o.store;
    return {
      theme: document.documentElement.dataset.theme, pref: s.get('ui.theme'),
      quality: s.get('ui.quality'), renderStyle: s.get('ui.renderStyle'), audioQuality: s.get('ui.audioQuality'), motion: document.documentElement.dataset.motion,
      patch: s.get('parts.2.patchName'), cutoff: s.get('parts.1.params.cutoff'), tempo: s.get('global.tempo'), root: s.get('global.scaleRoot'),
      step: s.get('parts.3.seq.steps.5'), cx: s.get('parts.0.params.centerX'), sel: s.get('ui.selectedPart'),
    };
  });
  back.shownPatch = await page.waitForFunction((name) => {
    const el = document.querySelectorAll('.part-tab .part-patch')[2];
    return el && el.textContent === name ? el.textContent : false;
  }, change.patch, { timeout: 30000 }).then(h => h.jsonValue()).catch(() => page.evaluate(() => (document.querySelectorAll('.part-tab .part-patch')[2] || {}).textContent));
  check(back.theme === 'light' && back.pref === 'light', `theme survives a reload (pref ${back.pref}, resolved ${back.theme})`);
  check(back.quality === 'low' && back.renderStyle === 'contour' && back.audioQuality === 'eco', `settings survive a reload (quality ${back.quality}, style ${back.renderStyle}, audio ${back.audioQuality})`);
  check(back.motion === 'reduce', `reduce-motion preference survives a reload (data-motion ${back.motion})`);
  check(back.patch === change.patch && back.shownPatch === change.patch, `session restores part 3's patch "${change.patch}" (store ${back.patch}, tab shows ${back.shownPatch})`);
  check(Math.abs(back.cutoff - 1234) < 1e-6, `session restores part 2 cutoff 1234 Hz (${back.cutoff})`);
  check(back.tempo === 97 && back.root === 2, `session restores tempo 97 and key D (tempo ${back.tempo}, root ${back.root})`);
  check(back.step && back.step.on === 1 && back.step.degree === 4, `session restores sequencer step 6 of part 4 (${JSON.stringify(back.step && { on: back.step.on, degree: back.step.degree })})`);
  check(Math.abs(back.cx - 0.137) < 1e-3, `session restores the dot position of part 1 (centerX ${fmt(back.cx)}; dot mode ${await page.evaluate(() => window.orograph.store.get('parts.0.dot.mode'))})`);
  console.log(`       selected part after reload: ${back.sel + 1} (was 3; ui state is not part of the session)`);
  errorCheck(errors, before, 'reload');

  // A moving dot (Roll, Drift, Explore, Tour) is written to the store by
  // src/visual/dot-sim.js every 15 ms (selected part) or 50 ms (other parts).
  // The 3D view only steps on animation frames, which this machine may not
  // deliver, so the same write pattern is also produced directly.
  const drift = await page.evaluate(async () => {
    const o = window.orograph, T = window.__t;
    o.presets.loadPatch(1, 'Tidal Flats');
    const mode = o.store.get('parts.1.dot.mode');
    let writes = 0;
    const off = o.store.subscribe('parts.1.params.centerX', () => writes++);
    const fps = await T.fps(1500);
    off();
    o.store.set('global.tempo', 101, { source: 'test' });
    let x = 0.3;
    const h = setInterval(() => { x = (x + 0.003) % 1; o.store.batch(() => { o.store.set('parts.1.params.centerX', x, { source: 'physics', user: false }); }); }, 50);
    await T.sleep(3000);
    clearInterval(h);
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem('orograph.session.v1')); } catch { /* none */ }
    await T.sleep(1200);
    let after = null;
    try { after = JSON.parse(localStorage.getItem('orograph.session.v1')); } catch { /* none */ }
    return { mode, writes, fps, savedTempo: saved && saved.global.tempo, afterTempo: after && after.global.tempo, visuals: !!o.visuals };
  });
  console.log(`       Tidal Flats (dot mode ${drift.mode}): ${drift.writes} dot writes from the 3D view in 1.5 s at ${fmt(drift.fps, 1)} frames/s`);
  check(drift.savedTempo === 101, `autosave still happens while a dot moves (tempo set to 101, then 3 s of dot writes every 50 ms like Drift: saved session has tempo ${drift.savedTempo}; 1.2 s after the dot stopped: ${drift.afterTempo})`);

  // Closing or reloading right after a change must not lose it.
  await page.evaluate(() => { window.orograph.presets.loadPatch(1, window.orograph.presets.patches()[0].id); window.orograph.store.set('global.tempo', 133, { source: 'test' }); });
  await sleep(80);
  await page.reload({ waitUntil: 'load', timeout: 180000 });
  await waitBoot(page);
  const quick = await page.evaluate(() => window.orograph.store.get('global.tempo'));
  check(quick === 133, `a change made just before a reload is kept (tempo 133 set 80 ms before reload, restored ${quick})`);

  // Put the theme back to System for the next tests in this context.
  await page.evaluate(() => window.orograph.store.set('ui.theme', 'system', { source: 'test' }));
  await context.close();
}

async function sectionRecording(browser, base) {
  current = 'recording';
  const { page, errors, context } = await openApp(browser, base);
  await startAudio(page);
  await lowQuality(page);
  // API path: engine.startRecording / stopRecording -> 24-bit stereo WAV of the right length.
  const api = await page.evaluate(async () => {
    const o = window.orograph, T = window.__t;
    o.engine.noteOn(0, 60, 0.9);
    await o.engine.startRecording();
    const t0 = performance.now();
    await T.sleep(1500);
    const blob = await o.engine.stopRecording();
    const wall = (performance.now() - t0) / 1000;
    o.engine.noteOff(0, 60);
    const buf = new Uint8Array(await blob.arrayBuffer());
    return { wall, bytes: Array.from(buf), type: blob.type, sr: o.engine.context.sampleRate };
  });
  const wav = parseWav(Buffer.from(api.bytes));
  check(!wav.error, `engine.stopRecording() returns a WAV (${wav.error || `${wav.channels} ch, ${wav.bits}-bit, ${wav.sampleRate} Hz`})`);
  if (!wav.error) {
    check(wav.channels === 2 && wav.bits === 24 && wav.sampleRate === api.sr, `recording is 24-bit stereo at the context rate (${wav.channels} ch, ${wav.bits} bit, ${wav.sampleRate} Hz vs ${api.sr})`);
    check(Math.abs(wav.seconds - api.wall) < 0.25, `recording length matches the time recorded (${fmt(wav.seconds, 3)} s vs ${fmt(api.wall, 3)} s wall clock)`);
    // Not silent: look at the 24-bit samples.
    const buf = Buffer.from(api.bytes);
    let dataOff = buf.indexOf(Buffer.from('data')) + 8, peak = 0;
    for (let i = dataOff; i + 2 < buf.length; i += 3) { const v = buf.readIntLE(i, 3) / 8388608; if (Math.abs(v) > peak) peak = Math.abs(v); }
    check(peak > 0.01 && peak <= 1, `recorded audio is not silent and within full scale (peak ${fmt(peak)})`);
  }
  // UI path: R starts, R stops, and a WAV download of about the same length appears.
  await page.evaluate(() => { document.activeElement && document.activeElement.blur(); window.orograph.engine.noteOn(0, 64, 0.8); });
  await page.keyboard.press('r');
  const tR = Date.now();
  await sleep(2000);
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 8000 }).catch(() => null), page.keyboard.press('r')]);
  const wallUi = (Date.now() - tR) / 1000;
  await page.evaluate(() => window.orograph.engine.noteOff(0, 64));
  check(!!dl, `R starts and R stops a recording that downloads (${dl ? dl.suggestedFilename() : 'no download'})`);
  if (dl) {
    const file = await dl.path();
    const w2 = parseWav(fs.readFileSync(file));
    check(!w2.error && Math.abs(w2.seconds - wallUi) < 0.35, `the downloaded WAV is about as long as the recording (${fmt(w2.seconds, 3)} s vs ${fmt(wallUi, 3)} s between key presses)`, w2.error);
    check(/^orograph-\d{8}-\d{6}\.wav$/.test(dl.suggestedFilename()), `recording file name follows orograph-YYYYMMDD-HHMMSS.wav (${dl.suggestedFilename()})`);
  }
  errorCheck(errors, 0, 'recording');
  await context.close();
}

async function sectionImport(browser, base) {
  current = 'import';
  const { page, errors, context } = await openApp(browser, base);
  await startAudio(page);
  await lowQuality(page);
  // PNG through the map panel's file input, like a person choosing a file.
  const png = grayPng(128, 128, (x, y) => 0.5 + 0.5 * Math.sin(2 * Math.PI * x * 3) * Math.cos(2 * Math.PI * y * 2));
  await page.evaluate(() => window.orograph.store.set('ui.selectedPart', 0, { source: 'test' }));
  await sleep(200);
  const input = page.locator('.terrain-slot[data-slot="A"] input[type=file]').first();
  let viaUi = false;
  if (await input.count()) {
    await input.setInputFiles({ name: 'test-ridges.png', mimeType: 'image/png', buffer: png });
    await sleep(300);
    const confirm = page.locator('.popover--import .btn--primary');
    await confirm.first().waitFor({ state: 'visible', timeout: 20000 }).catch(() => {});
    if (await confirm.count()) { await confirm.first().click({ force: true }); viaUi = true; }
  }
  if (!viaUi) {
    await page.evaluate(async (b64) => {
      const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
      await window.orograph.engine.importTerrainFile(0, 'A', new File([bytes], 'test-ridges.png', { type: 'image/png' }));
    }, png.toString('base64'));
  }
  await page.waitForFunction(() => window.orograph.store.get('parts.0.userTerrain.A'), null, { timeout: 8000 }).catch(() => {});
  const img = await page.evaluate(async () => {
    const o = window.orograph, T = window.__t;
    const { TERRAIN_INDEX } = await import('/src/dsp/catalog.js');
    const ut = o.store.get('parts.0.userTerrain.A');
    await Promise.race([o.engine.whenTerrainsReady(), T.sleep(4000)]);
    o.store.set('parts.0.params.morph', 0, { source: 'test' });
    const t = o.engine.getTerrain(0, 'A');
    let bad = 0, lo = Infinity, hi = -Infinity;
    if (t) for (const v of t.data) { if (!Number.isFinite(v)) bad++; else { lo = Math.min(lo, v); hi = Math.max(hi, v); } }
    o.engine.panic();
    await T.sleep(50);
    o.engine.noteOn(0, 60, 0.9);
    const a = await T.waitAudible(1500, 0.002);
    o.engine.noteOff(0, 60);
    return { ut: ut && { kind: ut.kind, w: ut.w, h: ut.h, name: ut.name }, terrainA: o.store.get('parts.0.params.terrainA'), user: TERRAIN_INDEX.user, size: t && t.size, bad, lo, hi, a };
  });
  check(!!img.ut && img.ut.kind === 'image', `PNG import ${viaUi ? 'through the map panel' : 'through the engine'} stores an image terrain (${JSON.stringify(img.ut)})`);
  check(img.terrainA === img.user, `PNG import switches terrain A to Imported (${img.terrainA} vs ${img.user})`);
  check(img.bad === 0 && img.hi - img.lo > 0.1, `imported image table is finite with relief (range ${fmt(img.lo)}..${fmt(img.hi)}, size ${img.size})`);
  check(img.a.ms >= 0 && img.a.bad === 0, `imported image terrain sounds (rms ${fmt(img.a.rms)})`);

  // WAV wavetable generated in the page: 16 single cycles of 2048 samples, sine morphing to saw.
  const wt = await page.evaluate(async () => {
    const o = window.orograph, T = window.__t;
    const frames = 16, N = 2048, sr = 44100;
    const pcm = new Int16Array(frames * N);
    for (let f = 0; f < frames; f++) {
      const k = f / (frames - 1);
      for (let i = 0; i < N; i++) {
        const ph = i / N;
        const v = (1 - k) * Math.sin(2 * Math.PI * ph) + k * (2 * ph - 1);
        pcm[f * N + i] = Math.round(v * 0.8 * 32767);
      }
    }
    const buf = new ArrayBuffer(44 + pcm.byteLength);
    const dv = new DataView(buf);
    const str = (o2, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(o2 + i, s.charCodeAt(i)); };
    str(0, 'RIFF'); dv.setUint32(4, 36 + pcm.byteLength, true); str(8, 'WAVE');
    str(12, 'fmt '); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
    dv.setUint32(24, sr, true); dv.setUint32(28, sr * 2, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true);
    str(36, 'data'); dv.setUint32(40, pcm.byteLength, true);
    new Int16Array(buf, 44).set(pcm);
    const file = new File([buf], 'test-sine-saw.wav', { type: 'audio/wav' });
    let err = null;
    try { await o.engine.importTerrainFile(0, 'B', file); } catch (e) { err = String(e && e.message || e); }
    const ut = o.store.get('parts.0.userTerrain.B');
    await Promise.race([o.engine.whenTerrainsReady(), T.sleep(4000)]);
    o.store.set('parts.0.params.morph', 1, { source: 'test' });
    const t = o.engine.getTerrain(0, 'B');
    let bad = 0, lo = Infinity, hi = -Infinity;
    if (t) for (const v of t.data) { if (!Number.isFinite(v)) bad++; else { lo = Math.min(lo, v); hi = Math.max(hi, v); } }
    o.engine.panic();
    await T.sleep(50);
    o.engine.noteOn(0, 60, 0.9);
    const a = await T.waitAudible(1500, 0.002);
    o.engine.noteOff(0, 60);
    const stats = o.engine.stats().import;
    return { err, ut: ut && { kind: ut.kind, w: ut.w, h: ut.h, name: ut.name }, terrainB: o.store.get('parts.0.params.terrainB'), bad, lo, hi, a, last: stats && stats.last };
  });
  check(!wt.err && !!wt.ut && wt.ut.kind === 'wavetable', `WAV wavetable import stores a wavetable terrain (${wt.err || JSON.stringify(wt.ut)})`);
  check(!!wt.ut && wt.ut.h >= 16, `all 16 frames of the 2048-sample wavetable are found (h ${wt.ut && wt.ut.h}, detection ${JSON.stringify(wt.last)})`);
  check(wt.bad === 0 && wt.hi - wt.lo > 0.1, `wavetable terrain table is finite with relief (range ${fmt(wt.lo)}..${fmt(wt.hi)})`);
  check(wt.a.ms >= 0 && wt.a.bad === 0, `wavetable terrain sounds with Morph on B (rms ${fmt(wt.a.rms)})`);
  errorCheck(errors, 0, 'import');
  await context.close();
}

async function sectionShortcuts(browser, base) {
  current = 'shortcuts';
  const { page, errors, context } = await openApp(browser, base);
  await startAudio(page);
  const get = (p) => page.evaluate((path) => window.orograph.store.get(path), p);
  await page.mouse.click(5, 5).catch(() => {});
  await page.evaluate(() => { if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur(); });

  await page.keyboard.press('Space');
  await sleep(400);
  const playing1 = await get('ui.playing');
  const steps = await page.evaluate(async () => { let n = 0; const off = window.orograph.music.transport.on('step', () => n++); await new Promise(r => setTimeout(r, 600)); off(); return n; });
  await page.keyboard.press('Space');
  await sleep(200);
  const playing2 = await get('ui.playing');
  check(playing1 === 1 && steps > 0 && playing2 === 0, `Space plays and stops (playing ${playing1} -> ${playing2}, ${steps} steps in 0.6 s)`);

  const parts = [];
  for (const k of ['2', '3', '4', '1']) { await page.keyboard.press(k); await sleep(60); parts.push(await get('ui.selectedPart')); }
  check(parts.join(',') === '1,2,3,0', `keys 1-4 select parts (got ${parts.map(p => p + 1).join(',')})`);

  await page.keyboard.press('?');
  await sleep(250);
  const help = await page.evaluate(() => ({ open: window.orograph.store.get('ui.helpOpen'), dialog: !!document.querySelector('[role=dialog][aria-modal=true]') }));
  await page.keyboard.press('Escape');
  await sleep(250);
  const helpAfter = await get('ui.helpOpen');
  check(help.open === 1 && help.dialog, `? opens Help (ui.helpOpen ${help.open}, modal dialog ${help.dialog})`);
  check(helpAfter === 0, `Esc closes Help (ui.helpOpen ${helpAfter})`);

  const oct0 = await get('ui.keyboardOctave');
  await page.keyboard.press('z'); await sleep(60);
  const oct1 = await get('ui.keyboardOctave');
  await page.keyboard.press('x'); await page.keyboard.press('x'); await sleep(60);
  const oct2 = await get('ui.keyboardOctave');
  await page.keyboard.press('z'); await sleep(60);
  check(oct1 === oct0 - 1 && oct2 === oct0 + 1, `Z / X shift the keyboard octave (${oct0} -> ${oct1} -> ${oct2})`);

  const octave = await get('ui.keyboardOctave');
  const expectA = 12 * (octave + 1);
  await page.evaluate(() => { window.__notes = []; window.orograph.music.router.on('note', e => window.__notes.push(e)); });
  await page.keyboard.down('a');
  await sleep(250);
  const held = await page.evaluate(() => ({ held: [...window.orograph.music.router.heldNotes('sel')], rms: window.__t.sample().rms }));
  await page.keyboard.down('k');
  await sleep(150);
  const held2 = await page.evaluate(() => [...window.orograph.music.router.heldNotes('sel')]);
  await page.keyboard.up('a');
  await page.keyboard.up('k');
  await sleep(150);
  const released = await page.evaluate(() => [...window.orograph.music.router.heldNotes('sel')]);
  check(held.held.includes(expectA), `QWERTY "A" plays C${octave} = note ${expectA} (held ${JSON.stringify(held.held)}, rms ${fmt(held.rms)})`);
  check(held2.includes(expectA + 12), `QWERTY "K" plays the C an octave up = ${expectA + 12} (held ${JSON.stringify(held2)})`);
  check(released.length === 0, `releasing the keys releases the notes (held ${JSON.stringify(released)})`);
  check(held.rms > 0.002, `QWERTY note is audible (rms ${fmt(held.rms)})`);

  const p0 = await get('parts.0.patchName');
  await page.keyboard.press(']'); await sleep(120);
  const p1 = await get('parts.0.patchName');
  await page.keyboard.press('['); await sleep(120);
  const p2 = await get('parts.0.patchName');
  check(p1 !== p0 && p2 === p0, `] / [ step through patches (${p0} -> ${p1} -> ${p2})`);

  // Esc cancels a MIDI learn started from a knob's menu (learning works without a device).
  const knob = page.locator('.knob[data-param="cutoff"] .knob-dial').first();
  if (await knob.count()) {
    await knob.click({ button: 'right', force: true });
    await sleep(200);
    const item = page.locator('.menu-item', { hasText: 'MIDI Learn' }).first();
    const hasItem = await item.count();
    if (hasItem) await item.click({ force: true });
    await sleep(150);
    const learning = await get('ui.midiLearn');
    await page.keyboard.press('Escape');
    await sleep(150);
    const after = await get('ui.midiLearn');
    check(hasItem > 0 && learning === 1 && after === 0, `knob menu MIDI Learn starts learning and Esc cancels it (menu item ${hasItem > 0}, learning ${learning} -> ${after})`);
  } else {
    check(false, 'cutoff knob found on the Sound panel');
  }
  errorCheck(errors, 0, 'shortcuts');
  await context.close();
}

async function sectionMidi(browser, base) {
  current = 'midi';
  const { page, errors, context } = await openApp(browser, base, { midi: true });
  await startAudio(page);
  await lowQuality(page);
  const st = await page.evaluate(async () => {
    const o = window.orograph;
    for (let i = 0; i < 40 && o.midi.status !== 'ready'; i++) await new Promise(r => setTimeout(r, 50));
    return {
      status: o.midi.status, requests: window.__fakeMidi.requests,
      inputs: o.midi.inputs(), output: o.midi.output,
      tip: document.querySelector('.midi-btn') && document.querySelector('.midi-btn').dataset.tip,
      attached: [...window.__fakeMidi.access.inputs.values()].map(p => typeof p.onmidimessage === 'function'),
    };
  });
  check(st.status === 'ready', `with permission already granted, MIDI connects at startup (status ${st.status}, ${st.requests} request(s))`);
  check(st.inputs.length === 2 && st.inputs.every(i => i.isMpc), `both MPC ports are detected as an MPC (${st.inputs.map(i => `${i.name}:${i.isMpc}`).join(', ')})`);
  check(st.output && st.output.name === 'MPC MIDI 1', `the output picks "MPC MIDI 1" automatically (${st.output && st.output.name})`);
  check(/MPC/.test(st.tip || ''), `the MIDI button says an MPC was detected ("${st.tip}")`);
  check(st.attached.every(Boolean), `both MPC inputs are listening (${st.attached.join(',')})`);

  // Note input routing: omni to the selected part, then multi-channel.
  const notes = await page.evaluate(async () => {
    const o = window.orograph, T = window.__t, F = window.__fakeMidi;
    o.engine.panic();
    o.store.set('ui.selectedPart', 1, { source: 'test' });
    o.music.transport.stop();
    F.fire('mpc-in-1', [0x90, 62, 100]);
    await T.sleep(250);
    const heldSel = [...o.music.router.heldNotes(1)];
    const rms = T.sample().rms;
    const voices = T.voices();
    F.fire('mpc-in-1', [0x80, 62, 0]);
    await T.sleep(50);
    const afterOff = [...o.music.router.heldNotes(1)];
    o.midi.setChannelMode('multi');
    F.fire('mpc-in-1', [0x92, 65, 90]);   // channel 3 -> part 3
    await T.sleep(120);
    const heldMulti = [0, 1, 2, 3].map(p => [...o.music.router.heldNotes(p)]);
    F.fire('mpc-in-1', [0x92, 65, 0]);     // note-on velocity 0 = note-off
    await T.sleep(50);
    const afterMulti = [0, 1, 2, 3].map(p => [...o.music.router.heldNotes(p)].length);
    o.midi.setChannelMode('omni');
    // Sustain pedal: held over the note-off, released with the pedal.
    F.fire('mpc-in-1', [0xb0, 64, 127]);
    F.fire('mpc-in-1', [0x90, 60, 100]);
    F.fire('mpc-in-1', [0x80, 60, 0]);
    await T.sleep(60);
    const sustained = [...o.music.router.heldNotes(1)];
    F.fire('mpc-in-1', [0xb0, 64, 0]);
    await T.sleep(60);
    const pedalUp = [...o.music.router.heldNotes(1)];
    return { heldSel, rms, voices, afterOff, heldMulti, afterMulti, sustained, pedalUp };
  });
  check(notes.heldSel.includes(62) && notes.rms > 0.002, `MPC pad (note 62, ch 1) plays the selected part 2 (held ${JSON.stringify(notes.heldSel)}, rms ${fmt(notes.rms)}, voices ${JSON.stringify(notes.voices)})`);
  check(notes.afterOff.length === 0, `MIDI note-off releases it (${JSON.stringify(notes.afterOff)})`);
  check(notes.heldMulti[2].includes(65) && notes.heldMulti[1].length === 0, `multi mode: channel 3 plays part 3 only (${JSON.stringify(notes.heldMulti)})`);
  check(notes.afterMulti.every(n => n === 0), `note-on with velocity 0 counts as note-off (${notes.afterMulti.join('/')})`);
  check(notes.sustained.includes(60) && notes.pedalUp.length === 0, `sustain pedal holds then releases (${JSON.stringify(notes.sustained)} -> ${JSON.stringify(notes.pedalUp)})`);

  // CC learn through the API, then through a knob, and persistence of the mapping.
  const learn = await page.evaluate(async () => {
    const o = window.orograph, F = window.__fakeMidi;
    const P = await import('/src/core/params.js');
    o.store.set('ui.selectedPart', 0, { source: 'test' });
    const pending = o.midi.learn('parts.sel.params.cutoff');
    F.fire('mpc-in-1', [0xb0, 21, 64]);
    const m = await Promise.race([pending, new Promise(r => setTimeout(() => r('timeout'), 1000))]);
    const v1 = o.store.get('parts.0.params.cutoff');
    F.fire('mpc-in-1', [0xb0, 21, 127]);
    const v2 = o.store.get('parts.0.params.cutoff');
    F.fire('mpc-in-1', [0xb0, 21, 0]);
    const v3 = o.store.get('parts.0.params.cutoff');
    const def = P.PART_PARAM_MAP.cutoff;
    const saved = JSON.parse(localStorage.getItem('orograph.midi') || '{}');
    // A CC on another channel than the learned one must not move it.
    F.fire('mpc-in-1', [0xb5, 21, 127]);
    const v4 = o.store.get('parts.0.params.cutoff');
    return { m, v1, v2, v3, v4, want1: P.fromNorm(def, 64 / 127), min: def.min, max: def.max, saved: (saved.mappings || []).length };
  });
  check(learn.m && learn.m !== 'timeout' && learn.m.cc === 21, `MIDI learn maps CC 21 to Cutoff (${JSON.stringify(learn.m)})`);
  check(Math.abs(learn.v1 - learn.want1) < 1e-6 && Math.abs(learn.v2 - learn.max) < 1e-6 && Math.abs(learn.v3 - learn.min) < 1e-6,
    `learned CC moves Cutoff across its range (64 -> ${fmt(learn.v1, 1)} Hz, 127 -> ${fmt(learn.v2, 0)}, 0 -> ${fmt(learn.v3, 1)})`);
  check(Math.abs(learn.v4 - learn.min) < 1e-6, `the mapping is channel specific (CC 21 on channel 6 left Cutoff at ${fmt(learn.v4, 1)})`);
  check(learn.saved >= 1, `the mapping is saved (${learn.saved} in orograph.midi)`);

  const knob = page.locator('.knob[data-param="resonance"] .knob-dial').first();
  let knobLearn = { ok: false, note: 'resonance knob not found' };
  if (await knob.count()) {
    await knob.click({ button: 'right', force: true });
    await sleep(200);
    await page.locator('.menu-item', { hasText: 'MIDI Learn' }).first().click({ force: true }).catch(() => {});
    await sleep(150);
    knobLearn = await page.evaluate(async () => {
      const o = window.orograph, F = window.__fakeMidi;
      const learning = o.store.get('ui.midiLearn');
      F.fire('mpc-in-1', [0xb0, 22, 127]);
      await new Promise(r => setTimeout(r, 200));
      const maps = o.midi.mappings();
      return { ok: true, learning, after: o.store.get('ui.midiLearn'), map: maps.find(m => m.target.id === 'resonance'), reso: o.store.get('parts.0.params.resonance'), pip: !!document.querySelector('.knob[data-param="resonance"].is-mapped, .knob[data-param="resonance"] .knob-midi:not([hidden])') };
    });
  }
  check(knobLearn.ok && knobLearn.learning === 1 && knobLearn.map && knobLearn.map.cc === 22 && knobLearn.after === 0 && Math.abs(knobLearn.reso - 1) < 1e-6,
    `right-click a knob > MIDI Learn, twist a Q-Link: mapped (${JSON.stringify(knobLearn)})`);

  // Clock follow: Start + 0xF8 at 120 bpm.
  const clock = await page.evaluate(async () => {
    const o = window.orograph, T = window.__t, F = window.__fakeMidi;
    o.store.set('global.tempo', 100, { source: 'test' });
    o.midi.setSetting('followClock', true);
    const badge = () => { const b = document.querySelector('.ext-badge'); return !!b && !b.hidden; };
    const tempoInput = () => document.querySelector('.tempo input');
    // Pulses at `bpm` for up to `ms`, timestamped on the ideal grid; `until` may end it early.
    const sendClock = async (bpm, ms, startMsg, until) => {
      const iv = 60000 / (bpm * 24);
      const t0 = performance.now();
      if (startMsg) F.fire('mpc-in-1', [startMsg], t0);
      let i = 0;
      await new Promise((resolve) => {
        const h = setInterval(() => {
          const now = performance.now();
          while (t0 + i * iv <= now) { F.fire('mpc-in-1', [0xf8], t0 + i * iv); i++; }
          if (now - t0 >= ms || (until && until(now - t0))) { clearInterval(h); resolve(); }
        }, 4);
      });
      return i;
    };
    let steps = 0;
    const off = o.music.transport.on('step', () => steps++);
    const pulses = await sendClock(120, 3000, 0xfa);
    const a = { tempo: o.store.get('global.tempo'), ext: o.midi.externalClock, playing: o.music.transport.isPlaying(), external: o.music.transport.isExternal(), steps, pulses, tTempo: o.music.transport.tempo() };
    // Keep the clock running while the UI paints its next frame (it can be slow here).
    let done = false;
    const running = sendClock(120, 60000, null, () => done);
    const t1 = performance.now();
    await T.uiTick(45000);
    await T.uiTick(15000);
    a.badgeAt = badge() ? performance.now() - t1 : -1;
    a.readOnly = !!(tempoInput() && tempoInput().readOnly);
    done = true;
    await running;
    steps = 0;
    await sendClock(140, 2500, null);
    const b = { tempo: o.store.get('global.tempo'), bpm: o.midi.externalClock.bpm, steps };
    F.fire('mpc-in-1', [0xfc]);
    await T.sleep(100);
    const c = { playing: o.music.transport.isPlaying(), ui: o.store.get('ui.playing') };
    off();
    // The clock has stopped for good: once the follower says no clock is
    // arriving (500 ms), the badge and the read-only tempo should go away by the
    // UI's next frames.
    await T.sleep(1500);
    await T.uiTick(45000);
    await T.uiTick(15000);
    const inp = tempoInput();
    const e = { gone: !badge() && !(inp && inp.readOnly), badge: badge(), readOnly: !!(inp && inp.readOnly), active: o.midi.externalClock.active };
    // Clock with no Start: tempo display follows, transport stays stopped.
    o.store.set('global.tempo', 100, { source: 'test' });
    await T.sleep(600);
    await sendClock(120, 1500, null);
    const d = { tempo: o.store.get('global.tempo'), bpm: o.midi.externalClock.bpm, playing: o.music.transport.isPlaying() };
    o.midi.setSetting('followClock', false);
    return { a, b, c, d, e };
  });
  check(clock.a.playing && clock.a.external, `MIDI Start + clock starts the transport on the external clock (playing ${clock.a.playing}, external ${clock.a.external})`);
  check(clock.a.tempo === 120, `following a 120 bpm MIDI clock sets the tempo to 120 (store ${clock.a.tempo}, display ${clock.a.ext.bpm}, transport ${fmt(clock.a.tTempo, 2)}, ${clock.a.pulses} pulses)`);
  check(clock.a.steps >= 20, `sequencer steps follow the clock (${clock.a.steps} step events in 3 s)`);
  check(clock.a.badgeAt >= 0 && clock.a.readOnly, `the EXT badge shows and the tempo is read-only while following (badge ${clock.a.badgeAt >= 0 ? 'shown' : 'hidden'} after the UI's next frames, read-only ${clock.a.readOnly})`);
  check(Math.abs(clock.b.tempo - 140) <= 1, `a tempo change to 140 bpm is followed (store ${clock.b.tempo}, display ${clock.b.bpm})`);
  check(!clock.c.playing && clock.c.ui === 0, `MIDI Stop stops the transport (playing ${clock.c.playing}, ui ${clock.c.ui})`);
  check(clock.e.gone, `when the clock stops arriving, the EXT badge goes away and the tempo can be edited again (1.5 s after MIDI Stop and two UI frames: badge ${clock.e.badge}, read-only ${clock.e.readOnly}, clock active ${clock.e.active})`);
  console.log(`       clock without Start: store tempo ${clock.d.tempo}, displayed ${clock.d.bpm}, transport playing ${clock.d.playing}`);

  // Send notes to the MPC, then Panic.
  const out = await page.evaluate(async () => {
    const o = window.orograph, T = window.__t, F = window.__fakeMidi;
    const port = F.access.outputs.get('mpc-out-1');
    port.sent.length = 0;
    o.midi.setSetting('sendNotes', true);
    o.music.router.noteOn(0, 60, 0.8, 'ui');
    await T.sleep(100);
    o.music.router.noteOff(0, 60, 'ui');
    await T.sleep(50);
    o.music.transport.play();
    await T.sleep(1200);
    o.music.transport.stop();
    await T.sleep(400);
    const ons = port.sent.filter(s => (s.data[0] & 0xf0) === 0x90 && s.data[2] > 0).length;
    const offs = port.sent.filter(s => (s.data[0] & 0xf0) === 0x80 || ((s.data[0] & 0xf0) === 0x90 && s.data[2] === 0)).length;
    port.sent.length = 0;
    o.midi.panic();
    const cc123 = port.sent.filter(s => (s.data[0] & 0xf0) === 0xb0 && s.data[1] === 123).length;
    o.midi.setSetting('sendNotes', false);
    return { ons, offs, cc123 };
  });
  check(out.ons > 0 && out.ons === out.offs, `Send notes mirrors notes to the MPC with matching note-offs (${out.ons} on, ${out.offs} off)`);
  check(out.cc123 >= 4, `Panic sends All Notes Off on every part's channel (${out.cc123} CC 123)`);

  // Reload: the learned mappings and settings come back.
  const before = errors.length;
  await page.reload({ waitUntil: 'load', timeout: 180000 });
  await waitBoot(page);
  const re = await page.evaluate(async () => {
    const o = window.orograph;
    for (let i = 0; i < 40 && o.midi.status !== 'ready'; i++) await new Promise(r => setTimeout(r, 50));
    return { status: o.midi.status, maps: o.midi.mappings().map(m => `${m.cc}:${m.target.id}`) };
  });
  check(re.status === 'ready' && re.maps.includes('21:cutoff') && re.maps.includes('22:resonance'), `MIDI reconnects and keeps the mappings after a reload (${re.status}, ${re.maps.join(', ')})`);
  errorCheck(errors, 0, 'midi');
  await context.close();
}

async function sectionSoak(browser, base) {
  current = 'soak';
  const { page, errors, context } = await openApp(browser, base);
  await startAudio(page);
  const r = await page.evaluate(async (seconds) => {
    const o = window.orograph, T = window.__t;
    const gc = typeof window.gc === 'function' ? window.gc : null;
    o.presets.loadScene(0);
    await Promise.race([o.engine.whenTerrainsReady(), T.sleep(4000)]);
    await T.sleep(500);
    if (gc) { gc(); gc(); }
    await T.sleep(200);
    const heap0 = performance.memory ? performance.memory.usedJSHeapSize : null;
    const lt0 = T.longTasks.length;
    let steps = 0;
    const off = o.music.transport.on('step', () => steps++);
    o.music.transport.play();
    const t0 = performance.now();
    const heap = [];
    let toggles = 0, bad = 0, peak = 0, minRms = Infinity, i = 0;
    let fps = 0, frames = 0;
    let raf = true;
    const count = () => { frames++; if (raf) requestAnimationFrame(count); };
    requestAnimationFrame(count);
    while (performance.now() - t0 < seconds * 1000) {
      i++;
      const p = i % 4;
      o.store.set(`parts.${p}.params.mute`, o.store.get(`parts.${p}.params.mute`) ? 0 : 1, { source: 'test' });
      toggles++;
      if (i % 4 === 0) o.store.set('ui.selectedPart', (i / 4) % 4, { source: 'test' });
      if (i % 12 === 0) o.presets.nextPatch(i % 4, 1);
      if (i % 9 === 0) o.store.set(`parts.${p}.params.morph`, (i % 10) / 10, { source: 'test' });
      const w = await T.watch(1500, 50);
      bad += w.bad; peak = Math.max(peak, w.peak); minRms = Math.min(minRms, w.minRms);
      if (performance.memory && i % 3 === 0) heap.push(performance.memory.usedJSHeapSize);
    }
    raf = false;
    const elapsed = (performance.now() - t0) / 1000;
    fps = frames / elapsed;
    o.music.transport.stop();
    off();
    for (let p = 0; p < 4; p++) o.store.set(`parts.${p}.params.mute`, 0, { source: 'test' });
    await T.sleep(500);
    if (gc) { gc(); gc(); }
    await T.sleep(300);
    const heap1 = performance.memory ? performance.memory.usedJSHeapSize : null;
    const lts = T.longTasks.slice(lt0);
    const tempo = o.store.get('global.tempo');
    return {
      seconds: elapsed, heap0, heap1, heapMax: Math.max(...heap, heap0 || 0), gc: !!gc, steps, tempo, toggles, bad, peak, fps,
      longCount: lts.length, longMax: Math.max(0, ...lts.map(x => x.d)), longTotal: lts.reduce((a, x) => a + x.d, 0),
      state: o.engine.context.state, recoveries: o.engine.stats().recoveries,
    };
  }, SOAK_SECONDS);
  const grow = r.heap1 != null && r.heap0 != null ? (r.heap1 - r.heap0) / 1048576 : null;
  const expectedSteps = 4 * r.seconds * (r.tempo / 60) * 2; // rough: the slowest common rate is 1/8 on scene 0
  console.log(`       soak: ${fmt(r.seconds, 1)} s, ${r.toggles} mute toggles, ${r.steps} step events, ${fmt(r.fps, 1)} fps, heap ${fmt(r.heap0 / 1048576, 1)} -> ${fmt(r.heap1 / 1048576, 1)} MB (max ${fmt(r.heapMax / 1048576, 1)}, gc ${r.gc}), long tasks ${r.longCount} (max ${fmt(r.longMax, 0)} ms, total ${fmt(r.longTotal, 0)} ms)`);
  check(r.bad === 0 && r.peak <= 1.0001, `soak: output finite and under full scale for ${fmt(r.seconds, 0)} s (bad ${r.bad}, peak ${fmt(r.peak)})`);
  check(grow != null && grow < 20, `soak: JS heap growth under 20 MB after GC (${fmt(grow, 2)} MB)`);
  check(r.steps >= expectedSteps * 0.5, `soak: the sequencer kept running (${r.steps} step events, rough floor ${Math.round(expectedSteps * 0.5)})`);
  check(r.longMax < 1000, `soak: no main-thread stall of 1 s or more (longest task ${fmt(r.longMax, 0)} ms)`);
  check(r.longTotal / (r.seconds * 1000) < 0.25, `soak: long tasks take under 25% of the time (${fmt(100 * r.longTotal / (r.seconds * 1000), 1)}%)`);
  check(r.state === 'running' && r.recoveries === 0, `soak: audio still running, no DSP restarts (${r.state}, ${r.recoveries} recoveries)`);
  errorCheck(errors, 0, 'soak');
  await context.close();
}

async function sectionSingle(browser) {
  current = 'single';
  try {
    execFileSync('npx', ['vite', 'build', '--mode', 'single', '--outDir', SINGLE_DIR, '--emptyOutDir'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], timeout: 240000 });
  } catch (err) {
    check(false, 'single-file build succeeds', String(err.stderr || err.message).slice(0, 1500));
    return;
  }
  const file = path.join(SINGLE_DIR, 'index.html');
  const files = fs.readdirSync(SINGLE_DIR);
  check(fs.existsSync(file), `single-file build writes index.html (${files.join(', ')}; ${fmt(fs.statSync(file).size / 1048576, 2)} MB)`);
  const { page, errors, context } = await openApp(browser, 'file://' + file, { hmr: false });
  const state = await startAudio(page);
  const r = await page.evaluate(async () => {
    const o = window.orograph, T = window.__t;
    [57, 60, 64].forEach(n => o.music.router.noteOn('sel', n, 0.9));
    const a = await T.waitAudible(1500, 0.005);
    const w = await T.watch(300);
    [57, 60, 64].forEach(n => o.music.router.noteOff('sel', n));
    return { a, w, mode: o.engine.mode, via: o.engine.stats().workletVia, secure: window.isSecureContext };
  });
  check(state === 'running', `file:// page starts audio (${state}, DSP ${r.mode} via ${r.via})`);
  check(r.a.ms >= 0 && r.w.bad === 0, `file:// page plays an audible chord (rms ${fmt(Math.max(r.a.rms, r.w.rms))}, ${fmt(r.a.ms, 0)} ms)`);
  check(r.w.peak <= 1.0001, `file:// output under full scale (peak ${fmt(r.w.peak)})`);
  errorCheck(errors, 0, 'single file');
  await page.screenshot({ path: `${OUT}/single.png` });
  await context.close();
}

// ------------------------------------------------------------------ main

(async () => {
  let server = null;
  let base = process.argv[2];
  const t0 = Date.now();
  if (!base) {
    server = await startServer();
    base = `http://127.0.0.1:${PORT}/`;
  }
  const browser = await chromium.launch({ args: ARGS });
  // [name, fn, time limit in seconds]: a hung page cannot stall the whole run.
  const sections = [
    ['boot', sectionBoot, 300], ['patches', sectionPatches, 900], ['scenes', sectionScenes, 600], ['stress', sectionStress, 600],
    ['extremes', sectionExtremes, 600], ['persistence', sectionPersistence, 900], ['recording', sectionRecording, 400],
    ['import', sectionImport, 400], ['shortcuts', sectionShortcuts, 400], ['midi', sectionMidi, 600],
    ['soak', sectionSoak, SOAK_SECONDS + 400], ['single', sectionSingle, 600],
  ];
  try {
    for (const [name, fn, limit] of sections) {
      if (!want(name)) continue;
      const s0 = Date.now();
      console.log(`\n== ${name} ==`);
      current = name;
      let timer = null;
      const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`timed out after ${limit} s`)), limit * 1000); });
      try { await Promise.race([fn(browser, base), timeout]); } catch (err) { current = name; check(false, `section crashed: ${err && err.message}`, err && err.stack && err.stack.split('\n').slice(1, 4).join('\n')); }
      clearTimeout(timer);
      console.log(`   (${name}: ${((Date.now() - s0) / 1000).toFixed(1)} s)`);
    }
  } finally {
    await Promise.race([browser.close().catch(() => {}), sleep(15000)]);
    stopServer(server);
  }
  console.log(`\n${results.pass} passed, ${results.fail} failed, ${results.skip} skipped in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
  if (results.fail) console.log('Failures:\n  ' + results.failures.join('\n  '));
  process.exit(results.fail ? 1 : 0);
})();
