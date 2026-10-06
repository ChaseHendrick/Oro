// Persisted four-slot track rack. Parameters are normalized; the catalogue
// defines each effect's interpretation, labels and musical starting values.
export const FX_SLOT_COUNT = 4;
const effect = (id, name, params, defaults, hint) => ({ id, name, params, defaults, hint });
export const FX_TYPES = Object.freeze([
  effect('bypass', 'Bypass', ['Amount', 'Shape', 'Tone', 'Level'], [0.5, 0.5, 0.5, 0.5], 'Pass the signal through unchanged.'),
  effect('delay', 'Stereo delay', ['Time', 'Feedback', 'Tone', 'Crossfeed'], [0.45, 0.35, 0.65, 0.1], 'Independent stereo echoes with filtered feedback.'),
  effect('pingpong', 'Ping-pong delay', ['Time', 'Feedback', 'Tone', 'Spread'], [0.45, 0.4, 0.6, 0.8], 'Echoes alternate between the left and right channels.'),
  effect('reverb', 'Reverb', ['Size', 'Decay', 'Damping', 'Diffusion'], [0.55, 0.4, 0.45, 0.7], 'An eight-line feedback delay network creates a diffuse stereo room.'),
  effect('shimmer', 'Shimmer reverb', ['Size', 'Decay', 'Damping', 'Shimmer'], [0.65, 0.55, 0.45, 0.6], 'An octave-up granular signal recirculates through the reverb.'),
  effect('chorus', 'Chorus', ['Rate', 'Depth', 'Feedback', 'Spread'], [0.35, 0.5, 0.15, 0.75], 'Long modulated delays create a stereo ensemble.'),
  effect('flanger', 'Flanger', ['Rate', 'Depth', 'Feedback', 'Manual'], [0.3, 0.65, 0.65, 0.3], 'Short modulated delay and signed feedback sweep comb notches.'),
  effect('phaser', 'Phaser', ['Rate', 'Depth', 'Feedback', 'Stages'], [0.3, 0.65, 0.55, 0.5], 'Four to eight all-pass stages sweep spectral notches.'),
  effect('overdrive', 'Overdrive', ['Drive', 'Tone', 'Bias', 'Level'], [0.4, 0.65, 0.5, 0.6], 'Asymmetric soft clipping with a variable tone filter.'),
  effect('distortion', 'Distortion', ['Drive', 'Threshold', 'Fold', 'Tone'], [0.4, 0.55, 0.25, 0.7], 'Hard clipping blends into triangular wave folding.'),
  effect('decimator', 'Decimator', ['Bits', 'Rate', 'Dither', 'Smooth'], [0.5, 0.25, 0.1, 0], 'Independent bit-depth and sample-rate reduction.'),
  effect('granular', 'Granular pitch shift', ['Pitch', 'Grain size', 'Feedback', 'Scatter'], [0.75, 0.45, 0.1, 0], 'Two overlapping windowed grains transpose buffered audio.'),
  effect('eq4', 'Four-band EQ', ['Low shelf', 'Low mid', 'High mid', 'High shelf'], [0.5, 0.5, 0.5, 0.5], 'Four independent bands at 100 Hz, 500 Hz, 3 kHz and 10 kHz.'),
  effect('duck', 'Sidechain ducking', ['Depth', 'Threshold', 'Attack', 'Release'], [0.75, 0.65, 0.1, 0.4], 'The chosen sidechain reduces this track when it gets loud.'),
  effect('ott', 'Multiband compression', ['Depth', 'Time', 'Gain', 'Upward'], [0.65, 0.4, 0.5, 0.6], 'Three bands apply upward and downward compression independently.'),
  effect('compressor', 'Compressor', ['Threshold', 'Ratio', 'Attack', 'Release'], [0.7, 0.25, 0.15, 0.4], 'Stereo-linked downward compression controls dynamics.'),
  effect('limiter', 'Limiter', ['Ceiling', 'Release', 'Lookahead', 'Knee'], [0.8, 0.35, 0.5, 0.3], 'Lookahead peak limiting with a soft or hard knee.'),
  effect('tremolo', 'Tremolo', ['Rate', 'Depth', 'Shape', 'Stereo'], [0.4, 0.65, 0.1, 0], 'Amplitude modulation blends smooth and square pulses.'),
  effect('autopan', 'Auto pan', ['Rate', 'Depth', 'Shape', 'Offset'], [0.4, 0.75, 0.1, 0.5], 'Opposing gain curves move the signal across the stereo field.'),
  effect('ringmod', 'Ring modulation', ['Frequency', 'Depth', 'Phase', 'Stereo'], [0.45, 1, 0, 0.5], 'Audio-rate multiplication creates sum and difference sidebands.'),
  effect('wah', 'Envelope wah', ['Sensitivity', 'Resonance', 'Range', 'Position'], [0.5, 0.55, 0.6, 0.35], 'An input envelope sweeps a resonant band-pass filter.'),
  effect('lowpass', 'Low-pass filter', ['Cutoff', 'Resonance', 'Drive', 'Slope'], [0.7, 0.2, 0, 0.5], 'A driven resonant filter blends 12 and 24 dB slopes.'),
  effect('highpass', 'High-pass filter', ['Cutoff', 'Resonance', 'Drive', 'Slope'], [0.3, 0.2, 0, 0.5], 'A driven resonant high-pass blends 12 and 24 dB slopes.'),
  effect('comb', 'Comb resonator', ['Frequency', 'Feedback', 'Tone', 'Drive'], [0.45, 0.7, 0.65, 0.1], 'A tuned short delay adds resonant harmonic peaks.'),
  effect('stereo', 'Stereo width', ['Width', 'Balance', 'Haas', 'Crossfeed'], [0.75, 0.5, 0.1, 0], 'Mid-side width, balance and a short right-channel delay.'),
  effect('warmth', 'Warmth', ['Drive', 'Body', 'Tone', 'Bias'], [0.35, 0.55, 0.65, 0.5], 'A rounded cubic saturator adds low-order harmonics and body.'),
  effect('gate', 'Noise gate', ['Threshold', 'Hold', 'Release', 'Floor'], [0.4, 0.25, 0.35, 0], 'Stereo-linked gating with hold, release and a finite floor.'),
  effect('tape', 'Tape colour', ['Drive', 'Wow', 'Tone', 'Noise'], [0.35, 0.3, 0.6, 0.1], 'Saturation, wow and flutter (flutter follows Wow), high-frequency loss and tape noise.'),
  effect('freqshift', 'Frequency shifter', ['Shift', 'Feedback', 'Direction', 'Delay'], [0.65, 0.2, 0, 0.3], 'A Hilbert transformer moves every partial by the same number of hertz.'),
  effect('hyper', 'Hyper dimension', ['Rate', 'Detune', 'Width', 'Dimension'], [0.35, 0.4, 0.8, 0.4], 'Six detuned delay voices spread across the stereo field, plus short cross reflections.'),
  effect('filterseq', 'Filter sequencer', ['Pattern', 'Glide', 'Resonance', 'Depth'], [0, 0.2, 0.45, 0.75], 'A resonant low-pass steps through an eight-step pattern in sixteenth notes at the song tempo.'),
  effect('vocoder', 'Vocoder', ['Bands', 'Formant', 'Sibilance', ''], [(16 - 8) / 24, 0.5, 0.4, 0.5], 'Microphone or another track shapes this track.'),
  // 2.17: appended, so saved racks keep their effects
  effect('transient', 'Transient shaper', ['Attack', 'Sustain', 'Speed', 'Output'], [0.65, 0.5, 0.4, 0.5], 'Two envelope followers find the attacks: push or soften the hits and the tails separately.'),
  effect('trancegate', 'Trance gate', ['Pattern', 'Rate', 'Smooth', 'Depth'], [0, 0.5, 0.15, 1], 'A tempo-synced gate chops the sound in a sixteen-step pattern.'),
  effect('disperser', 'Disperser', ['Frequency', 'Amount', 'Pinch', 'Spread'], [0.45, 0.4, 0.4, 0.1], 'A chain of up to 32 all-pass filters smears the phase around one frequency: zaps, lasers and rubbery transients.'),
  effect('tapestop', 'Tape stop', ['Stop', 'Stop time', 'Start time', 'Curve'], [0, 0.3, 0.2, 0.5], 'Turn Stop on and the tape slows to a halt; turn it off and it spins back up.'),
  effect('reverser', 'Reverser', ['Time', 'Smooth', 'Feedback', 'Tone'], [0.35, 0.6, 0, 0.8], 'Plays each slice of the sound backwards, with overlapping heads for a smooth swell.'),
  effect('peq', 'Parametric EQ band', ['Frequency', 'Gain', 'Q', 'Shape'], [0.5, 0.5, 0.35, 0], 'One band anywhere from 20 Hz to 20 kHz: bell, shelves, notch or a cut.'),
  effect('bbd', 'Bucket brigade delay', ['Time', 'Feedback', 'Modulation', 'Age'], [0.55, 0.35, 0.2, 0.35], 'A dark analog-style delay: the filters close as the time grows, and the modulation turns short times into chorus and flanging.'),
  effect('grainloop', 'Grain looper', ['Grain', 'Repeats', 'Envelope', 'Pitch'], [0.45, 0.2, 0.3, 0.5], 'Catches a grain of the sound and loops it a few times with an envelope, then catches the next.'),
  effect('tapeecho', 'Tape echo', ['Time', 'Feedback', 'Heads', 'Wear'], [0.45, 0.4, 0.3, 0.3], 'Three playback heads at 1x, 2x and 3x the time, with wow, saturation and a darkening loop.'),
]);
/** 2.17 trance gate patterns (sixteen steps, x open). */
export const TRANCE_PATTERNS = Object.freeze([
  { name: 'Eighths', steps: 'x.x.x.x.x.x.x.x.' },
  { name: 'Sixteenths', steps: 'xxxxxxxxxxxxxxxx' },
  { name: 'Offbeat', steps: '.x.x.x.x.x.x.x.x' },
  { name: 'Gallop', steps: 'x.xxx.xxx.xxx.xx' },
  { name: 'Stutter', steps: 'xx.xxx.xx.x.xxx.' },
  { name: 'Dotted', steps: 'x..x..x..x..x.x.' },
  { name: 'Pump', steps: '.xxx.xxx.xxx.xxx' },
  { name: 'Build', steps: 'x...x...x.x.xxxx' },
]);
export const TRANCE_RATES = Object.freeze(['1/32', '1/16', '1/8']);
export const PEQ_SHAPES = Object.freeze(['Bell', 'Low shelf', 'High shelf', 'Notch', 'Low cut', 'High cut']);
export const TAPE_ECHO_HEADS = Object.freeze(['1', '2', '3', '1+2', '2+3', '1+3', '1+2+3']);
/** Eight-step cutoff patterns of the filter sequencer (0 closed, 1 open). */
export const FILTER_SEQ_PATTERNS = Object.freeze([
  { name: 'Ramp up', steps: [0, .14, .29, .43, .57, .71, .86, 1] },
  { name: 'Ramp down', steps: [1, .86, .71, .57, .43, .29, .14, 0] },
  { name: 'Pulse', steps: [1, 0, 1, 0, 1, 0, 1, 0] },
  { name: 'Gallop', steps: [1, .15, .15, 1, .15, .15, 1, .5] },
  { name: 'Offbeat', steps: [.1, .1, 1, .1, .1, .1, 1, .35] },
  { name: 'Arch', steps: [0, .33, .67, 1, .67, .33, 0, .5] },
  { name: 'Accent', steps: [1, .3, .6, .3, .9, .3, .6, .2] },
  { name: 'Scatter', steps: [.8, .1, .55, .95, .25, .7, .05, .4] },
]);
export const FREQ_SHIFT_DIRECTIONS = Object.freeze(['Up', 'Down', 'Both']);
export const FX_TYPE_MAP = Object.freeze(Object.fromEntries(FX_TYPES.map((type, index) => [type.id, { ...type, index }])));
export const FX_ROUTINGS = Object.freeze([
  { id: 0, name: 'Serial', diagram: 'A → B → C → D' },
  { id: 1, name: 'Four parallel', diagram: '(A + B + C + D) / 4' },
  { id: 2, name: 'Parallel pairs', diagram: '(A → B) + (C → D)' },
  { id: 3, name: 'Middle split', diagram: 'A → (B + C) → D' },
  { id: 4, name: 'Input split', diagram: '(A + B) → C → D' },
  { id: 5, name: 'Output fan', diagram: 'A → (B + C + D)' },
  { id: 6, name: 'Input fan', diagram: '(A + B + C) → D' },
  { id: 7, name: 'Mid / side split', diagram: 'Mid → A → B; Side → C → D' },
  { id: 8, name: 'Low / high split', diagram: 'Below 800 Hz → A → B; above → C → D' },
  { id: 9, name: 'Left / right split', diagram: 'Left → A → B; Right → C → D' },
]);
const finite = (value, fallback) => typeof value === 'number' && Number.isFinite(value) ? value : fallback;
const clamp01 = (value, fallback) => Math.min(1, Math.max(0, finite(value, fallback)));
export function defaultFxSlot(type = 'bypass') {
  const def = FX_TYPE_MAP[type] || FX_TYPE_MAP.bypass;
  const slot = { type: def.id, mix: def.id === 'bypass' ? 0 : 0.5, p1: def.defaults[0], p2: def.defaults[1], p3: def.defaults[2], p4: def.defaults[3] };
  if (def.id === 'vocoder') slot.mod = 'mic';
  return slot;
}
export function defaultTrackFx() {
  return { routing: 0, sidechain: 'self', slots: Array.from({ length: FX_SLOT_COUNT }, () => defaultFxSlot()) };
}
export function sanitizeTrackFx(value) {
  const src = value && typeof value === 'object' ? value : {};
  const routing = Math.max(0, Math.min(FX_ROUTINGS.length - 1, Math.round(finite(src.routing, 0))));
  const sidechain = typeof src.sidechain === 'string' && (src.sidechain === 'self' || src.sidechain === 'mix' || /^[\w-]{1,24}$/.test(src.sidechain)) ? src.sidechain : 'self';
  return { routing, sidechain, slots: Array.from({ length: FX_SLOT_COUNT }, (_, index) => {
    const slot = src.slots?.[index];
    const def = defaultFxSlot(slot?.type);
    const out = { type: def.type, mix: clamp01(slot?.mix, def.mix), p1: clamp01(slot?.p1, def.p1), p2: clamp01(slot?.p2, def.p2), p3: clamp01(slot?.p3, def.p3), p4: clamp01(slot?.p4, def.p4) };
    if (out.type === 'vocoder') {
      const raw = typeof slot?.mod === 'string' ? slot.mod : 'mic';
      out.mod = raw === 'mic' || /^[\w-]{1,24}$/.test(raw) ? raw : 'mic';
    }
    return out;
  }) };
}
/** Actual-value scales keep keyboard entry and reset consistent with the
 * units displayed by the UI while persistence remains normalized. */
