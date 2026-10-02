import { describe, it, expect } from 'vitest';
import {
  LooperCore, loopFrames, barFrame, softLimit, sanitizeBars, LOOP_BARS, DEFAULT_BARS, SOFT_CEILING, MAX_LAYERS,
} from '../../src/audio/looper-core.js';

const BLOCK = 128;

/** A looper driven like the AudioWorklet: 128-frame blocks, messages between blocks. */
function rig(sr = 48000, opts = {}) {
  const msgs = [];
  const core = new LooperCore(sr, { emit: (m) => msgs.push(m), ...opts });
  let frame = 0;
  const outL = [], outR = [];
  const api = {
    core, msgs, sr,
    get frame() { return frame; },
    send(m) { core.handle(m, frame); },
    /** Run `n` frames (rounded up to whole blocks); input(f) -> [l, r] or a number. */
    run(n, input = () => 0, keep = true) {
      const blocks = Math.ceil(n / BLOCK);
      const iL = new Float32Array(BLOCK), iR = new Float32Array(BLOCK);
      const oL = new Float32Array(BLOCK), oR = new Float32Array(BLOCK);
      for (let b = 0; b < blocks; b++) {
        for (let i = 0; i < BLOCK; i++) {
          const v = input(frame + i);
          if (Array.isArray(v)) { iL[i] = v[0]; iR[i] = v[1]; } else { iL[i] = v; iR[i] = v; }
        }
        core.process(iL, iR, oL, oR, BLOCK, frame);
        if (keep) for (let i = 0; i < BLOCK; i++) { outL.push(oL[i]); outR.push(oR[i]); }
        frame += BLOCK;
      }
    },
    /** Run until the frame counter reaches at least `f`. */
    runTo(f, input, keep) { if (f > frame) api.run(f - frame, input, keep); },
    out: () => ({ L: Float32Array.from(outL), R: Float32Array.from(outR) }),
    clearOut() { outL.length = 0; outR.length = 0; },
    outStart: () => frame - outL.length,
  };
  return api;
}

const loop = (core) => ({ L: core.L.subarray(0, core.len), R: core.R.subarray(0, core.len) });
const ramp = (f) => (f % 100000) / 1e5;       // a unique-ish value per frame

describe('looper helpers', () => {
  it('loop lengths are exact at 44.1 and 48 kHz', () => {
    expect(loopFrames(2, 60 / 120, 48000)).toBe(192000);
    expect(loopFrames(2, 60 / 120, 44100)).toBe(176400);
    expect(loopFrames(1, 60 / 112, 44100)).toBe(94500);
    expect(loopFrames(8, 60 / 90, 48000)).toBe(1024000);
    expect(loopFrames(4, 60 / 133, 44100)).toBe(Math.round(16 * 60 / 133 * 44100));
  });
  it('finds bar lines of a transport anchor', () => {
    const tr = { beatTime: 1, beat: 0, spb: 0.5 };   // bars every 2 s from t = 1
    expect(barFrame(tr, 48000, 48000, 'next')).toBe(48000);
    expect(barFrame(tr, 48001, 48000, 'next')).toBe(144000);
    expect(barFrame(tr, 143999, 48000, 'prev')).toBe(48000);
    // External clock: anchor mid-bar (beat 6 at t = 10) -> bar lines at beats 8, 12 ...
    const ext = { beatTime: 10, beat: 6, spb: 0.5 };
    expect(barFrame(ext, 480000, 48000, 'next')).toBe(Math.round(11 * 48000));
  });
  it('soft limit is the identity below 0 dBFS and never reaches its ceiling', () => {
    expect(softLimit(0.5)).toBe(0.5);
    expect(softLimit(-1)).toBe(-1);
    expect(softLimit(1.5)).toBeGreaterThan(1.3);
    expect(softLimit(3)).toBeLessThan(SOFT_CEILING);
    expect(softLimit(-3)).toBeGreaterThan(-SOFT_CEILING);
    expect(softLimit(1e9)).toBeLessThanOrEqual(SOFT_CEILING);
    // Continuous slope at the knee.
    expect(softLimit(1.0001) - softLimit(1)).toBeCloseTo(0.0001, 6);
  });
  it('bars are limited to 1, 2, 4 or 8 with 2 as the default', () => {
    expect(LOOP_BARS).toEqual([1, 2, 4, 8]);
    expect(DEFAULT_BARS).toBe(2);
    expect(sanitizeBars(4)).toBe(4);
    expect(sanitizeBars(3)).toBe(2);
    expect(sanitizeBars('8')).toBe(8);
  });
});

