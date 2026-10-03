// The audio side of the pedal loop (docs/PEDALS.md):
//   output routing   main mix on outputs 1/2, the pedal send on 3/4 when the
//                    device has 4+ channels (discrete), else stereo with the
//                    send switched off and a reason the UI can show;
//   send limiter     about -18 dBFS so outputs that can reach +20 dBu never hit
//                    a pedal input that tops out at +5 dBu (HammerOn);
//   return           getUserMedia with every voice-call "helper" switched off;
//   feedback guard   mutes the return when it starts howling or running away;
//   ping             plays a chirp on the send, records the send and the return
//                    side by side, cross-correlates and reports the round trip.
//
// The signal maths (chirp, MLS, cross-correlation, limiter curve, feedback
// rules, routing plan) are pure functions so Node tests can prove them; the
// Web Audio glue below them is thin and checked in dev/pedals in a browser.

import { crossCorrelate, parabolic, dbToGain, gainToDb, rms, peakAbs } from './signal.js';
import { createPeriodicityMeter } from './pitch.js';

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

// ================================================================ pure: test signals

/**
 * Exponential sine sweep from f0 to f1 with raised-cosine fades (no clicks,
 * so pedals with gates or envelope followers are not tripped).
 * @returns {Float32Array}
 */
export function makeChirp(sampleRate, { f0 = 200, f1 = 10000, duration = 0.12, fade = 0.005, amplitude = 1 } = {}) {
  const top = Math.min(f1, sampleRate * 0.45);
  const lo = clamp(f0, 1, top * 0.99);
  const n = Math.max(16, Math.round(duration * sampleRate));
  const out = new Float32Array(n);
  const T = n / sampleRate;
  const L = Math.log(top / lo);
  const K = 2 * Math.PI * lo * T / L;
  const nf = Math.max(1, Math.round(fade * sampleRate));
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate;
    let w = 1;
    if (i < nf) w = 0.5 - 0.5 * Math.cos(Math.PI * i / nf);
    else if (i >= n - nf) w = 0.5 - 0.5 * Math.cos(Math.PI * (n - 1 - i) / nf);
    out[i] = amplitude * w * Math.sin(K * (Math.exp(t * L / T) - 1));
  }
  return out;
}

// Feedback taps of maximal-length Fibonacci LFSRs (1-based bit positions).
const MLS_TAPS = {
  4: [4, 3], 5: [5, 3], 6: [6, 5], 7: [7, 6], 8: [8, 6, 5, 4], 9: [9, 5], 10: [10, 7],
  11: [11, 9], 12: [12, 11, 10, 4], 13: [13, 12, 11, 8], 14: [14, 13, 12, 2], 15: [15, 14], 16: [16, 15, 13, 4],
};

/** Maximum length sequence of ±amplitude, length 2^order - 1. */
export function makeMls(order = 12, amplitude = 1) {
  const taps = MLS_TAPS[order];
  if (!taps) throw new Error(`MLS order must be 4 to 16, not ${order}`);
  const n = (1 << order) - 1;
  const out = new Float32Array(n);
  let reg = 1;
  for (let i = 0; i < n; i++) {
    out[i] = (reg & 1) ? amplitude : -amplitude;
    let bit = 0;
    for (const t of taps) bit ^= (reg >> (order - t)) & 1;
    reg = (reg >> 1) | (bit << (order - 1));
  }
  return out;
}

// ================================================================ pure: delay estimation

/**
 * Where does `ref` appear in `sig`? Normalised cross-correlation over lags
 * minLag..maxLag, the earliest strong peak (an echo from a delay pedal must
 * not win over the dry path), parabolic interpolation for sub-sample lag.
 *
 * confidence (0..1) = peak correlation x how far the peak stands above
 * everything outside its main lobe: 1 is a clean single path, near 0 is noise
 * or nothing came back.
 *
 * @param {ArrayLike<number>} ref the signal that was sent
 * @param {ArrayLike<number>} sig the recording that should contain it, delayed
 * @returns {{lag: number, lagInt: number, peak: number, sidelobe: number, confidence: number, inverted: boolean, echoes: number}}
 */
