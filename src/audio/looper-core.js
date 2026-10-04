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
// Follow tempo (v2.8): `replace` swaps in a time-stretched copy of the loop
// (made on the main thread, src/dsp/time-stretch.js) with a short crossfade
// from the old one, keeping the position in proportion. `edit` counts every
// change of the loop's audio (a recording, an overdub, an undo, a clear, a
// replace) so the main thread can tell whether its untouched copy of the
// loop is still the current one, and a replace made from an older loop is
// refused. A replace is itself an undo step (v2.9): undo brings back the
// audio from before the stretch, at its own length and tempo, and the older
// overdub layers after it; Follow tempo then fits what comes back.
// `loopSpb` is the beat length the loop's audio was recorded or stretched at
// (0 for a free-length loop).
//
// Tape (v2.13): speed is 0.5, 1 or 2, and Reverse flips the sign. Varispeed
// only: the read position advances by `rate` samples per output sample, so
// pitch follows speed. The stored loop is never resampled. At rate +1 forward
// (not scrubbing) the playhead stays an integer and the read is the original
// one, sample for sample. Anywhere else the head is fractional and the read
// is linear. Rate glides through a one-pole so a speed change does not click.
// Scrub is temporary: while the pointer is down the head follows it through
// its own one-pole, and the level falls as the finger moves faster (a stopped
// finger is nearly silent). Releasing the strip resumes the previous play
// state at the new position.
// Overdub writes each loop index once per time the head enters it, so half
// speed does not stack the input and double speed does not skip. The undo
// snapshot keeps copying ahead of the head, backward when the head is
// moving backward. A peak overview for the strip is scanned a chunk at a
// time, never the whole loop in one block.
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
const TAPE_SECONDS = 0.03;
const SCRUB_SECONDS = 0.02;
const PEAK_BINS = 192;
const PEAK_SCAN = 2048;
const HALF_PI = Math.PI / 2;

const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);
const finite = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

/** Tape speed is only half, normal or double. Anything else stays normal. */
export function sanitizeTapeSpeed(v) {
  const n = Number(v);
  if (n === 0.5 || n === 2) return n;
  return 1;
}

function wrapIndex(i, len) {
  const m = i % len;
  return m < 0 ? m + len : m;
}

/**
 * Linear interpolation of `buf` at `pos` (wraps). An integer position returns
 * that sample and does not read its neighbour, so rate +/-1 can stay exact.
 */