describe('looper: free-length recording (transport stopped)', () => {
  it('records from the press to the second press and then plays it back sample-exact', () => {
    const r = rig();
    r.run(1024, ramp, false);
    r.send({ t: 'main' });
    expect(r.core.state).toBe('record');
    const start = r.frame;
    r.run(48000, ramp, false);
    r.send({ t: 'main' });
    const end = r.frame;
    expect(r.core.state).toBe('play');
    expect(r.core.len).toBe(end - start);
    const { L } = loop(r.core);
    // Untouched by the seam fade: the recorded frames, exactly.
    expect(L[0]).toBe(Math.fround(ramp(start)));
    expect(L[1000]).toBe(Math.fround(ramp(start + 1000)));
    const F = r.core.fadeLen;
    expect(L[r.core.len - F - 1]).toBe(Math.fround(ramp(end - F - 1)));
    // Playback: after the fade-in the loop plays at unity.
    r.clearOut();
    r.run(4096, () => 0);
    const o = r.out().L;
    expect(o[1000]).toBeCloseTo(L[1000], 6);
    expect(o[3000]).toBeCloseTo(L[3000], 6);
  });

  it('a very short press pair is discarded', () => {
    const r = rig();
    r.send({ t: 'main' });
    r.run(256);
    r.send({ t: 'main' });
    expect(r.core.state).toBe('empty');
    expect(r.core.len).toBe(0);
  });
});

describe('looper: bar-locked recording (transport playing)', () => {
  for (const sr of [44100, 48000]) {
    it(`starts on the next bar line and closes after exactly N bars at ${sr} Hz`, () => {
      const r = rig(sr);
      const spb = 60 / 112;
      r.send({ t: 'transport', playing: true, beatTime: 0, beat: 0, spb });
      r.send({ t: 'bars', v: 2 });
      r.run(Math.round(0.9 * sr), ramp, false);           // well past the late-press grace of bar 0
      r.send({ t: 'main' });
      expect(r.core.state).toBe('armed');
      const bar1 = Math.round(4 * spb * sr);
      expect(r.core.rec.startFrame).toBe(bar1);
      r.runTo(bar1 + 10, ramp, false);
      expect(r.core.state).toBe('record');
      r.runTo(bar1 + loopFrames(2, spb, sr) + 256, ramp, false);
      expect(r.core.state).toBe('play');
      expect(r.core.len).toBe(loopFrames(2, spb, sr));
      expect(r.core.loopBars).toBe(2);
      expect(r.core.L[0]).toBe(Math.fround(ramp(bar1)));
      expect(r.core.L[12345]).toBe(Math.fround(ramp(bar1 + 12345)));
    });
  }

  it('a press just after the bar line (within the grace) starts on that bar from history', () => {
    const sr = 48000;
    const r = rig(sr);
    r.send({ t: 'transport', playing: true, beatTime: 0, beat: 0, spb: 0.5 });
    r.run(96000 + 2048, ramp, false);                       // 42 ms after bar 1
    r.send({ t: 'main' });
    expect(r.core.state).toBe('record');
    expect(r.core.rec.startFrame).toBe(96000);
    r.runTo(96000 + 192000 + 256, ramp, false);
    expect(r.core.len).toBe(192000);
    expect(r.core.L[0]).toBe(Math.fround(ramp(96000)));
    expect(r.core.L[100]).toBe(Math.fround(ramp(96100)));
  });

  it('a second press while recording closes at the next whole bar', () => {
    const sr = 48000;
    const r = rig(sr);
    r.send({ t: 'transport', playing: true, beatTime: 0, beat: 0, spb: 0.5 });
    r.send({ t: 'bars', v: 4 });
    r.send({ t: 'main' });                                  // bar 0, immediately
    r.run(96000 + 20000, ramp, false);                       // into bar 2
    r.send({ t: 'main' });
    r.runTo(192000 + 256, ramp, false);
    expect(r.core.state).toBe('play');
    expect(r.core.len).toBe(192000);
    expect(r.core.loopBars).toBe(2);
  });
});