export function findDelay(ref, sig, { minLag = 0, maxLag = sig.length - ref.length, sampleRate = 48000, earliestRatio = 0.5, mainlobeMs = 1 } = {}) {
  const none = { lag: NaN, lagInt: -1, peak: 0, sidelobe: 0, confidence: 0, inverted: false, echoes: 0 };
  const lo = clamp(Math.round(minLag), 0, Math.max(0, sig.length - 1));
  const hi = clamp(Math.round(maxLag), lo, Math.max(lo, sig.length - 1));
  if (!ref.length || sig.length <= lo) return none;
  const seg = sig.subarray ? sig.subarray(lo, Math.min(sig.length, hi + ref.length)) : Array.prototype.slice.call(sig, lo, hi + ref.length);
  const span = Math.min(hi - lo, seg.length - 1);
  const c = crossCorrelate(ref, seg, span);
  let eRef = 0;
  for (let i = 0; i < ref.length; i++) eRef += ref[i] * ref[i];
  if (eRef <= 0) return none;
  // Sliding energy of the recording under the reference, via prefix sums.
  const pre = new Float64Array(seg.length + 1);
  for (let i = 0; i < seg.length; i++) pre[i + 1] = pre[i] + seg[i] * seg[i];
  const ncc = new Float64Array(c.length);
  let floor = 0;
  for (let l = 0; l < c.length; l++) { const e = pre[Math.min(seg.length, l + ref.length)] - pre[l]; if (e > floor) floor = e; }
  // Below this the window is silence; dividing by it would amplify rounding noise.
  floor *= 1e-6;
  for (let l = 0; l < c.length; l++) {
    const e = pre[Math.min(seg.length, l + ref.length)] - pre[l];
    ncc[l] = e > floor && e > 0 ? c[l] / Math.sqrt(eRef * e) : 0;
  }
  let best = 0;
  for (let l = 1; l < ncc.length; l++) if (Math.abs(ncc[l]) > Math.abs(ncc[best])) best = l;
  const top = Math.abs(ncc[best]);
  if (!(top > 0)) return none;
  const lobe = Math.max(2, Math.round(mainlobeMs * 0.001 * sampleRate));
  const isLocalMax = (l) => {
    const v = Math.abs(ncc[l]);
    for (let j = Math.max(0, l - lobe); j <= Math.min(ncc.length - 1, l + lobe); j++) if (Math.abs(ncc[j]) > v) return false;
    return true;
  };
  // Every strong, separate copy of the reference (the dry path plus any echoes).
  const copies = [];
  for (let l = 0; l < ncc.length; l++) {
    if (Math.abs(ncc[l]) >= earliestRatio * top && isLocalMax(l) && (!copies.length || l - copies[copies.length - 1] > lobe)) copies.push(l);
  }
  const pick = copies.length ? copies[0] : best;
  const sign = ncc[pick] < 0 ? -1 : 1;
  const signed = new Float64Array(3);
  signed[0] = pick > 0 ? sign * ncc[pick - 1] : sign * ncc[pick];
  signed[1] = sign * ncc[pick];
  signed[2] = pick < ncc.length - 1 ? sign * ncc[pick + 1] : sign * ncc[pick];
  const p = parabolic(signed, 1);
  // The interpolated height: a broadband ping delayed by x.5 samples peaks
  // between two lags, and the raw sample there undersells the match.
  const peak = clamp(Math.max(Math.abs(ncc[pick]), p.value), 0, 1);
  // Sidelobe level: the strongest correlation that is not one of the copies.
  // Echoes from a delay pedal are clean copies and do not make the dry path less certain.
  let side = 0;
  let ci = 0;
  for (let l = 0; l < ncc.length; l++) {
    while (ci < copies.length && copies[ci] < l - lobe) ci++;
    if (ci < copies.length && Math.abs(l - copies[ci]) <= lobe) continue;
    const v = Math.abs(ncc[l]);
    if (v > side) side = v;
  }
  const confidence = clamp(peak, 0, 1) * clamp(2 * (1 - side / peak), 0, 1);
  return { lag: lo + pick + p.offset, lagInt: lo + pick, peak, sidelobe: side, confidence, inverted: sign < 0, echoes: Math.max(0, copies.length - 1) };
}

// ================================================================ pure: send limiter

/** Soft clipper in units of the ceiling: identity up to `knee`, then a tanh shoulder that never passes 1. */
export function softClip(x, knee = 0.5) {
  const a = Math.abs(x);
  if (a <= knee) return x;
  const y = knee + (1 - knee) * Math.tanh((a - knee) / (1 - knee));
  return x < 0 ? -y : y;
}

/**
 * WaveShaper curve for the send limiter. Shaper input -1..1 stands for
 * -drive..+drive times the ceiling, so peaks up to `drive` x over the ceiling
 * are rounded off smoothly; anything beyond is held at the ceiling.
 */
export function limiterCurve(n = 4097, { drive = 4, knee = 0.5 } = {}) {
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = softClip((i / (n - 1) * 2 - 1) * drive, knee);
  return out;
}

/** Gains around the shaper: pre = 1 / (drive * ceiling), post = ceiling (linear). */
export function limiterGains(ceilingDb = -18, drive = 4) {
  const c = dbToGain(ceilingDb);
  return { pre: 1 / (drive * c), post: c };
}

