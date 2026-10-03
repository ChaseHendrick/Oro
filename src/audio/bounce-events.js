// Fallback event list for engine.bounce() when the caller passes none.
//
// The real source is music.renderEvents(), which replays the live sequencer
// and arpeggiator offline. This is a small stand-in so a bounce still works
// without the music module (tests, the audio harness): it reads the step
// sequencers from the session state and produces the same message shapes:
//   { time, msg: {t:'transport', playing: true, beatTime: 0, beat: 0, spb} }
//   { time, msg: {t:'noteOn', part, note, vel} } / { time, msg: {t:'noteOff', part, note} }
//   { time, msg: {t:'params', part, p: {centerX, centerY}, ramp} }   dot locks
// Swing, slides, ties, gates, accents, probability (the transport's first
// Play, seed 1) and ratchets follow src/music/transport.js;
// arpeggiators need held keys and are not rendered here.

import { MAX_PARTS, SEQ_RATES, RATCHET_DECAY, stepToMidi, stepPlays, stepRatchet, activeSeq, clamp } from '../core/params.js';

const MIN_GAP = 0.003;        // between a note-off and the next note-on (as the router)
const SLIDE_OVERLAP = 0.004;  // a slid note overlaps the next one (legato)

const PROB_SEED = 1;         // the transport's seed on its first Play

const finite = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

/** The transport's swing time-warp within each eighth note (see src/music/transport.js). */
export function swingBeat(beat, swing) {
  const d = (clamp(finite(swing, 0), 0, 0.6) / 0.6) * 0.125;
  if (d <= 0) return beat;
  const e = Math.floor(beat * 2 + 1e-9) / 2;
  const f = Math.max(0, beat - e);
  return f <= 0.25 ? e + f * (0.25 + d) / 0.25 : e + 0.25 + d + (f - 0.25) * (0.25 - d) / 0.25;
}

/**
 * @param {{global: object, parts: object[]}} state a session (store.serialize())
 * @param {number} bars
 * @param {{parts?: number[]}} [o]
 * @returns {{time: number, msg: object}[]} sorted by time, beat 0 at time 0
 */
export function sequencerEvents(state, bars = 4, { parts } = {}) {
  const g = (state && state.global) || {};
  const tempo = clamp(finite(g.tempo, 112), 20, 400);
  const spb = 60 / tempo;
  const totalBeats = clamp(Math.round(finite(bars, 4)), 1, 512) * 4;
  const end = totalBeats * spb;
  const list = (state && Array.isArray(state.parts) ? state.parts : []).slice(0, MAX_PARTS);
  const include = new Set(Array.isArray(parts) ? parts : list.map((_, i) => i));
  const out = [{ time: 0, msg: { t: 'transport', playing: true, beatTime: 0, beat: 0, spb } }];
  let order = 0;
  const push = (time, msg) => out.push({ time: Math.max(0, Math.min(end, time)), msg, order: order++ });

  for (let p = 0; p < list.length; p++) {
    // the pattern each track plays (its activePattern), on when its seqOn is
    const seq = activeSeq(list[p]);
    if (!include.has(p) || !seq || !seq.enabled || !Array.isArray(seq.steps)) continue;
    const rateIdx = clamp(Math.round(finite(seq.rate, 3)), 0, SEQ_RATES.length - 1);
    const rate = SEQ_RATES[rateIdx].beats;
    const triplet = /T$/.test(SEQ_RATES[rateIdx].name);
    const len = clamp(Math.round(finite(seq.length, 16)), 1, seq.steps.length || 16);
    const timeAt = (beat) => (triplet ? beat : swingBeat(beat, g.swing)) * spb;
    let tie = null;
    for (let abs = 0; abs * rate < totalBeats - 1e-9; abs++) {
      const t = timeAt(abs * rate);
      const tNext = timeAt((abs + 1) * rate);
      const step = seq.steps[abs % len] || {};
      if (step.lock) {
        push(t, { t: 'params', part: p, p: { centerX: clamp(finite(step.lx, 0.5), 0, 1), centerY: clamp(finite(step.ly, 0.5), 0, 1) },
          ramp: clamp(finite(seq.lockGlide, 0.5), 0, 1) * Math.max(0, tNext - t) });
      }
      if (!step.on || !stepPlays(step, PROB_SEED, p, abs)) {
        if (tie !== null) { push(t, { t: 'noteOff', part: p, note: tie }); tie = null; }
        continue;
      }
      const note = clamp(stepToMidi(step, finite(seq.baseOctave, 3), finite(g.scaleRoot, 0), finite(g.scaleType, 0)), 0, 127);
      const vel = step.accent ? 1 : clamp(finite(step.vel, 0.8), 0.01, 1);
      const gateSec = clamp(finite(step.gate, 0.5), 0.05, 1) * rate * spb;
      const hits = stepRatchet(step);
      for (let i = 0; i < hits; i++) {
        const ti = hits === 1 ? t : t + (tNext - t) * i / hits;
        const tiNext = i + 1 === hits ? tNext : t + (tNext - t) * (i + 1) / hits;
        const minLen = hits === 1 ? 0.01 : Math.min(0.01, (tiNext - ti) / 2);
        const slide = i + 1 === hits && step.slide;
        const gateEnd = Math.max(ti + minLen, Math.min(ti + gateSec / hits, tiNext - MIN_GAP));
        if (tie === note) {
          if (!slide) { push(gateEnd, { t: 'noteOff', part: p, note }); tie = null; }
          continue;
        }
        push(ti, { t: 'noteOn', part: p, note, vel: clamp(vel * RATCHET_DECAY ** i, 0.01, 1) });
        if (tie !== null) { push(ti + SLIDE_OVERLAP, { t: 'noteOff', part: p, note: tie }); tie = null; }
        if (slide) tie = note;
        else push(gateEnd, { t: 'noteOff', part: p, note });
      }
    }
    if (tie !== null) push(end, { t: 'noteOff', part: p, note: tie });
  }
  out.sort((a, b) => a.time - b.time || (a.order ?? -1) - (b.order ?? -1));
  return out.map(({ time, msg }) => ({ time, msg }));
}