describe('looper: seam', () => {
  it('a sine looped at an awkward length has no jump at the seam', () => {
    const sr = 48000;
    const r = rig(sr);
    const f = 441.3, amp = 0.8;
    const sine = (n) => amp * Math.sin(2 * Math.PI * f * n / sr);
    r.run(4096, sine, false);
    r.send({ t: 'main' });
    r.run(sr * 0.5, sine, false);
    r.send({ t: 'main' });
    const len = r.core.len;
    // Play two whole passes with the input silent and look at the loop output.
    r.clearOut();
    r.run(len * 2 + 1024, () => 0);
    const o = r.out().L;
    const lead = 1024;                                      // after the first fade-in
    let maxStep = 0, seamStep = 0;
    for (let i = lead; i < len * 2; i++) {
      const d = Math.abs(o[i] - o[i - 1]);
      if (d > maxStep) maxStep = d;
    }
    // The seam is between output index len - 1 and len (the loop wraps there).
    for (let i = len - 64; i < len + 64; i++) seamStep = Math.max(seamStep, Math.abs(o[i] - o[i - 1]));
    const sineStep = amp * 2 * Math.PI * f / sr;           // largest step of the sine itself
    expect(seamStep).toBeLessThan(sineStep * 1.5);
    expect(maxStep).toBeLessThan(sineStep * 1.5);
    // For scale: cutting the same loop without a crossfade jumps by far more.
    const L = r.core.L;
    const raw = Math.abs(sine(4096 + len) - sine(4096));
    expect(raw).toBeGreaterThan(sineStep * 3);
    expect(Math.abs(L[0] - L[len - 1])).toBeLessThan(sineStep * 1.5);
    // Report the measured value for the record.
    console.log(`[looper seam] largest step at the seam ${seamStep.toExponential(3)}, sine's own largest step ${sineStep.toExponential(3)}, ratio ${(seamStep / sineStep).toFixed(3)}; uncrossfaded jump would be ${raw.toFixed(3)}`);
  });

  it('starts and stops fade instead of stepping', () => {
    const r = rig();
    const dc = () => 0.5;
    r.send({ t: 'main' });
    r.run(24000, dc, false);
    r.send({ t: 'main' });
    r.clearOut();
    r.run(2048, () => 0);
    const o = r.out().L;
    expect(Math.abs(o[0])).toBeLessThan(0.5 / r.core.fadeLen * 2);
    for (let i = 1; i < 2048; i++) expect(Math.abs(o[i] - o[i - 1])).toBeLessThan(0.5 / r.core.fadeLen * 1.6 + 1e-6);
    r.send({ t: 'stop' });
    r.clearOut();
    r.run(2048, () => 0);
    const s = r.out().L;
    for (let i = 1; i < 2048; i++) expect(Math.abs(s[i] - s[i - 1])).toBeLessThan(0.5 / r.core.fadeLen * 1.6 + 1e-6);
    expect(s[2047]).toBe(0);
    expect(r.core.state).toBe('paused');
  });
});

