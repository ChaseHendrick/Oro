// Looper core (v1.2): a stereo loop recorder with overdub, written as plain
// logic so the same class runs inside the 'orograph-looper' AudioWorklet
// (looper-worklet.js) and in Node tests.
//
// Audio is 32-bit float at the context rate, stored as it arrives: nothing is
// resampled or quantised. Every frame passes through process() in order, so
// starts, stops and loop lengths are exact to the sample.
//
// States
//   empty    no loop
//   armed    waiting for the next bar line to start recording (transport playing)
//   record   recording the first pass; closes by itself after the chosen bars
//            (transport playing) or on the next press (free length)
//   play     the loop plays
//   overdub  the loop plays and the input is summed onto it each pass:
//            new = old * decay + input (decay = feedback 0..1, never above 1)
//   paused   a loop exists but is silent (transport stopped, or Stop)
//
// Clicks are avoided with short fades (FADE_SECONDS):
//   * the loop seam: the last few ms of the first pass are crossfaded (equal
//     power) with the audio that came just before the recording started, so the
//     end of the loop runs straight into its first sample;
//   * entering and leaving overdub ramps the input in and the decay down;
//   * starting, stopping, clearing and undo fade or crossfade the output;
//   * volume, mute and feedback changes are smoothed.
//
// Undo keeps a copy of the loop as it was before each overdub layer (up to
// MAX_LAYERS, and at most UNDO_BUDGET_BYTES in all; the oldest go first). The
// copy is made a chunk at a time ahead of the playhead so no single audio
// block does a whole-loop copy.
//
// The core never hears itself: its input is the master bus before the point
// where its output is mixed back in (see engine.js), so the loop only reaches
// the loop again through overdub, and then at most at unity.

export const LOOP_BARS = Object.freeze([1, 2, 4, 8]);
export const DEFAULT_BARS = 2;
export const FADE_SECONDS = 0.008;
export const MAX_LAYERS = 8;
export const UNDO_BUDGET_BYTES = 192 * 1024 * 1024;
export const MAX_FREE_SECONDS = 60;
export const MAX_LOOP_SECONDS = 120;
export const HISTORY_SECONDS = 0.5;
export const LATE_GRACE_SECONDS = 0.2;
export const MIN_LOOP_SECONDS = 0.05;
export const SOFT_KNEE = 1;
export const SOFT_CEILING = 2;
const SNAPSHOT_CHUNK = 16384;
const POS_RATE_HZ = 30;
const SMOOTH_SECONDS = 0.01;
const HALF_PI = Math.PI / 2;

const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);
const finite = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

/** Frames in `bars` 4/4 bars at `spb` seconds per beat (exact loop length, rounded once). */
export function loopFrames(bars, spb, sampleRate) {
  return Math.max(1, Math.round(bars * 4 * spb * sampleRate));
}

/** Nearest allowed bar count. */
export function sanitizeBars(n) {
  const v = Math.round(Number(n));
  return LOOP_BARS.includes(v) ? v : DEFAULT_BARS;
}

/**
 * Bar lines of a transport anchor ({beatTime, beat, spb}: beat `beat` sounds at
 * audio time `beatTime`). Bars are 4 beats and beat 0 is a bar line.
 * Returns the frame of the bar line at or after `frame` ('next') or at or before it ('prev').
 */
export function barFrame(transport, frame, sampleRate, which = 'next') {
  const spb = finite(transport.spb, 0.5);
  const beatAtFrame = finite(transport.beat, 0) + (frame / sampleRate - finite(transport.beatTime, 0)) / spb;
  const q = beatAtFrame / 4;
  const k = which === 'prev' ? Math.floor(q + 1e-9) : Math.ceil(q - 1e-9);
  return Math.round((finite(transport.beatTime, 0) + (4 * k - finite(transport.beat, 0)) * spb) * sampleRate);
}

/**
 * Gentle limit for stored loop samples: the identity up to SOFT_KNEE (0 dBFS),
 * then a tanh curve that never reaches SOFT_CEILING (+6 dBFS). The master
 * limiter handles the output; this only keeps a stack of overdubs finite
 * without the hard edge of clipping.
 */
