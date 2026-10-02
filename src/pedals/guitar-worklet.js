// AudioWorklet processors for the pedal and guitar features. Bundled into one
// classic script by vite.config.js (virtual:worklet:src/pedals/guitar-worklet.js)
// and loaded by worklet-loader.js.
//
//   'orograph-guitar'         envelope follower + Single tracker on one channel;
//                             Chords batches raw samples for a dedicated Worker.
//                             Posts level at ~100 Hz and Single pitch at ~30 Hz.
//   'orograph-pedal-capture'  records N input channels sample-aligned (the round
//                             trip ping and guitar Capture) and ships ~170 ms chunks.
//
// Both keep returning true and treat a missing input as silence, so their time
// base never skips.

import { createPitchTracker, createEnvelopeFollower } from './pitch.js';

const GUITAR_SAMPLE_CHUNK = 1024;

class GuitarProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const o = (options && options.processorOptions) || {};
    this.channel = o.channel || 0;
    this.tracker = createPitchTracker({ sampleRate, ...(o.tracker || {}) });
    this.mode = o.guitarMode === 'chords' ? 'chords' : 'single';
    this.revision = o.revision || 0;
    this.sampleBuffer = new Float32Array(GUITAR_SAMPLE_CHUNK);
    this.sampleFill = 0;
    this.sampleTime = 0;
    this.env = createEnvelopeFollower({ sampleRate, ...(o.envelope || {}) });
    this.levelEvery = Math.max(1, Math.round(sampleRate / (o.envRateHz || 100) / 128));
    this.pitchEvery = Math.max(1, Math.round(sampleRate / (o.pitchRateHz || 30) / 128));
    this.blocks = 0;
    this.zero = new Float32Array(128);
    this.alive = true;
    this.port.onmessage = (e) => {
      const m = e.data || {};
      if (m.t === 'config') {
        const mode = m.guitarMode === undefined ? this.mode : m.guitarMode === 'chords' ? 'chords' : 'single';
        if (mode !== this.mode || (m.revision !== undefined && m.revision !== this.revision)) {
          this.releaseSingle();
          this.tracker.reset(); this.sampleFill = 0;
          this.mode = mode;
          if (m.revision !== undefined) this.revision = m.revision;
          this.port.postMessage({ t: 'pitch', mode, notes: [], voiced: false, revision: this.revision, time: currentTime });
        }
        if (m.tracker) this.tracker.configure(m.tracker);
        if (m.envelope) this.env.configure(m.envelope);
      } else if (m.t === 'reset') {
        this.releaseSingle(); this.tracker.reset(); this.env.reset(); this.sampleFill = 0;
        this.port.postMessage({ t: 'pitch', mode: this.mode, notes: [], voiced: false, revision: this.revision, time: currentTime });
      } else if (m.t === 'stop') {
        this.releaseSingle();
        this.alive = false;
      }
    };
  }

  releaseSingle() {
    if (this.tracker.note != null) this.port.postMessage({ t: 'noteOff', note: this.tracker.note, mode: 'single', revision: this.revision, time: currentTime });
  }

  sendSamples(x) {
    let offset = 0;
    while (offset < x.length) {
      if (!this.sampleFill) this.sampleTime = (currentFrame + offset) / sampleRate;
      const count = Math.min(x.length - offset, GUITAR_SAMPLE_CHUNK - this.sampleFill);
      this.sampleBuffer.set(x.subarray(offset, offset + count), this.sampleFill);
      offset += count; this.sampleFill += count;
      if (this.sampleFill === GUITAR_SAMPLE_CHUNK) {
        const data = this.sampleBuffer;
        this.port.postMessage({ t: 'samples', mode: 'chords', data, time: this.sampleTime, revision: this.revision }, [data.buffer]);
        this.sampleBuffer = new Float32Array(GUITAR_SAMPLE_CHUNK);
        this.sampleFill = 0;
      }
    }
  }

  process(inputs) {
    if (!this.alive) return false;
    const inp = inputs[0];
    const x = inp && inp.length ? (inp[this.channel] || inp[0]) : this.zero;
    if (this.mode === 'chords') this.sendSamples(x);
    else {
      const before = this.tracker.samples;
      const events = this.tracker.process(x);
      for (let i = 0; i < events.length; i++) {
        const e = events[i];
        const time = (currentFrame + (e.sample - before)) / sampleRate;
        this.port.postMessage({ ...e, t: e.type, mode: 'single', revision: this.revision, time });
      }
    }
    const s = this.env.process(x);
    this.blocks++;
    if (this.blocks % this.levelEvery === 0) this.port.postMessage({ t: 'level', value: s.value, db: s.db, open: s.open, time: currentTime });
    if (this.mode === 'single' && this.blocks % this.pitchEvery === 0) {
      const frame = this.tracker.lastFrame;
      this.port.postMessage({ t: 'pitch', mode: 'single', freq: frame.freq, midi: frame.midi, clarity: frame.clarity, voiced: frame.voiced, revision: this.revision, time: currentTime });
    }
    return true;
  }
}

const CHUNK = 8192;

class CaptureProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const o = (options && options.processorOptions) || {};
    this.channels = Math.max(1, Math.min(8, o.channels || 2));
    this.armed = false;
    this.frames = 0;
    this.maxFrames = Infinity;
    this.fill = 0;
    this.buf = null;
    this.port.onmessage = (e) => {
      const m = e.data || {};
      if (m.t === 'start') {
        this.armed = true;
        this.frames = 0;
        this.fill = 0;
        this.maxFrames = m.maxFrames > 0 ? m.maxFrames : Infinity;
        this.fresh();
      } else if (m.t === 'stop') {
        if (this.armed) this.finish('stop');
        else this.port.postMessage({ t: 'done', frames: this.frames, reason: 'stop' });
      }
    };
  }

  fresh() { this.buf = Array.from({ length: this.channels }, () => new Float32Array(CHUNK)); }

  ship() {
    if (!this.fill) return;
    const data = this.buf.map(b => b.subarray(0, this.fill).slice());
    this.port.postMessage({ t: 'chunk', data, frames: this.fill }, data.map(d => d.buffer));
    this.fill = 0;
  }

  finish(reason) {
    this.ship();
    this.armed = false;
    this.port.postMessage({ t: 'done', frames: this.frames, reason });
  }

  process(inputs) {
    if (!this.armed) return true;
    const inp = inputs[0] || [];
    const n = (inp[0] && inp[0].length) || 128;
    let i = 0;
    while (i < n && this.armed) {
      const room = Math.min(CHUNK - this.fill, n - i, this.maxFrames - this.frames);
      for (let c = 0; c < this.channels; c++) {
        const src = inp[c];
        const dst = this.buf[c];
        if (src) dst.set(src.subarray(i, i + room), this.fill);
        else dst.fill(0, this.fill, this.fill + room);
      }
      this.fill += room;
      this.frames += room;
      i += room;
      if (this.fill === CHUNK) this.ship();
      if (this.frames >= this.maxFrames) this.finish('limit');
    }
    return true;
  }
}

registerProcessor('orograph-guitar', GuitarProcessor);
registerProcessor('orograph-pedal-capture', CaptureProcessor);
