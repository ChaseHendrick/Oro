// The styles compose() writes (score.js). Each one is a small arranger: it
// knows a form, a chord progression and what each section of the orchestra
// plays, and writes a text score. Nothing here calls a model, and the same
// prompt and seed always write the same score.
//
//   orchestra-type  driving strings, brass stabs, choir, timpani, kit
//   strings / brass-choir / sparse / atlas / opening   (2.16, upgraded)
//   anime-song      a TV-size anime opening: intro hook, verse, pre-chorus
//                   build with a riser and snare roll, a royal-road chorus,
//                   a kime break, the last chorus a semitone up, end hits
//   epic            hybrid trailer: taiko and spiccato ostinato, low brass
//                   braams, choir, risers and impacts
//   symphonic       a full orchestra in a classical layout
//   lullaby         celesta, harp and soft strings in 3/4

const SHARP = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const FLAT = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];
const FLAT_KEYS = new Set(['F', 'Bb', 'Eb', 'Ab', 'Db', 'Gb', 'Cb']);
const LETTER = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const MAJ = [0, 2, 4, 5, 7, 9, 11];
const MIN = [0, 2, 3, 5, 7, 8, 10];
const QUAL = {
  maj: [0, 4, 7], m: [0, 3, 7], dim: [0, 3, 6], maj7: [0, 4, 7, 11], 7: [0, 4, 7, 10], m7: [0, 3, 7, 10],
  sus4: [0, 5, 7], add9: [0, 4, 7, 14], 5: [0, 7],
};
const DIATONIC = ['maj', 'm', 'm', 'maj', 'maj', 'm', 'dim'];

export const STYLES = Object.freeze({
  'orchestra-type': { bpm: 156, bars: 4, about: 'Strings in 8ths, brass stabs, a choir pad, timpani, hats on 16ths, kick and low strings' },
  strings: { bpm: 112, bars: 4, about: 'A string section with voice leading, no drums' },
  'brass-choir': { bpm: 96, bars: 4, about: 'Horns, trumpets, trombones, tuba and choir' },
  sparse: { bpm: 84, bars: 4, about: 'Long tones, little rhythm' },
  atlas: { bpm: 108, bars: 4, about: 'One gesture from every synthesis family' },
  opening: { bpm: 180, bars: 8, about: 'Cold flash, three name-card stabs, eight hits, a title hold. Cues: cold, card-1, card-2, card-3, hits, title' },
  'anime-song': { bpm: 176, bars: 36, key: 'D', mode: 'minor', voicing: 'patch',
    about: 'A TV-size anime opening: intro hook, verse, pre-chorus build, royal-road chorus, kime break, last chorus a semitone up, end hits. Cues name each section' },
  epic: { bpm: 132, bars: 16, key: 'D', mode: 'minor', voicing: 'patch', about: 'Hybrid trailer: taiko and spiccato ostinato, low brass braams, choir, risers and impacts' },
  symphonic: { bpm: 104, bars: 16, key: 'D', mode: 'major', voicing: 'patch', about: 'Full orchestra: violins and flute on the tune, winds and horns inside, low strings, timpani and harp' },
  lullaby: { bpm: 72, bars: 8, key: 'F', mode: 'major', voicing: 'patch', about: 'Celesta tune, harp and soft strings in 3/4' },
  drums: { bpm: 112, bars: 16, voicing: 'patch',
    about: 'A drum piece: intro, groove, a B groove with more pieces, a break, the groove again and an ending, with fills. Name a groove: rock, funk, hiphop, trap, house, techno, disco, dnb, breakbeat, halftime, metal, shuffle, jazz, bossa, samba, reggaeton, afrobeat, latin, march, taiko; "solo" adds a drum solo' },
  ambient: { bpm: 70, bars: 16, key: 'D', mode: 'major', voicing: 'patch', about: 'A soundscape: rain, ocean, wind, city, fire or vinyl, a drone, slow pads, sparse piano and bells; birds for a forest, thunder for a storm' },
  lofi: { bpm: 82, bars: 8, key: 'F', mode: 'major', voicing: 'patch', about: 'Lo-fi: vinyl, swung boom-bap, Rhodes sevenths, bass and a few vibes notes; add rain' },
});

// ------------------------------------------------------------------ helpers