export function softLimit(x) {
  const a = x < 0 ? -x : x;
  if (a <= SOFT_KNEE) return x;
  const w = SOFT_CEILING - SOFT_KNEE;
  const y = SOFT_KNEE + w * Math.tanh((a - SOFT_KNEE) / w);
  return x < 0 ? -y : y;
}

export class LooperCore {
  /**
   * @param {number} sampleRate
   * @param {object} [o]
   * @param {(msg: object, transfer?: ArrayBuffer[]) => void} [o.emit] messages to the main thread
   */
  constructor(sampleRate, {
    emit = () => {}, fadeSeconds = FADE_SECONDS, maxLayers = MAX_LAYERS, undoBudgetBytes = UNDO_BUDGET_BYTES,
    maxFreeSeconds = MAX_FREE_SECONDS, maxLoopSeconds = MAX_LOOP_SECONDS, graceSeconds = LATE_GRACE_SECONDS,
  } = {}) {
    this.sr = sampleRate;
    this.emit = emit;
    this.fadeLen = Math.max(16, Math.round(fadeSeconds * sampleRate));
    this.maxLayers = maxLayers;
    this.undoBudget = undoBudgetBytes;
    this.maxFree = Math.round(maxFreeSeconds * sampleRate);
    this.maxLoop = Math.round(maxLoopSeconds * sampleRate);
    this.grace = graceSeconds;
    this.histLen = Math.max(this.fadeLen * 2, Math.round(Math.max(HISTORY_SECONDS, graceSeconds + 0.1) * sampleRate));
    this.histL = new Float32Array(this.histLen);
    this.histR = new Float32Array(this.histLen);
    this.histEnd = 0;                  // absolute frame after the newest history sample

    this.transport = { playing: false, beatTime: 0, beat: 0, spb: 0.5 };
    this.bars = DEFAULT_BARS;
    this.state = 'empty';
    this.L = null; this.R = null;      // loop buffers (capacity may exceed len while recording)
    this.len = 0;
    this.pos = 0;
    this.loopBars = 0;                 // bars in the loop (0 = free length)
    this.rec = null;                   // { startFrame, pos, target, preL, preR, mode }
    this.cueFrame = -1;                // play restarts at pos 0 on this frame
    this.userPaused = false;

    // Smoothed controls.
    this.smoothA = 1 - Math.exp(-1 / (SMOOTH_SECONDS * sampleRate));
    this.volume = 1; this.muted = false; this.gain = 1;
    this.decayTarget = 1; this.decay = 1;
    this.pg = 0; this.pgTarget = 0;    // play fade 0..1 (linear over fadeLen)
    this.od = 0; this.odTarget = 0;    // overdub ramp 0..1
    this.afterFade = null;             // 'pause' | 'clear' once pg reaches 0
    this.xf = null;                    // { L, R, k } crossfade from an old buffer (undo)

    this.layers = [];                  // undo: [{ L, R, done, start, copied, peak }]
    this.peak = 0;                     // largest |sample| stored in the loop
    this.capture = null;               // raw capture for Resample
    this.posCountdown = 0;
    this.posEvery = Math.max(128, Math.round(sampleRate / POS_RATE_HZ));
    this.frameNow = 0;
  }

  // ------------------------------------------------------------------ queries

  get audible() { return this.len > 0 && (this.state === 'play' || this.state === 'overdub'); }

  info() {
    return {
      t: 'state',
      state: this.state,
      len: this.len,
      pos: this.pos,
      bars: this.bars,
      loopBars: this.loopBars,
      layers: this.layers.length,
      recPos: this.rec ? this.rec.pos : 0,
      recTarget: this.rec ? this.rec.target : 0,
      recStart: this.rec ? this.rec.startFrame : 0,
      cue: this.cueFrame >= 0,
      muted: this.muted,
      volume: this.volume,
      feedback: this.decayTarget,
      peak: this.peak,
      capturing: !!this.capture,
      sampleRate: this.sr,
    };
  }

