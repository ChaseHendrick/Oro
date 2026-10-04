// Voice chat policy. Playback is an HTML audio element, never the synth
// AudioContext, so bounces, the looper and stems cannot hear it.

export const VOICE_CONSTRAINTS = Object.freeze({
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
});

export const DEFAULT_PTT_KEY = 'n';

export function voiceGraphTouchesEngine() { return false; }

export function createVoicePolicy({ key = DEFAULT_PTT_KEY, mode = 'ptt' } = {}) {
  let ptt = String(key || DEFAULT_PTT_KEY).toLowerCase();
  let open = mode === 'open';
  let joined = false;
  let muted = false;
  let deaf = false;
  const down = new Set();
  const volumes = new Map();
  return {
    constraints: VOICE_CONSTRAINTS,
    join(on = true) { joined = !!on; },
    get joined() { return joined; },
    setMode(next) { open = next === 'open'; },
    setKey(k) { ptt = String(k || DEFAULT_PTT_KEY).toLowerCase(); },
    get key() { return ptt; },
    get mode() { return open ? 'open' : 'ptt'; },
    keyDown(k) { down.add(String(k).toLowerCase()); },
    keyUp(k) { down.delete(String(k).toLowerCase()); },
    setMuted(on) { muted = !!on; },
    setDeaf(on) { deaf = !!on; },
    setVolume(id, v) { volumes.set(id, Math.max(0, Math.min(1, Number(v) || 0))); },
    volume(id) { return deaf ? 0 : (volumes.has(id) ? volumes.get(id) : 1); },
    /** True when this person's mic should be sent. */
    sending() {
      if (!joined || muted) return false;
      return open || down.has(ptt);
    },
  };
}

/** Records play calls. Throws if handed the synth engine. */
export function createVoiceSink() {
  const played = [];
  return {
    play(el) {
      if (el && el.oroEngine) throw new Error('Voice must not use the synth engine');
      played.push(el);
    },
    played,
  };
}
