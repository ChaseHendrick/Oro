import { REPLACE_TRACKS } from '../core/tracks.js';
import { encodeNoiseRecording, MAX_NOISE_SECONDS } from '../dsp/noise-recording.js';

/** Decode a recording and keep its destination attached to the original track. */
export async function importNoiseRecording(store, context, part, file) {
  if (!context) throw new Error('Audio import needs Web Audio');
  const trackId = Number.isInteger(part) && part >= 0 ? store.get(`parts.${part}.id`) : null;
  if (typeof trackId !== 'string' || !trackId) throw new Error('Choose an existing track for the recording');
  if (file.size > 64 * 1024 * 1024) throw new Error('Choose an audio file smaller than 64 MB');
  let removed = false;
  const unsubscribe = store.subscribe('', (path, value, meta) => {
    if (path !== '' && path !== 'parts') return;
    // A later track may reuse this ID. Once removed or replaced, this import
    // must stay cancelled even if that ID reappears before decoding finishes.
    const parts = path === 'parts' ? value : store.get('parts');
    if (path === '' || meta?.[REPLACE_TRACKS] || !parts.some(track => track.id === trackId)) removed = true;
  });
  try {
    const buffer = await context.decodeAudioData(await file.arrayBuffer());
    const destination = store.get('parts').findIndex(track => track.id === trackId);
    if (removed || destination < 0) throw new Error('The track was removed or replaced while the recording was decoding');
    const length = Math.min(buffer.length, Math.round(context.sampleRate * MAX_NOISE_SECONDS));
    const mono = new Float32Array(length);
    for (let c = 0; c < buffer.numberOfChannels; c++) {
      const data = buffer.getChannelData(c);
      for (let i = 0; i < length; i++) mono[i] += data[i] / buffer.numberOfChannels;
    }
    const recording = encodeNoiseRecording(mono, context.sampleRate, file.name);
    store.batch(() => {
      store.set(`parts.${destination}.noiseRecording`, recording, { source: 'import' });
      store.set(`parts.${destination}.params.airType`, 8, { source: 'import' });
    });
    return recording;
  } finally {
    unsubscribe();
  }
}
