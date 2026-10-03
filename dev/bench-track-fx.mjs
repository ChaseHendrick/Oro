// Repeatable pure-DSP benchmark. This excludes voices, visual rendering and
// device I/O; measured deadlines are evidence for this machine, not a promise
// about audio hardware. Run: node dev/bench-track-fx.mjs
import { TrackEffects, defaultFxSlot } from '../src/dsp/track-effects.js';
const sampleRate = 48000, blockSize = 128;
const scenarios = [
  ['Bypass', ['bypass', 'bypass', 'bypass', 'bypass']],
  ['Space and pitch', ['reverb', 'shimmer', 'granular', 'phaser']],
  ['Dynamics', ['ott', 'duck', 'compressor', 'limiter']],
  ['Modulation and colour', ['chorus', 'flanger', 'overdrive', 'eq4']],
];
const results = [];
for (const [name, types] of scenarios) for (const tracks of [1, 4, 16]) {
  const racks = Array.from({ length: tracks }, () => {
    const fx = new TrackEffects(sampleRate);
    fx.configure({ routing: 0, slots: types.map(type => ({ ...defaultFxSlot(type), mix: type === 'bypass' ? 0 : .5 })) });
    return fx;
  });
  let frame = 0;
  const block = () => {
    for (let i = 0; i < blockSize; i++, frame++) {
      const L = .12 * Math.sin(frame * .057) + .03 * Math.sin(frame * .33), R = .1 * Math.sin(frame * .07);
      for (const fx of racks) fx.processSample(L, R, .4);
    }
  };
  for (let i = 0; i < 375; i++) block(); // one second of JIT warm-up
  const times = [], start = performance.now();
  for (let i = 0; i < 375; i++) { const t = performance.now(); block(); times.push(performance.now() - t); }
  const elapsed = performance.now() - start; times.sort((a, b) => a - b);
  const percentile = q => Number(times[Math.floor((times.length - 1) * q)].toFixed(3));
  results.push({ name, tracks, activeSlots: types.filter(t => t !== 'bypass').length * tracks, cpuMsPerAudioSecond: Number(elapsed.toFixed(1)), blockMedianMs: percentile(.5), blockP99Ms: percentile(.99), blockMaxMs: percentile(1), deadlineMs: Number((blockSize / sampleRate * 1000).toFixed(3)) });
}
console.log(JSON.stringify({ sampleRate, blockSize, node: process.version, platform: process.platform, arch: process.arch, results }, null, 2));
