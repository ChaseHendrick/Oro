// Round D checks for the audio harness (dev/audio/main.js): quality modes,
// controllers, links, the limiter ceiling, offline bounces with stems, 16-bit
// PNG height maps, odd files, and the stress cases from the bug hunt
// (start/stop cycles, device switching, recording through patch changes, huge
// reverbs, delay feedback at 0.95 under tempo changes, four busy parts).

import { DEFAULT_PARTS } from '../../src/core/params.js';
import { TERRAIN_INDEX } from '../../src/dsp/catalog.js';
import { makePng, oddWavs } from './files.js';

export async function roundD(h) {
  const { engine, store, check, note, sleep, meanRms, setPhase, parseWavBlob, metrics } = h;
  const ctx = engine.context;
  const settle = async () => { engine.panic(); await sleep(200); };
  const sendsTo = (d, r, part = 0) => store.batch(() => { store.set(`parts.${part}.params.delaySend`, d); store.set(`parts.${part}.params.reverbSend`, r); });
  const peakFor = async (ms) => {
    const buf = new Float32Array(engine.analyser.fftSize);
    let peak = 0, bad = 0;
    const t0 = performance.now();
    while (performance.now() - t0 < ms) {
      engine.analyser.getFloatTimeDomainData(buf);
      for (const v of buf) { if (!Number.isFinite(v)) bad++; else peak = Math.max(peak, Math.abs(v)); }
      await sleep(15);
    }
    return { peak, bad };
  };

  // ---- quality -------------------------------------------------------------------------
  setPhase('quality');
  const seen = [];
  const offQ = engine.on('quality', (e) => seen.push(e.mode));
  const modes = {};
  for (const mode of ['eco', 'high', 'pristine', 'raw', 'standard']) {
    store.set('ui.audioQuality', mode);
    await sleep(20);
    engine.noteOn(0, 57, 0.9);
    await sleep(120);
    modes[mode] = { engine: engine.quality, rms: Math.round(await meanRms(120) * 1000) / 1000 };
    engine.noteOff(0, 57);
    await sleep(60);
  }
  offQ();
  check('engine follows ui.audioQuality and keeps playing in every mode',
    Object.entries(modes).every(([m, r]) => r.engine === m && r.rms > 0.01) && seen.join() === 'eco,high,pristine,raw,standard', modes);
  const bogus = engine.setQuality('ultra');
  const direct = engine.setQuality('high');
  check('setQuality validates and works without the store', bogus === 'standard' && direct === 'high' && store.get('ui.audioQuality') === 'standard', { bogus, direct });
  store.set('ui.audioQuality', 'high'); store.set('ui.audioQuality', 'standard');
  await sleep(20);

  // ---- controllers, marble, links, macros ------------------------------------------------------
  setPhase('controllers');
  sendsTo(0, 0);
  await settle();
  engine.noteOn(0, 57, 0.9);
  await sleep(100);
  for (let i = 0; i <= 20; i++) {
    engine.pressure(0, i / 20); engine.pressure(0, 1 - i / 20, 57);
    engine.slide(0, i / 20); engine.slide(0, i / 20, 57);
    for (let p = 0; p < DEFAULT_PARTS; p++) engine.marble(p, (i % 7) / 7, Math.sin(i) * 0.9);
    await sleep(10);
  }
  engine.pressure(9, 1); engine.pressure(0, NaN); engine.slide(0, 'x'); engine.marble(0, NaN, 0); engine.pressure(0, 0.5, 'C4');
  const ctlRms = await meanRms(150);
  engine.noteOff(0, 57);
  check('pressure, slide and marble messages are accepted while a note plays', ctlRms > 0.01, ctlRms);

  // Links: a macro drives the watched part's cutoff down (visible in telemetry once the DSP applies links).
  store.batch(() => {
    store.set('parts.0.links', [{ src: 5, dst: 'cutoff', amt: -1, curve: 0 }, { src: 1, dst: 'morph', amt: 1, curve: 0 }]);
    store.set('global.macro1', 0);
    store.set('ui.selectedPart', 0);
  });
  engine.noteOn(0, 57, 0.9);
  await sleep(150);
  const cut0 = engine.telemetry() && engine.telemetry().n ? engine.telemetry().n.cutoff : null;
  store.set('global.macro1', 1);
  await sleep(150);
  const cut1 = engine.telemetry() && engine.telemetry().n ? engine.telemetry().n.cutoff : null;
  engine.noteOff(0, 57);
  check('links and macros reach the DSP: Macro 1 -> Cutoff (-1) pulls the modulated cutoff down', cut0 !== null && cut1 !== null && cut1 < cut0 - 0.3, { macro0: cut0, macro1: cut1 });
  store.set('global.macro1', 0);
  store.set('parts.0.links', [{ src: 1, dst: 'morph', amt: 1, curve: 0 }]);

  // ---- ceiling --------------------------------------------------------------------------------
  setPhase('ceiling');
  await settle();
  store.batch(() => {
    store.set('global.masterVolume', 1);
    store.set('parts.0.params.level', 1);
    store.set('parts.0.params.unison', 3);
    store.set('global.saturation', 1);
  });
  const chord = [45, 52, 57, 64];
  chord.forEach(n => engine.noteOn(0, n, 1));
  await sleep(200);
  store.set('global.ceiling', 0);
  await sleep(150);
  const at0 = await peakFor(500);
  store.set('global.ceiling', -6);
  await sleep(150);
  const at6 = await peakFor(500);
  chord.forEach(n => engine.noteOff(0, n));
  // quiet material is not touched by the ceiling
  store.batch(() => { store.set('global.masterVolume', 0.25); store.set('global.saturation', 0.15); store.set('parts.0.params.unison', 1); });
  await settle();
  store.set('global.ceiling', 0);
  engine.noteOn(0, 57, 0.5); await sleep(200);
  const quiet0 = await meanRms(300);
  store.set('global.ceiling', -6); await sleep(150);
  const quiet6 = await meanRms(300);
  engine.noteOff(0, 57);
  const qdb = 20 * Math.log10(quiet6 / quiet0);
  metrics.ceiling = { peak0: at0.peak, peak6: at6.peak, quietChangeDb: qdb };
  check('ceiling -6 dB holds loud peaks under 0.5; 0 dB under 1.0; no NaN', at6.peak <= 0.502 && at0.peak <= 1 && at0.peak > 0.6 && !at0.bad && !at6.bad, metrics.ceiling);
  check('ceiling leaves quiet material at the same level (within 1 dB)', Math.abs(qdb) < 1, qdb);
  store.batch(() => { store.set('global.ceiling', -0.3); store.set('global.masterVolume', 0.8); store.set('parts.0.params.level', 0.75); });

  // ---- bounce -----------------------------------------------------------------------------------
  setPhase('bounce');
  await settle();
  sendsTo(0.3, 0.4, 0);
  store.batch(() => {
    store.set('global.tempo', 120);
    for (const [p, deg] of [[0, [0, 2, 4, 7]], [1, [0, 0, 3, 5]], [2, [1, 1, 1, 1]]]) {
      store.set(`parts.${p}.seqOn`, 1);
      store.set(`parts.${p}.patterns.0.rate`, 1);    // 1/8
      store.set(`parts.${p}.patterns.0.length`, 8);
      deg.forEach((d, i) => { store.set(`parts.${p}.patterns.0.steps.${2 * i}.on`, 1); store.set(`parts.${p}.patterns.0.steps.${2 * i}.degree`, d); });
    }
    store.set('parts.2.params.mute', 1);
    store.set('parts.0.patterns.0.steps.4.lock', 1);
    store.set('parts.0.patterns.0.steps.4.lx', 0.2);
    store.set('parts.0.patterns.0.steps.4.ly', 0.8);
  });
  const prog = [];
  const offB = engine.on('bounce', (e) => prog.push(e));
  const tB = performance.now();
  let second = '';
  const bouncing = engine.bounce({ bars: 1, stems: true, tailSeconds: 1 });
  try { await engine.bounce({ bars: 1 }); } catch (err) { second = err.message; }
  const res = await bouncing;
  const bounceMs = performance.now() - tB;
  offB();
  const mix = await parseWavBlob(res.mix);
  const wantFrames = Math.ceil(3 * engine.sampleRate);     // 1 bar at 120 bpm = 2 s, + 1 s tail
  const stemInfo = await Promise.all(res.stems.map(b => (b ? parseWavBlob(b) : null)));
  const st = engine.stats().bounce;
  metrics.bounce = { ms: Math.round(bounceMs), passes: st && st.passes.map(p => ({ stage: p.stage, part: p.part, via: p.via, peak: +p.peak.toFixed(3), rms: +p.rms.toFixed(4) })), frames: mix.frames, wantFrames, events: st && st.events };
  check('bounce: 24-bit stereo WAV of the right length with sound', mix.riff === 'RIFF' && mix.bits === 24 && mix.channels === 2
    && mix.sampleRate === engine.sampleRate && Math.abs(mix.frames - wantFrames) <= 128 && mix.peak > 0.02, metrics.bounce);
  check('bounce: stems for the sounding parts only (muted and silent parts are null)',
    res.stems.length === DEFAULT_PARTS && !!stemInfo[0] && !!stemInfo[1] && !stemInfo[2] && !stemInfo[3] && stemInfo[0].peak > 0.01 && stemInfo[1].peak > 0.01,
    stemInfo.map(s => (s ? +s.peak.toFixed(3) : null)));
  const monotonic = prog.every((e, i) => i === 0 || e.done >= prog[i - 1].done);
  const last = prog[prog.length - 1] || {};
  check('bounce: progress events climb to done = total', prog.length > 5 && monotonic && last.done === last.total && last.stage === 'done', { events: prog.length, last });
  check('bounce: a second bounce while one runs is refused', /already running/.test(second), second);

  // fx off: nothing after the notes end; fx on: a tail
  const evs = [{ time: 0, msg: { t: 'noteOn', part: 0, note: 60, vel: 1 } }, { time: 0.3, msg: { t: 'noteOff', part: 0, note: 60 } },
    { time: 0.1, msg: { t: 'bend', part: 0, v: 0.5 } }];
  sendsTo(1, 1, 0);
  store.set('parts.0.params.release', 0.05);
  const dryB = await engine.bounce({ bars: 1, fx: false, tailSeconds: 1, events: evs });
  const wetB = await engine.bounce({ bars: 1, fx: true, tailSeconds: 1, events: evs });
  const tailRms = async (blob) => {
    const b = new DataView(await blob.arrayBuffer());
    const sr = b.getUint32(24, true);
    let s = 0, n = 0;
    for (let f = Math.round(1.0 * sr); f < Math.round(2.9 * sr); f++) {
      const p = 44 + f * 6;
      let v = b.getUint8(p) | (b.getUint8(p + 1) << 8) | (b.getUint8(p + 2) << 16);
      if (v & 0x800000) v |= ~0xffffff;
      s += (v / 8388608) ** 2; n++;
    }
    return Math.sqrt(s / n);
  };
  const dryTail = await tailRms(dryB.mix), wetTail = await tailRms(wetB.mix);
  // Offline renders are sample-exact: the same session renders to the same bytes.
  const again = await engine.bounce({ bars: 1, fx: true, tailSeconds: 1, events: evs });
  const [x, y] = await Promise.all([wetB.mix.arrayBuffer(), again.mix.arrayBuffer()]);
  const ux = new Uint8Array(x), uy = new Uint8Array(y);
  let diff = ux.length === uy.length ? 0 : -1;
  if (diff === 0) for (let i = 0; i < ux.length; i++) if (ux[i] !== uy[i]) diff++;
  check('bounce: rendering the same session twice gives identical files', diff === 0, { bytes: ux.length, differingBytes: diff });
  metrics.bounceTails = { dry: dryTail, wet: wetTail };
  check('bounce: effects off leaves no tail, effects on keeps the delay/reverb tail', dryTail < 1e-4 && wetTail > 1e-3, metrics.bounceTails);
  store.batch(() => {
    for (let p = 0; p < 3; p++) store.set(`parts.${p}.seqOn`, 0);
    store.set('parts.2.params.mute', 0);
    store.set('parts.0.params.release', 0.2);
  });
  sendsTo(0.12, 0.22, 0);

  // ---- 16-bit PNG height maps --------------------------------------------------------------------
  setPhase('png16');
  // A DEM whose relief spans 300 of 65536 levels: one 8-bit level would be 256 of them.
  const dem = await h.harnessOnly(() => makePng({ width: 512, height: 512, bitDepth: 16, name: 'dem16.png',
    sample: (x, y) => 30000 + Math.round(150 + 150 * Math.sin(x / 40) * Math.cos(y / 55)) }));
  const tPng = performance.now();
  const utDem = await engine.importTerrainFile(2, 'A', dem, { channel: 'luma', smooth: 0.1, tile: 'mirror' });
  await engine.whenTerrainsReady();
  const pngMs = performance.now() - tPng;
  const last16 = engine.stats().import.last;
  const tbl = engine.getTerrain(2, 'A');
  const row = Array.from(tbl.data.subarray(100 * tbl.size, 100 * tbl.size + tbl.size));
  const levels = new Set(row.map(v => Math.round(v * 1e5))).size;
  let finite = true;
  for (const v of tbl.data) if (!Number.isFinite(v)) { finite = false; break; }
  metrics.png16 = { ms: Math.round(pngMs), via: last16 && last16.via, bits: last16 && last16.bits, n: utDem.w, rowLevels: levels, steps: engine.stats().import.steps };
  check('16-bit PNG DEM is read by our decoder at full depth and stored with its low byte plane',
    last16.via === 'png' && last16.bits === 16 && typeof utDem.lo === 'string' && utDem.w === 256 && finite, metrics.png16);
  check('the narrow-band DEM keeps smooth detail (not a few 8-bit terraces)', levels > 200, levels);
  const rgb = await h.harnessOnly(() => makePng({ width: 64, height: 64, colorType: 2, bitDepth: 8, name: 'rgb.png', sample: (x, y, c) => (c === 0 ? x * 4 : c === 1 ? y * 4 : 0) }));
  const ur = await engine.importTerrainFile(2, 'B', rgb, { channel: 'r', smooth: 0, tile: 'wrap' });
  const ug = await engine.importTerrainFile(2, 'B', rgb, { channel: 'g', smooth: 0, tile: 'wrap' });
  check('channel and tile options reach the stored terrain', ur.mirror === 0 && ur.data !== ug.data && ur.w === 64, { mirror: ur.mirror, w: ur.w });

  // ---- odd files ---------------------------------------------------------------------------------
  setPhase('odd-files');
  const odd = {};
  const tryImport = async (label, file, slot = 'A') => {
    try {
      const u = await engine.importTerrainFile(3, slot, file);
      odd[label] = { ok: true, kind: u.kind, w: u.w, h: u.h };
    } catch (err) { odd[label] = { ok: false, msg: String(err.message || err) }; }
  };
  const goodPng = await h.harnessOnly(() => makePng({ width: 40, height: 40, bitDepth: 8, name: 'g.png', sample: (x, y) => (x * y) & 255 }));
  const bytes = new Uint8Array(await goodPng.arrayBuffer());
  await tryImport('empty', new File([], 'empty.png'));
  await tryImport('textAsPng', new File(['hello, I am not a picture'], 'fake.png', { type: 'image/png' }));
  await tryImport('truncatedPng', new File([bytes.subarray(0, bytes.length - 30)], 'cut.png'));
  const huge = bytes.slice();
  new DataView(huge.buffer).setUint32(16, 60000); new DataView(huge.buffer).setUint32(20, 60000);
  await tryImport('hugePng', new File([huge], 'huge.png'));
  await tryImport('pngNamedJpg', new File([bytes], 'actually-png.jpg', { type: 'image/jpeg' }));
  await tryImport('onePixel', await makePng({ width: 1, height: 1, bitDepth: 16, name: 'px.png', sample: () => 1234 }));
  await tryImport('rgba16', await makePng({ width: 30, height: 20, colorType: 6, bitDepth: 16, name: 'rgba16.png', sample: (x, y, c) => (c === 3 ? (x > 15 ? 65535 : 0) : x * 2000) }));
  const w = oddWavs();
  for (const k of Object.keys(w)) await tryImport('wav-' + k, w[k], 'B');
  await tryImport('mp3', new File([new Uint8Array([0x49, 0x44, 0x33, 3, 0, 0, 0, 0, 0, 0])], 'song.mp3', { type: 'audio/mpeg' }));
  metrics.oddFiles = odd;
  const msgOk = (k, re) => odd[k] && !odd[k].ok && re.test(odd[k].msg);
  check('odd files fail with clear messages', msgOk('empty', /empty/) && msgOk('textAsPng', /could not be decoded|not a PNG/) && msgOk('truncatedPng', /cut short|damaged/)
    && msgOk('hugePng', /megapixels/) && msgOk('wav-empty', /no usable audio|no audio/) && msgOk('mp3', /not an image or a WAV/), odd);
  check('unusual but valid files import', odd.pngNamedJpg.ok && odd.onePixel.ok && odd.rgba16.ok && odd['wav-u8'].ok && odd['wav-f64'].ok && odd['wav-ext24'].ok
    && odd['wav-u8'].h === 4 && odd['wav-ext24'].h === 4, odd);
  check('a failed import leaves the slot as it was', store.get('parts.3.params.terrainA') === TERRAIN_INDEX.user, store.get('parts.3.params.terrainA'));

  // ---- start / stop / resume cycles ---------------------------------------------------------------
  setPhase('cycles');
  const states = [];
  for (let i = 0; i < 6; i++) {
    await ctx.suspend();
    states.push(await engine.start());
  }
  // overlapping calls in odd orders
  ctx.suspend(); const a = engine.start(); ctx.suspend(); const b = engine.start();
  await Promise.all([a, b]);
  await sleep(100);
  const finalState = ctx.state;
  sendsTo(0, 0);
  await settle();
  const cyc = await h.noteAndTail({ tail: [200, 300] });
  check('start/suspend cycles end running and playing', states.every(s => s === 'running') && finalState === 'running' && cyc.during > 0.01, { states, finalState, rms: cyc.during });

  // ---- output device switching ------------------------------------------------------------------
  setPhase('device-switch');
  const sw = await Promise.allSettled([engine.setOutputDevice('default'), engine.setOutputDevice('no-such-device'), engine.setOutputDevice(''), engine.setOutputDevice('default')]);
  const swOut = sw.map(r => (r.status === 'fulfilled' ? r.value : 'error: ' + (r.reason && r.reason.message)));
  let noneSink = 'skipped';
  if (typeof ctx.setSinkId === 'function') {
    try { await ctx.setSinkId({ type: 'none' }); await sleep(150); await ctx.setSinkId(''); noneSink = 'ok'; } catch (err) { noneSink = err.message; }
  }
  await engine.start();
  await sleep(150);
  const afterSw = await h.noteAndTail({ tail: [200, 300] });
  metrics.deviceSwitch = { results: swOut, noneSink, state: ctx.state, outputDeviceId: engine.outputDeviceId };
  check('device switches are serialised, bad ids give a message, audio keeps running',
    swOut[0] === 'default' && /no longer available|not found|NotFound/i.test(swOut[1]) && swOut[3] === 'default' && ctx.state === 'running' && afterSw.during > 0.01, metrics.deviceSwitch);

  // ---- recording while patches and devices change ---------------------------------------------
  setPhase('record-switch');
  await settle();
  const base = store.serialize();
  await engine.startRecording();
  const recT0 = performance.now();
  const recC0 = ctx.currentTime;
  engine.noteOn(0, 57, 0.9);
  for (let i = 0; i < 6; i++) {
    const s = JSON.parse(JSON.stringify(base));
    s.parts[0].params.cutoff = 800 + i * 1500;
    s.parts[0].params.morph = (i % 3) / 2;
    s.parts[0].params.terrainA = [TERRAIN_INDEX.swell, TERRAIN_INDEX.ridge, TERRAIN_INDEX.crater][i % 3];
    s.parts[0].params.sustain = 0.9;
    store.load(s);
    if (i === 3 && typeof ctx.setSinkId === 'function') { try { await ctx.setSinkId({ type: 'none' }); await ctx.setSinkId(''); } catch { /* not supported */ } }
    await sleep(250);
  }
  engine.noteOff(0, 57);
  await sleep(300);
  const recC1 = ctx.currentTime;
  const recBlob = await engine.stopRecording();
  const recWall = (performance.now() - recT0) / 1000;
  const rec = await parseWavBlob(recBlob);
  // From the moment the note is heard (the recorder may start a little before
  // the note-on reaches the DSP) to well before its release.
  const gaps = await longestSilence(recBlob, 1.2);
  // Compare with the audio clock: on an overloaded machine the device itself
  // falls behind the wall clock, and the recorder can only capture what was rendered.
  metrics.recordSwitch = { seconds: rec.frames / rec.sampleRate, audioClock: recC1 - recC0, wall: recWall, peak: rec.peak, longestSilenceInNote: gaps };
  check('recording survives patch loads and a device switch (every rendered frame, no dropouts while the note holds)',
    Math.abs(rec.frames / rec.sampleRate - (recC1 - recC0)) < 0.1 && rec.peak > 0.01 && gaps < 0.03, metrics.recordSwitch);
  store.load(base);
  await engine.whenTerrainsReady();

  // ---- very long reverb ---------------------------------------------------------------------------
  setPhase('long-reverb');
  await settle();
  const fxBefore = engine.stats().fx;
  for (let i = 0; i < 12; i++) { store.set('global.reverbSize', i % 2 ? 0.95 : 1); store.set('global.reverbDamp', i / 12); await sleep(40); }
  store.set('global.reverbSize', 1); store.set('global.reverbDamp', 0.1);
  for (let i = 0; i < 50 && engine.stats().fx.irBuilds === fxBefore.irBuilds; i++) await sleep(100);
  await sleep(400);
  const fxAfter = engine.stats().fx;
  sendsTo(0, 1);
  engine.noteOn(0, 57, 1); await sleep(300); engine.noteOff(0, 57);
  await sleep(3000);
  const rvTail = await meanRms(300);
  metrics.longReverb = { builds: fxAfter.irBuilds - fxBefore.irBuilds, irSeconds: fxAfter.lastIrLength / engine.sampleRate, setBufferMs: fxAfter.steps.setBuffer, tail3s: rvTail };
  check('a burst of reverb size changes builds the IR at most twice and the 7 s tail rings', metrics.longReverb.builds <= 2 && metrics.longReverb.irSeconds > 6.9 && rvTail > 1e-4, metrics.longReverb);
  store.batch(() => { store.set('global.reverbSize', 0.62); store.set('global.reverbDamp', 0.45); });

  // ---- delay feedback 0.95 under tempo changes -------------------------------------------------------
  setPhase('delay-feedback');
  await settle();
  sendsTo(1, 0);
  store.batch(() => { store.set('global.delayFeedback', 0.95); store.set('global.delayLevel', 1); store.set('global.delayTone', 1); store.set('global.delayDiv', 8); });
  engine.noteOn(0, 64, 1); await sleep(80); engine.noteOff(0, 64);
  await sleep(300);
  const early = await meanRms(400);
  const tempos = [40, 240, 60, 200, 90, 233, 41, 180];
  let bad = 0;
  for (let i = 0; i < 24; i++) {
    store.set('global.tempo', tempos[i % tempos.length]);
    if (i % 5 === 0) store.set('global.delayDiv', (i / 5) % 10);
    if (i % 7 === 0) store.set('global.delayTone', (i % 2));
    const p = await peakFor(100);
    bad += p.bad;
  }
  const lateRms = await meanRms(400);
  metrics.delayFeedback = { early, late: lateRms, nan: bad, delayTime: engine.stats().fx.delayTime };
  check('delay feedback 0.95 with wild tempo changes decays instead of building up (no NaN)', bad === 0 && lateRms < early * 1.2, metrics.delayFeedback);
  store.batch(() => { store.set('global.delayFeedback', 0.42); store.set('global.delayLevel', 0.7); store.set('global.delayTone', 0.55); store.set('global.delayDiv', 3); store.set('global.tempo', 112); });
  await settle();

  // ---- four busy parts ------------------------------------------------------------------------------
  setPhase('cpu');
  store.batch(() => {
    for (let p = 0; p < DEFAULT_PARTS; p++) {
      store.set(`parts.${p}.params.unison`, 2);
      store.set(`parts.${p}.params.polyMode`, 0);
      store.set(`parts.${p}.params.level`, 0.4);
    }
  });
  const busy = [];
  for (let p = 0; p < DEFAULT_PARTS; p++) for (let k = 0; k < 8; k++) busy.push({ time: 0, msg: { t: 'noteOn', part: p, note: 40 + p * 7 + k * 3, vel: 0.7 } });
  const cpu = {};
  for (const q of ['standard', 'high']) {
    const t0 = performance.now();
    await engine.bounce({ bars: 1, tailSeconds: 0, events: busy, quality: q });
    const ms = performance.now() - t0;
    const secs = engine.stats().bounce.seconds;
    cpu[q] = { renderMs: Math.round(ms), audioSeconds: +secs.toFixed(2), realtimeFactor: +(ms / 1000 / secs).toFixed(3) };
  }
  // live: everything held for a second, the output must stay finite
  for (const e of busy) engine.noteOn(e.msg.part, e.msg.note, 0.7);
  const live = await peakFor(1000);
  engine.allNotesOff();
  cpu.live = { peak: +live.peak.toFixed(3), nan: live.bad, teleRate: h.teleRate() };
  metrics.cpu = cpu;
  note('four parts x 8 voices x unison 2: offline render time per second of audio (lower is better; < 1 = faster than real time)', cpu);
  check('four busy parts stay finite and bounded live', live.bad === 0 && live.peak <= 1, cpu.live);
  store.batch(() => { for (let p = 0; p < DEFAULT_PARTS; p++) { store.set(`parts.${p}.params.unison`, 1); store.set(`parts.${p}.params.level`, 0.75); } });
  await settle();
}

/**
 * Longest run of near-silence (seconds) in a 24-bit stereo WAV blob, during
 * the `span` seconds that follow the first audible sample.
 */
async function longestSilence(blob, span) {
  const b = new DataView(await blob.arrayBuffer());
  const sr = b.getUint32(24, true);
  const frames = b.getUint32(40, true) / 6;
  const at = (f) => {
    const p = 44 + f * 6;
    let v = b.getUint8(p) | (b.getUint8(p + 1) << 8) | (b.getUint8(p + 2) << 16);
    if (v & 0x800000) v |= ~0xffffff;
    return Math.abs(v);
  };
  let onset = 0;
  while (onset < frames && at(onset) < 80) onset++;
  let run = 0, worst = 0;
  for (let f = onset; f < Math.min(frames, onset + Math.round(span * sr)); f++) {
    if (at(f) < 80) { run++; worst = Math.max(worst, run); } else run = 0;
  }
  return onset >= frames ? Infinity : worst / sr;
}