export function fxParamScale(type, parameter) {
  let min = 0, max = 1, curve = 'lin', unit = '';
  if (type === 'eq4') { min = -12; max = 12; unit = 'dB'; }
  else if (type === 'granular' && parameter === 0) { min = -24; max = 24; unit = 'st'; }
  else if (type === 'decimator' && parameter === 0) { min = 3; max = 16; curve = 'int'; unit = 'bit'; }
  else if (['delay', 'pingpong'].includes(type) && parameter === 0) { min = .02; max = 2; curve = 'exp'; unit = 's'; }
  else if (type === 'ringmod' && parameter === 0) { min = 20; max = 2000; curve = 'exp'; unit = 'Hz'; }
  else if (['lowpass', 'highpass'].includes(type) && parameter === 0) { min = 20; max = 18000; curve = 'exp'; unit = 'Hz'; }
  else if (type === 'limiter' && parameter === 0) { min = -12; max = 0; unit = 'dB'; }
  else if (['compressor', 'gate'].includes(type) && parameter === 0) { min = type === 'gate' ? -70 : -48; max = type === 'gate' ? -15 : -3; unit = 'dB'; }
  else if (type === 'duck' && parameter === 1) { min = -48; max = -6; unit = 'dB'; }
  else if (['chorus', 'flanger', 'phaser'].includes(type) && parameter === 0) { min = .05; max = 5; curve = 'exp'; unit = 'Hz'; }
  else if (['tremolo', 'autopan'].includes(type) && parameter === 0) { min = .1; max = 20; curve = 'exp'; unit = 'Hz'; }
  else if (type === 'freqshift' && parameter === 0) return { min: -2000, max: 2000, curve: 'bipow', k: 3, unit: 'Hz' };
  else if (type === 'freqshift' && parameter === 2) return { min: 0, max: 2, curve: 'int', unit: '', options: FREQ_SHIFT_DIRECTIONS.slice() };
  else if (type === 'freqshift' && parameter === 3) { min = .001; max = .5; curve = 'exp'; unit = 's'; }
  else if (type === 'hyper' && parameter === 0) { min = .05; max = 5; curve = 'exp'; unit = 'Hz'; }
  else if (type === 'hyper' && parameter === 1) { min = 0; max = 25; unit = 'ct'; }
  else if (type === 'filterseq' && parameter === 0) return { min: 0, max: FILTER_SEQ_PATTERNS.length - 1, curve: 'int', unit: '', options: FILTER_SEQ_PATTERNS.map(pattern => pattern.name) };
  else if (type === 'vocoder' && parameter === 0) return { min: 8, max: 32, curve: 'int', unit: '' };
  else if (type === 'vocoder' && parameter === 1) { min = -12; max = 12; unit = 'st'; }
  else if (type === 'transient' && parameter < 2) { min = -100; max = 100; unit = '%'; }
  else if (type === 'transient' && parameter === 3) { min = -12; max = 12; unit = 'dB'; }
  else if (type === 'trancegate' && parameter === 0) return { min: 0, max: TRANCE_PATTERNS.length - 1, curve: 'int', unit: '', options: TRANCE_PATTERNS.map((x) => x.name) };
  else if (type === 'trancegate' && parameter === 1) return { min: 0, max: 2, curve: 'int', unit: '', options: TRANCE_RATES.slice() };
  else if (type === 'disperser' && parameter === 0) { min = 40; max = 8000; curve = 'exp'; unit = 'Hz'; }
  else if (type === 'disperser' && parameter === 1) return { min: 1, max: 32, curve: 'int', unit: '' };
  else if (type === 'tapestop' && parameter === 0) return { min: 0, max: 1, curve: 'int', unit: '', options: ['Play', 'Stop'] };
  else if (type === 'tapestop' && (parameter === 1 || parameter === 2)) { min = .05; max = 2; unit = 's'; }
  else if (type === 'reverser' && parameter === 0) { min = .05; max = 1; unit = 's'; }
  else if (type === 'peq' && parameter === 0) { min = 20; max = 20000; curve = 'exp'; unit = 'Hz'; }
  else if (type === 'peq' && parameter === 1) { min = -18; max = 18; unit = 'dB'; }
  else if (type === 'peq' && parameter === 2) { min = .3; max = 12; curve = 'exp'; unit = ''; }
  else if (type === 'peq' && parameter === 3) return { min: 0, max: PEQ_SHAPES.length - 1, curve: 'int', unit: '', options: PEQ_SHAPES.slice() };
  else if (type === 'bbd' && parameter === 0) { min = .005; max = .6; curve = 'exp'; unit = 's'; }
  else if (type === 'grainloop' && parameter === 0) { min = .02; max = 1; curve = 'exp'; unit = 's'; }
  else if (type === 'grainloop' && parameter === 1) return { min: 1, max: 16, curve: 'int', unit: '' };
  else if (type === 'grainloop' && parameter === 3) { min = -12; max = 12; unit = 'st'; }
  else if (type === 'tapeecho' && parameter === 0) { min = .04; max = .5; curve = 'exp'; unit = 's'; }
  else if (type === 'tapeecho' && parameter === 2) return { min: 0, max: TAPE_ECHO_HEADS.length - 1, curve: 'int', unit: '', options: TAPE_ECHO_HEADS.slice() };
  return { min, max, curve, unit };
}
export function formatFxParam(type, parameter, value) {
  const p = Math.max(0, Math.min(1, Number(value) || 0));
  if (type === 'eq4') return ((p * 24 - 12) >= 0 ? '+' : '') + (p * 24 - 12).toFixed(1) + ' dB';
  if (type === 'granular' && parameter === 0) return (p * 48 - 24).toFixed(1) + ' st';
  if (type === 'decimator' && parameter === 0) return Math.round(3 + p * 13) + ' bit';
  if (['delay', 'pingpong'].includes(type) && parameter === 0) return Math.round(20 * Math.pow(100, p)) + ' ms';
  if (type === 'ringmod' && parameter === 0) return Math.round(20 * Math.pow(100, p)) + ' Hz';
  if (['lowpass', 'highpass'].includes(type) && parameter === 0) return Math.round(20 * Math.pow(900, p)) + ' Hz';
  if (type === 'limiter' && parameter === 0) return (p * 12 - 12).toFixed(1) + ' dB';
  if (['compressor', 'duck', 'gate'].includes(type) && parameter === 0 && type !== 'duck') return Math.round((type === 'gate' ? -70 : -48) + p * (type === 'gate' ? 55 : 45)) + ' dB';
  if (type === 'duck' && parameter === 1) return Math.round(-48 + p * 42) + ' dB';
  if (['chorus', 'flanger', 'phaser'].includes(type) && parameter === 0) return (0.05 * Math.pow(100, p)).toFixed(2) + ' Hz';
  if (['tremolo', 'autopan'].includes(type) && parameter === 0) return (0.1 * Math.pow(200, p)).toFixed(2) + ' Hz';
  if (type === 'freqshift' && parameter === 0) { const hz = freqShiftHz(p); return (hz > 0 ? '+' : hz < 0 ? '-' : '') + (Math.abs(hz) < 100 ? Math.abs(hz).toFixed(1) : Math.round(Math.abs(hz))) + ' Hz'; }
  if (type === 'freqshift' && parameter === 2) return FREQ_SHIFT_DIRECTIONS[Math.round(p * 2)];
  if (type === 'freqshift' && parameter === 3) { const ms = Math.pow(500, p); return (ms < 10 ? ms.toFixed(1) : Math.round(ms)) + ' ms'; }
  if (type === 'hyper' && parameter === 0) return (0.05 * Math.pow(100, p)).toFixed(2) + ' Hz';
  if (type === 'hyper' && parameter === 1) return (p * 25).toFixed(1) + ' ct';
  if (type === 'filterseq' && parameter === 0) return FILTER_SEQ_PATTERNS[Math.round(p * (FILTER_SEQ_PATTERNS.length - 1))].name;
  if (type === 'vocoder' && parameter === 0) return String(Math.round(8 + p * 24));
  if (type === 'vocoder' && parameter === 1) { const st = p * 24 - 12; return (st >= 0 ? '+' : '') + st.toFixed(1) + ' st'; }
  if (type === 'vocoder' && parameter === 2) return Math.round(p * 100) + '%';
  if (type === 'transient' && parameter < 2) { const v = Math.round(p * 200 - 100); return (v > 0 ? '+' : '') + v + '%'; }
  if (type === 'transient' && parameter === 3) { const v = p * 24 - 12; return (v >= 0 ? '+' : '') + v.toFixed(1) + ' dB'; }
  if (type === 'trancegate' && parameter === 0) return TRANCE_PATTERNS[Math.round(p * (TRANCE_PATTERNS.length - 1))].name;
  if (type === 'trancegate' && parameter === 1) return TRANCE_RATES[Math.round(p * 2)];
  if (type === 'disperser' && parameter === 0) return Math.round(40 * Math.pow(200, p)) + ' Hz';
  if (type === 'disperser' && parameter === 1) return String(Math.round(1 + p * 31));
  if (type === 'tapestop' && parameter === 0) return p >= .5 ? 'Stop' : 'Play';
  if (type === 'tapestop' && (parameter === 1 || parameter === 2)) return (.05 + p * 1.95).toFixed(2) + ' s';
  if (type === 'reverser' && parameter === 0) return Math.round((.05 + p * .95) * 1000) + ' ms';
  if (type === 'peq' && parameter === 0) { const hz = 20 * Math.pow(1000, p); return hz < 1000 ? Math.round(hz) + ' Hz' : (hz / 1000).toFixed(1) + ' kHz'; }
  if (type === 'peq' && parameter === 1) { const v = p * 36 - 18; return (v >= 0 ? '+' : '') + v.toFixed(1) + ' dB'; }
  if (type === 'peq' && parameter === 2) return (.3 * Math.pow(40, p)).toFixed(2);
  if (type === 'peq' && parameter === 3) return PEQ_SHAPES[Math.round(p * (PEQ_SHAPES.length - 1))];
  if (type === 'bbd' && parameter === 0) { const ms = 5 * Math.pow(120, p); return (ms < 100 ? ms.toFixed(1) : Math.round(ms)) + ' ms'; }
  if (type === 'grainloop' && parameter === 0) return Math.round(20 * Math.pow(50, p)) + ' ms';
  if (type === 'grainloop' && parameter === 1) return String(Math.round(1 + p * 15));
  if (type === 'grainloop' && parameter === 3) { const st = Math.round(p * 24 - 12); return (st > 0 ? '+' : '') + st + ' st'; }
  if (type === 'tapeecho' && parameter === 0) return Math.round(40 * Math.pow(12.5, p)) + ' ms';
  if (type === 'tapeecho' && parameter === 2) return TAPE_ECHO_HEADS[Math.round(p * (TAPE_ECHO_HEADS.length - 1))];
  return Math.round(p * 100) + '%';
}
/** Frequency shifter amount: a cubic curve around the centre gives fine
 * control near 0 Hz and reaches +-2000 Hz at the ends. */
export function freqShiftHz(p) { const x = 2 * Math.max(0, Math.min(1, p)) - 1; return x * x * x * 2000; }
