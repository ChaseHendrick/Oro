// Sampler (2.13): a track that plays one recorded sample across the keyboard
// instead of the terrain oscillator. Plain logic shared by the audio worklet,
// the main-thread renders (Freeze, bounce, stems) and the tests.
//
// SamplerPlayer runs at the host rate and adds its mono output into the
// track's buffers, where the track's rack, sends, mixer and 3D sound take it
// like any other track output (dsp-core.js renderSegment).
//
// Playback modes (part.sampler.mode):
//   0 Chromatic  every key plays the region at its pitch relative to Root;
//                Attack, then Decay (or full level while held with Sustain);
//                letting go fades the note over the Decay time
//   1 One-shot   every key plays the whole region once at its pitch and the
//                note-off is ignored (Loop does not apply)
//   2 Held       plays while the key is held (Sustain keeps it at full level,
//                otherwise the Attack/Decay shape), a quick fade on release
//   3 Slices     keys from Root up pick the slices in turn, each played once
//                at the sample's own pitch (times Speed). With no stored marks
//                the sample is sixteen even pieces. A sequencer step can name
//                one slice and leave the scale degree alone.
//   4 Granular   a cloud of short windowed grains read around Position in the
//                region; the key transposes the grains; gated like Held
//
// Pitch: source frames per output frame = sampleRate / hostRate *
// 2^(semis / 12) * speed * bend, where semis is the key against Root (in
// the session's tuning when it has one) plus Fine. Reading uses 4-point
// Hermite interpolation. Looping jumps back with a short equal-power
// crossfade (LOOP_XFADE_SECONDS, at most a quarter of the region) so loop
// points need not sit on zero crossings; ping-pong turns round at the ends.
//
// Voices: MAX_VOICES sounding notes, plus spare slots so a stolen voice can
// fade out (STEAL_SECONDS) while the new note starts. Nothing is allocated
// after the constructor; grains come from a fixed pool per voice. Grain
// randomness is a per-note generator seeded from the note and velocity, so a
// bounce or Freeze repeats a live take sample for sample.

export const SAMPLER_MODES = ['Chromatic', 'One-shot', 'Held', 'Slices', 'Granular'];
export const SAMPLER_DIRS = ['Forward', 'Reverse', 'Ping-pong'];
export const MAX_VOICES = 8;
const VOICE_SLOTS = MAX_VOICES + 4;
export const GRAINS_PER_VOICE = 24;
export const LOOP_XFADE_SECONDS = 0.01;
const STEAL_SECONDS = 0.004;
const GATE_RELEASE_SECONDS = 0.02;
const EDGE_SECONDS = 0.002;
export const SAMPLER_MAX_SECONDS = 16;
export const SAMPLER_RATE = 48000;
export const MAX_SLICES = 32;
/** Even pieces used when Slices mode has no stored marks. */
export const EVEN_SLICES = 16;
const WIN_N = 1024;

/** Periodic Hann window, WIN_N + 1 points (the last repeats the first) for linear lookup. */
export const GRAIN_WINDOW = (() => {
  const w = new Float32Array(WIN_N + 1);
  for (let i = 0; i <= WIN_N; i++) w[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / WIN_N);
  return w;
})();

const clampN = (v, lo, hi, d) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);

// ---- saved data ----------------------------------------------------------
// part.sampler (absent until a track is put in Sampler mode) =
// { on, name, sample: null | { rate, data (base64 16-bit PCM), right? (the
// other channel, same length, absent when the take is mono) }, mode,
//   root (MIDI note), fine (cents), loop (0/1), dir (0 forward, 1 reverse,
//   2 ping-pong), attack (s), decay (s), sustain (0/1), level (0..1),
//   slices (frame offsets, ascending, absent when none),
//   grain: { size (s), density (grains/s), spread (0..1), jitter (semitones), rev (0..1) } }
// Speed, Start, End and grain Position are track parameters (smpSpeed,
// smpStart, smpEnd, smpPos) so Links, macros and LFOs can move them.

