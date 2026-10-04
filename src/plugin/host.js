// What a plugin host would automate, and how the outputs are numbered.
// Output 1 is the master mix. Each track is another stereo pair.
// This is the contract for a host shell. It is not a VST, AU or CLAP binary.

export const HOST_TRACK_PARAMS = Object.freeze(['level', 'mute', 'morph', 'cutoff', 'resonance', 'attack', 'release']);

export function hostOutputs(trackCount) {
  const n = Math.max(0, Math.round(trackCount) || 0);
  const outs = [{ index: 1, name: 'Mix', left: 0, right: 1 }];
  for (let i = 0; i < n; i++) outs.push({ index: i + 2, name: `Track ${i + 1}`, left: 2 + i * 2, right: 3 + i * 2 });
  return outs;
}

/** First host parameters: master volume, then tracks 1 to 4. */
export function hostParamList(trackCount = 4) {
  const n = Math.min(4, Math.max(0, Math.round(trackCount) || 0));
  const list = [{ id: 'volume', scope: 'master' }];
  for (let i = 0; i < n; i++) {
    for (const id of HOST_TRACK_PARAMS) list.push({ id, scope: 'track', track: i });
  }
  return list;
}

export function applyHostParam(store, param, value) {
  if (!param) return null;
  if (param.scope === 'master' || param.id === 'volume') {
    store.set('global.masterVolume', value, { source: 'plugin' });
    return 'global.masterVolume';
  }
  const path = `parts.${param.track}.params.${param.id}`;
  store.set(path, value, { source: 'plugin' });
  return path;
}

export function pluginRequested(loc = typeof location !== 'undefined' ? location : null) {
  if (!loc || !loc.search) return false;
  return /(?:^|[?&])plugin=1(?:&|$)/.test(loc.search);
}