function mulberry32(a) {
  let s = a >>> 0;
  return () => {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const r3 = (n) => Math.round(n * 1000) / 1000;
const pcOfKey = (key) => (LETTER[key[0]] + (key[1] === '#' ? 1 : key[1] === 'b' ? -1 : 0) + 12) % 12;
const midiOf = (pc, oct) => (oct + 1) * 12 + (((pc % 12) + 12) % 12);
/** The lowest MIDI note of pitch class pc at or above lo. */
const atOrAbove = (pc, lo) => lo + ((((pc - lo) % 12) + 12) % 12);

function writer(o) {
  const beats = o.beats || 4;
  const end = o.bars * beats;
  const flats = FLAT_KEYS.has(o.key);
  const lines = [];
  const cues = [];
  const spell = (m) => (flats ? FLAT : SHARP)[((m % 12) + 12) % 12] + (Math.floor(m / 12) - 1);
  const ok = (beat) => beat >= 0 && beat < end - 1e-6;
  const fit = (beat, len) => Math.max(0.03, Math.min(len, end - beat - 0.002));
  const vol = (v) => Math.max(0.05, Math.min(1, v));
  return {
    end, beats,
    note(voice, midi, beat, len, vel, pan) {
      if (!ok(beat) || !(midi >= 0 && midi <= 127)) return;
      lines.push(`${voice} ${spell(Math.round(midi))} ${r3(beat)} ${r3(fit(beat, len))} ${r3(vol(vel))}${pan != null ? ` ${pan}` : ''}`);
    },
    chord(voice, midis, beat, len, vel) { for (const m of midis) this.note(voice, m, beat, len, vel); },
    hit(voice, beat, len, vel) {
      if (!ok(beat)) return;
      lines.push(`${voice} x ${r3(beat)} ${r3(fit(beat, len))} ${r3(vol(vel))}`);
    },
    tom(midi, beat, len, vel) {
      if (!ok(beat)) return;
      lines.push(`tom ${spell(midi)} ${r3(beat)} ${r3(fit(beat, len))} ${r3(vol(vel))}`);
    },
    cue(name, beat) { if (beat >= 0 && beat <= end && !cues.some((c) => c.name === name)) cues.push({ name, beat }); },
    text(head) {
      const out = [
        `title ${head.title}`, `bpm ${head.bpm}`, `bars ${head.bars}`, `beats ${beats}`, `key ${head.key}`, `mode ${head.mode}`,
      ];
      if (head.style) out.push(`style ${head.style}`);
      if (head.swing) out.push(`swing ${head.swing}`);
      if (head.voicing) out.push(`voicing ${head.voicing}`);
      out.push('');
      for (const c of cues) out.push(`cue ${c.name} ${r3(c.beat)}`);
      if (cues.length) out.push('');
      return out.concat(lines).join('\n') + '\n';
    },
  };
}

/**
 * Harmony in a key. Progressions are written in degrees of the major key
 * whose notes the piece uses (a minor piece uses its relative major, so its
 * tonic is degree 6). degree may carry a quality: [4, 'maj7'].
 */
function harmony(key, mode) {
  const tonic = pcOfKey(key);
  const R = mode === 'minor' ? (tonic + 3) % 12 : tonic;
  const scale = MAJ.map((s) => (R + s) % 12);
  return {
    R, tonic, scale,
    home: mode === 'minor' ? 6 : 1,
    chord(deg, q, shift = 0) {
      const d = ((deg - 1) % 7 + 7) % 7;
      const quality = q || DIATONIC[d];
      const root = (R + MAJ[d] + shift + 120) % 12;
      return { root, quality, ivs: QUAL[quality] || QUAL.maj, pcs: (QUAL[quality] || QUAL.maj).map((i) => (root + i) % 12) };
    },
    inScale(pc, shift = 0) { return scale.includes(((pc - shift) % 12 + 12) % 12); },
  };
}

/** Close-position voicing of `ch` in [lo, hi] nearest to `prev` (voice leading). */
function voiceLead(ch, lo, hi, prev) {
  const ivs = ch.ivs.filter((i) => i < 12);
  let best = null, bestCost = Infinity;
  for (let inv = 0; inv < ivs.length; inv++) {
    const order = ivs.slice(inv).concat(ivs.slice(0, inv).map((i) => i + 12));
    for (let base = atOrAbove((ch.root + order[0]) % 12, lo); base + (order[order.length - 1] - order[0]) <= hi; base += 12) {
      const cand = order.map((i) => base + i - order[0]);
      const cost = prev && prev.length
        ? cand.reduce((a, m, i) => a + Math.abs(m - prev[Math.min(i, prev.length - 1)]), 0)
        : Math.abs(cand[0] - (lo + hi) / 2);
      if (cost < bestCost) { best = cand; bestCost = cost; }
    }
  }
  return best || ivs.map((i) => atOrAbove((ch.root + i) % 12, lo));
}

/** A bass note for chord root pc in [lo, lo + 11]. */
const bassOf = (pc, lo = 28) => atOrAbove(pc, lo);

// ------------------------------------------------------------------ melody

const VERSE_RHYTHMS = [
  [0.5, 1, 1.5, 2.5, 3, 4.5, 5, 5.5, 6, 6.5],
  [0, 0.5, 1, 2, 2.5, 3.5, 4, 4.5, 5, 6],
  [0.5, 1.5, 2, 2.5, 3, 4.5, 5.5, 6, 7],
];
const CHORUS_RHYTHMS = [
  [0, 1, 1.5, 2.5, 4, 5, 5.5, 6.5],
  [0, 0.5, 1.5, 2, 3, 4, 4.5, 5.5, 6],
  [0, 1.5, 2, 3, 3.5, 4, 5.5, 6],
];

/**
 * A two-bar phrase over chords chordAt(beat): strong beats land on chord
 * tones nearest the line so far, the rest step along the scale towards the
 * phrase's goal (up in the first half, down after). Returns [{beat, len, midi}].
 */
function phrase({ rng, rhythm, start, lo, hi, chordAt, scaleAt, prev, peak = false, span = 8 }) {
  const out = [];
  let last = prev != null ? prev : Math.round((lo + hi) / 2);
  rhythm.forEach((t, i) => {
    const beat = start + t;
    const next = i + 1 < rhythm.length ? rhythm[i + 1] : span;
    const len = Math.max(0.2, Math.min(i + 1 < rhythm.length ? next - t - 0.04 : span - t - 0.4, 2.5));
    const ch = chordAt(beat);
    const scale = scaleAt(beat);
    const up = t < span / 2 ? 1 : -1;
    const strong = Math.abs(t - Math.round(t)) < 1e-9 || i === 0;
    let target;
    if (strong) {
      // nearest chord tone in the direction of the phrase, sometimes a leap
      const leap = peak && i === 0 ? 7 : rng() < 0.2 ? 4 : 0;
      const aim = last + up * leap;
      target = nearestPc(ch.pcs, aim, lo, hi);
    } else {
      const step = rng() < 0.75 ? 1 : 2;
      target = stepScale(scale, last, up * step, lo, hi);
    }
    last = target;
    out.push({ beat, len, midi: target });
  });
  return out;
}

function nearestPc(pcs, aim, lo, hi) {
  let best = aim, d = Infinity;
  for (let m = lo; m <= hi; m++) {
    if (!pcs.includes(m % 12)) continue;
    const dd = Math.abs(m - aim);
    if (dd < d) { d = dd; best = m; }
  }
  return best;
}

function stepScale(scale, from, steps, lo, hi) {
  let m = from;
  const dir = steps > 0 ? 1 : -1;
  let n = Math.abs(steps);
  let guard = 0;
  while (n > 0 && guard++ < 48) {
    m += dir;
    if (m > hi) { m = hi; break; }
    if (m < lo) { m = lo; break; }
    if (scale.includes(((m % 12) + 12) % 12)) n -= 1;
  }
  return m;
}

// ------------------------------------------------------------------ styles

/** Write a score. Returns { text, warnings }. */
export function writeStyle(style, o) {
  const rng = mulberry32((o.seed >>> 0) || 1);
  const head = { title: o.title || titleOf(style), bpm: o.bpm, bars: o.bars, key: o.key, mode: o.mode, style, voicing: o.voicing || '' };
  const fn = {
    opening: fillOpening, strings: fillStrings, 'brass-choir': fillBrass, sparse: fillSparse, atlas: fillAtlas,
    'anime-song': fillAnime, epic: fillEpic, symphonic: fillSymphonic, lullaby: fillLullaby,
    drums: fillDrums, ambient: fillAmbient, lofi: fillLofi,
  }[style] || fillOrchestra;
  if (style === 'lullaby') head.beats = 3;
  const w = writer({ ...o, beats: head.beats || 4 });
  const warnings = [];
  const r = fn(o, w, rng, warnings) || {};
  if (r.bars) head.bars = r.bars;
  if (w.swing) head.swing = w.swing;
  return { text: w.text(head), warnings };
}

function titleOf(style) {
  return { opening: 'Opening', 'anime-song': 'Opening Theme', epic: 'Epic', symphonic: 'Symphony', lullaby: 'Lullaby' }[style] || style;
}

function fillOpening(o, w) {
  const H = harmony(o.key, o.mode);
  const t = H.tonic;
  const end = w.end;
  let cards = [], hits = null, title = null;
  if (o.bars >= 8) { cards = [4, 8, 12]; hits = 16; title = 24; } else if (o.bars >= 4) { cards = [2, 4, 6]; hits = 8; title = 12; }
  const third = o.mode === 'minor' ? 3 : 4;
  const triad = (oct) => [midiOf(t, oct), midiOf(t, oct) + third, midiOf(t, oct) + 7];
  w.cue('cold', 0);
  w.note('violin', midiOf(t, 5), 0, 0.25, 0.9);
  w.hit('rim', 0, 0.1, 0.7);
  w.hit('crash', 0, 1, 0.55);
  cards.forEach((beat, i) => {
    if (beat >= end) return;
    w.cue(`card-${i + 1}`, beat);
    w.chord('trumpet', triad(4), beat, 0.45, 0.88);
    w.chord('brass', [midiOf(t, 3), midiOf(t, 3) + 7], beat, 0.6, 0.8);
    w.note('timpani', bassOf(t, 38), beat, 0.8, 0.95);
    w.hit('kick', beat, 0.15, 1);
    w.hit('crash', beat, 1.2, 0.6);
  });
  if (hits != null && hits + 4 <= end) {
    w.cue('hits', hits);
    for (let i = 0; i < 8; i++) {
      const beat = hits + i * 0.5;
      w.hit('kick', beat, 0.12, i % 2 === 0 ? 1 : 0.75);
      if (i % 2 === 1) w.hit('snare', beat, 0.12, 0.85);
      w.note('trumpet', midiOf(t, 4), beat, 0.2, 0.7);
      w.note('spiccato', midiOf(t, 4) + (i % 2 ? 7 : 0), beat, 0.2, 0.7);
      w.note('spiccato', midiOf(t, 4) + (i % 2 ? 12 : 7), beat + 0.25, 0.2, 0.6);
    }
    if (title != null) w.note('riser', midiOf(t, 4), Math.max(hits + 4, title - 4), 4, 0.55);
  }
  if (title != null && title < end) {
    w.cue('title', title);
    const len = end - title - 0.05;
    w.chord('choir', triad(4), title, len, 0.6);
    w.chord('strings', triad(4), title, len, 0.5);
    w.note('violin', midiOf(t, 5), title, len, 0.55);
    w.note('contrabass', bassOf(t, 28), title, len, 0.7);
    w.note('timpani', bassOf(t, 38), title, 1.5, 1);
    w.note('impact', midiOf(t, 2), title, 4, 0.9);
    w.hit('crash', title, 2, 0.75);
  }
}

function fillOrchestra(o, w) {
  const H = harmony(o.key, o.mode);
  const t = H.tonic;
  const scale = (o.mode === 'minor' ? MIN : MAJ).map((s) => (t + s) % 12);
  const prog = o.mode === 'minor' ? [6, 4, 1, 5] : [1, 6, 4, 5];
  let prevStr = null, prevBrass = null;
  for (let bar = 0; bar < o.bars; bar++) {
    const b = bar * 4;
    const ch = H.chord(prog[bar % prog.length]);
    w.hit('kick', b, 0.15, 1);
    w.hit('kick', b + 2, 0.15, 0.9);
    w.hit('snare', b + 2, 0.12, 0.8);
    for (let s = 0; s < 16; s++) w.hit('hat', b + s * 0.25, 0.06, s % 4 === 0 ? 0.42 : 0.3);
    if (bar % 4 === 0) w.hit('crash', b, 1.5, 0.55);
    w.note('timpani', bassOf(ch.root, 38), b, 0.6, 0.85);
    for (let s = 0; s < 8; s++) {
      const deg = (bar * 2 + s) % scale.length;
      w.note('violin', midiOf(t, 5) + ((scale[deg] - t + 12) % 12), b + s * 0.5, 0.42, s % 2 ? 0.55 : 0.68);
    }
    prevStr = voiceLead(ch, 55, 72, prevStr);
    for (let s = 0; s < 8; s++) w.note('viola', prevStr[s % prevStr.length], b + s * 0.5, 0.4, 0.5);
    w.note('cello', bassOf(ch.root, 40), b, 1.8, 0.7);
    w.note('cello', bassOf(ch.root, 40), b + 2, 1.8, 0.62);
    w.note('contrabass', bassOf(ch.root, 28), b, 3.8, 0.7);
    prevBrass = voiceLead(ch, 53, 67, prevBrass);
    w.chord('horn', prevBrass, b, 3.6, 0.5);
    w.chord('trumpet', voiceLead(ch, 62, 74, null), b, 0.4, 0.62);
    w.chord('trumpet', voiceLead(ch, 62, 74, null), b + 2.5, 0.4, 0.55);
    w.note('trombone', bassOf(ch.root, 40), b, 0.45, 0.6);
    if (bar % 2 === 0) w.chord('choir', voiceLead(ch, 57, 72, null), b, 7.5, 0.4);
  }
}

function fillStrings(o, w) {
  const H = harmony(o.key, o.mode);
  const prog = o.mode === 'minor' ? [6, 4, 1, 5] : [1, 6, 4, 5];
  let vln = null, vla = null;
  for (let bar = 0; bar < o.bars; bar++) {
    const b = bar * 4;
    const ch = H.chord(prog[bar % prog.length]);
    vln = voiceLead(ch, 67, 84, vln);
    vla = voiceLead(ch, 55, 69, vla);
    w.chord('violin', vln, b, 3.6, 0.55);
    w.chord('viola', vla, b, 3.6, 0.45);
    w.note('cello', bassOf(ch.root, 43), b, 3.6, 0.6);
    w.note('contrabass', bassOf(ch.root, 31), b, 3.6, 0.6);
  }
}

function fillBrass(o, w) {
  const H = harmony(o.key, o.mode);
  const prog = o.mode === 'minor' ? [6, 4, 1, 5] : [1, 4, 6, 5];
  let hn = null;
  for (let bar = 0; bar < o.bars; bar++) {
    const b = bar * 4;
    const ch = H.chord(prog[bar % prog.length]);
    hn = voiceLead(ch, 53, 67, hn);
    w.chord('horn', hn, b, 3.2, 0.55);
    w.chord('trumpet', voiceLead(ch, 62, 74, null), b + (bar % 2) * 2, 1.2, 0.6);
    w.note('trombone', bassOf(ch.root, 40), b, 3.2, 0.6);
    w.note('tuba', bassOf(ch.root, 29), b, 3.2, 0.55);
    w.chord('choir', voiceLead(ch, 57, 72, null), b, 3.6, 0.4);
  }
}

function fillSparse(o, w) {
  const t = pcOfKey(o.key);
  const root = midiOf(t, 4);
  w.note('pad', root, 0, o.bars * 4 - 0.1, 0.45);
  w.note('choir', root + (o.mode === 'minor' ? 3 : 4), 0, o.bars * 4 - 0.1, 0.35);
  w.note('bell', root + 12, o.bars * 2, 2, 0.4);
}

function fillAtlas(o, w) {
  const t = pcOfKey(o.key);
  const third = o.mode === 'minor' ? 3 : 4;
  const b = [0, 4, 8, 12].map((x) => Math.min(x, Math.max(0, o.bars * 4 - 1)));
  w.chord('piano', [midiOf(t, 3), midiOf(t, 3) + third, midiOf(t, 3) + 7], b[0], 3, 0.7);
  w.note('guitar', midiOf(t, 2), b[0], 1.2, 0.65);
  w.note('rhodes', midiOf(t, 4) + 5, b[1], 2, 0.6);
  w.note('organ', midiOf(t, 4), b[1], 2, 0.5);
  w.note('marimba', midiOf(t, 5), b[2], 0.4, 0.7);
  w.note('lead', midiOf(t, 4) + 7, b[2], 1.2, 0.6);
  w.note('sub', midiOf(t, 2), b[2], 2, 0.75);
  w.note('pad', midiOf(t, 4), b[3], 2, 0.4);
  w.note('cloud', midiOf(t, 4) + 3, b[3], 2, 0.35);
  w.note('bell', midiOf(t, 5) + 7, b[3] + 1, 1, 0.5);
  w.note('timpani', bassOf(t, 38), b[0], 1, 0.8);
  w.hit('kick', b[0], 0.15, 1);
  w.hit('hat', b[0] + 0.5, 0.06, 0.3);
  w.hit('crash', b[3], 1, 0.5);
}

// ------------------------------------------------------------- anime song

const ANIME_PLANS = [
  { bars: 8, sections: [['chorus', 8]] },
  { bars: 16, sections: [['intro', 2], ['verse', 4], ['pre', 2], ['chorus', 8]] },
  { bars: 24, sections: [['intro', 4], ['verse', 8], ['pre', 4], ['chorus', 8]] },
  { bars: 36, sections: [['intro', 4], ['verse', 8], ['pre', 4], ['chorus', 8], ['break', 1], ['last', 8], ['outro', 3]] },
  { bars: 53, sections: [['intro', 4], ['verse', 8], ['pre', 4], ['chorus', 8], ['interlude', 4], ['bridge', 4], ['break', 1], ['last', 8], ['last2', 8], ['outro', 4]] },
];

function fillAnime(o, w, rng, warnings) {
  const plan = ANIME_PLANS.filter((p) => p.bars <= Math.max(8, o.bars)).pop();
  if (plan.bars !== o.bars) {
    warnings.push({ line: 0, field: 'bars', message: `The anime song form fits ${plan.bars} bars, so it is ${Math.min(plan.bars, o.bars)} bars long.`, fix: 'Ask for 8, 16, 24, 36 or 53 bars.' });
  }
  const bars = Math.min(plan.bars, o.bars);
  const end = bars * 4;
  const H = harmony(o.key, o.mode);
  const minor = o.mode === 'minor';
  const P = minor
    ? { intro: [6, 4, 5, 6], verse: [6, 4, 5, 3, 6, 4, 5, 5], pre: [2, 3, 4, 5], chorus: [[4, 'maj7'], 5, [3, 'm7'], 6, [4, 'maj7'], 5, [3, 'm7'], 6],
      bridge: [4, 3, 2, 5], outro: [4, 5, 6, 6] }
    : { intro: [1, 5, 6, 4], verse: [1, 5, 6, 3, 4, 1, 2, 5], pre: [4, 5, 3, 6], chorus: [[4, 'maj7'], 5, [3, 'm7'], 6, [4, 'maj7'], 5, 1, 1],
      bridge: [6, 3, 4, 5], outro: [4, 5, 1, 1] };
  // lay the sections out and give every bar its chord and key shift
  const sections = [];
  let bar0 = 0;
  for (const [kind, n] of plan.sections) {
    if (bar0 >= bars) break;
    sections.push({ kind, start: bar0, n: Math.min(n, bars - bar0) });
    bar0 += n;
  }
  const barChord = [];
  for (const s of sections) {
    const shift = s.kind === 'last' || s.kind === 'last2' || (s.kind === 'outro' && sections.some((x) => x.kind === 'last')) ? 1 : 0;
    const prog = s.kind === 'last' || s.kind === 'last2' ? P.chorus : s.kind === 'interlude' ? P.intro : s.kind === 'break' ? [5] : (P[s.kind] || P.intro);
    for (let i = 0; i < s.n; i++) {
      const d = prog[i % prog.length];
      const [deg, q] = Array.isArray(d) ? d : [d, null];
      const ch = s.kind === 'break' ? H.chord(5, '7', shift) : H.chord(deg, q, shift);
      barChord[s.start + i] = { ...ch, shift, kind: s.kind };
    }
  }
  const chordAt = (beat) => barChord[Math.min(barChord.length - 1, Math.max(0, Math.floor(beat / 4)))];
  const scaleAt = (beat) => H.scale.map((pc) => (pc + chordAt(beat).shift) % 12);

  // a chorus hook (two phrases, A and B), reused in the intro and the last chorus
  const hookRhythmA = CHORUS_RHYTHMS[Math.floor(rng() * CHORUS_RHYTHMS.length)];
  const hookRhythmB = CHORUS_RHYTHMS[Math.floor(rng() * CHORUS_RHYTHMS.length)];
  const verseRhythm = VERSE_RHYTHMS[Math.floor(rng() * VERSE_RHYTHMS.length)];

  const melody = (start, n, kind) => {
    let prev = null;
    for (let k = 0; k < n; k += 2) {
      const span = Math.min(8, (n - k) * 4);
      const chorus = kind !== 'verse';
      const rhythm = (chorus ? ((k / 2) % 2 === 0 ? hookRhythmA : hookRhythmB) : verseRhythm).filter((t) => t < span - 0.25);
      const lo = chorus ? 62 : 57, hi = chorus ? 79 : 72;
      const notes = phrase({ rng, rhythm, start: start * 4 + k * 4, lo, hi, chordAt, scaleAt, prev, peak: chorus && k % 4 === 2, span });
      const vel = kind === 'last' || kind === 'last2' ? 0.86 : chorus ? 0.8 : 0.66;
      for (const nt of notes) w.note('lead', nt.midi, nt.beat, nt.len, vel + (Math.abs(nt.beat - Math.round(nt.beat)) < 1e-9 ? 0.06 : 0));
      if (kind === 'last' || kind === 'last2') for (const nt of notes) w.note('violin', nt.midi + 12, nt.beat, nt.len, 0.5);
      if (notes.length) prev = notes[notes.length - 1].midi;
    }
  };

  let pads = null, brassV = null;
  const groove = (b, kind, i, n) => {
    const big = kind === 'chorus' || kind === 'last' || kind === 'last2';
    if (kind === 'verse' && i < n / 2) {
      // half time for the first half of the verse
      w.hit('kick', b, 0.15, 0.85); w.hit('kick', b + 2.5, 0.15, 0.7);
      w.hit('snare', b + 2, 0.12, 0.72);
      for (let s = 0; s < 8; s++) w.hit('hat', b + s * 0.5, 0.06, s % 2 ? 0.28 : 0.38);
      return;
    }
    if (kind === 'pre') {
      for (let s = 0; s < 4; s++) w.hit('kick', b + s, 0.15, 0.8 + 0.03 * i);
      w.hit('snare', b + 1, 0.12, 0.75); w.hit('snare', b + 3, 0.12, 0.75);
      for (let s = 0; s < 4; s++) w.hit('openhat', b + s + 0.5, 0.2, 0.32);
      return;
    }
    // 8-beat rock groove (verse second half, intro, chorus)
    w.hit('kick', b, 0.15, 1); w.hit('kick', b + 1.5, 0.15, 0.82); w.hit('kick', b + 2, 0.15, 0.92);
    if (big && i % 2 === 1) w.hit('kick', b + 3.5, 0.15, 0.75);
    w.hit('snare', b + 1, 0.12, big ? 0.95 : 0.82); w.hit('snare', b + 3, 0.12, big ? 0.95 : 0.82);
    if (big) for (let s = 0; s < 4; s++) { w.hit('hat', b + s, 0.06, 0.4); w.hit('openhat', b + s + 0.5, 0.22, 0.38); }
    else for (let s = 0; s < 8; s++) w.hit('hat', b + s * 0.5, 0.06, s % 2 ? 0.3 : 0.42);
    if (big) w.hit('ride', b + 0.5, 0.3, 0.3);
  };
  const fill = (b) => {
    // a tom run on the last beat: high, high, low, low, then the crash lands on the next bar
    const hiT = 57, loT = 45;
    [hiT, hiT, loT, loT].forEach((m, k) => w.tom(m, b + 3 + k * 0.25, 0.2, 0.7 + 0.07 * k));
  };

  for (const s of sections) {
    const sb = s.start * 4;
    w.cue({ last: 'chorus-2', last2: 'chorus-3' }[s.kind] || s.kind, sb);
    for (let i = 0; i < s.n; i++) {
      const bar = s.start + i;
      const b = bar * 4;
      const ch = barChord[bar];
      const root = ch.root;
      const big = s.kind === 'chorus' || s.kind === 'last' || s.kind === 'last2';
      const lastBar = i === s.n - 1;
      if (s.kind === 'break') {
        // kime: the whole band on the same syncopated hits, then a breath
        w.cue('hits', b);
        for (const t of [0, 0.75, 1.5, 2.5]) {
          w.hit('kick', b + t, 0.12, 1); w.hit('crash', b + t, 0.5, 0.5);
          w.note('bass', bassOf(root), b + t, 0.3, 0.95);
          w.chord('brass', voiceLead(ch, 55, 70, null), b + t, 0.3, 0.9);
          w.chord('guitar', [bassOf(root, 40), bassOf(root, 40) + 7, bassOf(root, 40) + 12], b + t, 0.3, 0.85);
          w.note('timpani', bassOf(root, 38), b + t, 0.4, 0.95);
        }
        w.note('riser', midiOf(root, 4), b, 3.9, 0.6);
        continue;
      }
      if (s.kind === 'outro') {
        if (!lastBar) {
          for (const t of [0, 1.5, 3]) {
            w.hit('kick', b + t, 0.12, 1); w.hit('snare', b + t, 0.12, 0.9);
            w.chord('brass', voiceLead(ch, 55, 70, null), b + t, 0.6, 0.9);
            w.note('bass', bassOf(root), b + t, 0.6, 0.95);
            w.chord('strings', voiceLead(ch, 60, 76, null), b + t, 0.6, 0.8);
            w.chord('guitar', [bassOf(root, 40), bassOf(root, 40) + 7, bassOf(root, 40) + 12], b + t, 0.6, 0.85);
          }
        } else {
          w.cue('end', b);
          const hold = Math.max(0.5, end - b - 0.05);
          w.hit('kick', b, 0.15, 1); w.hit('crash', b, 3, 0.85);
          w.note('impact', midiOf(root, 2), b, 4, 0.95);
          w.note('timpani', bassOf(root, 38), b, 1.5, 1);
          w.chord('strings', voiceLead(ch, 55, 79, null), b, hold, 0.7);
          w.chord('choir', voiceLead(ch, 57, 74, null), b, hold, 0.6);
          w.chord('brass', voiceLead(ch, 50, 67, null), b, hold, 0.75);
          w.note('bass', bassOf(root), b, hold, 0.85);
          w.note('glock', midiOf(root, 6), b, 2, 0.5);
        }
        continue;
      }
      // drums
      groove(b, s.kind === 'interlude' ? 'intro' : s.kind === 'bridge' ? 'verse' : s.kind, i, s.n);
      if (i === 0 && s.kind !== 'verse' && s.kind !== 'bridge') { w.hit('crash', b, 2, big ? 0.75 : 0.6); }
      if (i === 0 && big) { w.note('impact', midiOf(root, 2), b, 3, 0.8); w.note('timpani', bassOf(root, 38), b, 1, 0.95); }
      if (big && i === 4) w.hit('crash', b, 2, 0.6);
      if ((big || s.kind === 'intro' || s.kind === 'interlude') && (i % 4 === 3) && !lastBar) fill(b);
      // bass: driving eighths, quarters in the quiet half of the verse
      if ((s.kind === 'verse' && i < s.n / 2) || s.kind === 'bridge') {
        w.note('bass', bassOf(root), b, 1.4, 0.75); w.note('bass', bassOf(root), b + 1.5, 0.45, 0.65);
        w.note('bass', bassOf(root), b + 2, 1.4, 0.72); w.note('bass', bassOf(root) + 7, b + 3.5, 0.45, 0.6);
      } else {
        for (let e = 0; e < 8; e++) {
          const approach = e === 7 && barChord[bar + 1] ? bassOf(barChord[bar + 1].root) - 1 : null;
          w.note('bass', approach != null && rng() < 0.5 ? approach : bassOf(root) + (big && e % 4 === 3 ? 12 : 0), b + e * 0.5, 0.42, e % 2 ? 0.7 : 0.85);
        }
      }
      // guitar: palm-muted eighths in the verse, ringing power chords in the chorus
      const power = [bassOf(root, 40), bassOf(root, 40) + 7, bassOf(root, 40) + 12];
      if (s.kind === 'verse' && i >= s.n / 2) for (let e = 0; e < 8; e++) w.chord('guitar', power.slice(0, 2), b + e * 0.5, 0.3, e % 2 ? 0.45 : 0.55);
      else if (big || s.kind === 'intro' || s.kind === 'interlude' || s.kind === 'pre') { w.chord('guitar', power, b, 1.4, 0.72); w.chord('guitar', power, b + 1.5, 2.4, 0.66); }
      // piano: broken chords in the verse, blocks in the chorus
      const pv = voiceLead(ch, 60, 76, null);
      if (s.kind === 'verse' || s.kind === 'bridge') {
        const arp = [pv[0], pv[1], pv[2], pv[0] + 12, pv[2], pv[1], pv[0] + 12, pv[1] + 12];
        for (let e = 0; e < 16; e++) w.note('piano', arp[e % arp.length], b + e * 0.25, 0.3, e % 4 === 0 ? 0.5 : 0.38);
      } else if (big) {
        for (let q = 0; q < 4; q++) w.chord('piano', pv, b + q, 0.8, 0.5);
      }
      // strings: driving sixteenths in the intro, a rising run into the chorus, pads in the chorus
      if (s.kind === 'intro' || s.kind === 'interlude') {
        const tones = [midiOf(root, 4), midiOf(root, 4), midiOf(root, 4) + 7, midiOf(root, 4), midiOf(root, 4) + 12, midiOf(root, 4), midiOf(root, 4) + 7, midiOf(root, 4) + 10 - (ch.quality === 'm' || ch.quality === 'm7' ? 0 : 0)];
        for (let e = 0; e < 16; e++) w.note('spiccato', tones[e % 8] > 84 ? tones[e % 8] - 12 : tones[e % 8], b + e * 0.25, 0.2, e % 4 === 0 ? 0.7 : 0.52);
      }
      if (s.kind === 'pre' && lastBar) {
        let m = midiOf(scaleAt(b)[0], 4);
        for (let e = 0; e < 16; e++) { w.note('spiccato', m, b + e * 0.25, 0.22, 0.45 + e * 0.03); m = stepScale(scaleAt(b), m, 1, 50, 96); }
        for (let e = 0; e < 16; e++) w.hit('snare', b + e * 0.25, 0.1, 0.25 + e * 0.045);
        w.note('riser', midiOf(root, 4), b, 3.9, 0.6);
        w.note('timpani', bassOf(root, 38), b + 3, 0.25, 0.7);
        w.note('timpani', bassOf(root, 38), b + 3.5, 0.25, 0.9);
      }
      if (big || s.kind === 'pre' || s.kind === 'bridge') {
        pads = voiceLead(ch, 55, 72, pads);
        w.chord('strings', pads, b, 3.9, big ? 0.55 : 0.42);
      }
      // brass: stabs in the intro, pushes in the chorus
      if (s.kind === 'intro' || s.kind === 'interlude') { brassV = voiceLead(ch, 55, 70, brassV); w.chord('brass', brassV, b, 0.4, 0.82); w.chord('brass', brassV, b + 2.5, 0.4, 0.74); }
      if (big) { brassV = voiceLead(ch, 52, 67, brassV); w.chord('brass', brassV, b, 1.5, 0.6); w.chord('brass', brassV, b + 2, 1.5, 0.55); }
      // choir and glock in the chorus
      if (big) {
        w.chord('choir', voiceLead(ch, 57, 74, null), b, 3.9, s.kind === 'chorus' ? 0.45 : 0.55);
        if (i % 2 === 1) for (let e = 0; e < 8; e++) w.note('glock', midiOf(ch.pcs[e % ch.pcs.length], 6), b + e * 0.5, 0.4, 0.28);
      }
    }
    if (s.kind === 'verse' || s.kind === 'chorus' || s.kind === 'last' || s.kind === 'last2' || s.kind === 'intro' || s.kind === 'interlude') {
      melody(s.start, s.n, s.kind === 'intro' || s.kind === 'interlude' ? 'chorus' : s.kind);
    }
  }
  return { bars };
}

// -------------------------------------------------------------------- epic

function fillEpic(o, w) {
  const H = harmony(o.key, o.mode);
  const prog = o.mode === 'minor' ? [6, 4, 1, 5] : [1, 6, 4, 5];
  const n = o.bars;
  const a = Math.max(1, Math.round(n / 4)), bEnd = Math.max(a + 1, Math.round(n / 2));
  w.cue('low', 0); w.cue('build', a * 4); w.cue('full', bEnd * 4);
  let str = null;
  for (let bar = 0; bar < n; bar++) {
    const b = bar * 4;
    const ch = H.chord(prog[bar % prog.length]);
    const root = ch.root;
    const level = bar < a ? 0 : bar < bEnd ? 1 : 2;
    // taiko ostinato with accents
    [0, 0.75, 1.5, 2, 2.75, 3.5].forEach((t, k) => w.hit('taiko', b + t, 0.3, k === 0 || k === 3 ? 0.95 : 0.6 + 0.1 * level));
    if (level >= 1) w.hit('bassdrum', b, 0.6, 0.85);
    if (level === 2) { w.hit('snare', b + 1, 0.12, 0.85); w.hit('snare', b + 3, 0.12, 0.85); }
    // spiccato ostinato
    const tones = [0, 0, 7, 0, 12, 0, 7, 3].map((x) => midiOf(root, 3) + x + (ch.quality === 'maj' && x === 3 ? 1 : 0));
    for (let e = 0; e < 16; e++) w.note('spiccato', tones[e % 8], b + e * 0.25, 0.2, e % 4 === 0 ? 0.72 : 0.5);
    if (level >= 1 && bar % 2 === 0) {
      // braam: low brass on root and fifth
      w.chord('tuba', [bassOf(root, 26)], b, 7.6, 0.85);
      w.chord('trombone', [bassOf(root, 38), bassOf(root, 38) + 7], b, 7.6, 0.8);
      w.chord('horn', [bassOf(root, 50), bassOf(root, 50) + 7], b, 7.6, 0.7);
      w.note('impact', midiOf(root, 2), b, 3, 0.75);
    }
    if (level >= 1) { str = voiceLead(ch, 55, 74, str); w.chord('strings', str, b, 3.9, 0.45 + 0.1 * level); }
    if (level === 2) {
      w.chord('choir', voiceLead(ch, 55, 72, null), b, 3.9, 0.6);
      w.note('trumpet', midiOf(ch.pcs[1], 5), b, 1.5, 0.75);
      w.note('trumpet', midiOf(ch.pcs[2], 4), b + 1.5, 2.3, 0.7);
      w.note('contrabass', bassOf(root, 28), b, 3.9, 0.75);
      if (bar % 4 === 0) w.hit('crash', b, 2, 0.7);
    }
    if (bar === a - 1 || bar === bEnd - 1) {
      w.note('riser', midiOf(root, 4), b, 3.9, 0.65);
      for (let e = 0; e < 8; e++) w.note('timpani', bassOf(root, 38), b + 2 + e * 0.25, 0.25, 0.45 + e * 0.07);
    }
  }
  const last = n * 4 - 2;
  w.note('impact', midiOf(H.chord(prog[0]).root, 2), Math.max(0, last), 2, 0.9);
}

// --------------------------------------------------------------- symphonic

function fillSymphonic(o, w, rng) {
  const H = harmony(o.key, o.mode);
  const n = o.bars;
  const prog = o.mode === 'minor' ? [6, 4, 2, 3, 6, 4, 3, 6] : [1, 6, 4, 5, 1, 4, [5, '7'], 1];
  const chordOfBar = (bar) => { const d = prog[bar % prog.length]; const [deg, q] = Array.isArray(d) ? d : [d, null]; return H.chord(deg, q); };
  const chordAt = (beat) => chordOfBar(Math.floor(beat / 4));
  const scaleAt = () => H.scale;
  w.cue('theme', 0);
  if (n >= 8) w.cue('tutti', Math.floor(n / 2) * 4);
  let prev = null, inner = null, horns = null;
  for (let bar = 0; bar < n; bar += 2) {
    const tutti = bar >= Math.floor(n / 2);
    const notes = phrase({ rng, rhythm: CHORUS_RHYTHMS[(bar / 2) % 2 === 0 ? 0 : 1].filter((t) => t < Math.min(8, (n - bar) * 4) - 0.25), start: bar * 4, lo: 67, hi: 86, chordAt, scaleAt, prev, peak: tutti, span: Math.min(8, (n - bar) * 4) });
    for (const nt of notes) {
      w.note('violin', nt.midi, nt.beat, nt.len, tutti ? 0.78 : 0.62);
      if (tutti) w.note('flute', nt.midi + 12 > 96 ? nt.midi : nt.midi + 12, nt.beat, nt.len, 0.55);
      else if (bar % 4 === 2) w.note('oboe', nt.midi - 12, nt.beat, nt.len, 0.5);
    }
    if (notes.length) prev = notes[notes.length - 1].midi;
  }
  for (let bar = 0; bar < n; bar++) {
    const b = bar * 4;
    const ch = chordOfBar(bar);
    const tutti = bar >= Math.floor(n / 2);
    inner = voiceLead(ch, 55, 69, inner);
    for (let q = 0; q < 4; q += tutti ? 1 : 2) w.chord('viola', inner.slice(0, 2), b + q, tutti ? 0.9 : 1.8, 0.45);
    w.note('clarinet', inner[inner.length - 1], b, 3.8, 0.4);
    w.note('cello', bassOf(ch.root, 36), b, 1.9, 0.62); w.note('cello', bassOf(ch.root, 36) + 7 > 60 ? bassOf(ch.root, 36) : bassOf(ch.root, 36) + 7, b + 2, 1.9, 0.55);
    w.note('contrabass', bassOf(ch.root, 28), b, 3.8, 0.6);
    w.note('bassoon', bassOf(ch.root, 40), b, 3.8, 0.42);
    horns = voiceLead(ch, 53, 67, horns);
    w.chord('horn', horns, b, 3.8, tutti ? 0.58 : 0.42);
    // harp arpeggio
    const arp = voiceLead(ch, 55, 79, null);
    for (let e = 0; e < 8; e++) w.note('harp', arp[e % arp.length] + (e >= arp.length ? 12 : 0), b + e * 0.5, 1.2, 0.4);
    if (tutti) {
      w.chord('trumpet', voiceLead(ch, 62, 74, null), b, 0.9, 0.55);
      w.note('trombone', bassOf(ch.root, 40), b, 1.8, 0.55);
      w.note('tuba', bassOf(ch.root, 28), b, 1.8, 0.5);
      w.note('timpani', bassOf(ch.root, 38), b, 0.6, 0.8);
      if (bar % 4 === 0) w.hit('crash', b, 2, 0.45);
    }
    if (bar === n - 1) {
      w.note('glock', midiOf(ch.root, 6), b, 2, 0.45);
      for (let e = 0; e < 8; e++) w.note('timpani', bassOf(ch.root, 38), b + e * 0.25, 0.25, 0.5 + e * 0.06);
    }
  }
}

// ----------------------------------------------------------------- lullaby

function fillLullaby(o, w, rng) {
  const H = harmony(o.key, o.mode);
  const n = o.bars;
  const prog = o.mode === 'minor' ? [6, 2, 3, 6] : [1, 4, 5, 1, 6, 4, [5, 'sus4'], 1];
  const chordOfBar = (bar) => { const d = prog[bar % prog.length]; const [deg, q] = Array.isArray(d) ? d : [d, null]; return H.chord(deg, q); };
  const chordAt = (beat) => chordOfBar(Math.floor(beat / 3));
  const rhythm = [0, 1, 2, 3, 4.5, 5];
  let prev = null, pad = null;
  for (let bar = 0; bar < n; bar += 2) {
    const span = Math.min(6, (n - bar) * 3);
    const notes = phrase({ rng, rhythm: rhythm.filter((t) => t < span - 0.25), start: bar * 3, lo: 72, hi: 88, chordAt, scaleAt: () => H.scale, prev, span });
    for (const nt of notes) w.note('celesta', nt.midi, nt.beat, Math.min(nt.len, 1.8), 0.55);
    if (notes.length) prev = notes[notes.length - 1].midi;
  }
  for (let bar = 0; bar < n; bar++) {
    const b = bar * 3;
    const ch = chordOfBar(bar);
    const arp = voiceLead(ch, 53, 72, null);
    [0, 1, 2].forEach((q) => w.note('harp', q === 0 ? bassOf(ch.root, 41) : arp[q % arp.length] + (q === 2 ? 12 : 0), b + q, 1.5, q === 0 ? 0.5 : 0.36));
    pad = voiceLead(ch, 55, 70, pad);
    w.chord('strings', pad, b, 2.9, 0.3);
    if (bar % 2 === 1) w.note('glock', midiOf(ch.pcs[0], 6), b + 2, 1, 0.25);
  }
}

// ------------------------------------------------------------------- drums

/**
 * Grooves for drum pieces. Each lane is one bar of steps: X accent, x hit,
 * o ghost, - very soft, . rest. steps: 16 (sixteenths) or 12 (eighth-note
 * triplets). b: lanes added (or replaced) in the B section. fill: the fill
 * at the end of a phrase. swing: the score's swing (sixteenths move).
 */
export const GROOVES = Object.freeze({
  rock: { bpm: 112, steps: 16, fill: 'toms', lanes: { kick: 'X.......X.x.....', snare: '....X.......X...', hat: 'x.x.x.x.x.x.x.x.' },
    b: { hat: null, ride: 'x.x.x.x.x.x.x.x.', openhat: '..............x.' } },
  funk: { bpm: 102, steps: 16, swing: 0.12, fill: 'snare', lanes: { kick: 'X..x..x...X..x..', snare: '....X..o.o..X..o', hat: 'xoxoxoxoxoxoxoxo' },
    b: { openhat: '......x.......x.', cowbell: 'x...x...x...x...' } },
  hiphop: { bpm: 90, steps: 16, swing: 0.28, fill: 'snare', lanes: { kick: 'X......xX.x.....', snare: '....X.......X...', hat: 'x.x.x.x.x.x.x.x.' },
    b: { rim: '..x.......x...x.', shaker: 'x-x-x-x-x-x-x-x-' } },
  trap: { bpm: 140, steps: 16, fill: 'hats', lanes: { subkick: 'X......x..X.....', clap: '........X.......', hat: 'x.x.x.x.x.x.xxxx' },
    b: { openhat: '......x.......x.', snare2: '........X.......' } },
  house: { bpm: 124, steps: 16, fill: 'snare', lanes: { kick: 'X...X...X...X...', clap: '....X.......X...', openhat: '..x...x...x...x.', hat: 'x.x.x.x.x.x.x.x.' },
    b: { shaker: '-x-x-x-x-x-x-x-x', ride: 'x.x.x.x.x.x.x.x.' } },
  techno: { bpm: 132, steps: 16, fill: 'snare', lanes: { kick: 'X...X...X...X...', openhat: '..x...x...x...x.', rim: '......x.......x.' },
    b: { clap: '....x.......x...', ride: 'x.x.x.x.x.x.x.x.', burst: '..............x.' } },
  disco: { bpm: 118, steps: 16, fill: 'toms', lanes: { kick: 'X...X...X...X...', snare: '....X.......X...', hat: 'xxxxxxxxxxxxxxxx', openhat: '..x...x...x...x.' },
    b: { tambourine: 'x.x.x.x.x.x.x.x.', conga: '...x..x....x..x.' } },
  dnb: { bpm: 174, steps: 16, fill: 'snare', lanes: { kick: 'X.........X.....', snare: '....X.......X...', hat: 'x.x.x.x.x.x.x.x.' },
    b: { ride: 'x.x.x.x.x.x.x.x.', snare2: '.......o.o......', shaker: 'xxxxxxxxxxxxxxxx' } },
  breakbeat: { bpm: 136, steps: 16, fill: 'snare', lanes: { kick: 'X.X.......XX....', snare: '....X..o.o..X..o', ride: 'x.x.x.x.x.x.x.x.' },
    b: { openhat: '..............x.', crash2: null } },
  halftime: { bpm: 140, steps: 16, fill: 'toms', lanes: { kick: 'X.........X.....', snare: '........X.......', hat: 'x.x.x.x.x.x.x.x.' },
    b: { ride: 'x...x...x...x...', hat: null } },
  metal: { bpm: 180, steps: 16, fill: 'toms', lanes: { kick: 'xxxxxxxxxxxxxxxx', snare: '....X.......X...', ride: 'x...x...x...x...' },
    b: { china: 'X.......X.......', ride: null } },
  shuffle: { bpm: 96, steps: 12, fill: 'snare', lanes: { kick: 'X.....X.....', snare: '...X.....X..', hat: 'x.xx.xx.xx.x' },
    b: { ride: 'x.xx.xx.xx.x', hat: null } },
  jazz: { bpm: 150, steps: 12, fill: 'snare', lanes: { ride: 'x..x.xx..x.x', pedalhat: '...x.....x..', kick: '-..-..-..-..', snare: '.....o.....-' },
    b: { snare: '..o..o..o...' } },
  bossa: { bpm: 132, steps: 16, fill: 'snare', lanes: { kick: 'X..xX..xX..xX..x', rim: 'x..x..x...x..x..', hat: 'x.x.x.x.x.x.x.x.' },
    b: { shaker: 'xxxxxxxxxxxxxxxx' } },
  samba: { bpm: 100, steps: 16, fill: 'snare', lanes: { bassdrum: 'x.......X.......', tambourine: 'XxxXXxxXXxxXXxxX', snare2: 'x.xxx.xxx.xx.x.x' },
    b: { agogo: 'x.x..x.x.x.x..x.', claves: 'x..x..x...x.x...' } },
  reggaeton: { bpm: 95, steps: 16, fill: 'snare', lanes: { kick: 'X...X...X...X...', snare: '...x..x....x..x.', hat: 'x.x.x.x.x.x.x.x.' },
    b: { timbale: '...x..x....x..x.', shaker: 'xxxxxxxxxxxxxxxx' } },
  afrobeat: { bpm: 110, steps: 16, fill: 'snare', lanes: { kick: 'X.....X...X.....', snare: '....X.......X...', shaker: 'x-x-x-x-x-x-x-x-', conga: 'x..x.x..x..x.xx.' },
    b: { cowbell: 'x.x.xx.x.x.xx.x.', bongo: '.x...x.x.x...x..' } },
  latin: { bpm: 180, steps: 16, fill: 'snare', lanes: { claves: 'x..x..x...x.x...', conga: '....x.xx....x.xx', cowbell: 'x...x...x...x...', kick: '...x.......x....' },
    b: { timbale: 'x.xxx.xx.xxx.x.x', tumba: '......x.......x.' } },
  march: { bpm: 116, steps: 16, fill: 'snare', lanes: { snare: 'X.xxX.x.X.xxX.x.', bassdrum: 'X.......X.......' },
    b: { crash: 'X.......X.......' } },
  taiko: { bpm: 100, steps: 16, fill: 'taiko', lanes: { taiko: 'X..x..X.x.X..x..', bassdrum: 'X.......X.......', block: 'x.x.x.x.x.x.x.x.' },
    b: { snare2: '..o...o...o...o.', floortom: '......x.......x.' } },
});

const VEL = { X: 1, x: 0.8, o: 0.42, '-': 0.26 };

function grooveFrom(prompt) {
  const p = String(prompt || '').toLowerCase();
  const order = [
    ['boom ?bap|hip-?hop|rap', 'hiphop'], ['trap|drill', 'trap'], ['house|edm|four on the floor', 'house'], ['techno', 'techno'],
    ['disco', 'disco'], ['drum ?(and|&|n) ?bass|dnb|jungle', 'dnb'], ['breakbeat|amen|break', 'breakbeat'], ['half ?time', 'halftime'],
    ['metal|blast', 'metal'], ['shuffle|blues', 'shuffle'], ['jazz|swing', 'jazz'], ['bossa', 'bossa'], ['samba|carnival|batucada', 'samba'],
    ['reggaeton|dembow', 'reggaeton'], ['afro', 'afrobeat'], ['latin|salsa|clave|mambo', 'latin'], ['march|marching|drumline|military', 'march'],
    ['taiko|japanese drum', 'taiko'], ['funk', 'funk'], ['rock|punk', 'rock'],
  ];
  for (const [re, g] of order) if (new RegExp(`\\b(${re})\\b`).test(p)) return g;
  return 'rock';
}

/** The grooves' tempos, for compose() when no bpm is given. */
export function drumTempo(prompt) { return GROOVES[grooveFrom(prompt)].bpm; }

function fillDrums(o, w, rng, warnings) {
  const name = grooveFrom(o.prompt);
  const g = GROOVES[name];
  const solo = /\bsolo\b/i.test(o.prompt || '');
  const n = o.bars;
  const intro = n >= 8 ? 2 : 0, end = n >= 4 ? 1 : 0, brk = n >= 12 ? 1 : 0;
  const body = n - intro - end - brk;
  const a = Math.max(1, Math.ceil(body / 3 / 2) * 2), b = Math.max(0, Math.min(body - a, a)), a2 = Math.max(0, body - a - b);
  const plan = [['intro', intro], ['a', a], ['b', b], ['break', brk], ['a2', a2], ['end', end]].filter((s) => s[1] > 0);
  const step = 4 / g.steps;
  const human = () => (rng() - 0.5) * 0.08;
  const lanesFor = (kind) => {
    const lanes = { ...g.lanes };
    if (kind === 'b' || kind === 'a2') for (const [k, v] of Object.entries(g.b || {})) { if (v == null) delete lanes[k]; else lanes[k] = v; }
    if (kind === 'intro') for (const k of Object.keys(lanes)) if (/kick|snare|clap|taiko|bassdrum/.test(k)) delete lanes[k];
    return lanes;
  };
  const play = (lanes, b) => {
    for (const [voice, pat] of Object.entries(lanes)) {
      for (let i = 0; i < pat.length; i++) {
        const v = VEL[pat[i]];
        if (!v) continue;
        const len = voice === 'openhat' ? 0.3 : voice === 'crash' || voice === 'china' ? 1.5 : 0.12;
        w.hit(voice, b + i * step, len, v * (voice.includes('hat') || voice === 'ride' || voice === 'shaker' ? 0.6 : 1) + human());
      }
    }
  };
  const fill = (b, beats = 1) => {
    const s0 = b + 4 - beats;
    const k = Math.round(beats * 4);
    for (let i = 0; i < k; i++) {
      const t = s0 + i * 0.25, ramp = 0.55 + 0.45 * (i / Math.max(1, k - 1));
      if (g.fill === 'toms') w.hit(['snare', 'hitom', 'midtom', 'floortom'][Math.min(3, Math.floor(i * 4 / k))], t, 0.2, ramp);
      else if (g.fill === 'hats') { w.hit('hat', t, 0.05, 0.5 * ramp); w.hit('hat', t + 0.125, 0.05, 0.4 * ramp); }
      else if (g.fill === 'taiko') w.hit('taiko', t, 0.25, ramp);
      else w.hit('snare', t, 0.12, ramp * (i % 2 ? 0.8 : 1));
    }
  };
  const soloBar = (b) => {
    const kit = ['snare', 'hitom', 'midtom', 'floortom', 'kick'];
    for (let i = 0; i < 16; i++) {
      if (rng() < 0.15) continue;
      w.hit(kit[Math.floor(rng() * kit.length)], b + i * 0.25, 0.15, (i % 4 === 0 ? 0.95 : 0.6) + human());
    }
    w.hit('kick', b, 0.15, 1);
  };
  let bar = 0;
  for (const [kind, len] of plan) {
    w.cue(kind === 'a2' ? 'a-again' : kind, bar * 4);
    for (let i = 0; i < len; i++, bar++) {
      const b = bar * 4;
      const last = i === len - 1;
      if (kind === 'break') {
        for (const t of [0, 0.75, 1.5]) { w.hit('kick', b + t, 0.12, 1); w.hit('snare', b + t, 0.12, 0.9); w.hit('crash', b + t, 0.6, 0.6); }
        fill(b, 1);
        continue;
      }
      if (kind === 'end') {
        w.hit('kick', b, 0.2, 1); w.hit('snare', b, 0.15, 0.95); w.hit('crash', b, 3, 0.9); w.hit('crash2', b, 3, 0.7);
        continue;
      }
      if (i === 0 && kind !== 'intro') w.hit('crash', b, 1.5, 0.75);
      if (solo && kind === 'b') soloBar(b);
      else {
        const lanes = lanesFor(kind);
        // the last bar of a phrase leaves room for the fill
        if (last && kind !== 'intro') for (const k of Object.keys(lanes)) if (!/hat|ride|shaker|tambourine|cowbell|claves|agogo/.test(k)) lanes[k] = lanes[k].slice(0, Math.floor(g.steps * (g.fill === 'hats' ? 0.75 : 0.75)));
        play(lanes, b);
      }
      if (last && kind !== 'intro') fill(b, g.fill === 'hats' ? 1 : (rng() < 0.4 ? 2 : 1));
      if (kind === 'intro' && last) fill(b, 1);
    }
  }
  if (g.swing) w.swing = g.swing;
  warnings.push({ line: 0, field: 'style', message: `Drum piece: ${name}${solo ? ' with a solo' : ''}.`, fix: `Name a groove in the prompt: ${Object.keys(GROOVES).join(', ')}.` });
}

// ----------------------------------------------------------------- ambient

function fillAmbient(o, w, rng) {
  const p = String(o.prompt || '').toLowerCase();
  const H = harmony(o.key, o.mode);
  const end = w.end;
  const bed = /ocean|sea|waves|beach/.test(p) ? 'ocean' : /city|street|urban/.test(p) ? 'city' : /fire|campfire|hearth/.test(p) ? 'fire'
    : /wind|desert|mountain/.test(p) ? 'wind' : /vinyl|record/.test(p) ? 'vinyl' : 'rain';
  w.cue('begin', 0);
  w.note(bed, midiOf(H.tonic, 4), 0, end - 0.05, 0.7);
  if (/forest|bird|morning|garden/.test(p) || bed === 'wind') w.note('wind', midiOf(H.tonic, 5), 0, end - 0.05, 0.35);
  w.note('drone', midiOf(H.tonic, 2), 0, end - 0.05, 0.5);
  const prog = o.mode === 'minor' ? [6, 4] : [1, 4];
  for (let bar = 0; bar < o.bars; bar += 4) {
    const ch = H.chord(prog[(bar / 4) % prog.length]);
    w.chord('night', voiceLead(ch, 55, 72, null), bar * 4, Math.min(16, end - bar * 4) - 0.05, 0.4);
  }
  // sparse notes: a pentatonic piano and bells, a shimmer now and then
  const penta = [0, 2, 4, 7, 9].map((s) => (H.R + s) % 12);
  for (let beat = 2; beat < end - 2; beat += 1 + Math.floor(rng() * 3)) {
    if (rng() < 0.45) w.note(rng() < 0.7 ? 'piano' : 'bell', midiOf(penta[Math.floor(rng() * penta.length)], 5), beat, 2, 0.3 + rng() * 0.15);
  }
  if (/forest|bird|morning|garden/.test(p)) {
    for (let beat = 1; beat < end - 1; beat += 2 + Math.floor(rng() * 5)) {
      const base = 88 + Math.floor(rng() * 8);
      for (let k = 0; k < 2 + Math.floor(rng() * 3); k++) w.note('chirp', base + (k % 2 ? 3 : 0), beat + k * 0.15, 0.1, 0.3 + rng() * 0.2);
    }
  }
  if (/storm|thunder/.test(p)) for (let beat = 6; beat < end - 4; beat += 12 + Math.floor(rng() * 8)) w.note('thunder', midiOf(H.tonic, 2), beat, 6, 0.7 + rng() * 0.2);
  if (o.bars >= 8) w.note('shimmer', midiOf(H.tonic, 6), Math.floor(end / 2), Math.min(16, end / 2) - 0.05, 0.35);
}

// -------------------------------------------------------------------- lofi

function fillLofi(o, w, rng) {
  const H = harmony(o.key, o.mode);
  const end = w.end;
  const p = String(o.prompt || '').toLowerCase();
  const prog = o.mode === 'minor' ? [[2, 'm7'], [5, '7'], [6, 'm7'], [6, 'm7']] : [[2, 'm7'], [5, '7'], [1, 'maj7'], [6, 'm7']];
  w.cue('in', 0);
  w.note('vinyl', midiOf(H.tonic, 4), 0, end - 0.05, 0.55);
  if (/rain/.test(p)) w.note('rain', midiOf(H.tonic, 4), 0, end - 0.05, 0.4);
  let keys = null;
  const penta = (o.mode === 'minor' ? [0, 3, 5, 7, 10] : [0, 2, 4, 7, 9]).map((s) => (H.tonic + s) % 12);
  for (let bar = 0; bar < o.bars; bar++) {
    const b = bar * 4;
    const [deg, q] = prog[bar % prog.length];
    const ch = H.chord(deg, q);
    keys = voiceLead(ch, 55, 72, keys);
    w.chord('rhodes', keys, b, 1.9, 0.55);
    w.chord('rhodes', keys, b + 2.5, 1.4, 0.45);
    w.note('bass', bassOf(ch.root), b, 1.5, 0.75);
    w.note('bass', bassOf(ch.root) + (rng() < 0.5 ? 7 : 12), b + 2.5, 0.9, 0.6);
    // boom bap
    w.hit('kick', b, 0.15, 0.95); w.hit('kick', b + 1.75, 0.15, 0.6); w.hit('kick', b + 2.5, 0.15, 0.8);
    w.hit('snare', b + 1, 0.12, 0.7); w.hit('snare', b + 3, 0.12, 0.72);
    for (let e = 0; e < 8; e++) w.hit('hat', b + e * 0.5, 0.06, e % 2 ? 0.28 : 0.4);
    if (bar % 2 === 1) w.hit('rim', b + 3.75, 0.1, 0.4);
    // a few vibes notes
    if (bar >= 2) for (let e = 0; e < 4; e++) if (rng() < 0.35) w.note('vibes', midiOf(penta[Math.floor(rng() * penta.length)], 5), b + e + (rng() < 0.5 ? 0.5 : 0), 0.9, 0.42);
  }
  w.swing = 0.3;
}
