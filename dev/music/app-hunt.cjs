// Music-module checks against the real app (not the harness): every factory
// scene for 4 bars, stuck notes after stop, scene and patch changes while
// playing, arp hold, MIDI clock follow from a fake MIDI device, the patch
// preview and offline event rendering.
//
//   node dev/music/app-hunt.cjs http://127.0.0.1:5192/
//
// The 3D view is paused while measuring so a slow software-GL machine does
// not starve the scheduler. Exit code 1 on any failure.

const { chromium } = require('/opt/node22/lib/node_modules/playwright');

const URL_ = process.argv[2] || 'http://127.0.0.1:5192/';
const BOOT_MS = Number(process.env.BOOT_MS) || 180000;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const failures = [];
const check = (ok, msg, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'} ${msg}${detail ? ' :: ' + detail : ''}`); if (!ok) failures.push(msg); };

// A fake Web MIDI device whose input the test can fire from the page.
function fakeMidi() {
  const port = (id, name, type) => ({ id, name, manufacturer: 'Test', type, state: 'connected', connection: 'open', onmidimessage: null,
    send() {}, open() { return Promise.resolve(this); }, close() { return Promise.resolve(this); }, addEventListener() {}, removeEventListener() {} });
  const input = port('fake-in', 'Fake MPC MIDI 1', 'input');
  const access = { inputs: new Map([[input.id, input]]), outputs: new Map(), onstatechange: null, sysexEnabled: false };
  window.__fireMidi = (bytes, ts) => { if (input.onmidimessage) input.onmidimessage({ data: Uint8Array.from(bytes), timeStamp: ts == null ? performance.now() : ts }); };
  Object.defineProperty(navigator, 'requestMIDIAccess', { value: () => Promise.resolve(access), configurable: true });
}

async function main() {
  const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await context.addInitScript(fakeMidi);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  try {
    await page.goto(URL_, { waitUntil: 'load' });
    await page.waitForFunction(() => window.orograph && window.orograph.store, null, { timeout: BOOT_MS, polling: 200 });
    await sleep(2000);
    await page.evaluate(async () => {
      const o = window.orograph;
      await o.engine.start();
      if (o.visuals && o.visuals.debug && o.visuals.debug.pause) o.visuals.debug.pause();
      window.__sched = [];
      window.__tele = null;
      o.music.router.on('sched', e => window.__sched.push({ ...e, ct: o.engine.context.currentTime }));
      o.engine.on('tele', t => { window.__tele = t; });
    });
    const unbalanced = () => page.evaluate(() => {
      const open = new Map();
      for (const e of window.__sched.slice().sort((a, b) => a.time - b.time || (a.on ? 1 : -1))) {
        const k = e.part + ':' + e.note;
        open.set(k, (open.get(k) || 0) + (e.on ? 1 : -1));
      }
      return [...open].filter(([, v]) => v !== 0);
    });
    const voices = () => page.evaluate(() => (window.__tele ? window.__tele.activeVoices : null));
    const quiet = async (label, waitMs) => {
      await sleep(waitMs);
      const u = await unbalanced();
      const v = await voices();
      check(u.length === 0 && (!v || v.every(x => x === 0)), `${label}: nothing left hanging`, `unbalanced ${JSON.stringify(u)} voices ${JSON.stringify(v)}`);
    };

    // 1. Every scene for 4 bars.
    const scenes = await page.evaluate(() => window.orograph.presets.scenes().filter(s => s.factory).map(s => s.name));
    for (let i = 0; i < scenes.length; i++) {
      const info = await page.evaluate((i) => {
        const o = window.orograph;
        o.presets.loadScene(i);
        window.__sched = [];
        window.__steps = [];
        window.__offStep && window.__offStep();
        window.__offStep = o.music.transport.on('step', e => window.__steps.push(e));
        return { tempo: o.store.get('global.tempo'), release: Math.max(...o.store.get('parts').map(p => p.params.release)) };
      }, i);
      await sleep(1200);
      await page.evaluate(() => window.orograph.music.transport.play());
      await sleep(16 * 60000 / info.tempo + 300);
      const r = await page.evaluate(() => {
        const o = window.orograph;
        o.music.transport.stop();
        const late = window.__sched.filter(e => e.on && e.time > 0 && e.time < e.ct - 0.0005).length;
        const parts = [0, 1, 2, 3].map(p => window.__sched.filter(e => e.on && e.part === p).length);
        return { late, parts };
      });
      check(r.parts.every(n => n > 0) && r.late === 0, `scene "${scenes[i]}" plays all parts on time`, `notes ${r.parts.join(',')} late ${r.late}`);
      await quiet(`scene "${scenes[i]}" after stop`, info.release * 1000 + 1500);
    }

    // 2. Scene and patch changes while playing.
    await page.evaluate(() => { const o = window.orograph; o.presets.loadScene(0); window.__sched = []; o.music.transport.play(); });
    await sleep(2000);
    await page.evaluate(() => window.orograph.presets.loadScene(2));
    await sleep(2000);
    await page.evaluate(() => { const o = window.orograph; o.presets.loadPatch(1, 'Pebble Pluck'); o.presets.nextPatch(3, 1); });
    await sleep(1500);
    await page.evaluate(() => window.orograph.presets.loadScene(6));
    await sleep(1500);
    await page.evaluate(() => window.orograph.music.transport.stop());
    await quiet('scene and patch changes while playing', 7000);

    // 3. Arp hold.
    const arp = await page.evaluate(async () => {
      const o = window.orograph;
      const wait = (ms) => new Promise(r => setTimeout(r, ms));
      const ons = () => window.__sched.filter(e => e.on && e.part === 2).map(e => e.note);
      o.store.set('parts.2.arp', { mode: 1, rate: 3, octaves: 1, gate: 0.5, hold: 1 });
      window.__sched = [];
      for (const n of [57, 60, 64]) o.music.router.noteOn(2, n, 0.8);
      await wait(120);
      for (const n of [57, 60, 64]) o.music.router.noteOff(2, n);
      await wait(1200);
      const held = ons();
      window.__sched = [];
      o.music.transport.play(); await wait(1000); o.music.transport.stop(); await wait(600);
      const throughTransport = ons().length;
      o.store.set('parts.2.arp.hold', 0);
      await wait(300);
      window.__sched = [];
      await wait(600);
      const afterOff = ons().length;
      o.store.set('parts.2.arp', { mode: 1, rate: 3, octaves: 1, gate: 0.5, hold: 1 });
      for (const n of [62, 65]) o.music.router.noteOn(2, n, 0.8);
      for (const n of [62, 65]) o.music.router.noteOff(2, n);
      await wait(300);
      o.presets.loadScene(4);
      await wait(200);
      window.__sched = [];
      await wait(800);
      const afterScene = ons().length;
      o.music.router.allNotesOff();
      return { held: held.length, notes: [...new Set(held)].sort(), throughTransport, afterOff, afterScene };
    });
    check(arp.held >= 6 && arp.notes.join() === '57,60,64', 'arp hold keeps the released chord going', JSON.stringify(arp));
    check(arp.throughTransport >= 6, 'arp hold carries on through transport start and stop', String(arp.throughTransport));
    check(arp.afterOff === 0, 'switching Hold off stops the latched arp', String(arp.afterOff));
    check(arp.afterScene === 0, 'loading a scene drops a latched arp', String(arp.afterScene));
    await quiet('arp checks', 3000);

    // 4. MIDI clock follow from a fake device: Start, 4 s of 130 bpm clock, Stop.
    const clock = await page.evaluate(async () => {
      const o = window.orograph;
      if (!o.midi) return { skipped: 'no MIDI module' };
      await o.midi.connect();
      o.midi.setSetting('followClock', true);
      o.presets.loadScene(3);
      o.store.set('global.swing', 0);
      await new Promise(r => setTimeout(r, 800));
      const steps = [];
      const off = o.music.transport.on('step', e => { if (e.part === 0) steps.push(e.time); });
      const bpm = 130, ms = 60000 / (bpm * 24);
      const t0 = performance.now() + 50;
      window.__fireMidi([0xfa], t0 - 1);
      let i = 0;
      await new Promise((resolve) => {
        const pump = () => {
          const now = performance.now();
          while (t0 + i * ms <= now) { window.__fireMidi([0xf8], t0 + i * ms); i++; }
          if (now - t0 < 4000) setTimeout(pump, 4); else resolve();
        };
        pump();
      });
      const playing = o.music.transport.isPlaying() && o.music.transport.isExternal();
      const tempo = o.store.get('global.tempo');
      window.__fireMidi([0xfc]);
      await new Promise(r => setTimeout(r, 300));
      off();
      const stopped = !o.music.transport.isPlaying();
      o.midi.setSetting('followClock', false);
      const dts = steps.slice(1).map((t, k) => t - steps[k]).slice(2, -2).sort((a, b) => a - b);
      return { pulses: i, playing, tempo, stopped, steps: steps.length, median: dts[Math.floor(dts.length / 2)], expect: 60 / bpm / 4 };
    });
    if (clock.skipped) console.log('skip MIDI clock: ' + clock.skipped);
    else {
      check(clock.playing && Math.abs(clock.tempo - 130) <= 1 && clock.stopped, 'follows MIDI clock: Start, tempo, Stop', JSON.stringify(clock));
      check(clock.steps > 20 && Math.abs(clock.median - clock.expect) < 0.002, 'steps follow the external 16th grid', `${(clock.median * 1000).toFixed(1)} ms vs ${(clock.expect * 1000).toFixed(1)} ms`);
      await quiet('MIDI clock stop', 3000);
    }

    // 5. Preview and offline rendering.
    const pv = await page.evaluate(async () => {
      const o = window.orograph;
      window.__sched = [];
      o.presets.loadPatch(0, 'Cirque Bell');
      const info = o.music.preview(0);
      await new Promise(r => setTimeout(r, 800));
      o.music.stopPreview();
      const ev = o.music.renderEvents(4);
      return { category: info && info.category, ons: window.__sched.filter(e => e.on && e.source === 'preview').length, events: ev.length, playing: o.store.get('ui.playing') };
    });
    check(pv.category === 'Bell' && pv.ons > 0, 'preview plays a Bell phrase for a Bell patch', JSON.stringify(pv));
    check(pv.events > 20 && pv.playing === 0, 'renderEvents works without starting the live transport', JSON.stringify(pv));
    await quiet('stopped preview', 4000);

    check(errors.length === 0, 'no page errors', errors.slice(0, 5).join(' | '));
  } finally {
    await browser.close();
  }
}

main().then(() => {
  console.log(failures.length ? `\n${failures.length} check(s) failed` : '\nAll music app checks passed');
  process.exit(failures.length ? 1 : 0);
}).catch((err) => { console.error(err); process.exit(1); });