// ================================================================ pure: feedback detection

/**
 * Watches the return for a feedback loop. Feed it blocks of samples with a
 * timestamp (ms) about every 20-50 ms. It trips, and stays tripped until
 * reset(), on any of:
 *   howl     loud (>= thresholdDb), extremely steady pitch (clarity >= clarityMin)
 *            and not dying away, for holdMs; or >= quietThresholdDb for quietHoldMs
 *            (a loop through the send limiter settles near -18 dBFS). A plucked
 *            note always decays. Deliberate feedback or an E-bow can trip it:
 *            raise the thresholds or switch the guard off for that. With
 *            howlSpreadCents, the pitch must also stay within that many cents
 *            over the whole hold: a howl sits on one frequency, while a held
 *            sung vowel is just as periodic but wobbles (vibrato, drift).
 *   runaway  level climbing in every quarter of riseWindowMs and now loud:
 *            loop gain above 1. With riseFloorDb, every quarter must already be
 *            above it, so a note starting out of silence (a sung attack) is not
 *            a climb; feedback grows out of sound that is already there.
 *   clipping the return pinned at full scale for clipMs.
 */
export function createFeedbackDetector({
  sampleRate = 48000, thresholdDb = -9, holdMs = 400, clarityMin = 0.95, decayAllowDb = 0.5,
  quietThresholdDb = -24, quietHoldMs = 1500, quietClarityMin = 0.97,
  riseWindowMs = 400, riseStepDb = 1.5, riseFloorDb = -Infinity, clipDb = -0.3, clipMs = 300,
  howlSpreadCents = Infinity,
} = {}) {
  const meter = createPeriodicityMeter({ sampleRate, size: 2048, minFreq: 50, maxFreq: 5000 });
  const keep = Math.max(holdMs, quietHoldMs, riseWindowMs, clipMs) + 200;
  let hist = [];
  const st = { tripped: false, reason: null, kind: null, levelDb: -240, clarity: 0, at: null };

  function trip(kind, t) {
    st.tripped = true;
    st.kind = kind;
    st.at = t;
    st.reason = kind === 'clipping'
      ? 'The pedal return was clipping, so Oro muted it. Turn the return level down, then unmute.'
      : 'The pedal return started feeding back, so Oro muted it. Turn the send or the pedal feedback down, then unmute.';
  }

  function observe(block, t) {
    const levelDb = gainToDb(rms(block));
    const peakDb = gainToDb(peakAbs(block));
    // The periodicity check costs an FFT; only loud blocks can trip anything.
    const m = levelDb >= Math.min(thresholdDb - 12, quietThresholdDb) ? meter.measure(block) : null;
    const clarity = m ? m.clarity : 0;
    const freq = m && m.freq > 0 ? m.freq : 0;
    st.levelDb = levelDb; st.clarity = clarity;
    hist.push({ t, levelDb, peakDb, clarity, freq });
    while (hist.length && hist[0].t < t - keep) hist.shift();
    if (st.tripped) return st;

    const since = (ms) => hist.filter(h => h.t >= t - ms);
    // Max minus min pitch over the window, in cents, within howlSpreadCents.
    const steadyPitch = (w) => {
      if (!(howlSpreadCents < Infinity)) return true;
      let lo = Infinity, hi = 0;
      for (const h of w) { if (!(h.freq > 0)) return false; if (h.freq < lo) lo = h.freq; if (h.freq > hi) hi = h.freq; }
      return 1200 * Math.log2(hi / lo) <= howlSpreadCents;
    };
    const howling = (ms, db, clar) => {
      const w = since(ms);
      return w.length >= 3 && t - w[0].t >= ms * 0.8 &&
        w.every(h => h.levelDb >= db && h.clarity >= clar) &&
        w[w.length - 1].levelDb >= w[0].levelDb - decayAllowDb &&
        steadyPitch(w);
    };
    // Howl: loud and steady for holdMs, or (held down by the -18 dBFS send
    // limiter) quieter but just as steady for quietHoldMs.
    if (howling(holdMs, thresholdDb, clarityMin) || howling(quietHoldMs, quietThresholdDb, quietClarityMin)) {
      trip('howl', t);
      return st;
    }
    // Runaway: mean level of each quarter of the window above the one before.
    const win = since(riseWindowMs);
    if (win.length >= 8 && t - win[0].t >= riseWindowMs * 0.8 && levelDb >= thresholdDb) {
      const q = [0, 0, 0, 0], n = [0, 0, 0, 0];
      const t0 = t - riseWindowMs;
      for (const h of win) { const k = clamp(Math.floor((h.t - t0) / riseWindowMs * 4), 0, 3); q[k] += h.levelDb; n[k]++; }
      if (n.every(c => c > 0)) {
        const m = q.map((s, i) => s / n[i]);
        if (m[0] >= riseFloorDb && m[1] >= m[0] + riseStepDb && m[2] >= m[1] + riseStepDb && m[3] >= m[2] + riseStepDb) { trip('runaway', t); return st; }
      }
    }
    // Clipping
    const clip = since(clipMs);
    if (clip.length >= 3 && t - clip[0].t >= clipMs * 0.8 && clip.every(h => h.peakDb >= clipDb)) trip('clipping', t);
    return st;
  }

  return {
    observe,
    reset() { hist = []; st.tripped = false; st.reason = null; st.kind = null; st.at = null; },
    get state() { return st; },
    get tripped() { return st.tripped; },
  };
}

