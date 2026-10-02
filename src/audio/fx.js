// Effect graph and master chain.
//
//   dry (worklet out 0) ─────────────────────────────┐
//   delay send (out 1) ─> ping-pong delay ─> return ─┼─> bus ─> chorus ─> warmth ─> volume
//   reverb send (out 2) ─> HP ─> convolver(s) ─> ret ┘      ─> 1/ceiling ─> limiter ─> soft clip ─> ceiling ─> out
//                                                                                            ─> analyser ─> destination
//
// The ceiling (global.ceiling, dB) scales the limiter and soft clip stage as a
// whole: 1/c in, c out. Quiet material therefore passes at the same level
// whatever the ceiling, and peaks can never exceed it (the clip curve stays
// below 1). Every parameter change is a setTargetAtTime glide, so knobs never
// zipper. The pure mapping functions are exported for the unit tests.

import { DELAY_DIVS } from '../core/params.js';
import { generateImpulse } from './reverb-ir.js';

const MAX_DELAY = 4;              // s; 1/2 note at 40 bpm is 3 s
const DELAY_MAX_SLEW = 0.6;       // max |d(delay time)/dt|: keeps the tape-style pitch bend under ~an octave
const PARAM_TAU = 0.02;
const IR_DEBOUNCE_MS = 250;
const IR_FADE = 0.12;             // s, equal-power crossfade between old and new convolver
const WARM_RANGE = 8;             // the warmth curve spans input ±WARM_RANGE / drive
const WARM_REF = 0.25;            // program level whose loudness warmth keeps constant
const CLIP_RANGE = 2;             // soft clip curve spans ±2
const CLIP_KNEE = 0.85;           // soft clip is the identity below this

function clamp(x, lo, hi) { return x < lo ? lo : x > hi ? hi : x; }
function num(v, fallback) { return typeof v === 'number' && Number.isFinite(v) ? v : fallback; }

// ---- pure mappings ------------------------------------------------------------

/** Delay time in seconds for a tempo (bpm) and a DELAY_DIVS index. */
export function delaySeconds(tempo, divIndex) {
  const bpm = clamp(num(tempo, 112), 20, 400);
  const div = DELAY_DIVS[clamp(Math.round(num(divIndex, 3)), 0, DELAY_DIVS.length - 1)];
  return Math.min(MAX_DELAY - 0.01, div.beats * 60 / bpm);
}

/** Tone 0..1 -> filter corners in the feedback loop: dark & full at 0, thin & bright at 1. */
export function delayToneFreqs(tone) {
  const t = clamp(num(tone, 0.55), 0, 1);
  return { lowpass: 900 * Math.pow(2, t * 4.5), highpass: 30 * Math.pow(2, t * 4.3) };
}

/** Time constant for a delay-time glide that never slews faster than DELAY_MAX_SLEW. */
export function delayGlideTau(from, to) {
  return Math.max(0.05, Math.abs(to - from) / DELAY_MAX_SLEW);
}

/** masterVolume 0..1 -> linear gain (audio taper, +2 dB at the 0.8 default, +6 dB at 1). */
export function volumeGain(v) {
  const x = clamp(num(v, 0.8), 0, 1);
  return 2 * x * x;
}

export const CEILING_MIN_DB = -6;
export const CEILING_MAX_DB = 0;

/** Ceiling in dB (-6..0) -> linear peak level. */
export function ceilingGain(db) {
  return Math.pow(10, clamp(num(db, -0.3), CEILING_MIN_DB, CEILING_MAX_DB) / 20);
}

/** Chorus amount 0..1 -> dry/wet gains and modulation depth (s). */
export function chorusSettings(amount) {
  const a = clamp(num(amount, 0), 0, 1);
  return { dry: 1 - 0.2 * a, wet: 0.5 * a, depth: 0.0004 + 0.0024 * a };
}

/**
 * Warmth (saturation) 0..1 -> gains around a fixed tanh curve.
 * The shaper computes tanh(drive · x); post-gain WARM_REF / tanh(WARM_REF · drive)
 * keeps a signal peaking at WARM_REF at the same level, so turning Warmth up
 * thickens the sound instead of just making it louder.
 */