  notify() { this.emit(this.info()); }

  barLenExact() { return this.bars * 4 * finite(this.transport.spb, 0.5) * this.sr; }

  // ------------------------------------------------------------------ messages

  /**
   * Handle a control message at absolute frame `frame` (the start of the next block).
   * main | stop | undo | clear | bars n | volume v | mute v | feedback v | transport {...}
   * | get {id} | capture {id, bars, frames}
   */
  handle(msg, frame = this.frameNow) {
    if (!msg || typeof msg.t !== 'string') return;
    this.frameNow = frame;
    switch (msg.t) {
      case 'main': this.main(frame); break;
      case 'stop': this.stop(frame); break;
      case 'undo': this.undo(); break;
      case 'clear': this.clear(); break;
      case 'bars': this.bars = sanitizeBars(msg.v); this.notify(); break;
      case 'volume': this.volume = clamp(finite(msg.v, 1), 0, 1); this.notify(); break;
      case 'mute': this.muted = !!msg.v; this.notify(); break;
      case 'feedback': this.decayTarget = clamp(finite(msg.v, 1), 0, 1); this.notify(); break;
      case 'transport': this.setTransport(msg, frame); break;
      case 'get': this.sendLoop(msg.id); break;
      case 'capture': this.startCapture(msg, frame); break;
      case 'cancelCapture': if (this.capture) { const id = this.capture.id; this.capture = null; this.emit({ t: 'captured', id, cancelled: true }); this.notify(); } break;
      default: break;
    }
  }

  /** The one-button cycle: Empty -> Record -> Play -> Overdub -> Play ... */
  main(frame) {
    switch (this.state) {
      case 'empty': this.arm(frame); break;
      case 'armed': this.rec = null; this.state = 'empty'; this.L = this.R = null; break;
      case 'record': {
        const r = this.rec;
        if (r.mode === 'free') { this.closeRecording(r.pos); break; }
        // Bar mode: finish at the next whole bar (at least one).
        const bl = this.barLenExact() / this.bars;
        const k = Math.max(1, Math.ceil((r.pos + 1) / bl - 1e-9));
        r.target = Math.min(r.target, Math.round(k * bl));
        if (r.pos >= r.target) this.closeRecording(r.target);
        break;
      }
      case 'play': this.startOverdub(); break;
      case 'overdub': this.state = 'play'; this.odTarget = 0; break;
      case 'paused': this.resume(frame); break;
      default: break;
    }
    this.notify();
  }

  /** Stop / play the loop without recording. Stop during a recording keeps what was played. */
  stop(frame) {
    switch (this.state) {
      case 'armed': this.rec = null; this.state = 'empty'; this.L = this.R = null; break;
      case 'record': {
        const r = this.rec;
        if (r.mode === 'free') this.closeRecording(r.pos, true);
        else {
          const bl = this.barLenExact() / this.bars;
          const k = Math.floor(r.pos / bl + 1e-9);
          if (k >= 1) this.closeRecording(Math.round(k * bl), true);
          else this.discardRecording();
        }
        break;
      }
      case 'play': case 'overdub': this.userPaused = true; this.fadeTo('pause'); break;
      case 'paused': this.userPaused = false; this.resume(frame); break;
      default: break;
    }
    this.notify();
  }

  resume(frame) {
    if (!this.len) return;
    this.state = 'play';
    this.userPaused = false;
    this.afterFade = null;
    if (this.transport.playing) {
      this.cueFrame = barFrame(this.transport, frame, this.sr, 'next');
      if (this.pg > 0) this.pgTarget = 0;
    } else {
      this.cueFrame = -1;
      this.pos = 0;
      this.pg = 0;
      this.pgTarget = 1;
    }
  }

  fadeTo(after) {
    this.odTarget = 0;
    this.cueFrame = -1;
    if (this.state === 'overdub') this.state = 'play';
    if (this.pg <= 0 || !this.audible) { this.finishFade(after); return; }
    this.pgTarget = 0;
    this.afterFade = after;
  }