export function loopSampleAt(buf, pos, len) {
  let p = pos % len;
  if (p < 0) p += len;
  const i0 = Math.floor(p);
  const frac = p - i0;
  if (frac === 0) return buf[i0];
  const i1 = i0 + 1 >= len ? 0 : i0 + 1;
  return buf[i0] * (1 - frac) + buf[i1] * frac;
}

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
    this.tapeA = 1 - Math.exp(-1 / (TAPE_SECONDS * sampleRate));
    this.scrubA = 1 - Math.exp(-1 / (SCRUB_SECONDS * sampleRate));
    this.volume = 1; this.muted = false; this.gain = 1;
    this.decayTarget = 1; this.decay = 1;
    this.pg = 0; this.pgTarget = 0;    // play fade 0..1 (linear over fadeLen)
    this.od = 0; this.odTarget = 0;    // overdub ramp 0..1
    this.afterFade = null;             // 'pause' | 'clear' once pg reaches 0
    this.xf = null;                    // { L, R, k, p, len } crossfade from an old buffer (undo, replace)
    this.edit = 0;                     // changes of the loop's audio (v2.8)
    this.loopSpb = 0;                  // beat length the loop was recorded at (0 = free length)

    // Tape. `rate` is the smoothed signed speed. `frac` is set only while the
    // integer +1 path is not in use, so a normal forward loop never reads it.
    this.speed = 1;                    // 0.5 | 1 | 2
    this.reverse = false;
    this.rate = 1;
    this.frac = false;
    this.fpos = 0;
    this.scrubbing = false;
    this.scrubTarget = 0;
    this.dubAt = -1;                   // last loop index written by this overdub visit

    this.layers = [];                  // undo: [{ L, R, done, start, copied, peak }]
    this.peak = 0;                     // largest |sample| stored in the loop
    this.capture = null;               // raw capture for Resample
    this.posCountdown = 0;
    this.posEvery = Math.max(128, Math.round(sampleRate / POS_RATE_HZ));
    this.frameNow = 0;
    this.peakAcc = new Float32Array(PEAK_BINS);
    this.peakScanAt = 0;
    this.peakScanEdit = -1;
    this.peakScanLen = 0;
    this.peakSentAt = -1e15;
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
      edit: this.edit,
      loopSpb: this.loopSpb,
      speed: this.speed,
      reverse: this.reverse,
      rate: this.rate,
      scrub: this.scrubbing,
      fpos: this.scrubbing || this.frac ? this.fpos : this.pos,
    };
  }

  notify() { this.emit(this.info()); }

  barLenExact() { return this.bars * 4 * finite(this.transport.spb, 0.5) * this.sr; }

  // ------------------------------------------------------------------ messages

  /**
   * Handle a control message at absolute frame `frame` (the start of the next block).
   * main | stop | undo | clear | bars n | volume v | mute v | feedback v | transport {...}
   * | get {id} | capture {id, bars, frames} | tape {rate, reverse, scrub}
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
      case 'replace': this.replace(msg); break;
      case 'tape': this.setTape(msg); break;
      case 'cancelCapture': if (this.capture) { const id = this.capture.id; this.capture = null; this.emit({ t: 'captured', id, cancelled: true }); this.notify(); } break;
      default: break;
    }
  }

  /**
   * Tape controls. `rate` is 0.5, 1 or 2 (the speed; sign comes from `reverse`).
   * `scrub` is a 0..1 position while the pointer is down, or null to let go.
   * Omitted fields are left alone, so a scrub move does not reset the speed.
   */
  setTape(msg) {
    let changed = false;
    if (msg.rate != null) {
      const speed = sanitizeTapeSpeed(msg.rate);
      if (speed !== this.speed) { this.speed = speed; changed = true; }
    }
    if (msg.reverse != null) {
      const reverse = !!msg.reverse;
      if (reverse !== this.reverse) { this.reverse = reverse; changed = true; }
    }
    if (Object.prototype.hasOwnProperty.call(msg, 'scrub')) {
      const was = this.scrubbing;
      if (msg.scrub == null) this.endScrub();
      else this.moveScrub(msg.scrub);
      if (was !== this.scrubbing) changed = true;
    }
    if (changed) this.notify();
  }

  /** Pointer down or moved. `u` is 0..1 across the loop. */
  moveScrub(u) {
    if (!this.len || this.state === 'empty' || this.state === 'armed' || this.state === 'record') return;
    if (!this.scrubbing) {
      this.scrubbing = true;
      if (!this.frac) this.fpos = this.pos;
      this.dubAt = -1;
      // A scrub can land anywhere. Finish the open snapshot before more
      // overdub writes, a chunk at a time, so undo still has the old audio.
      const s = this.layers[this.layers.length - 1];
      if (s && !s.done) s.hold = true;
    }
    const x = clamp(finite(u, 0), 0, 1);
    // The far end of the strip is the last sample, not a wrap back to 0.
    this.scrubTarget = x >= 1 ? this.len - 1e-4 : x * this.len;
  }

  /** Pointer up: keep the new position and go back to the play state we had. */
  endScrub() {
    if (!this.scrubbing) return;
    this.scrubbing = false;
    this.dubAt = -1;
    if (!this.len) return;
    let p = this.fpos % this.len;
    if (p < 0) p += this.len;
    this.fpos = p;
    this.pos = p <= 0 ? 0 : Math.min(this.len - 1, Math.floor(p));
    // Back on the integer path only when the tape is exactly normal forward.
    this.frac = !(this.rate === 1 && !this.reverse && this.speed === 1);
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
    this.scrubbing = false;
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
    if (this.len) this.edit++;
    this.loopSpb = 0;
    this.state = 'empty';
    this.L = this.R = null;
    this.len = 0; this.pos = 0; this.loopBars = 0;
    this.rec = null; this.cueFrame = -1;
    this.layers = [];
    this.peak = 0;
    this.userPaused = false;
    this.scrubbing = false;
    this.frac = false;
    this.fpos = 0;
    this.dubAt = -1;
    this.peakScanEdit = -1;
    this.peakScanLen = 0;
    this.peakScanAt = 0;
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
    this.scrubbing = false;
    this.frac = false;
    this.fpos = 0;
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
    this.loopSpb = r.mode === 'free' ? 0 : finite(this.transport.spb, 0.5);
    this.edit++;
    this.rec = null;
    this.pos = 0;
    this.fpos = 0;
    this.frac = false;
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
        this.layers.push({ L, R, done: false, start: this.pos, copied: 0, copiedBack: 0, peak: this.peak, len: this.len, spb: this.loopSpb, bars: this.loopBars });
      } catch {
        this.emit({ t: 'error', reason: 'memory' });
      }
    }
    this.state = 'overdub';
    this.odTarget = 1;
    this.dubAt = -1;
    this.edit++;
  }

  /** Copy `count` frames of the snapshot `s` (from its start, wrapping). */
  copySnapshot(s, count) {
    const len = this.len;
    const back = s.copiedBack || 0;
    let n = Math.min(count, len - s.copied - back);
    while (n > 0) {
      const at = (s.start + s.copied) % len;
      const run = Math.min(n, len - at);
      s.L.set(this.L.subarray(at, at + run), at);
      s.R.set(this.R.subarray(at, at + run), at);
      s.copied += run;
      n -= run;
    }
    if (s.copied + (s.copiedBack || 0) >= len) s.done = true;
  }

  finishSnapshots() {
    for (const s of this.layers) if (!s.done) this.copySnapshot(s, this.len);
  }

  /** Before a block that may write [pos, pos + n): keep the newest snapshot ahead of the writes. */
  advanceSnapshot(n) {
    const s = this.layers[this.layers.length - 1];
    if (!s || s.done) return;
    if (s.hold) {
      this.copySnapshot(s, SNAPSHOT_CHUNK);
      if (!s.done) this.copyBackward(s, SNAPSHOT_CHUNK);
      if (s.done) s.hold = false;
      return;
    }
    // Forward (the original walk) whenever the head is not moving backward.
    // Reverse copies the other way so the saved audio stays ahead of the head.
    // One chunk per block either way: the head only moves a few hundred frames.
    if (!(this.rate < 0)) {
      const ahead = ((this.pos - s.start) % this.len + this.len) % this.len + n;
      this.copySnapshot(s, Math.max(SNAPSHOT_CHUNK, ahead - s.copied));
      return;
    }
    if (!s.copied) this.copySnapshot(s, 1);
    this.copyBackward(s, SNAPSHOT_CHUNK);
  }

  /** True while a scrub has asked the open snapshot to finish before more writes. */
  snapHeld() {
    const s = this.layers[this.layers.length - 1];
    return !!(s && s.hold && !s.done);
  }

  /** Copy `count` frames backward from the sample before `s.start`. */
  copyBackward(s, count) {
    const len = this.len;
    if (!s.copiedBack) s.copiedBack = 0;
    let n = Math.min(count, len - s.copied - s.copiedBack);
    while (n > 0) {
      const at = ((s.start - 1 - s.copiedBack) % len + len) % len;
      const run = Math.min(n, at + 1);
      const from = at - run + 1;
      s.L.set(this.L.subarray(from, at + 1), from);
      s.R.set(this.R.subarray(from, at + 1), from);
      s.copiedBack += run;
      n -= run;
    }
    if (s.copied + s.copiedBack >= len) s.done = true;
  }

  undo() {
    if (this.state === 'armed' || this.state === 'record') { this.discardRecording(); this.notify(); return; }
    if (!this.layers.length || !this.len) { this.emit({ t: 'info', reason: 'nothing-to-undo' }); this.notify(); return; }
    this.finishSnapshots();
    if (this.state === 'overdub') this.state = 'play';
    this.od = 0; this.odTarget = 0;
    this.dubAt = -1;
    const prev = this.layers.pop();
    if (this.audible && this.pg > 0 && this.cueFrame < 0) {
      this.xf = { L: this.L, R: this.R, k: 0, p: this.pos, phase: this.pos, len: this.len };
    }
    // v2.9 a layer from before a stretch has its own length and tempo
    if (prev.len > 0 && prev.len !== this.len) {
      this.pos = Math.min(prev.len - 1, Math.floor((this.pos * prev.len) / this.len));
      this.len = prev.len;
      if (prev.spb > 0) this.loopSpb = prev.spb;
      if (prev.bars > 0) this.loopBars = prev.bars;
    }
    this.L = prev.L; this.R = prev.R;
    this.peak = prev.peak;
    this.edit++;
    this.notify();
  }

  /**
   * Swap in new loop audio (Follow tempo): {L, R, id, base, spb, bars}. Only
   * while the loop plays or is stopped, and only when `base` (when given) is
   * still the current `edit`. Answers {t:'replaced', id, ok, edit}.
   */
  replace(msg) {
    const L = msg.L, R = msg.R;
    const len = L && typeof L.length === 'number' ? L.length : 0;
    const ok = this.len > 0 && (this.state === 'play' || this.state === 'paused')
      && L instanceof Float32Array && R instanceof Float32Array && R.length === len
      && len >= Math.max(2 * this.fadeLen, Math.round(MIN_LOOP_SECONDS * this.sr)) && len <= this.maxLoop
      && (msg.base == null || msg.base === this.edit);
    if (!ok) { this.emit({ t: 'replaced', id: msg.id, ok: false, edit: this.edit }); return; }
    const oldL = this.L, oldR = this.R, oldLen = this.len, oldPos = this.pos;
    // v2.9 the audio from before the stretch becomes an undo step (oldest steps make room)
    this.finishSnapshots();
    const keep = { L: oldL, R: oldR, done: true, start: 0, copied: oldLen, peak: this.peak, len: oldLen, spb: this.loopSpb, bars: this.loopBars };
    const size = (layer) => layer.L.length * 8;
    let total = size(keep);
    for (const layer of this.layers) total += size(layer);
    while (this.layers.length && (this.layers.length + 1 > this.maxLayers || total > this.undoBudget)) total -= size(this.layers.shift());
    if (this.maxLayers > 0 && total <= this.undoBudget) this.layers.push(keep);
    this.od = 0; this.odTarget = 0;
    this.L = L; this.R = R; this.len = len;
    this.pos = Math.min(len - 1, Math.floor((oldPos * len) / oldLen));
    this.xf = this.audible && this.pg > 0 && this.cueFrame < 0 ? { L: oldL, R: oldR, k: 0, p: oldPos, phase: oldPos, len: oldLen } : null;
    const bars = Math.round(finite(msg.bars, 0));
    if (bars > 0) this.loopBars = bars;
    const spb = finite(msg.spb, 0);
    if (spb > 0) this.loopSpb = spb;
    let peak = 0;
    for (let i = 0; i < len; i++) { const a = Math.max(Math.abs(L[i]), Math.abs(R[i])); if (a > peak) peak = a; }
    this.peak = peak;
    this.edit++;
    this.emit({ t: 'replaced', id: msg.id, ok: true, edit: this.edit });
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
    this.emit({ t: 'loop', id, L, R, len: this.len, sampleRate: this.sr, loopBars: this.loopBars, edit: this.edit, loopSpb: this.loopSpb }, [L.buffer, R.buffer]);
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
      if (this.scrubbing && this.len > 0 && (this.state === 'play' || this.state === 'overdub' || this.state === 'paused')) {
        const heard = this.scrubSample();
        ol = heard[0]; or = heard[1];
      } else if (this.len > 0 && (this.state === 'play' || this.state === 'overdub')) {
        const rateTarget = this.reverse ? -this.speed : this.speed;
        if (this.rate !== rateTarget) {
          this.rate += (rateTarget - this.rate) * this.tapeA;
          const rd = this.rate - rateTarget;
          if (rd < 1e-4 && rd > -1e-4) this.rate = rateTarget;
        }
        if (this.cueFrame >= 0 && f >= this.cueFrame) {
          this.cueFrame = -1; this.pos = 0; this.pg = 0; this.pgTarget = 1; this.od = 0; this.xf = null;
          if (this.state === 'overdub') this.state = 'play';
          this.odTarget = 0;
          changed = true;
          this.fpos = 0;
          this.frac = false;
        }
        if (!(this.cueFrame >= 0 && this.pg <= 0)) {
          // Integer +1 forward is the original read. Anything else (half, double,
          // reverse, or a glide that has not settled) uses the tape head.
          const unity = this.rate === 1 && rateTarget === 1;
          if (unity) {
            if (this.frac) {
              let fp = this.fpos % this.len;
              if (fp < 0) fp += this.len;
              this.pos = fp <= 0 ? 0 : Math.min(this.len - 1, Math.floor(fp));
              this.frac = false;
            }
            const p = this.pos;
            let sl = this.L[p], sr = this.R[p];
            const x = this.xf;
            if (x) {
              const t = (x.k + 0.5) / F * HALF_PI;
              const fi = Math.sin(t), fo = Math.cos(t);
              const xp = x.p;
              sl = sl * fi + x.L[xp] * fo;
              sr = sr * fi + x.R[xp] * fo;
              x.p = xp + 1 >= x.len ? 0 : xp + 1;
              if (++x.k >= F) this.xf = null;
            }
            // Overdub ramp and decay glide.
            if (this.od !== this.odTarget) this.od = this.od < this.odTarget ? Math.min(this.odTarget, this.od + odStep) : Math.max(this.odTarget, this.od - odStep);
            this.decay += (this.decayTarget - this.decay) * a;
            if (this.od > 0 && !this.snapHeld()) {
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
          } else {
            const heard = this.varispeedSample(xl, xr, F, a, odStep);
            ol = heard[0]; or = heard[1];
          }
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
        this.emit({
          t: 'pos', state: this.state, pos: this.pos, len: this.len,
          fpos: this.scrubbing || this.frac ? this.fpos : this.pos,
          rate: this.scrubbing ? 0 : this.rate, speed: this.speed, reverse: this.reverse, scrub: this.scrubbing,
          recPos: this.rec ? this.rec.pos : 0, recTarget: this.rec ? this.rec.target : 0,
          cue: this.cueFrame >= 0, capture: this.capture ? this.capture.pos / this.capture.frames : -1, peak: this.peak,
        });
      }
    }
    this.scanPeaks();
  }

  /** One scrub sample: the head glides toward the finger, and fast moves get quieter. */
  scrubSample() {
    const len = this.len;
    const prev = this.fpos;
    let next = prev + (this.scrubTarget - prev) * this.scrubA;
    if (next < 0) next = 0;
    const last = len - 1e-4;
    if (next > last) next = last;
    const vel = next > prev ? next - prev : prev - next;
    this.fpos = next;
    this.pos = next <= 0 ? 0 : Math.min(len - 1, Math.floor(next));
    const sl = loopSampleAt(this.L, next, len);
    const sr = loopSampleAt(this.R, next, len);
    // Stopped is silent. Around 1 sample per output sample is full level.
    // Faster than that falls off, so a flick across the strip stays quiet.
    let sg = 0;
    if (vel > 0) sg = vel <= 1 ? vel : 1 / vel;
    const rateTarget = this.reverse ? -this.speed : this.speed;
    if (this.rate !== rateTarget) {
      this.rate += (rateTarget - this.rate) * this.tapeA;
      const rd = this.rate - rateTarget;
      if (rd < 1e-4 && rd > -1e-4) this.rate = rateTarget;
    }
    const g = sg * this.gain;
    return [sl * g, sr * g];
  }

  /**
   * Playback off unity forward. Rate -1 steps backward by one integer sample.
   * Any other rate moves a fractional head and reads with linear interpolation.
   * Overdub writes each index once per entry.
   */
  varispeedSample(xl, xr, F, a, odStep) {
    const len = this.len;
    if (this.od !== this.odTarget) this.od = this.od < this.odTarget ? Math.min(this.odTarget, this.od + odStep) : Math.max(this.odTarget, this.od - odStep);
    this.decay += (this.decayTarget - this.decay) * a;
    if (this.od <= 0) this.dubAt = -1;

    if (this.rate === -1) {
      if (this.frac) {
        let fp = this.fpos % len;
        if (fp < 0) fp += len;
        this.pos = fp <= 0 ? 0 : Math.min(len - 1, Math.floor(fp));
        this.fpos = this.pos;
        this.frac = false;
        this.dubAt = -1;
      }
      const p = this.pos;
      let sl = this.L[p], sr = this.R[p];
      const mixed = this.mixXf(sl, sr, F, -1);
      sl = mixed[0]; sr = mixed[1];
      if (this.od > 0 && !this.snapHeld()) this.writeDub(p, xl, xr);
      const g = this.pg * this.gain;
      this.pos = p - 1 < 0 ? len - 1 : p - 1;
      this.fpos = this.pos;
      return [sl * g, sr * g];
    }

    if (!this.frac) {
      this.fpos = this.pos;
      this.frac = true;
      this.dubAt = -1;
    }
    const from = this.fpos;
    const to = from + this.rate;
    let sl = loopSampleAt(this.L, from, len);
    let sr = loopSampleAt(this.R, from, len);
    const mixed = this.mixXf(sl, sr, F, this.rate);
    sl = mixed[0]; sr = mixed[1];
    if (this.od > 0 && !this.snapHeld()) this.dubBins(from, to, xl, xr);
    let wrapped = to % len;
    if (wrapped < 0) wrapped += len;
    this.fpos = wrapped;
    this.pos = wrapped <= 0 ? 0 : Math.min(len - 1, Math.floor(wrapped));
    const g = this.pg * this.gain;
    return [sl * g, sr * g];
  }

  /** Equal-power crossfade from the buffer undo or replace saved. `step` follows the head. */
  mixXf(sl, sr, F, step) {
    const x = this.xf;
    if (!x) return [sl, sr];
    const t = (x.k + 0.5) / F * HALF_PI;
    const fi = Math.sin(t), fo = Math.cos(t);
    let ph = x.phase == null ? x.p : x.phase;
    const ol = loopSampleAt(x.L, ph, x.len);
    const orr = loopSampleAt(x.R, ph, x.len);
    ph += step;
    ph %= x.len;
    if (ph < 0) ph += x.len;
    x.phase = ph;
    x.p = ph <= 0 ? 0 : Math.min(x.len - 1, Math.floor(ph));
    if (++x.k >= F) this.xf = null;
    return [sl * fi + ol * fo, sr * fi + orr * fo];
  }

  /** Overdub one loop index (the same curve the integer path uses). */
  writeDub(idx, xl, xr) {
    const w = Math.sin(this.od * HALF_PI);
    const d = 1 - this.od * (1 - this.decay);
    const nl = softLimit(this.L[idx] * d + xl * w);
    const nr = softLimit(this.R[idx] * d + xr * w);
    this.L[idx] = nl; this.R[idx] = nr;
    const m = Math.max(nl < 0 ? -nl : nl, nr < 0 ? -nr : nr);
    if (m > this.peak) this.peak = m;
  }

  /**
   * Write each integer bin the head enters while moving from `from` to `to`
   * (unwrapped), and skip a bin it is already inside. Half speed therefore
   * writes an index once; double speed writes both indices it crosses.
   */
  dubBins(from, to, xl, xr) {
    const len = this.len;
    const a = Math.floor(from);
    const b = Math.floor(to);
    const span = b >= a ? b - a : a - b;
    const step = b >= a ? 1 : -1;
    const last = b + step;
    let i = a;
    const guard = span + 1;
    for (let n = 0; n < guard; n++) {
      const idx = wrapIndex(i, len);
      if (idx !== this.dubAt) {
        this.writeDub(idx, xl, xr);
        this.dubAt = idx;
      }
      i += step;
      if (i === last) break;
    }
  }

  /**
   * Peak overview for the strip. One chunk per block, and never the whole
   * loop in that block, so a long loop cannot stall the audio thread.
   * A finished pass is posted at a modest rate.
   */
  scanPeaks() {
    const len = this.len;
    if (!len || !this.L) { this.peakScanLen = 0; return; }
    if (this.peakScanEdit !== this.edit || this.peakScanLen !== len) {
      this.peakAcc.fill(0);
      this.peakScanAt = 0;
      this.peakScanEdit = this.edit;
      this.peakScanLen = len;
    }
    const bins = this.peakAcc.length;
    const room = len - this.peakScanAt;
    // Leave at least one frame for a later block when the loop is longer than one frame.
    const cap = this.peakScanAt === 0 && len > 1 ? Math.min(PEAK_SCAN, len - 1) : Math.min(PEAK_SCAN, room);
    const n = cap;
    const at0 = this.peakScanAt;
    const L = this.L, R = this.R, acc = this.peakAcc;
    for (let i = 0; i < n; i++) {
      const at = at0 + i;
      const m = Math.max(Math.abs(L[at]), Math.abs(R[at]));
      let b = (at * bins / len) | 0;
      if (b >= bins) b = bins - 1;
      if (m > acc[b]) acc[b] = m;
    }
    this.peakScanAt = at0 + n;
    if (this.peakScanAt >= len) {
      this.peakScanAt = 0;
      const now = this.frameNow;
      if (now - this.peakSentAt >= (this.sr >> 3)) {
        const peaks = this.peakAcc.slice();
        this.peakSentAt = now;
        this.emit({ t: 'peaks', peaks, len, edit: this.edit, bins }, [peaks.buffer]);
      }
      this.peakAcc.fill(0);
    }
  }
}