// ================================================================ pure: routing plan

/**
 * Decide how to use the output device. Channel numbers are 0-based
 * (sendChannels [2, 3] = outputs 3 and 4).
 * @returns {{mode: 'multichannel'|'stereo', channelCount: number, reason: string|null}}
 */
export function planRouting(maxChannelCount, { sendChannels = [2, 3], mainChannels = [0, 1] } = {}) {
  const max = Math.max(0, Math.floor(Number(maxChannelCount) || 0));
  const all = [...sendChannels, ...mainChannels];
  const bad = all.some(c => !Number.isInteger(c) || c < 0 || c > 31) || new Set(all).size !== all.length || !sendChannels.length;
  if (bad) return { mode: 'stereo', channelCount: 2, reason: 'The pedal send channels overlap the main outputs, so the send is switched off. Pick different outputs for the send.' };
  const need = Math.max(...all) + 1;
  if (max >= need) return { mode: 'multichannel', channelCount: need, reason: null };
  const outs = sendChannels.map(c => c + 1).join(' and ');
  return {
    mode: 'stereo',
    channelCount: 2,
    reason: `This output device has ${max || 2} channels, and the pedal send uses output${sendChannels.length > 1 ? 's' : ''} ${outs}. The send is switched off for now. Choose a device with ${need} or more outputs, such as the MPC XL, in Settings > Pedals.`,
  };
}

// ================================================================ Web Audio glue

/**
 * Point the context at an output device (Chrome / Edge: AudioContext.setSinkId).
 * The channel count can change with the device, so rebuild the routing after.
 */
export async function applyOutputDevice(ctx, deviceId) {
  if (!ctx || typeof ctx.setSinkId !== 'function') {
    return { ok: false, reason: 'This browser cannot send Oro to a chosen output device. Chrome and Edge can.', maxChannelCount: ctx && ctx.destination ? ctx.destination.maxChannelCount : 2 };
  }
  try {
    await ctx.setSinkId(deviceId || '');
    return { ok: true, reason: null, maxChannelCount: ctx.destination.maxChannelCount };
  } catch (err) {
    return { ok: false, reason: `That output device could not be used (${(err && err.message) || err}). Check that it is connected.`, maxChannelCount: ctx.destination.maxChannelCount };
  }
}

/**
 * Main mix and pedal send to the right outputs. Connect the master output to
 * `mainIn` and the send bus (after its limiter) to `sendIn`.
 * @returns {{mode, reason, channelCount, mainIn: GainNode, sendIn: GainNode, setStereoSendMix(g), dispose()}}
 */