  finishFade(after) {
    this.afterFade = null;
    this.od = 0; this.odTarget = 0;
    this.pg = 0; this.pgTarget = 0;
    this.xf = null;
    if (after === 'clear') this.reset();
    else if (after === 'pause') { this.state = this.len ? 'paused' : 'empty'; this.pos = 0; }
  }

  reset() {
    this.state = 'empty';
    this.L = this.R = null;
    this.len = 0; this.pos = 0; this.loopBars = 0;
    this.rec = null; this.cueFrame = -1;
    this.layers = [];
    this.peak = 0;
    this.userPaused = false;
  }

  clear() {
    if (this.state === 'armed' || this.state === 'record') { this.discardRecording(); this.notify(); return; }
    if (this.audible && this.pg > 0) this.fadeTo('clear');
    else this.finishFade('clear');
    this.notify();
  }

  discardRecording() {
    this.rec = null;
    if (!this.len) { this.L = this.R = null; this.state = 'empty'; }
  }

  // ------------------------------------------------------------------ recording

  arm(frame) {
    const sr = this.sr;
    const tr = this.transport;
    let target = 0, cap, mode;
    if (tr.playing) {
      mode = 'bar';
      target = Math.min(this.maxLoop, loopFrames(this.bars, tr.spb, sr));
      cap = target;
    } else {
      mode = 'free';
      cap = this.maxFree;
    }
    try {
      this.L = new Float32Array(cap);
      this.R = new Float32Array(cap);
    } catch {
      this.L = this.R = null;
      this.emit({ t: 'error', reason: 'memory' });
      return;
    }
    this.len = 0; this.pos = 0; this.layers = []; this.peak = 0;
    this.loopBars = mode === 'bar' ? this.bars : 0;
    let start = frame;
    if (mode === 'bar') {
      const prev = barFrame(tr, frame, sr, 'prev');
      const bl = (this.barLenExact() / this.bars);
      const grace = Math.min(this.grace * sr, bl / 8);
      // A press just after the bar line (as heard, the output runs a little
      // behind) still starts on that bar: the audio since then is in history.
      start = frame - prev <= grace && frame - prev >= 0 && frame - prev < this.histLen - this.fadeLen ? prev : barFrame(tr, frame, sr, 'next');
    }
    this.rec = { startFrame: start, pos: 0, target, cap, mode, preL: null, preR: null };
    if (start <= frame) this.beginRecording(start, frame);
    else this.state = 'armed';
  }

  /** Start recording at absolute frame `start`; frames before `now` come from history. */
  beginRecording(start, now = start) {
    const r = this.rec;
    const F = this.fadeLen;
    r.preL = new Float32Array(F);
    r.preR = new Float32Array(F);
    this.readHistory(start - F, F, r.preL, r.preR, 0);
    const back = Math.min(now - start, r.target || r.cap);
    if (back > 0) this.readHistory(start, back, this.L, this.R, 0);
    r.pos = back;
    for (let i = 0; i < back; i++) { const a = Math.max(Math.abs(this.L[i]), Math.abs(this.R[i])); if (a > this.peak) this.peak = a; }
    this.state = 'record';
  }

  readHistory(from, count, dstL, dstR, offset) {
    const H = this.histLen;
    for (let i = 0; i < count; i++) {
      const f = from + i;
      if (f < 0 || f >= this.histEnd || f < this.histEnd - H) { dstL[offset + i] = 0; dstR[offset + i] = 0; continue; }
      const k = f % H;
      dstL[offset + i] = this.histL[k];
      dstR[offset + i] = this.histR[k];
    }
  }