describe('looper: smoothed controls', () => {
  it('volume and mute glide instead of stepping, and feedback is capped at unity', () => {
    const r = rig();
    r.send({ t: 'main' }); r.run(24000, () => 0.5, false); r.send({ t: 'main' });
    r.run(4096, () => 0, false);
    r.clearOut();
    r.send({ t: 'mute', v: true });
    r.run(4096, () => 0);
    const o = r.out().L;
    let worst = 0;
    for (let i = 1; i < o.length; i++) worst = Math.max(worst, Math.abs(o[i] - o[i - 1]));
    expect(worst).toBeLessThan(0.5 * 0.01);           // a 10 ms glide, no step
    expect(Math.abs(o[o.length - 1])).toBeLessThan(1e-3);
    r.send({ t: 'feedback', v: 5 });
    expect(r.core.decayTarget).toBe(1);
    r.send({ t: 'volume', v: -2 });
    expect(r.core.volume).toBe(0);
  });
});

describe('looper: overdub', () => {
  function recordConstant(r, v, frames = 24000) {
    r.send({ t: 'main' });
    r.run(frames, () => v, false);
    r.send({ t: 'main' });
    return r.core.len;
  }

  it('sums the input onto the loop each pass with the decay applied to the old layer', () => {
    const r = rig();
    const len = recordConstant(r, 0.1);
    r.send({ t: 'feedback', v: 0.5 });
    r.run(4096, () => 0, false);                            // let the decay glide settle
    r.send({ t: 'main' });
    expect(r.core.state).toBe('overdub');
    r.run(len, () => 0.2, false);                           // one full pass
    r.send({ t: 'main' });
    expect(r.core.state).toBe('play');
    r.run(4096, () => 0, false);
    const { L } = loop(r.core);
    // Away from the punch-in / punch-out ramps: 0.1 * 0.5 + 0.2.
    const mid = (r.core.pos + (len >> 1)) % len;
    expect(L[mid]).toBeCloseTo(0.25, 5);
  });

  it('feedback 1 with a silent input keeps the loop exactly as it was (no build-up)', () => {
    const r = rig();
    const len = recordConstant(r, 0.3);
    const before = Float32Array.from(loop(r.core).L);
    r.send({ t: 'main' });
    r.run(len * 5, () => 0, false);                         // five passes of overdub, nothing played
    r.send({ t: 'main' });
    r.run(2048, () => 0, false);
    const after = loop(r.core).L;
    let worst = 0;
    for (let i = 0; i < len; i++) worst = Math.max(worst, Math.abs(after[i] - before[i]));
    expect(worst).toBeLessThan(1e-6);
  });

  it('stacked overdubs never clip hard and stay below the soft ceiling', () => {
    const r = rig();
    const len = recordConstant(r, 0.9);
    r.send({ t: 'main' });
    r.run(len * 6, () => 0.9, false);
    const { L } = loop(r.core);
    let peak = 0;
    for (let i = 0; i < len; i++) peak = Math.max(peak, Math.abs(L[i]));
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThan(SOFT_CEILING);
    expect(Number.isFinite(peak)).toBe(true);
  });

  it('entering and leaving overdub ramps the input in and out', () => {
    const r = rig();
    const len = recordConstant(r, 0);
    const p0 = r.core.pos;
    r.send({ t: 'main' });
    r.run(2048, () => 0.5, false);
    const { L } = loop(r.core);
    const F = r.core.fadeLen;
    // The first written sample is tiny, the ramp is monotonic and reaches 0.5.
    expect(Math.abs(L[p0])).toBeLessThan(0.5 * 0.05);
    for (let k = 1; k < F + 4; k++) expect(L[(p0 + k) % len]).toBeGreaterThanOrEqual(L[(p0 + k - 1) % len] - 1e-7);
    expect(L[(p0 + F + 10) % len]).toBeCloseTo(0.5, 6);
  });
});