export function defaultGrain() {
  return { size: 0.08, density: 20, spread: 0.1, jitter: 0, rev: 0 };
}

export function defaultSampler() {
  return { on: 0, name: '', sample: null, mode: 0, root: 60, fine: 0, loop: 0, dir: 0, attack: 0.002, decay: 2, sustain: 1, level: 0.8, grain: defaultGrain() };
}

/** Longest base64 string accepted: SAMPLER_MAX_SECONDS of 16-bit audio at 48 kHz. */
export const SAMPLER_MAX_B64 = Math.ceil(SAMPLER_MAX_SECONDS * SAMPLER_RATE * 2 / 3) * 4 + 8;

/** part.sampler from anything; null when absent or not an object (the field stays out of the session). */
export function sanitizeSampler(src) {
  if (!src || typeof src !== 'object') return null;
  const b = defaultSampler();
  const s = src.sample;
  const sample = s && typeof s === 'object' && typeof s.data === 'string' && s.data.length > 0 && s.data.length <= SAMPLER_MAX_B64
    && /^[A-Za-z0-9+/]*={0,2}$/.test(s.data.slice(-8))
    ? { rate: Math.round(clampN(s.rate, 8000, 96000, SAMPLER_RATE)), data: s.data } : null;
  if (sample && typeof s.right === 'string' && s.right.length === sample.data.length
      && /^[A-Za-z0-9+/]*={0,2}$/.test(s.right.slice(-8))) sample.right = s.right;
  const g = src.grain && typeof src.grain === 'object' ? src.grain : {};
  const bg = b.grain;
  const out = {
    on: src.on ? 1 : 0,
    name: typeof src.name === 'string' ? src.name.slice(0, 40) : '',
    sample,
    mode: Math.round(clampN(src.mode, 0, SAMPLER_MODES.length - 1, b.mode)),
    root: Math.round(clampN(src.root, 0, 127, b.root)),
    fine: clampN(src.fine, -100, 100, 0),
    loop: src.loop ? 1 : 0,
    dir: Math.round(clampN(src.dir, 0, SAMPLER_DIRS.length - 1, 0)),
    attack: clampN(src.attack, 0.0005, 4, b.attack),
    decay: clampN(src.decay, 0.01, 20, b.decay),
    sustain: src.sustain === undefined ? b.sustain : src.sustain ? 1 : 0,
    level: clampN(src.level, 0, 1, b.level),
    grain: {
      size: clampN(g.size, 0.01, 0.5, bg.size),
      density: clampN(g.density, 1, 100, bg.density),
      spread: clampN(g.spread, 0, 1, bg.spread),
      jitter: clampN(g.jitter, 0, 12, bg.jitter),
      rev: clampN(g.rev, 0, 1, bg.rev),
    },
  };
  if (Array.isArray(src.slices)) {
    const sl = [];
    for (const v of src.slices) {
      const f = Math.round(Number(v));
      if (Number.isFinite(f) && f >= 0 && f < SAMPLER_MAX_SECONDS * 96000 && (!sl.length || f > sl[sl.length - 1])) sl.push(f);
      if (sl.length >= MAX_SLICES) break;
    }
    if (sl.length) out.slices = sl;
  }
  return out;
}

/** Settings the DSP needs (everything but the audio and the name). */
export function samplerConfig(s) {
  return { mode: s.mode, root: s.root, fine: s.fine, loop: s.loop, dir: s.dir, attack: s.attack, decay: s.decay, sustain: s.sustain, level: s.level,
    slices: s.slices || null, grain: { ...s.grain } };
}

// ---- playback ------------------------------------------------------------