  /** Close the first pass at `len` frames; crossfade the seam; play (or pause). */
  closeRecording(len, pause = false) {
    const r = this.rec;
    if (!r || len < Math.max(2 * this.fadeLen, Math.round(MIN_LOOP_SECONDS * this.sr))) { this.discardRecording(); return; }
    this.len = len;
    // Seam: the end of the loop fades (equal power) into the audio heard just
    // before the recording began, which runs continuously into sample 0.
    const F = Math.min(this.fadeLen, len >> 1);
    const off = this.fadeLen - F;
    for (let j = 0; j < F; j++) {
      const idx = len - F + j;
      const t = (j + 0.5) / F * HALF_PI;
      const fo = Math.cos(t), fi = Math.sin(t);
      this.L[idx] = this.L[idx] * fo + r.preL[off + j] * fi;
      this.R[idx] = this.R[idx] * fo + r.preR[off + j] * fi;
    }
    if (r.mode === 'free') this.loopBars = 0;
    else this.loopBars = Math.round(len / (this.barLenExact() / this.bars));
    this.rec = null;
    this.pos = 0;
    this.cueFrame = -1;
    this.pg = 0;
    if (pause) { this.state = 'paused'; this.pgTarget = 0; this.userPaused = true; }
    else { this.state = 'play'; this.pgTarget = 1; }
  }

  // ------------------------------------------------------------------ overdub + undo

  startOverdub() {
    if (!this.len) return;
    this.finishSnapshots();
    let L = null, R = null;
    // Make room first; reuse a dropped layer's buffers when they fit.
    const bytes = this.len * 8;
    while (this.layers.length && (this.layers.length >= this.maxLayers || (this.layers.length + 1) * bytes > this.undoBudget)) {
      const old = this.layers.shift();
      if (!L && old.L.length === this.len) { L = old.L; R = old.R; }
    }
    if ((bytes <= this.undoBudget) && this.maxLayers > 0) {
      try {
        if (!L) { L = new Float32Array(this.len); R = new Float32Array(this.len); }
        this.layers.push({ L, R, done: false, start: this.pos, copied: 0, peak: this.peak });
      } catch {
        this.emit({ t: 'error', reason: 'memory' });
      }
    }
    this.state = 'overdub';
    this.odTarget = 1;
  }

  /** Copy `count` frames of the snapshot `s` (from its start, wrapping). */
  copySnapshot(s, count) {
    const len = this.len;
    let n = Math.min(count, len - s.copied);
    while (n > 0) {
      const at = (s.start + s.copied) % len;
      const run = Math.min(n, len - at);
      s.L.set(this.L.subarray(at, at + run), at);
      s.R.set(this.R.subarray(at, at + run), at);
      s.copied += run;
      n -= run;
    }
    if (s.copied >= len) s.done = true;
  }

  finishSnapshots() {
    for (const s of this.layers) if (!s.done) this.copySnapshot(s, this.len);
  }

  /** Before a block that may write [pos, pos + n): keep the newest snapshot ahead of the writes. */
  advanceSnapshot(n) {
    const s = this.layers[this.layers.length - 1];
    if (!s || s.done) return;
    const ahead = ((this.pos - s.start) % this.len + this.len) % this.len + n;
    this.copySnapshot(s, Math.max(SNAPSHOT_CHUNK, ahead - s.copied));
  }

  undo() {
    if (this.state === 'armed' || this.state === 'record') { this.discardRecording(); this.notify(); return; }
    if (!this.layers.length || !this.len) { this.emit({ t: 'info', reason: 'nothing-to-undo' }); this.notify(); return; }
    this.finishSnapshots();
    if (this.state === 'overdub') this.state = 'play';
    this.od = 0; this.odTarget = 0;
    const prev = this.layers.pop();
    if (this.audible && this.pg > 0 && this.cueFrame < 0) this.xf = { L: this.L, R: this.R, k: 0 };
    this.L = prev.L; this.R = prev.R;
    this.peak = prev.peak;
    this.notify();
  }

  // ------------------------------------------------------------------ transport