describe('looper: undo, clear and layers', () => {
  it('undo restores the loop before the last overdub, layer by layer', () => {
    const r = rig();
    r.send({ t: 'main' });
    r.run(24000, () => 0.1, false);
    r.send({ t: 'main' });
    const len = r.core.len;
    const base = Float32Array.from(loop(r.core).L);
    r.send({ t: 'main' }); r.run(len, () => 0.2, false); r.send({ t: 'main' }); r.run(1024, () => 0, false);
    const layer1 = Float32Array.from(loop(r.core).L);
    r.send({ t: 'main' }); r.run(len, () => 0.3, false); r.send({ t: 'main' }); r.run(1024, () => 0, false);
    expect(r.core.layers.length).toBe(2);
    r.send({ t: 'undo' });
    expect(Array.from(loop(r.core).L)).toEqual(Array.from(layer1));
    r.send({ t: 'undo' });
    expect(Array.from(loop(r.core).L)).toEqual(Array.from(base));
    r.send({ t: 'undo' });                                  // nothing left: the loop stays
    expect(r.core.len).toBe(len);
    expect(r.msgs.some(m => m.t === 'info' && m.reason === 'nothing-to-undo')).toBe(true);
  });

  it('undo while overdubbing drops the layer in progress, even before its copy finished', () => {
    const r = rig();
    r.send({ t: 'main' });
    r.run(96000, () => 0.1, false);
    r.send({ t: 'main' });
    const base = Float32Array.from(loop(r.core).L);
    r.send({ t: 'main' });
    r.run(256, () => 0.4, false);
    r.send({ t: 'undo' });
    expect(r.core.state).toBe('play');
    expect(Array.from(loop(r.core).L)).toEqual(Array.from(base));
  });

  it('keeps at most MAX_LAYERS undo layers and respects the memory budget', () => {
    const r = rig(48000);
    r.send({ t: 'main' }); r.run(4800, () => 0.1, false); r.send({ t: 'main' });
    for (let k = 0; k < MAX_LAYERS + 3; k++) { r.send({ t: 'main' }); r.run(512, () => 0.01, false); r.send({ t: 'main' }); }
    expect(r.core.layers.length).toBe(MAX_LAYERS);
    const small = rig(48000, { undoBudgetBytes: 4800 * 8 * 2 });
    small.send({ t: 'main' }); small.run(4800, () => 0.1, false); small.send({ t: 'main' });
    for (let k = 0; k < 5; k++) { small.send({ t: 'main' }); small.run(512, () => 0.01, false); small.send({ t: 'main' }); }
    expect(small.core.layers.length).toBeLessThanOrEqual(2);
  });

  it('clear fades out and empties the looper', () => {
    const r = rig();
    r.send({ t: 'main' }); r.run(24000, () => 0.5, false); r.send({ t: 'main' });
    r.run(2048, () => 0, false);
    r.send({ t: 'clear' });
    r.run(2048, () => 0, false);
    expect(r.core.state).toBe('empty');
    expect(r.core.len).toBe(0);
    expect(r.core.L).toBe(null);
  });
});