/** 4-point Hermite read of d at fractional x, indices clamped to [0, last]. */
function hermite(d, x, last) {
  let i = Math.floor(x);
  const t = x - i;
  const i0 = i - 1 < 0 ? 0 : i - 1 > last ? last : i - 1;
  const i1 = i < 0 ? 0 : i > last ? last : i;
  const i2 = i + 1 < 0 ? 0 : i + 1 > last ? last : i + 1;
  const i3 = i + 2 < 0 ? 0 : i + 2 > last ? last : i + 2;
  const y0 = d[i0], y1 = d[i1], y2 = d[i2], y3 = d[i3];
  const c1 = 0.5 * (y2 - y0);
  const c2 = y0 - 2.5 * y1 + 2 * y2 - 0.5 * y3;
  const c3 = 0.5 * (y3 - y0) + 1.5 * (y1 - y2);
  return ((c3 * t + c2) * t + c1) * t + y1;
}

/** A small seeded generator (xorshift32): next() in 0..1. */
function seedOf(note, vel) {
  let h = (Math.round(note * 1000) * 2654435761) ^ (Math.round(vel * 1000) * 40503) ^ 0x9e3779b9;
  h >>>= 0;
  return h || 1;
}

const ENV_ATTACK = 0, ENV_HOLD = 1, ENV_DECAY = 2, ENV_RELEASE = 3;

class Voice {
  constructor() {
    this.on = false; this.note = 0; this.gate = false; this.age = 0;
    this.semis = 0; this.vel = 0; this.gain = 0;
    this.pos = 0; this.dir = 1; this.slice = -1; this.passes = 0;
    this.env = 0; this.stage = ENV_ATTACK; this.attInc = 1; this.decK = 1; this.relK = 1;
    this.steal = 0;          // 0, or the fade-out gain of a stolen voice
    this.seed = 1;
    // granular
    this.nextGrain = 0; this.grainCount = 0;
    this.gPos = new Float64Array(GRAINS_PER_VOICE);
    this.gInc = new Float64Array(GRAINS_PER_VOICE);
    this.gT = new Float64Array(GRAINS_PER_VOICE);    // window phase 0..1
    this.gDt = new Float64Array(GRAINS_PER_VOICE);   // window step per output frame
    this.gOn = new Uint8Array(GRAINS_PER_VOICE);
  }
  rand() {
    let s = this.seed;
    s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0;
    this.seed = s || 1;
    return (s >>> 0) / 4294967296;
  }
}

export class SamplerPlayer {
  constructor(sr) {
    this.sr = sr;
    this.data = null; this.right = null; this.rate = sr; this.last = 0;
    this.cfg = samplerConfig(defaultSampler());
    this.voices = Array.from({ length: VOICE_SLOTS }, () => new Voice());
    this.counter = 0;
    this.active = 0;          // voices on (kept current so the engine can skip a quiet track)
    this.grainsStarted = 0;   // for tests and the meter
    this.stealK = Math.exp(-1 / (STEAL_SECONDS * sr));
    this.gateK = Math.exp(-6.9 / (GATE_RELEASE_SECONDS * sr));
    this.edgeN = Math.max(1, Math.round(EDGE_SECONDS * sr));
  }

  get busy() { return this.active > 0; }

  /** New audio (Float32Array at `rate`), optional right channel of the same length. Sounding notes stop. */
  setData(data, rate, right) {
    for (const v of this.voices) v.on = false;
    this.active = 0;
    this.data = data instanceof Float32Array && data.length > 4 ? data : null;
    this.right = this.data && right instanceof Float32Array && right.length === this.data.length ? right : null;
    this.rate = clampN(rate, 8000, 192000, this.sr);
    this.last = this.data ? this.data.length - 1 : 0;
  }

  /** One source frame, as a stereo pair. A mono buffer is copied to both sides. */
  readPair(pos) {
    const l = hermite(this.data, pos, this.last);
    return [l, this.right ? hermite(this.right, pos, this.last) : l];
  }

  configure(cfg) {
    if (!cfg || typeof cfg !== 'object') return;
    const c = sanitizeSampler({ ...cfg, on: 1 }) || defaultSampler();
    this.cfg = samplerConfig(c);
  }