  setTransport(msg, frame) {
    const was = this.transport.playing;
    const spb = finite(msg.spb, 0);
    this.transport = {
      playing: !!msg.playing,
      beatTime: finite(msg.beatTime, 0),
      beat: finite(msg.beat, 0),
      spb: spb > 0 ? spb : this.transport.spb,
    };
    const now = this.transport.playing;
    if (!was && now) {
      // Play: a loop restarts on bar 1 (the first bar line of the new run).
      if (this.len && (this.state === 'play' || this.state === 'overdub' || (this.state === 'paused' && !this.userPaused))) {
        this.state = 'play';
        this.odTarget = 0;
        this.afterFade = null;
        this.cueFrame = barFrame(this.transport, frame, this.sr, 'next');
        this.pgTarget = 0;
      }
    } else if (was && !now) {
      // Stop: the loop stops; a bar-locked recording keeps its whole bars.
      if (this.state === 'armed') { this.discardRecording(); }
      else if (this.state === 'record' && this.rec.mode === 'bar') {
        const bl = this.barLenExact() / this.bars;
        const k = Math.floor(this.rec.pos / bl + 1e-9);
        if (k >= 1) this.closeRecording(Math.round(k * bl), true);
        else this.discardRecording();
        this.userPaused = false;
      } else if (this.audible) { this.userPaused = false; this.fadeTo('pause'); }
      else if (this.state === 'play') { this.cueFrame = -1; this.state = 'paused'; this.pos = 0; }
      if (this.capture && this.capture.armed) { const id = this.capture.id; this.capture = null; this.emit({ t: 'captured', id, cancelled: true }); }
    }
    this.notify();
  }

  // ------------------------------------------------------------------ export / capture

  sendLoop(id) {
    if (!this.len) { this.emit({ t: 'loop', id, len: 0, sampleRate: this.sr }); return; }
    const L = this.L.slice(0, this.len), R = this.R.slice(0, this.len);
    this.emit({ t: 'loop', id, L, R, len: this.len, sampleRate: this.sr, loopBars: this.loopBars }, [L.buffer, R.buffer]);
  }

  /** Record `frames` (or `bars` at the transport tempo) of the raw input, starting on a bar line when playing. */
  startCapture(msg, frame) {
    if (this.capture) { this.emit({ t: 'captured', id: msg.id, error: 'busy' }); return; }
    const tr = this.transport;
    const bars = sanitizeBars(msg.bars);
    const frames = Math.min(this.maxLoop, Math.max(1, Math.round(finite(msg.frames, 0)) || loopFrames(bars, tr.spb, this.sr)));
    let L, R;
    try { L = new Float32Array(frames); R = new Float32Array(frames); } catch { this.emit({ t: 'captured', id: msg.id, error: 'memory' }); return; }
    let start = frame;
    if (tr.playing) {
      const prev = barFrame(tr, frame, this.sr, 'prev');
      const bl = 4 * tr.spb * this.sr;
      const grace = Math.min(this.grace * this.sr, bl / 8);
      start = frame - prev >= 0 && frame - prev <= grace ? prev : barFrame(tr, frame, this.sr, 'next');
    }
    const c = { id: msg.id, L, R, pos: 0, frames, start, armed: start > frame };
    if (start < frame) {
      const back = Math.min(frame - start, frames);
      this.readHistory(start, back, L, R, 0);
      c.pos = back;
    }
    this.capture = c;
    this.notify();
  }

  finishCapture() {
    const c = this.capture;
    this.capture = null;
    this.emit({ t: 'captured', id: c.id, L: c.L, R: c.R, frames: c.frames, sampleRate: this.sr }, [c.L.buffer, c.R.buffer]);
    this.notify();
  }

  // ------------------------------------------------------------------ audio