export function buildOutputRouting(ctx, { sendChannels = [2, 3], mainChannels = [0, 1], stereoSendMix = 0 } = {}) {
  const dest = ctx.destination;
  let plan = planRouting(dest.maxChannelCount, { sendChannels, mainChannels });
  const stereo = (node) => { node.channelCount = 2; node.channelCountMode = 'explicit'; node.channelInterpretation = 'speakers'; return node; };
  const mainIn = stereo(ctx.createGain());
  const sendIn = ctx.createGain();
  if (sendChannels.length === 1) { sendIn.channelCount = 1; sendIn.channelCountMode = 'explicit'; sendIn.channelInterpretation = 'speakers'; } else stereo(sendIn);
  const owned = [];
  let sendMute = null;
  const prev = { channelCount: dest.channelCount, channelCountMode: dest.channelCountMode, channelInterpretation: dest.channelInterpretation };

  if (plan.mode === 'multichannel') {
    try {
      dest.channelCount = plan.channelCount;
      dest.channelCountMode = 'explicit';
      // Discrete: four outputs are four separate jacks here, not quad speakers to up/down-mix.
      dest.channelInterpretation = 'discrete';
      const merger = ctx.createChannelMerger(plan.channelCount);
      const ms = ctx.createChannelSplitter(2);
      mainIn.connect(ms);
      ms.connect(merger, 0, mainChannels[0]);
      ms.connect(merger, 1, mainChannels[1]);
      if (sendChannels.length === 1) sendIn.connect(merger, 0, sendChannels[0]);
      else {
        const ss = ctx.createChannelSplitter(2);
        sendIn.connect(ss);
        ss.connect(merger, 0, sendChannels[0]);
        ss.connect(merger, 1, sendChannels[1]);
        owned.push(ss);
      }
      merger.connect(dest);
      owned.push(ms, merger);
    } catch (err) {
      for (const n of owned) { try { n.disconnect(); } catch { /* ignore */ } }
      owned.length = 0;
      try { mainIn.disconnect(); sendIn.disconnect(); } catch { /* ignore */ }
      try { Object.assign(dest, prev); } catch { /* ignore */ }
      plan = { mode: 'stereo', channelCount: 2, reason: `The output device would not open ${plan.channelCount} channels (${(err && err.message) || err}), so the pedal send is switched off for now.` };
    }
  }
  if (plan.mode === 'stereo') {
    mainIn.connect(dest);
    // Kept connected through a silent gain so the send bus (and its meters) still run.
    sendMute = ctx.createGain();
    sendMute.gain.value = stereoSendMix;
    sendIn.connect(sendMute);
    sendMute.connect(dest);
    owned.push(sendMute);
  }
  return {
    mode: plan.mode,
    reason: plan.reason,
    channelCount: plan.channelCount,
    maxChannelCount: dest.maxChannelCount,
    mainIn,
    sendIn,
    /** Stereo fallback only: hear the send in the main mix (0 = off) to check it without hardware. */
    setStereoSendMix(g) { if (sendMute) sendMute.gain.setTargetAtTime(clamp(Number(g) || 0, 0, 1), ctx.currentTime, 0.02); return !!sendMute; },
    dispose() {
      for (const n of [mainIn, sendIn, ...owned]) { try { n.disconnect(); } catch { /* ignore */ } }
      try { Object.assign(dest, prev); } catch { /* ignore */ }
    },
  };
}

/**
 * Send-bus safety limiter: soft clipper with a hard ceiling (default -18 dBFS).
 * A WaveShaper and not a DynamicsCompressor because Chrome's compressor adds
 * its own make-up gain and has no guaranteed ceiling.
 */
export function createSendLimiter(ctx, { ceilingDb = -18, drive = 4, knee = 0.5 } = {}) {
  const input = ctx.createGain();
  const shaper = ctx.createWaveShaper();
  const output = ctx.createGain();
  shaper.curve = limiterCurve(4097, { drive, knee });
  shaper.oversample = '4x';
  let current = ceilingDb;
  const apply = () => { const g = limiterGains(current, drive); input.gain.value = g.pre; output.gain.value = g.post; };
  apply();
  input.connect(shaper);
  shaper.connect(output);
  return {
    input, output,
    get ceilingDb() { return current; },
    setCeiling(db) { current = clamp(Number(db), -60, 0); apply(); return current; },
    dispose() { for (const n of [input, shaper, output]) { try { n.disconnect(); } catch { /* ignore */ } } },
  };
}

/** Audio inputs the browser can see (names appear once permission was given). */
export async function listAudioInputs() {
  const md = typeof navigator !== 'undefined' && navigator.mediaDevices;
  if (!md || typeof md.enumerateDevices !== 'function') return [];
  try {
    const list = await md.enumerateDevices();
    return list.filter(d => d.kind === 'audioinput').map((d, i) => ({ deviceId: d.deviceId, label: d.label || `Input ${i + 1}`, groupId: d.groupId }));
  } catch { return []; }
}

/** getUserMedia constraints for an instrument / pedal return: every voice-call process off. */
export function returnConstraints(deviceId, sampleRate) {
  const audio = {
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: false,
    channelCount: { ideal: 2 },
    latency: { ideal: 0 },
  };
  if (deviceId) audio.deviceId = { exact: deviceId };
  if (sampleRate) audio.sampleRate = { ideal: sampleRate };
  return { audio, video: false };
}

function mediaErrorReason(err) {
  const name = err && err.name;
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'Oro needs permission to hear the pedal return. Allow microphone access for this page in the browser, then try again.';
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'That input is not connected any more. Plug it in or pick another input.';
  if (name === 'NotReadableError' || name === 'AbortError') return 'Another app is using that input, or the system blocked it. Close the other app and try again.';
  return `The input could not be opened (${(err && err.message) || err}).`;
}

/**
 * Open the pedal return. layout 'stereo' (both channels are the return) or
 * 'mono+guitar' (channel 1 = return, channel 2 = the guitar DI, the doc's
 * "mono return + guitar" mode; Chrome captures two input channels at most).
 * Never throws: failures come back as { ok: false, reason }.
 */