  /** The playable region in source frames for this block: [a, b) with b - a >= 8. */
  region(start, end) {
    const n = this.data ? this.data.length : 0;
    let s0 = clampN(start, 0, 1, 0), s1 = clampN(end, 0, 1, 1);
    if (s1 < s0) { const t = s0; s0 = s1; s1 = t; }
    let a = Math.floor(s0 * n), b = Math.ceil(s1 * n);
    if (b - a < 8) { b = Math.min(n, a + 8); a = Math.max(0, b - 8); }
    return [a, b];
  }

  heldCount() { let k = 0; for (const v of this.voices) if (v.on && v.gate && !v.steal) k++; return k; }

  /** Pick a slot for a new note: a free one, else steal (fading) the quietest released or the oldest. */
  slot() {
    let sounding = 0, free = null;
    for (const v of this.voices) { if (v.on && !v.steal) sounding++; else if (!v.on && !free) free = v; }
    if (sounding >= MAX_VOICES) {
      let victim = null;
      for (const v of this.voices) if (v.on && !v.steal && !v.gate && (!victim || v.env < victim.env)) victim = v;
      if (!victim) for (const v of this.voices) if (v.on && !v.steal && (!victim || v.age < victim.age)) victim = v;
      if (victim) victim.steal = 1;
    }
    if (free) return free;
    // every slot busy: take the quietest fading voice outright
    let q = null;
    for (const v of this.voices) if (v.steal && (!q || v.steal * v.env < q.steal * q.env)) q = v;
    return q || this.voices[0];
  }

  /**
   * Start a note. `semis`: the key against Root in semitones (the engine
   * applies the session's tuning); `vel`: 0..1 gain already shaped.
   * `slicePick`: in Slices mode, that slice instead of the key. Null keeps
   * the key mapping, so an old pattern sounds the same until a step is edited.
   */
  noteOn(note, semis, vel, start = 0, end = 1, slicePick = null) {
    if (!this.data || !(vel > 0)) return;
    const c = this.cfg;
    // the same key retriggered in a mode that ignores note-offs fades the old one
    for (const v of this.voices) if (v.on && !v.steal && v.note === note && (c.mode === 1 || c.mode === 3)) v.steal = 1;
    const v = this.slot();
    if (!v.on) this.active++;
    v.on = true; v.steal = 0; v.note = note; v.gate = true; v.age = ++this.counter;
    v.vel = vel; v.semis = c.mode === 3 ? 0 : semis + c.fine / 100;
    v.env = 0; v.stage = ENV_ATTACK;
    v.attInc = 1 / Math.max(1, c.attack * this.sr);
    v.decK = Math.exp(-6.9 / Math.max(1, c.decay * this.sr));
    v.relK = v.decK;
    v.passes = 0;
    v.seed = seedOf(note, vel);
    v.nextGrain = 0; v.gOn.fill(0); v.grainCount = 0;
    v.slice = -1;
    let [a, b] = this.region(start, end);
    if (c.mode === 3) {
      const count = this.sliceCount();
      let k;
      if (slicePick != null && Number.isFinite(+slicePick)) {
        k = Math.round(+slicePick);
        if (k < 0) k = 0;
        if (k >= count) k = count - 1;
      } else k = (((Math.round(note) - c.root) % count) + count) % count;
      v.slice = k;
      [a, b] = this.sliceBounds(k);
    }
    const rev = c.dir === 1;
    v.dir = rev ? -1 : 1;
    v.pos = rev ? b - 1 : a;
  }

  /** How many slices a key or a step can pick. Stored marks win; otherwise an even grid. */
  sliceCount() {
    const sl = this.cfg.slices;
    return sl && sl.length ? sl.length : EVEN_SLICES;
  }

  sliceBounds(k) {
    const sl = this.cfg.slices, n = this.data ? this.data.length : 0;
    if (!n) return [0, 0];
    if (sl && sl.length) {
      const a = Math.min(n - 8, sl[k] || 0);
      const b = k + 1 < sl.length ? Math.min(n, sl[k + 1]) : n;
      return [Math.max(0, a), Math.max(a + 8, b)];
    }
    const count = EVEN_SLICES;
    const kk = ((k % count) + count) % count;
    let a = Math.floor(kk * n / count);
    let b = kk + 1 === count ? n : Math.floor((kk + 1) * n / count);
    if (b - a < 8) { b = Math.min(n, a + 8); a = Math.max(0, b - 8); }
    return [a, b];
  }