export function warmthSettings(amount) {
  const a = clamp(num(amount, 0), 0, 1);
  const drive = 0.3 + 3.7 * a;
  return { drive, pre: drive / WARM_RANGE, post: WARM_REF / Math.tanh(WARM_REF * drive) };
}

/** WaveShaper curve: y = tanh(WARM_RANGE · x) for x in [-1, 1]. */
export function makeWarmthCurve(n = 8193) {
  const c = new Float32Array(n);
  for (let i = 0; i < n; i++) c[i] = Math.tanh(WARM_RANGE * (2 * i / (n - 1) - 1));
  return c;
}

/** The soft clipper's transfer function on its own input scale (|y| < 1 always). */
export function softClip(x) {
  const a = Math.abs(x);
  if (a <= CLIP_KNEE) return x;
  const w = 1 - CLIP_KNEE;
  return Math.sign(x) * (CLIP_KNEE + w * Math.tanh((a - CLIP_KNEE) / w));
}

/** WaveShaper curve for softClip over input [-CLIP_RANGE, CLIP_RANGE] (pre-gain 1/CLIP_RANGE). */
export function makeSoftClipCurve(n = 4097) {
  const c = new Float32Array(n);
  for (let i = 0; i < n; i++) c[i] = softClip(CLIP_RANGE * (2 * i / (n - 1) - 1));
  return c;
}

// ---- graph helpers ------------------------------------------------------------

function glide(ctx, param, value, tau = PARAM_TAU) {
  if (!Number.isFinite(value)) return;
  const t = ctx.currentTime;
  try {
    param.cancelScheduledValues(t);
    param.setTargetAtTime(value, t, tau);
  } catch {
    param.value = value;
  }
}

function equalPowerCurve(rising, n = 33) {
  const c = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = i / (n - 1);
    c[i] = rising ? Math.sin(0.5 * Math.PI * x) : Math.cos(0.5 * Math.PI * x);
  }
  return c;
}

/**
 * Build the effect graph on `ctx`.
 * `computeIR(opts)` may return (a promise of) generateImpulse(opts), e.g. from
 * a worker; without it the impulse response is generated on this thread.
 * `effects: false` (dry bounces) keeps only volume and the ceiling limiter:
 * delay, reverb and chorus are silent and warmth is at its transparent end.
 * @returns {{dryIn, delayIn, reverbIn, output, analyser, set(global), panic(), stats(), dispose()}}
 */
