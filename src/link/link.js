// Ableton Link needs a native library whose licence is GPL.
// Oro is MIT, so that library is not included. The desktop app can still
// show the controls. Until a separate build provides the library, status
// stays "Not in this build" and nothing on the network is contacted.

export function desktopApp() {
  return typeof navigator !== 'undefined' && /Electron\//.test(navigator.userAgent || '');
}

export function createLink() {
  let on = false;
  let startStop = false;
  let peers = 0;
  let playing = false;
  let available = false;
  const listeners = new Set();
  function emit() { for (const fn of listeners) fn(); }
  return {
    get on() { return on; },
    get startStop() { return startStop; },
    get peers() { return peers; },
    get available() { return available; },
    setAvailable(v) { available = !!v; emit(); },
    setOn(v) { on = !!v; if (!on) peers = 0; emit(); },
    setStartStop(v) { startStop = !!v; emit(); },
    setPeers(n) { peers = Math.max(0, Math.round(n) || 0); emit(); },
    setPlaying(v) { playing = !!v; emit(); },
    status() {
      if (!on) return '';
      if (!available) return 'Not in this build';
      if (peers <= 0) return 'Looking';
      const word = peers === 1 ? '1 peer' : `${peers} peers`;
      if (!startStop) return word;
      return playing ? `${word}, playing` : `${word}, stopped`;
    },
    onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
  };
}