describe('looper: transport', () => {
  it('stops with the transport and restarts on bar 1 when it plays again', () => {
    const sr = 48000;
    const r = rig(sr);
    r.send({ t: 'transport', playing: true, beatTime: 0, beat: 0, spb: 0.5 });
    r.send({ t: 'bars', v: 1 });
    r.send({ t: 'main' });
    r.runTo(96000 + 512, ramp, false);
    expect(r.core.state).toBe('play');
    r.run(30000, () => 0, false);
    r.send({ t: 'transport', playing: false, beatTime: 0, beat: 0, spb: 0.5 });
    r.run(2048, () => 0, false);
    expect(r.core.state).toBe('paused');
    // Play again: beat 0 lands 60 ms from now.
    const at = r.frame / sr + 0.06;
    r.send({ t: 'transport', playing: true, beatTime: at, beat: 0, spb: 0.5 });
    expect(r.core.cueFrame).toBe(Math.round(at * sr));
    r.runTo(Math.round(at * sr) + 4096, () => 0, false);
    expect(r.core.state).toBe('play');
    expect(r.core.pos).toBe(r.frame - Math.round(at * sr));
  });

  it('a tempo update while playing does not restart the loop', () => {
    const r = rig();
    r.send({ t: 'transport', playing: true, beatTime: 0, beat: 0, spb: 0.5 });
    r.send({ t: 'bars', v: 1 });
    r.send({ t: 'main' });
    r.runTo(96000 + 5000, () => 0.1, false);
    const pos = r.core.pos;
    r.send({ t: 'transport', playing: true, beatTime: 2, beat: 4, spb: 0.4 });
    expect(r.core.cueFrame).toBe(-1);
    r.run(128, () => 0, false);
    expect(r.core.pos).toBe(pos + 128);
  });

  it('stopping the transport during a bar-locked recording keeps the whole bars', () => {
    const r = rig();
    r.send({ t: 'transport', playing: true, beatTime: 0, beat: 0, spb: 0.5 });
    r.send({ t: 'bars', v: 4 });
    r.send({ t: 'main' });
    r.run(96000 + 30000, ramp, false);
    r.send({ t: 'transport', playing: false, beatTime: 0, beat: 0, spb: 0.5 });
    expect(r.core.state).toBe('paused');
    expect(r.core.len).toBe(96000);
  });
});

describe('looper: no self-feedback', () => {
  it('a graph that taps the bus before the loop is mixed back never re-records the loop', () => {
    // master = synth + loopOut; looper input = synth (the tap is upstream of the return).
    const r = rig();
    const synth = (f) => (f < 48000 ? 0.4 * Math.sin(f / 30) : 0);
    r.send({ t: 'main' });
    r.run(24000, synth, false);
    r.send({ t: 'main' });
    const before = Float32Array.from(loop(r.core).L);
    // Overdub for 4 passes while the master (synth + loop) is loud: the loop must not grow.
    r.send({ t: 'main' });
    r.runTo(48000 + r.core.len * 4, synth, false);
    const after = loop(r.core).L;
    let worst = 0;
    // Compare away from the stretch where the synth itself was still playing into the overdub.
    const tail = r.core.len;
    for (let i = 0; i < tail; i++) worst = Math.max(worst, Math.abs(after[i]) - Math.abs(before[i]) - 0.4);
    expect(worst).toBeLessThanOrEqual(1e-6);
    // And with a feedback-style miswiring (input = synth + loop out) it would grow: guard the topology in engine tests.
  });
});

describe('looper: capture for Resample', () => {
  it('captures N bars of the raw input from the next bar line, untouched', () => {
    const sr = 48000;
    const r = rig(sr);
    r.send({ t: 'transport', playing: true, beatTime: 0, beat: 0, spb: 0.5 });
    r.run(30000, ramp, false);
    r.send({ t: 'capture', id: 7, bars: 1 });
    r.runTo(96000 + 96000 + 256, ramp, false);
    const m = r.msgs.find(x => x.t === 'captured' && x.id === 7);
    expect(m).toBeTruthy();
    expect(m.frames).toBe(96000);
    expect(m.L[0]).toBe(Math.fround(ramp(96000)));
    expect(m.R[95999]).toBe(Math.fround(ramp(96000 + 95999)));
    expect(r.core.state).toBe('empty');
  });

  it('get returns a copy of the loop', () => {
    const r = rig();
    r.send({ t: 'main' }); r.run(24000, ramp, false); r.send({ t: 'main' });
    r.send({ t: 'get', id: 3 });
    const m = r.msgs.find(x => x.t === 'loop' && x.id === 3);
    expect(m.len).toBe(r.core.len);
    expect(m.L).not.toBe(r.core.L);
    expect(m.L[10]).toBe(r.core.L[10]);
  });
});