  noteOff(note) {
    const m = this.cfg.mode;
    for (const v of this.voices) {
      if (!v.on || !v.gate || Math.abs(v.note - note) > 1e-6) continue;
      v.gate = false;
      if (m === 1 || m === 3) continue;   // one-shot and slices ignore note-offs
      v.stage = ENV_RELEASE;
      v.relK = m === 2 ? this.gateK : v.decK;
    }
  }

  /** Release everything (allOff), or with `hard` stop at once (panic, freeze). */
  allOff(hard = false) {
    for (const v of this.voices) {
      if (!v.on) continue;
      if (hard) { v.on = false; continue; }
      v.gate = false; v.stage = ENV_RELEASE; v.relK = this.gateK;
    }
    if (hard) this.active = 0;
  }

  /**
   * Add the sounding notes into L/R from `off` for `n` frames. `speed`,
   * `start`, `end`, `gpos`: the track's (modulated) Speed, Start, End and
   * grain Position; `bend`: pitch-bend ratio.
   */
  render(L, R, off, n, speed = 1, start = 0, end = 1, gpos = 0.5, bend = 1) {
    if (this.active === 0 || !this.data) return;
    const c = this.cfg;
    const base = this.rate / this.sr * clampN(speed, 0.01, 16, 1) * bend;
    const [ra, rb] = this.region(start, end);
    let active = 0;
    for (const v of this.voices) {
      if (!v.on) continue;
      const inc = base * Math.pow(2, v.semis / 12);
      const g = c.level * v.vel;
      if (c.mode === 4) this.renderGrains(v, L, R, off, n, inc, g, ra, rb, gpos);
      else this.renderVoice(v, L, R, off, n, inc, g, ra, rb);
      if (v.on) active++;
    }
    this.active = active;
  }

  /** Envelope step for one frame; returns the level (and turns the voice off at the end). */
  envStep(v) {
    const c = this.cfg;
    switch (v.stage) {
      case ENV_ATTACK:
        v.env += v.attInc;
        if (v.env >= 1) { v.env = 1; v.stage = c.sustain ? ENV_HOLD : ENV_DECAY; }
        break;
      case ENV_HOLD:
        // Sustain: full level while the key is held (one-shot and slices: to the end of the region)
        break;
      case ENV_DECAY:
        v.env *= v.decK;
        if (v.env < 1e-4) v.on = false;
        break;
      default:
        v.env *= v.relK;
        if (v.env < 1e-4) v.on = false;
    }
    let e = v.env;
    if (v.steal) { v.steal *= this.stealK; e *= v.steal; if (v.steal < 1e-3) v.on = false; }
    return e;
  }