export async function openReturn(ctx, deviceId, { layout = 'stereo', gain = 1 } = {}) {
  const md = typeof navigator !== 'undefined' && navigator.mediaDevices;
  if (!md || typeof md.getUserMedia !== 'function') {
    return { ok: false, reason: 'This browser cannot capture audio here. Oro needs a secure page (https or localhost) to use an audio input.' };
  }
  let stream;
  try {
    stream = await md.getUserMedia(returnConstraints(deviceId, ctx.sampleRate));
  } catch (err) {
    return { ok: false, reason: mediaErrorReason(err), error: err };
  }
  const track = stream.getAudioTracks()[0];
  const settings = track && typeof track.getSettings === 'function' ? track.getSettings() : {};
  const warnings = [];
  for (const k of ['echoCancellation', 'noiseSuppression', 'autoGainControl']) {
    if (settings[k] === true) warnings.push(`The browser kept ${k.replace(/[A-Z]/g, c => ' ' + c.toLowerCase())} on, which will colour the return.`);
  }
  if (settings.sampleRate && settings.sampleRate !== ctx.sampleRate) {
    warnings.push(`The input runs at ${settings.sampleRate} Hz and Oro at ${ctx.sampleRate} Hz, so the browser resamples it.`);
  }
  const source = ctx.createMediaStreamSource(stream);
  const out = ctx.createGain();
  out.gain.value = gain;
  const owned = [source, out];
  let guitar = null;
  if (layout === 'mono+guitar') {
    const split = ctx.createChannelSplitter(2);
    source.connect(split);
    split.connect(out, 0);
    out.channelCount = 1; out.channelCountMode = 'explicit';
    guitar = ctx.createGain();
    guitar.channelCount = 1; guitar.channelCountMode = 'explicit';
    split.connect(guitar, 1);
    owned.push(split, guitar);
  } else {
    source.connect(out);
  }
  return {
    ok: true, reason: null, warnings, settings, stream, source,
    gain: out, output: out, guitar,
    close() {
      for (const n of owned) { try { n.disconnect(); } catch { /* ignore */ } }
      for (const t of stream.getTracks()) { try { t.stop(); } catch { /* ignore */ } }
    },
  };
}

/**
 * Watch `input` (the return before its mute) and ramp `gain` to 0 when the
 * detector trips. Stays muted until reset(). Main-thread polling is enough:
 * feedback builds over hundreds of milliseconds and the send limiter caps how
 * loud it can get meanwhile.
 */
export function attachFeedbackGuard(ctx, { input, gain, intervalMs = 25, onTrip = null, now = () => performance.now(), ...detectorOptions } = {}) {
  const det = createFeedbackDetector({ sampleRate: ctx.sampleRate, ...detectorOptions });
  const an = ctx.createAnalyser();
  an.fftSize = 2048;
  input.connect(an);
  const buf = new Float32Array(an.fftSize);
  let restore = gain ? gain.gain.value : 1;
  let muted = false;
  const timer = setInterval(() => {
    an.getFloatTimeDomainData(buf);
    const st = det.observe(buf, now());
    if (st.tripped && !muted) {
      muted = true;
      if (gain) {
        const t = ctx.currentTime;
        restore = gain.gain.value || restore;
        gain.gain.cancelScheduledValues(t);
        gain.gain.setValueAtTime(gain.gain.value, t);
        gain.gain.linearRampToValueAtTime(0, t + 0.02);
      }
      if (onTrip) { try { onTrip({ ...st }); } catch { /* listener bug */ } }
    }
  }, intervalMs);
  return {
    get tripped() { return det.tripped; },
    status() {
      const s = det.state;
      // Still loud and steady after we muted: the loop runs outside Oro (for example in the MPC's monitoring).
      const outside = muted && s.levelDb >= (detectorOptions.thresholdDb ?? -9) && s.clarity >= 0.9;
      return { ...s, muted, outside, outsideReason: outside ? 'It is still feeding back with Oro muted, so the loop is in the MPC routing. Check that the return track goes to USB Out 1,2 only.' : null };
    },
    reset() {
      det.reset();
      if (muted && gain) {
        const t = ctx.currentTime;
        gain.gain.cancelScheduledValues(t);
        gain.gain.setValueAtTime(0, t);
        gain.gain.linearRampToValueAtTime(restore, t + 0.05);
      }
      muted = false;
    },
    dispose() { clearInterval(timer); try { input.disconnect(an); } catch { /* ignore */ } },
  };
}

