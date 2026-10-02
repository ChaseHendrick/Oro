// A stand-in for the music module (src/music) for the 3D map harness: just
// the transport parts the visuals use. play() runs a 16-step grid at the
// session tempo and emits 'step' events ({ part, step, time, lock }) for every
// part whose sequencer is on, with the lock spot when the step carries one;
// beatAt() / timebase give the beat for Tour sync; exploreNote() logs.

import { NUM_PARTS, SEQ_RATES } from '../../src/core/params.js';

export function createFakeMusic({ store }) {
  const listeners = new Map();
  let playing = false, t0 = 0, timer = 0;
  const lastStep = new Array(NUM_PARTS).fill(-1);
  const notes = [];

  const on = (type, fn) => {
    if (!listeners.has(type)) listeners.set(type, new Set());
    listeners.get(type).add(fn);
    return () => listeners.get(type)?.delete(fn);
  };
  const emit = (type, ev) => { for (const fn of [...(listeners.get(type) || [])]) fn(ev); };
  const tempo = () => Number(store.get('global.tempo')) || 120;
  const now = () => performance.now() / 1000;
  const beat = () => (playing ? ((now() - t0) * tempo()) / 60 : 0);

  function tick() {
    const b = beat();
    for (let p = 0; p < NUM_PARTS; p++) {
      const seq = store.get(`parts.${p}.seq`);
      if (!seq || !seq.enabled) continue;
      const rate = (SEQ_RATES[seq.rate] || SEQ_RATES[3]).beats;
      const abs = Math.floor(b / rate);
      if (abs === lastStep[p]) continue;
      lastStep[p] = abs;
      const i = abs % (seq.length || 16);
      const st = seq.steps[i];
      const lock = st && st.lock ? { x: st.lx, y: st.ly } : null;
      emit('step', { part: p, step: i, time: now(), lock });
      if (lock) {
        store.set(`parts.${p}.params.centerX`, lock.x, { source: 'lock' });
        store.set(`parts.${p}.params.centerY`, lock.y, { source: 'lock' });
      }
    }
  }

  const transport = {
    on,
    off: (type, fn) => listeners.get(type)?.delete(fn),
    isPlaying: () => playing,
    beatAt: () => beat(),
    tempo,
    play() { if (playing) return; playing = true; t0 = now(); lastStep.fill(-1); timer = setInterval(tick, 10); tick(); },
    stop() { playing = false; clearInterval(timer); },
    toggle() { if (playing) transport.stop(); else transport.play(); },
  };

  return {
    transport,
    timebase: { perfNow: () => performance.now(), perfToAudio: (ms) => ms / 1000 },
    notes,
    exploreNote(ev) { notes.push(ev); if (notes.length > 200) notes.shift(); },
  };
}
