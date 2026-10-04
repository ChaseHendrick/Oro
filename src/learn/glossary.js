// Short definitions linked from lessons. Original wording. No dashes of the long kind.

export const GLOSSARY = Object.freeze([
  { id: 'harmonic', label: 'harmonic', text: 'A higher tone whose frequency is a whole multiple of the note you hear as the pitch.' },
  { id: 'terrain', label: 'terrain', text: 'The height map. The path reads it once per cycle, and that height is the waveform.' },
  { id: 'path', label: 'path', text: 'The closed curve the dot traces. How fast it goes around sets the pitch.' },
  { id: 'nyquist', label: 'Nyquist', text: 'The highest frequency a sample rate can represent: half the sample rate. Anything higher folds back down as aliasing.' },
  { id: 'aliasing', label: 'aliasing', text: 'A frequency above Nyquist that comes back as a lower, usually unwanted, tone.' },
  { id: 'filter', label: 'filter', text: 'A process that turns some frequencies up or down. Cutoff chooses where, resonance boosts the edge.' },
  { id: 'envelope', label: 'envelope', text: 'How loud a note gets over time: attack, decay, sustain and release.' },
  { id: 'lfo', label: 'LFO', text: 'A slow repeating movement used to wiggle a knob, not to be heard as a note.' },
  { id: 'cent', label: 'cent', text: 'A hundredth of an equal tempered semitone. 1200 cents is one octave.' },
  { id: 'inharmonic', label: 'inharmonic', text: 'Overtones that are not whole multiples of the fundamental, so the tone is bell like or drum like rather than a clean string.' },
].map(Object.freeze));

const MAP = new Map(GLOSSARY.map((g) => [g.id, g]));
export function glossaryEntry(id) { return MAP.get(id) || null; }