/**
 * Record `channels` channels of whatever is connected to `input`, sample-aligned
 * with each other. Uses the 'orograph-pedal-capture' AudioWorklet processor when
 * guitar-worklet.js is loaded (see worklet-loader.js), else a ScriptProcessor.
 */
export function createCapture(ctx, { channels = 2, maxSeconds = 4 } = {}) {
  const maxFrames = Math.ceil(maxSeconds * ctx.sampleRate);
  let node = null, via = 'worklet';
  const chunks = [];
  let armed = false, frames = 0, done = null, dropouts = 0;
  try {
    node = new AudioWorkletNode(ctx, 'orograph-pedal-capture', {
      numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1],
      channelCount: channels, channelCountMode: 'explicit', channelInterpretation: 'discrete',
      processorOptions: { channels },
    });
    node.port.onmessage = (e) => {
      const m = e.data || {};
      if (m.t === 'chunk') { chunks.push(m.data); frames += m.frames; }
      else if (m.t === 'done' && done) { const d = done; done = null; d(); }
    };
  } catch {
    via = 'script';
    node = ctx.createScriptProcessor(2048, channels, 1);
    node.channelCountMode = 'explicit';
    node.channelInterpretation = 'discrete';
    let lastPlayback = null;
    node.onaudioprocess = (e) => {
      // Skipped callbacks (busy main thread) leave holes in the recording; count them.
      if (armed && lastPlayback != null && e.playbackTime - lastPlayback > 1.5 * 2048 / ctx.sampleRate) dropouts++;
      lastPlayback = e.playbackTime;
      if (!armed) return;
      const n = Math.min(e.inputBuffer.length, maxFrames - frames);
      if (n <= 0) { armed = false; return; }
      const block = [];
      for (let c = 0; c < channels; c++) block.push(e.inputBuffer.getChannelData(Math.min(c, e.inputBuffer.numberOfChannels - 1)).slice(0, n));
      chunks.push(block);
      frames += n;
    };
  }
  const sink = ctx.createGain();
  sink.gain.value = 0;
  node.connect(sink);
  sink.connect(ctx.destination);

  function join() {
    const out = Array.from({ length: channels }, () => new Float32Array(frames));
    let o = 0;
    for (const block of chunks) {
      const n = block[0].length;
      for (let c = 0; c < channels; c++) out[c].set(block[c] || block[0], o);
      o += n;
    }
    return out;
  }
  return {
    input: node,
    via,
    /** ScriptProcessor fallback only: callbacks skipped since start(). */
    get dropouts() { return dropouts; },
    async start() {
      chunks.length = 0; frames = 0; dropouts = 0;
      if (via === 'worklet') node.port.postMessage({ t: 'start', maxFrames });
      armed = true;
    },
    /** Stop and return one Float32Array per channel. */
    stop() {
      armed = false;
      if (via !== 'worklet') return Promise.resolve(join());
      return new Promise((resolve) => {
        const timer = setTimeout(() => { done = null; resolve(join()); }, 1000);
        done = () => { clearTimeout(timer); resolve(join()); };
        node.port.postMessage({ t: 'stop' });
      });
    },
    dispose() { try { node.disconnect(); sink.disconnect(); } catch { /* ignore */ } },
  };
}

const wait = (ms) => new Promise(r => setTimeout(r, ms));
async function waitUntil(ctx, t) {
  while (ctx.currentTime < t) await wait(Math.max(5, Math.min(50, (t - ctx.currentTime) * 1000)));
}

/**
 * Measure the pedal loop's round trip. Plays a chirp (or an MLS burst) into
 * `sendNode` and records, in one capture node, the chirp itself on channel 1 and
 * `returnNode` on channel 2, so both share one clock and the answer includes
 * output latency + converters + cables + pedals + input latency: exactly how
 * late the return is behind the dry signal.
 *
 * `mute` (optional) is called first and may return an undo function: use it to
 * silence the music, so the ping is the only thing on the send.
 *
 * @returns {Promise<{ok, latencyMs, latencySamples, confidence, inverted, runs, via, reason}>}
 */
