// 2.12 Listening modes: change only what you hear, never what Oro records,
// bounces, loops or exports. The stage sits after every capture point (the
// recorder taps the master output, the looper the volume stage, bounces and
// stems render offline) and right before mainOut, the last node on the way to
// the device:
//
//   effects master -> analyser (meters) -> listen.input -> [mode] -> mainOut -> device
//
// Modes:
//   normal      straight through (gain 1, so the samples are unchanged)
//   headphones  gentle crossfeed: each side also hears a little of the other,
//               low-passed and ~0.3 ms late, as it would from speakers. Hard
//               panned sounds get less tiring; the middle keeps its level
//   mono        (L + R) / 2 on both sides: a sound in the middle keeps its
//               level, so mono is never louder; out-of-phase parts cancel
//   small       a rough phone or laptop speaker preview: mono, no deep bass,
//               less top, a little presence bump. Not a model of any device
//   swap        left and right exchanged
//
// Switching glides over 25 ms (old path down, new path up), so it never clicks.
// The design numbers are exported so the unit tests can check the maths on
// a plain JS version of each mode (renderListen).

export const LISTEN_MODES = Object.freeze([
  { value: 'normal', label: 'Normal', text: 'What Oro plays, unchanged.' },
  { value: 'headphones', label: 'Headphones', text: 'Gentle crossfeed: each ear hears a little of the other side, so hard-panned sounds are less tiring.' },
  { value: 'mono', label: 'Mono check', text: 'Left and right summed, at the same level. Parts that cancel in mono disappear.' },
  { value: 'small', label: 'Small speaker', text: 'A rough preview of a phone or laptop speaker: no deep bass, less treble, in mono. Only a rough guide.' },
  { value: 'swap', label: 'Swap L/R', text: 'Left and right exchanged, to check your headphones or the panning.' },
]);
export const LISTEN_VALUES = Object.freeze(LISTEN_MODES.map(m => m.value));

export const CROSSFEED = Object.freeze({ levelDb: -8, lowpassHz: 700, delayMs: 0.3 });
export const SMALL_SPEAKER = Object.freeze({ highpassHz: 280, lowpassHz: 9000, peakHz: 2500, peakDb: 3 });
export const SWITCH_SECONDS = 0.025;

/** Crossfeed gains: cross (into the other side, low-passed) and direct, so a centred low tone keeps its level. */
export function crossfeedGains(levelDb = CROSSFEED.levelDb) {
  const cross = Math.pow(10, levelDb / 20);
  const direct = 1 - cross;
  // the direct path's high shelf brings the treble back to 1 (direct * 1 / direct)
  return { cross, direct, shelfDb: -20 * Math.log10(direct) };
}

/**
 * Plain JS reference of each mode on whole buffers (tests, and the
 * documentation of what the node graph does). One-pole filters stand in for
 * the graph's biquads, so levels match at the extremes, not to the decimal.
 */
export function renderListen(mode, L, R, sr) {
  const n = Math.min(L.length, R.length);
  const oL = new Float64Array(n), oR = new Float64Array(n);
  const pole = (hz) => Math.exp(-2 * Math.PI * hz / sr);
  if (mode === 'mono' || mode === 'small') {
    for (let i = 0; i < n; i++) oL[i] = oR[i] = 0.5 * (L[i] + R[i]);
    if (mode === 'small') {
      const aH = pole(SMALL_SPEAKER.highpassHz), aL = pole(SMALL_SPEAKER.lowpassHz);
      let h1 = 0, h2 = 0, l = 0;
      for (let i = 0; i < n; i++) {
        const x = oL[i];
        h1 = x + (h1 - x) * aH; const y1 = x - h1;
        h2 = y1 + (h2 - y1) * aH; const y2 = y1 - h2;
        l = y2 + (l - y2) * aL;
        oL[i] = oR[i] = l;
      }
    }
    return { L: oL, R: oR };
  }
  if (mode === 'swap') { for (let i = 0; i < n; i++) { oL[i] = R[i]; oR[i] = L[i]; } return { L: oL, R: oR }; }
  if (mode === 'headphones') {
    const { cross, direct } = crossfeedGains();
    const d = Math.round(CROSSFEED.delayMs * sr / 1000);
    const a = pole(CROSSFEED.lowpassHz);
    let zl = 0, zr = 0, sl = 0, sr2 = 0;
    const aS = a;
    for (let i = 0; i < n; i++) {
      const xl = i >= d ? L[i - d] : 0, xr = i >= d ? R[i - d] : 0;
      zl = xl + (zl - xl) * a; zr = xr + (zr - xr) * a;
      // direct path: low part at `direct`, high part at 1 (the shelf)
      sl = L[i] + (sl - L[i]) * aS; sr2 = R[i] + (sr2 - R[i]) * aS;
      const dl = direct * sl + (L[i] - sl), dr = direct * sr2 + (R[i] - sr2);
      oL[i] = dl + cross * zr;
      oR[i] = dr + cross * zl;
    }
    return { L: oL, R: oR };
  }
  for (let i = 0; i < n; i++) { oL[i] = L[i]; oR[i] = R[i]; }
  return { L: oL, R: oR };
}

