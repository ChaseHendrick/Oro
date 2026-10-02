// Bundled as a classic worker string for web, offline HTML and Electron.
// Spectral chord estimation stays off the audio rendering thread.
import { createGuitarAnalysis } from './guitar-analysis.js';

export function createChordWorkerCore(post) {
  let analysis = null, revision = -1;
  return function handle(message) {
    const m = message || {};
    if (m.t === 'ping') { post({ t: 'pong' }); return; }
    if (m.t === 'config') {
      if (!analysis || revision !== m.revision) {
        analysis = createGuitarAnalysis({ sampleRate: m.sampleRate, guitarMode: 'chords', tracker: m.tracker });
        revision = m.revision;
      } else analysis.configure({ tracker: m.tracker });
      return;
    }
    if (m.t !== 'samples') return;
    if (!analysis || m.revision !== revision) {
      post({ t: 'result', id: m.id, revision: m.revision, events: [] });
      return;
    }
    const before = analysis.samples;
    try {
      const events = analysis.process(m.data).map(event => ({
        ...event, t: event.type, mode: 'chords', time: m.time + (event.sample - before) / m.sampleRate,
      }));
      post({ t: 'result', id: m.id, revision, events, pitch: { t: 'pitch', ...analysis.pitch, time: m.time + m.data.length / m.sampleRate } });
    } catch (error) {
      post({ t: 'error', id: m.id, revision, message: String(error?.message || error) });
    }
  };
}

if (typeof self !== 'undefined') {
  const handle = createChordWorkerCore(message => self.postMessage(message));
  self.onmessage = event => handle(event.data);
}