  renderVoice(v, L, R, off, n, inc, g, ra, rb) {
    const c = this.cfg;
    let a = ra, b = rb;
    if (v.slice >= 0) [a, b] = this.sliceBounds(v.slice);
    const loop = c.loop && c.mode !== 1 && c.mode !== 3;
    const ping = c.dir === 2;
    const len = b - a;
    const X = loop && !ping ? Math.max(0, Math.min(Math.floor(LOOP_XFADE_SECONDS * this.rate), Math.floor(len / 4))) : 0;
    const edge = this.edgeN * inc;      // source frames over which the ends fade
    let pos = v.pos, dir = v.dir;
    for (let j = off; j < off + n; j++) {
      const e = this.envStep(v);
      if (!v.on) break;
      let pair;
      if (X > 0 && dir > 0 && pos >= b - X) {
        const w = (pos - (b - X)) / X * Math.PI / 2, c0 = Math.cos(w), s0 = Math.sin(w);
        const p0 = this.readPair(pos), p1 = this.readPair(a + (pos - (b - X)));
        pair = [p0[0] * c0 + p1[0] * s0, p0[1] * c0 + p1[1] * s0];
      } else if (X > 0 && dir < 0 && pos < a + X) {
        const w = ((a + X) - pos) / X * Math.PI / 2, c0 = Math.cos(w), s0 = Math.sin(w);
        const p0 = this.readPair(pos), p1 = this.readPair(b - ((a + X) - pos));
        pair = [p0[0] * c0 + p1[0] * s0, p0[1] * c0 + p1[1] * s0];
      } else pair = this.readPair(pos);
      // fade the very ends of a region that is not looping (or a one-way pass)
      if (!loop && !(ping && v.passes === 0 && dir > 0)) {
        const toEnd = dir > 0 ? (b - 1 - pos) : (pos - a);
        if (toEnd < edge) {
          const f = toEnd > 0 ? toEnd / edge : 0;
          pair = [pair[0] * f, pair[1] * f];
        }
      }
      const eg = e * g;
      L[j] += pair[0] * eg; R[j] += pair[1] * eg;
      pos += inc * dir;
      if (dir > 0 && loop && !ping) {
        if (pos >= b) pos -= len - X;
      } else if (dir > 0 && pos >= b - 1) {
        if (loop) { pos = 2 * (b - 1) - pos; dir = -1; }
        else if (ping && v.passes === 0) { pos = 2 * (b - 1) - pos; dir = -1; v.passes = 1; }
        else { v.on = false; break; }
      } else if (dir < 0 && pos <= a) {
        if (loop && ping) { pos = 2 * a - pos; dir = 1; }
        else if (loop) pos += len - X;
        else { v.on = false; break; }
      }
    }
    v.pos = pos; v.dir = dir;
  }

  renderGrains(v, L, R, off, n, inc, g, ra, rb, gpos) {
    const gc = this.cfg.grain, W = GRAIN_WINDOW;
    const len = rb - ra;
    const every = this.sr / gc.density;
    const gLen = Math.max(8, gc.size * this.sr);
    const dt = 1 / gLen;
    const norm = 1 / Math.sqrt(Math.max(1, gc.density * gc.size * 0.5));
    const centre = clampN(gpos, 0, 1, 0.5);
    for (let j = off; j < off + n; j++) {
      const e = this.envStep(v);
      if (!v.on) break;
      if (v.gate || v.stage !== ENV_RELEASE) {
        v.nextGrain -= 1;
        if (v.nextGrain <= 0) {
          v.nextGrain += every;
          // a free grain from the pool (a full pool skips this grain)
          let k = -1;
          for (let q = 0; q < GRAINS_PER_VOICE; q++) if (!v.gOn[q]) { k = q; break; }
          const r1 = v.rand(), r2 = v.rand(), r3 = v.rand();
          if (k >= 0) {
            let p = centre + gc.spread * (r1 - 0.5);
            p -= Math.floor(p);
            const rev = r3 < gc.rev;
            v.gOn[k] = 1; v.gT[k] = 0; v.gDt[k] = dt;
            v.gInc[k] = (rev ? -inc : inc) * Math.pow(2, gc.jitter * (2 * r2 - 1) / 12);
            v.gPos[k] = ra + p * len;
            this.grainsStarted++;
          }
        }
      }
      let sumL = 0, sumR = 0;
      for (let q = 0; q < GRAINS_PER_VOICE; q++) {
        if (!v.gOn[q]) continue;
        const t = v.gT[q] * WIN_N, ti = t | 0;
        const w = W[ti] + (W[ti + 1] - W[ti]) * (t - ti);
        let p = v.gPos[q];
        const pair = this.readPair(p);
        sumL += pair[0] * w; sumR += pair[1] * w;
        p += v.gInc[q];
        if (p >= rb) p -= len; else if (p < ra) p += len;
        v.gPos[q] = p;
        const nt = v.gT[q] + v.gDt[q];
        if (nt >= 1) v.gOn[q] = 0; else v.gT[q] = nt;
      }
      const eg = norm * e * g;
      L[j] += sumL * eg; R[j] += sumR * eg;
    }
  }
}