export function createFx(ctx, { global = {}, destination = ctx.destination, computeIR = null, effects = true } = {}) {
  const gain = (v = 1) => { const g = ctx.createGain(); g.gain.value = v; return g; };
  const stereoGain = (v = 1) => {
    const g = gain(v);
    g.channelCount = 2; g.channelCountMode = 'explicit'; g.channelInterpretation = 'speakers';
    return g;
  };
  const biquad = (type, freq, q = Math.SQRT1_2) => {
    const f = ctx.createBiquadFilter();
    f.type = type; f.frequency.value = freq; f.Q.value = q;
    return f;
  };

  const g = {
    tempo: 112, delayDiv: 3, delayFeedback: 0.42, delayTone: 0.55, delayLevel: 0.7,
    reverbSize: 0.62, reverbDamp: 0.45, reverbLevel: 0.75, chorus: 0.15, saturation: 0.15, masterVolume: 0.8, ceiling: -0.3,
  };
  for (const k in g) g[k] = num(global[k], g[k]);
  const withFx = effects !== false;
  const DRY_ONLY = { delayLevel: 0, reverbLevel: 0, chorus: 0, saturation: 0 };
  if (!withFx) Object.assign(g, DRY_ONLY);

  const dryIn = stereoGain(1);
  const delayIn = stereoGain(1);
  const reverbIn = stereoGain(1);
  const bus = stereoGain(1);
  dryIn.connect(bus);

  // ---- ping-pong delay ---------------------------------------------------------
  // Mono sum feeds the left line; each line feeds the other through the tone
  // filters and the feedback gain, so repeats alternate L, R, L ... and darken.
  const delayReturn = stereoGain(g.delayLevel);
  delayReturn.connect(bus);
  let delayTarget = delaySeconds(g.tempo, g.delayDiv);

  function buildDelay() {
    const input = gain(1);
    input.channelCount = 1; input.channelCountMode = 'explicit'; input.channelInterpretation = 'speakers';
    const dL = ctx.createDelay(MAX_DELAY), dR = ctx.createDelay(MAX_DELAY);
    dL.delayTime.value = delayTarget; dR.delayTime.value = delayTarget;
    const tone = delayToneFreqs(g.delayTone);
    const hpL = biquad('highpass', tone.highpass), lpL = biquad('lowpass', tone.lowpass);
    const hpR = biquad('highpass', tone.highpass), lpR = biquad('lowpass', tone.lowpass);
    const fbL = gain(g.delayFeedback), fbR = gain(g.delayFeedback);
    const merger = ctx.createChannelMerger(2);
    input.connect(dL);
    dL.connect(hpL); hpL.connect(lpL); lpL.connect(fbL); fbL.connect(dR);
    dR.connect(hpR); hpR.connect(lpR); lpR.connect(fbR); fbR.connect(dL);
    lpL.connect(merger, 0, 0); lpR.connect(merger, 0, 1);
    const nodes = [input, dL, dR, hpL, lpL, hpR, lpR, fbL, fbR, merger];
    return {
      input, output: merger, dL, dR, hp: [hpL, hpR], lp: [lpL, lpR], fb: [fbL, fbR],
      dispose() { for (const n of nodes) { try { n.disconnect(); } catch { /* ignore */ } } },
    };
  }
  let delay = buildDelay();
  delayIn.connect(delay.input);
  delay.output.connect(delayReturn);

  function setDelayTime(seconds) {
    const t = ctx.currentTime;
    const from = num(delay.dL.delayTime.value, delayTarget);
    const tau = delayGlideTau(from, seconds);
    delayTarget = seconds;
    for (const d of [delay.dL, delay.dR]) {
      try { d.delayTime.cancelScheduledValues(t); d.delayTime.setTargetAtTime(seconds, t, tau); } catch { d.delayTime.value = seconds; }
    }
  }

  // ---- reverb ---------------------------------------------------------------------
  const reverbPre = biquad('highpass', 70, 0.6);
  reverbIn.connect(reverbPre);
  const reverbReturn = stereoGain(g.reverbLevel);
  reverbReturn.connect(bus);
  let conv = null;            // {node, gain, buffer, key}
  let irTimer = 0;
  let irKey = '';
  const st = { irBuilds: 0, irSwaps: 0, lastIrMs: 0, maxIrMs: 0, lastIrLength: 0, lastBufferMs: 0, maxBufferMs: 0, steps: {} };
  // Worst main-thread time per reverb step, so a slow browser shows where it hurts.
  const timeStep = (name, fn) => {
    const t0 = performance.now();
    try { return fn(); } finally { st.steps[name] = Math.max(st.steps[name] || 0, Math.round((performance.now() - t0) * 10) / 10); }
  };

  function makeConvolver(buffer) {
    const c = ctx.createConvolver();
    c.normalize = false;      // the IR is already energy-normalised; must be set before buffer
    const t0 = performance.now();
    c.buffer = buffer;
    const ms = performance.now() - t0;
    st.lastBufferMs = ms; st.maxBufferMs = Math.max(st.maxBufferMs, ms);
    return c;
  }

  // The impulse response is computed off the main thread when the host gives
  // us a worker-backed computeIR; only the AudioBuffer copy and the
  // convolver's own setup (FFT of the IR, inside the browser) happen here.
  let irSerial = 0;
  let disposed = false;
  function requestIR(fade) {
    const serial = ++irSerial;
    const t0 = performance.now();
    const opts = { sampleRate: ctx.sampleRate, size: g.reverbSize, damp: g.reverbDamp, seed: 11 };
    Promise.resolve()
      .then(() => (computeIR ? computeIR(opts) : generateImpulse(opts)))
      // A worker that died takes the job with it: build this one here instead
      // (slower, but the reverb, and a bounce waiting for it, carries on).
      .catch((err) => { console.warn('[audio] reverb worker failed, building the impulse here', err); return generateImpulse(opts); })
      .then((ir) => {
        if (disposed || serial !== irSerial) return null;   // a newer request superseded this one
        const buffer = timeStep('createBuffer', () => {
          const b = ctx.createBuffer(2, ir.length, ctx.sampleRate);
          if (b.copyToChannel) { b.copyToChannel(ir.left, 0); b.copyToChannel(ir.right, 1); }
          else { b.getChannelData(0).set(ir.left); b.getChannelData(1).set(ir.right); }
          return b;
        });
        st.lastIrLength = ir.length;
        // The convolver's own setup (an FFT of the whole IR) is the other big
        // main-thread step; give it a task of its own.
        return new Promise((resolve) => setTimeout(() => resolve(buffer), 0));
      })
      .then((buffer) => {
        if (!buffer || disposed || serial !== irSerial) return;
        installConvolver(buffer, fade && !!conv);
        const ms = performance.now() - t0;
        st.irBuilds++; st.lastIrMs = ms; st.maxIrMs = Math.max(st.maxIrMs, ms);
        installedSerial = serial;
        const waiters = irWaiters; irWaiters = [];
        for (const fn of waiters) fn();
      })
      .catch((err) => {
        console.error('[audio] reverb impulse failed', err);
        // Never leave whenReverbReady() hanging: the reverb stays as it was.
        if (serial === irSerial) { installedSerial = serial; const w = irWaiters; irWaiters = []; for (const fn of w) fn(); }
      });
  }
  let irWaiters = [];
  let installedSerial = 0;
  const irSerialDone = () => installedSerial === irSerial;

  function installConvolver(buffer, fade) {
    const node = timeStep('setBuffer', () => makeConvolver(buffer));
    const out = gain(fade ? 0 : 1);
    timeStep('connect', () => { reverbPre.connect(node); node.connect(out); out.connect(reverbReturn); });
    const next = { node, gain: out, buffer };
    const prev = conv;
    conv = next;
    if (fade && prev) {
      const t = ctx.currentTime + 0.01;
      try { out.gain.setValueCurveAtTime(equalPowerCurve(true), t, IR_FADE); } catch { out.gain.value = 1; }
      // The outgoing gain may itself still be fading in (two swaps in a row), so
      // hold wherever it is and glide down rather than scheduling a second curve.
      const pg = prev.gain.gain;
      try {
        if (typeof pg.cancelAndHoldAtTime === 'function') pg.cancelAndHoldAtTime(t);
        else pg.cancelScheduledValues(t);
        pg.setTargetAtTime(0, t, IR_FADE / 4);
      } catch {
        pg.value = 0;
      }
      st.irSwaps++;
      setTimeout(() => timeStep('disconnect', () => {
        try { reverbPre.disconnect(prev.node); } catch { /* ignore */ }
        try { prev.node.disconnect(); prev.gain.disconnect(); } catch { /* ignore */ }
      }), (IR_FADE + 0.15) * 1000);
    } else if (prev) {
      try { reverbPre.disconnect(prev.node); prev.node.disconnect(); prev.gain.disconnect(); } catch { /* ignore */ }
    }
  }

  const irKeyOf = () => `${Math.round(g.reverbSize * 200)}:${Math.round(g.reverbDamp * 200)}`;
  function regenIR() {
    irTimer = 0;
    const key = irKeyOf();
    if (key === irKey) return;
    irKey = key;
    requestIR(true);
  }
  irKey = irKeyOf();
  if (withFx) requestIR(false);

  // ---- chorus ---------------------------------------------------------------------
  // Two short delays swept by slow sines in opposite directions: L and R drift
  // apart in time, which widens and thickens without an obvious vibrato.
  const ch = chorusSettings(g.chorus);
  const chorusOut = stereoGain(1);
  const chorusDry = stereoGain(ch.dry);
  const chorusWet = gain(ch.wet);
  bus.connect(chorusDry); chorusDry.connect(chorusOut);
  const chSplit = ctx.createChannelSplitter(2);
  const chMerge = ctx.createChannelMerger(2);
  const chDL = ctx.createDelay(0.05), chDR = ctx.createDelay(0.05);
  chDL.delayTime.value = 0.0125; chDR.delayTime.value = 0.0145;
  bus.connect(chSplit);
  chSplit.connect(chDL, 0); chSplit.connect(chDR, 1);
  chDL.connect(chMerge, 0, 0); chDR.connect(chMerge, 0, 1);
  chMerge.connect(chorusWet); chorusWet.connect(chorusOut);
  const lfoA = ctx.createOscillator(), lfoB = ctx.createOscillator();
  lfoA.frequency.value = 0.31; lfoB.frequency.value = 0.23;
  const depthL = gain(ch.depth), depthR = gain(-ch.depth);
  lfoA.connect(depthL); depthL.connect(chDL.delayTime);
  lfoB.connect(depthR); depthR.connect(chDR.delayTime);
  lfoA.start(); lfoB.start();

  // ---- warmth -----------------------------------------------------------------------
  const warm = warmthSettings(g.saturation);
  const warmPre = stereoGain(warm.pre);
  const warmShaper = ctx.createWaveShaper();
  warmShaper.curve = makeWarmthCurve();
  warmShaper.oversample = '4x';
  const warmPost = stereoGain(warm.post);
  chorusOut.connect(warmPre); warmPre.connect(warmShaper); warmShaper.connect(warmPost);

  // ---- volume, limiter, soft clip, analyser ----------------------------------------
  const volume = stereoGain(volumeGain(g.masterVolume));
  warmPost.connect(volume);
  const ceil0 = ceilingGain(g.ceiling);
  const ceilIn = stereoGain(1 / ceil0);
  volume.connect(ceilIn);
  const limiter = ctx.createDynamicsCompressor();
  limiter.threshold.value = -2;
  limiter.knee.value = 0;
  limiter.ratio.value = 20;
  limiter.attack.value = 0.001;
  limiter.release.value = 0.12;
  ceilIn.connect(limiter);
  const clipPre = stereoGain(1 / CLIP_RANGE);
  const clipShaper = ctx.createWaveShaper();
  clipShaper.curve = makeSoftClipCurve();
  clipShaper.oversample = '2x';
  const output = stereoGain(ceil0);
  limiter.connect(clipPre); clipPre.connect(clipShaper); clipShaper.connect(output);
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 2048;
  analyser.smoothingTimeConstant = 0.6;
  output.connect(analyser);
  if (destination) analyser.connect(destination);

  // ---- parameters -------------------------------------------------------------------
  function set(global, changed = null) {
    // A dry render ignores the effect settings it was built without.
    const has = (k) => (!changed || changed.includes(k)) && Number.isFinite(global[k]) && (withFx || !(k in DRY_ONLY));
    let timeDirty = false, irDirty = false;
    if (has('tempo') && global.tempo !== g.tempo) { g.tempo = global.tempo; timeDirty = true; }
    if (has('delayDiv') && global.delayDiv !== g.delayDiv) { g.delayDiv = global.delayDiv; timeDirty = true; }
    if (timeDirty) {
      const s = delaySeconds(g.tempo, g.delayDiv);
      if (Math.abs(s - delayTarget) > 1e-6) setDelayTime(s);
    }
    if (has('delayFeedback')) {
      g.delayFeedback = clamp(global.delayFeedback, 0, 0.95);
      for (const f of delay.fb) glide(ctx, f.gain, g.delayFeedback);
    }
    if (has('delayTone')) {
      g.delayTone = global.delayTone;
      const t = delayToneFreqs(g.delayTone);
      for (const f of delay.hp) glide(ctx, f.frequency, t.highpass, 0.03);
      for (const f of delay.lp) glide(ctx, f.frequency, t.lowpass, 0.03);
    }
    if (has('delayLevel')) { g.delayLevel = clamp(global.delayLevel, 0, 1); glide(ctx, delayReturn.gain, g.delayLevel); }
    if (has('reverbLevel')) { g.reverbLevel = clamp(global.reverbLevel, 0, 1); glide(ctx, reverbReturn.gain, g.reverbLevel); }
    if (has('reverbSize') && global.reverbSize !== g.reverbSize) { g.reverbSize = clamp(global.reverbSize, 0, 1); irDirty = true; }
    if (has('reverbDamp') && global.reverbDamp !== g.reverbDamp) { g.reverbDamp = clamp(global.reverbDamp, 0, 1); irDirty = true; }
    if (irDirty) { clearTimeout(irTimer); irTimer = setTimeout(regenIR, IR_DEBOUNCE_MS); }
    if (has('chorus')) {
      g.chorus = global.chorus;
      const c = chorusSettings(g.chorus);
      glide(ctx, chorusDry.gain, c.dry, 0.03); glide(ctx, chorusWet.gain, c.wet, 0.03);
      glide(ctx, depthL.gain, c.depth, 0.05); glide(ctx, depthR.gain, -c.depth, 0.05);
    }
    if (has('saturation')) {
      g.saturation = global.saturation;
      const w = warmthSettings(g.saturation);
      glide(ctx, warmPre.gain, w.pre, 0.03); glide(ctx, warmPost.gain, w.post, 0.03);
    }
    if (has('masterVolume')) { g.masterVolume = global.masterVolume; glide(ctx, volume.gain, volumeGain(g.masterVolume), 0.03); }
    if (has('ceiling') && global.ceiling !== g.ceiling) {
      g.ceiling = clamp(global.ceiling, CEILING_MIN_DB, CEILING_MAX_DB);
      const c = ceilingGain(g.ceiling);
      // Same time constant on both sides, so the level of quiet material holds still while it moves.
      glide(ctx, ceilIn.gain, 1 / c, 0.03); glide(ctx, output.gain, c, 0.03);
    }
  }

  /**
   * Hard-silence the effect tails: the delay network is rebuilt (its lines are
   * the only memory) and the convolver is replaced by a fresh one with the
   * same impulse response. The returns dip for a few ms to hide the swap.
   */
  function panic() {
    const t = ctx.currentTime;
    for (const r of [delayReturn.gain, reverbReturn.gain]) {
      try { r.cancelScheduledValues(t); r.setValueAtTime(0, t); r.setTargetAtTime(r === delayReturn.gain ? g.delayLevel : g.reverbLevel, t + 0.03, 0.01); } catch { /* ignore */ }
    }
    try { delayIn.disconnect(delay.input); } catch { /* ignore */ }
    delay.dispose();
    delay = buildDelay();
    delayIn.connect(delay.input);
    delay.output.connect(delayReturn);
    if (conv) installConvolver(conv.buffer, false);
  }

  const allNodes = () => [dryIn, delayIn, reverbIn, bus, delayReturn, reverbPre, reverbReturn, chorusOut, chorusDry, chorusWet,
    chSplit, chMerge, chDL, chDR, lfoA, lfoB, depthL, depthR, warmPre, warmShaper, warmPost, volume, ceilIn, limiter, clipPre, clipShaper, output, analyser];

  return {
    dryIn, delayIn, reverbIn, output, analyser, limiter,
    set,
    panic,
    /** Current effect settings (plain values) and timings. */
    stats: () => ({ ...st, delayTime: delayTarget, reduction: limiter.reduction, settings: { ...g } }),
    /** Resolves once the current reverb settings are loaded in a convolver (tests). */
    whenReverbReady() {
      if (!withFx) return Promise.resolve();
      if (irTimer) { clearTimeout(irTimer); regenIR(); }
      return new Promise((resolve) => { if ((conv && st.irBuilds && irSerialDone()) || (installedSerial && irSerialDone())) resolve(); else irWaiters.push(resolve); });
    },
    dispose() {
      disposed = true;
      clearTimeout(irTimer);
      try { lfoA.stop(); lfoB.stop(); } catch { /* ignore */ }
      delay.dispose();
      if (conv) { try { conv.node.disconnect(); conv.gain.disconnect(); } catch { /* ignore */ } }
      for (const n of allNodes()) { try { n.disconnect(); } catch { /* ignore */ } }
    },
  };
}