/**
 * The live stage. `input` takes the master after the meters; `output` is
 * mainOut. Returns { input, mode, set(mode), dispose() }.
 */
export function createListen(ctx, output, initial = 'normal') {
  const stereo = (g = 1) => {
    const n = ctx.createGain();
    n.channelCount = 2; n.channelCountMode = 'explicit'; n.channelInterpretation = 'speakers';
    n.gain.value = g;
    return n;
  };
  const input = stereo();
  let current = null, mode = 'normal';

  function build(m) {
    const out = stereo(0);
    const nodes = [out];
    let head = null;
    if (m === 'normal') head = out;
    else if (m === 'swap' || m === 'mono' || m === 'small' || m === 'headphones') {
      const split = ctx.createChannelSplitter(2), merge = ctx.createChannelMerger(2);
      nodes.push(split, merge);
      head = split;
      merge.connect(out);
      if (m === 'swap') { split.connect(merge, 0, 1); split.connect(merge, 1, 0); }
      else if (m === 'mono' || m === 'small') {
        const sum = ctx.createGain();
        sum.channelCount = 1; sum.channelCountMode = 'explicit'; sum.channelInterpretation = 'discrete';
        sum.gain.value = 0.5;
        split.connect(sum, 0); split.connect(sum, 1);
        nodes.push(sum);
        let tail = sum;
        if (m === 'small') {
          const f = (type, hz, q = 0.707, gain = 0) => { const b = ctx.createBiquadFilter(); b.type = type; b.frequency.value = hz; b.Q.value = q; b.gain.value = gain; nodes.push(b); return b; };
          const chain = [f('highpass', SMALL_SPEAKER.highpassHz), f('highpass', SMALL_SPEAKER.highpassHz), f('peaking', SMALL_SPEAKER.peakHz, 1, SMALL_SPEAKER.peakDb), f('lowpass', SMALL_SPEAKER.lowpassHz)];
          for (const b of chain) { tail.connect(b); tail = b; }
        }
        tail.connect(merge, 0, 0); tail.connect(merge, 0, 1);
      } else {
        const { cross, direct, shelfDb } = crossfeedGains();
        for (const [from, to] of [[0, 0], [1, 1]]) {
          const g = ctx.createGain(); g.gain.value = direct;
          const shelf = ctx.createBiquadFilter(); shelf.type = 'highshelf'; shelf.frequency.value = CROSSFEED.lowpassHz; shelf.gain.value = shelfDb;
          split.connect(g, from); g.connect(shelf); shelf.connect(merge, 0, to);
          nodes.push(g, shelf);
        }
        for (const [from, to] of [[0, 1], [1, 0]]) {
          const d = ctx.createDelay(0.01); d.delayTime.value = CROSSFEED.delayMs / 1000;
          const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = CROSSFEED.lowpassHz; lp.Q.value = 0.5;
          const g = ctx.createGain(); g.gain.value = cross;
          split.connect(d, from); d.connect(lp); lp.connect(g); g.connect(merge, 0, to);
          nodes.push(d, lp, g);
        }
      }
    }
    input.connect(head);
    out.connect(output);
    return { out, dispose() { for (const n of nodes) { try { n.disconnect(); } catch { /* ignore */ } } try { input.disconnect(head); } catch { /* ignore */ } } };
  }

  function set(next, { instant = false } = {}) {
    const m = LISTEN_VALUES.includes(next) ? next : 'normal';
    if (current && m === mode) return mode;
    const path = build(m);
    const t = ctx.currentTime;
    const old = current;
    if (instant || !old) path.out.gain.value = 1;
    else {
      path.out.gain.setValueAtTime(0, t);
      path.out.gain.linearRampToValueAtTime(1, t + SWITCH_SECONDS);
      old.out.gain.cancelScheduledValues(t);
      old.out.gain.setValueAtTime(old.out.gain.value, t);
      old.out.gain.linearRampToValueAtTime(0, t + SWITCH_SECONDS);
      setTimeout(() => old.dispose(), SWITCH_SECONDS * 1000 + 60);
    }
    if (instant && old) old.dispose();
    current = path;
    mode = m;
    return mode;
  }

  set(initial, { instant: true });
  return {
    input,
    get mode() { return mode; },
    set,
    dispose() { if (current) current.dispose(); try { input.disconnect(); } catch { /* ignore */ } },
  };
}
