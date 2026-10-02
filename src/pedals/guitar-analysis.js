// Shared detector adapter for the chord Worker and main-thread fallback.
// Changing mode releases every old note before the new detector starts.
import { createPitchTracker } from './pitch.js';
import { createChordTracker } from './chords.js';

export const normalizeGuitarMode = (value) => value === 'chords' ? 'chords' : 'single';

export function createGuitarAnalysis({ sampleRate = 48000, guitarMode = 'single', tracker = {} } = {}) {
  let mode = normalizeGuitarMode(guitarMode);
  let options = { ...tracker };
  const held = new Set();
  const make = () => (mode === 'chords' ? createChordTracker : createPitchTracker)({ ...options, sampleRate });
  let detector = make();

  function release() {
    const sample = detector.samples;
    const events = [...held].map(note => ({ type: 'noteOff', note, sample, time: sample / sampleRate }));
    held.clear();
    return events;
  }

  return {
    process(block) {
      const events = detector.process(block);
      for (const event of events) {
        if (event.type === 'noteOn') held.add(event.note);
        else if (event.type === 'noteOff') held.delete(event.note);
      }
      return events;
    },
    configure({ guitarMode: value, tracker: update = {} } = {}) {
      options = { ...options, ...update };
      const next = value === undefined ? mode : normalizeGuitarMode(value);
      if (next === mode) { detector.configure(update); return []; }
      const events = release();
      mode = next;
      detector = make();
      return events;
    },
    reset() {
      const events = release();
      detector = make();
      return events;
    },
    release,
    get samples() { return detector.samples; },
    get mode() { return mode; },
    get notes() { return [...held].sort((a, b) => a - b); },
    get pitch() {
      const frame = detector.lastFrame;
      if (mode === 'chords') {
        const notes = [...held].sort((a, b) => a - b);
        return { mode, notes, heard: [...(frame.heard || [])], voiced: notes.length > 0 };
      }
      return { mode, freq: frame.freq, midi: frame.midi, clarity: frame.clarity, voiced: frame.voiced };
    },
  };
}