export async function measureRoundTrip(ctx, {
  sendNode, returnNode, signal = 'chirp', levelDb = -24, maxLatencyMs = 400, runs = 3, mute = null,
  minConfidence = 0.3, chirp = {},
} = {}) {
  const fail = (reason, extra = {}) => ({ ok: false, latencyMs: NaN, latencySamples: NaN, confidence: 0, inverted: false, runs: [], via: null, reason, ...extra });
  if (!ctx || !sendNode || !returnNode) return fail('The ping needs the pedal send and the pedal return to be set up first.');
  if (ctx.state !== 'running') return fail('Start the audio first, then run the ping again.');
  const sr = ctx.sampleRate;
  const ref = signal === 'mls' ? makeMls(sr >= 88200 ? 14 : 13) : makeChirp(sr, chirp);
  const buf = ctx.createBuffer(1, ref.length, sr);
  buf.copyToChannel(ref, 0);
  const listenSec = ref.length / sr + maxLatencyMs / 1000 + 0.15;
  const cap = createCapture(ctx, { channels: 2, maxSeconds: listenSec + 0.5 });
  const level = ctx.createGain();
  // Below the send limiter's knee, so the reference we record is what really leaves.
  level.gain.value = dbToGain(levelDb);
  const merger = ctx.createChannelMerger(2);
  level.connect(sendNode);
  level.connect(merger, 0, 0);
  returnNode.connect(merger, 0, 1);
  merger.connect(cap.input);
  let undo = null;
  const results = [];
  try {
    if (typeof mute === 'function') undo = await mute();
    for (let r = 0; r < Math.max(1, runs); r++) {
      await cap.start();
      const t0 = ctx.currentTime + 0.06;
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.connect(level);
      src.start(t0);
      await waitUntil(ctx, t0 + listenSec);
      const [chRef, chRet] = await cap.stop();
      try { src.disconnect(); } catch { /* ended */ }
      const run = analyseRun(ref, chRef, chRet, sr, maxLatencyMs);
      // A recording with holes in it cannot be trusted, however well it correlates.
      if (cap.dropouts) Object.assign(run, { ok: false, dropouts: cap.dropouts, reason: 'The browser was too busy to record the ping.' });
      results.push(run);
      await wait(80);
    }
  } finally {
    if (typeof undo === 'function') { try { undo(); } catch { /* ignore */ } }
    for (const [a, b] of [[level, sendNode], [level, merger], [returnNode, merger]]) { try { a.disconnect(b); } catch { /* ignore */ } }
    try { merger.disconnect(); } catch { /* ignore */ }
    cap.dispose();
  }
  return combineRuns(results, sr, { minConfidence, via: cap.via });
}

/** One ping: where the chirp sits in the send channel, then in the return channel. */
export function analyseRun(ref, chRef, chRet, sampleRate, maxLatencyMs = 400) {
  if (!chRef || chRef.length < ref.length || peakAbs(chRef) < 1e-5) return { ok: false, reason: 'The ping did not play.' };
  const sent = findDelay(ref, chRef, { sampleRate });
  if (!(sent.peak > 0.9)) return { ok: false, reason: 'The ping did not play cleanly.' };
  const maxLag = sent.lagInt + Math.ceil(maxLatencyMs * 0.001 * sampleRate);
  const back = findDelay(ref, chRet, { sampleRate, minLag: sent.lagInt, maxLag: Math.min(maxLag, chRet.length - 1) });
  if (!Number.isFinite(back.lag)) return { ok: false, reason: 'Nothing came back from the pedals.', confidence: 0 };
  const samples = back.lag - sent.lag;
  return { ok: true, samples, ms: samples / sampleRate * 1000, confidence: back.confidence, inverted: back.inverted, peak: back.peak };
}

/** Median of the confident runs; runs that disagree lower the confidence. */
export function combineRuns(results, sampleRate, { minConfidence = 0.3, via = null } = {}) {
  const good = results.filter(r => r.ok && r.confidence >= minConfidence);
  if (!good.length) {
    const played = results.some(r => r.ok || r.reason !== 'The ping did not play.');
    return {
      ok: false, latencyMs: NaN, latencySamples: NaN, confidence: Math.max(0, ...results.map(r => r.confidence || 0)), inverted: false,
      runs: results, via,
      reason: played
        ? 'No clear ping came back. Check that the send reaches the pedals, the return is plugged into the selected input, and time-based pedals (delay, reverb, looper) are bypassed.'
        : 'The ping did not play. Start the audio and try again.',
    };
  }
  const sorted = good.map(r => r.samples).sort((a, b) => a - b);
  const med = sorted[sorted.length >> 1];
  const spreadMs = (sorted[sorted.length - 1] - sorted[0]) / sampleRate * 1000;
  const confs = good.map(r => r.confidence).sort((a, b) => a - b);
  // A majority of good runs is full strength; a lone good run counts for less.
  let confidence = confs[confs.length >> 1] * Math.min(1, good.length / Math.ceil(results.length / 2));
  if (spreadMs > 1) confidence *= clamp(1 / spreadMs, 0.2, 1);
  return {
    ok: true,
    latencySamples: med,
    latencyMs: med / sampleRate * 1000,
    confidence: clamp(confidence, 0, 1),
    inverted: good.filter(r => r.inverted).length > good.length / 2,
    spreadMs,
    runs: results,
    via,
    reason: null,
  };
}
