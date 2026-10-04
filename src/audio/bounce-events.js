// Fallback event list for engine.bounce() when the caller passes none.
//
// The real source is music.renderEvents(), which replays the live sequencer
// and arpeggiator offline. This is a small stand-in so a bounce still works
// without the music module (tests, the audio harness): it reads the step
// sequencers from the session state and produces the same message shapes:
//   { time, msg: {t:'transport', playing: true, beatTime: 0, beat: 0, spb} }
//   { time, msg: {t:'noteOn', part, note, vel} } / { time, msg: {t:'noteOff', part, note} }
//   { time, msg: {t:'params', part, p: {centerX, centerY}, ramp} }   dot locks
//   { time, msg: {t:'params', part, p: {cutoff, ...}} }               v2.9 parameter locks
// v2.9 song mode chains are followed (from Play, like the transport).
// Swing, slides, ties, gates, accents, probability (the transport's first
// Play, seed 1) and ratchets follow src/music/transport.js;
// arpeggiators need held keys and are not rendered here.

import { KIT_PADS, KIT_BASE_NOTE } from '../dsp/drum-kit.js';
import { MAX_PARTS, SEQ_RATES, RATCHET_DECAY, PART_PARAM_MAP, stepToMidi, stepPlays, stepRatchet, stepSlice, stepPlocks, activeSeq, activeChain, clamp } from '../core/params.js';

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
    const params = list[p].params || {};
    let tie = null;
    let plocked = null;   // v2.9 parameter ids the previous step locked
    // One step of `pat` (a pattern with `steps`) at grid count `abs`, from t to tNext.
    const playStep = (pat, idx, abs, t, tNext, rate) => {
      const step = pat.steps[idx] || {};
      if (step.lock) {
        push(t, { t: 'params', part: p, p: { centerX: clamp(finite(step.lx, 0.5), 0, 1), centerY: clamp(finite(step.ly, 0.5), 0, 1) },
          ramp: clamp(finite(pat.lockGlide, 0.5), 0, 1) * Math.max(0, tNext - t) });
      }
      // v2.9 parameter locks, and the track's own value back where a lock ends
      if (plocked || step.plocks) {
        const want = stepPlocks(step);
        const vals = {};
        let any = false;
        if (plocked) for (const id of plocked) if (!want || !(id in want)) { vals[id] = finite(params[id], PART_PARAM_MAP[id].default); any = true; }
        if (want) for (const id of Object.keys(want)) { vals[id] = want[id]; any = true; }
        plocked = want ? Object.keys(want) : null;
        if (any) push(t, { t: 'params', part: p, p: vals });
      }
      // v2.7 a drum kit track plays its lanes instead of its melodic steps
      if (list[p].drum && list[p].drum.on) {
        const lanes = Array.isArray(pat.drumLanes) ? pat.drumLanes : [];
        for (let r = 0; r < KIT_PADS; r++) {
          const v = finite(lanes[r] && lanes[r][idx], 0);
          if (v > 0) { push(t, { t: 'noteOn', part: p, note: KIT_BASE_NOTE + r, vel: clamp(v, 0.01, 1) }); push(t + 0.05, { t: 'noteOff', part: p, note: KIT_BASE_NOTE + r }); }
        }
        return;
      }
      if (!step.on || !stepPlays(step, PROB_SEED, p, abs)) {
        if (tie !== null) { push(t, { t: 'noteOff', part: p, note: tie }); tie = null; }
        return;
      }
      const note = clamp(stepToMidi(step, finite(pat.baseOctave, 3), finite(g.scaleRoot, 0), finite(g.scaleType, 0)), 0, 127);
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
        const slice = stepSlice(step);
        const on = { t: 'noteOn', part: p, note, vel: clamp(vel * RATCHET_DECAY ** i, 0.01, 1) };
        if (slice != null) on.slice = slice;
        push(ti, on);
        if (tie !== null) { push(ti + SLIDE_OVERLAP, { t: 'noteOff', part: p, note: tie }); tie = null; }
        if (slide) tie = note;
        else push(gateEnd, { t: 'noteOff', part: p, note });
      }
    };
    const rateOf = (pat) => clamp(Math.round(finite(pat.rate, 3)), 0, SEQ_RATES.length - 1);
    const timeAt = (beat, rateIdx) => (/T$/.test(SEQ_RATES[rateIdx].name) ? beat : swingBeat(beat, g.swing)) * spb;
    const chain = activeChain(list[p]);
    if (!chain) {
      const rateIdx = rateOf(seq);
      const rate = SEQ_RATES[rateIdx].beats;
      const len = clamp(Math.round(finite(seq.length, 16)), 1, seq.steps.length || 16);
      for (let abs = 0; abs * rate < totalBeats - 1e-9; abs++) {
        playStep(seq, abs % len, abs, timeAt(abs * rate, rateIdx), timeAt((abs + 1) * rate, rateIdx), rate);
      }
    } else {
      // v2.9 song mode, as the transport plays it from Play: each entry's
      // pattern `repeats` passes, in order, looping; a new rate continues
      // from the same musical position.
      const pats = list[p].patterns;
      let rateIdx = rateOf(seq), abs = 0, e = 0, rep = 0, pos = 0;
      for (let guard = 0; guard < 100000; guard++) {
        if (pos >= clamp(Math.round(finite(pats[chain[e].pattern].length, 16)), 1, 16)) {
          pos = 0;
          if (++rep >= chain[e].repeats) { rep = 0; e = (e + 1) % chain.length; }
        }
        const pat = pats[chain[e].pattern];
        if (!Array.isArray(pat.steps)) break;
        const ri = rateOf(pat);
        if (ri !== rateIdx) { abs = Math.ceil(abs * SEQ_RATES[rateIdx].beats / SEQ_RATES[ri].beats - 1e-9); rateIdx = ri; }
        const rate = SEQ_RATES[rateIdx].beats;
        if (abs * rate >= totalBeats - 1e-9) break;
        playStep(pat, pos, abs, timeAt(abs * rate, rateIdx), timeAt((abs + 1) * rate, rateIdx), rate);
        pos++;
        abs++;
      }
    }
    if (tie !== null) push(end, { t: 'noteOff', part: p, note: tie });
  }
  out.sort((a, b) => a.time - b.time || (a.order ?? -1) - (b.order ?? -1));
  return out.map(({ time, msg }) => ({ time, msg }));
}