  /**
   * One block. Inputs may be null (silence). Outputs are overwritten.
   * @param {number} frame0 absolute frame of the first sample (AudioWorklet currentFrame)
   */
  process(inL, inR, outL, outR, n, frame0) {
    this.frameNow = frame0;
    if (this.audible && this.layers.length && (this.od > 0 || this.odTarget > 0)) this.advanceSnapshot(n);
    const H = this.histLen;
    const F = this.fadeLen;
    const pgStep = 1 / F, odStep = 1 / F;
    const a = this.smoothA;
    const gTarget = this.muted ? 0 : this.volume;
    let changed = false;
    for (let i = 0; i < n; i++) {
      const f = frame0 + i;
      const xl = inL ? inL[i] : 0;
      const xr = inR ? inR[i] : xl;
      const hk = f % H;
      this.histL[hk] = xl; this.histR[hk] = xr;
      this.histEnd = f + 1;

      // ---- raw capture (Resample from the output)
      const c = this.capture;
      if (c) {
        if (c.armed && f >= c.start) c.armed = false;
        if (!c.armed) {
          c.L[c.pos] = xl; c.R[c.pos] = xr; c.pos++;
          if (c.pos >= c.frames) this.finishCapture();
        }
      }

      // ---- playback (and overdub writes) before recording, so a loop closed
      //      on this frame starts playing on the next one.
      let ol = 0, or = 0;
      if (this.len > 0 && (this.state === 'play' || this.state === 'overdub')) {
        if (this.cueFrame >= 0 && f >= this.cueFrame) {
          this.cueFrame = -1; this.pos = 0; this.pg = 0; this.pgTarget = 1; this.od = 0; this.xf = null;
          if (this.state === 'overdub') this.state = 'play';
          this.odTarget = 0;
          changed = true;
        }
        if (!(this.cueFrame >= 0 && this.pg <= 0)) {
          const p = this.pos;
          let sl = this.L[p], sr = this.R[p];
          const x = this.xf;
          if (x) {
            const t = (x.k + 0.5) / F * HALF_PI;
            const fi = Math.sin(t), fo = Math.cos(t);
            sl = sl * fi + x.L[p] * fo;
            sr = sr * fi + x.R[p] * fo;
            if (++x.k >= F) this.xf = null;
          }
          // Overdub ramp and decay glide.
          if (this.od !== this.odTarget) this.od = this.od < this.odTarget ? Math.min(this.odTarget, this.od + odStep) : Math.max(this.odTarget, this.od - odStep);
          this.decay += (this.decayTarget - this.decay) * a;
          if (this.od > 0) {
            const w = Math.sin(this.od * HALF_PI);
            const d = 1 - this.od * (1 - this.decay);
            const nl = softLimit(this.L[p] * d + xl * w);
            const nr = softLimit(this.R[p] * d + xr * w);
            this.L[p] = nl; this.R[p] = nr;
            const m = Math.max(nl < 0 ? -nl : nl, nr < 0 ? -nr : nr);
            if (m > this.peak) this.peak = m;
          }
          const g = this.pg * this.gain;
          ol = sl * g; or = sr * g;
          this.pos = p + 1 >= this.len ? 0 : p + 1;
        }
        if (this.pg !== this.pgTarget) {
          this.pg = this.pg < this.pgTarget ? Math.min(this.pgTarget, this.pg + pgStep) : Math.max(this.pgTarget, this.pg - pgStep);
          if (this.pg <= 0 && this.afterFade) { this.finishFade(this.afterFade); changed = true; }
        }
      }
      this.gain += (gTarget - this.gain) * a;

      // ---- recording the first pass
      if (this.state === 'armed' && f >= this.rec.startFrame) { this.beginRecording(f, f); changed = true; }
      if (this.state === 'record') {
        const r = this.rec;
        if (r.pos < r.cap) {
          this.L[r.pos] = xl; this.R[r.pos] = xr; r.pos++;
          const m = Math.max(xl < 0 ? -xl : xl, xr < 0 ? -xr : xr);
          if (m > this.peak) this.peak = m;
        }
        if ((r.target && r.pos >= r.target) || r.pos >= r.cap) { this.closeRecording(r.target || r.pos); changed = true; }
      }

      outL[i] = ol; outR[i] = or;
    }
    if (this.gain < 1e-7 && gTarget === 0) this.gain = 0;
    if (changed) this.notify();
    this.posCountdown -= n;
    if (this.posCountdown <= 0) {
      this.posCountdown = this.posEvery;
      if (this.state !== 'empty' || this.capture) {
        this.emit({ t: 'pos', state: this.state, pos: this.pos, len: this.len, recPos: this.rec ? this.rec.pos : 0, recTarget: this.rec ? this.rec.target : 0, cue: this.cueFrame >= 0, capture: this.capture ? this.capture.pos / this.capture.frames : -1, peak: this.peak });
      }
    }
  }
}
