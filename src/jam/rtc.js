// A link is { send(text), close(), onmessage(fn) }. Tests use a memory pair.
// Browsers use RTCPeerConnection. STUN is off unless asked for.

export const STUN_SERVER = Object.freeze({ urls: 'stun:stun.l.google.com:19302' });

export function iceServers(stun) {
  return stun ? [STUN_SERVER] : [];
}

export function createMemoryLink() {
  const ends = [make(), make()];
  function make() { return { handler: null, closed: false }; }
  function face(self, other) {
    return {
      send(text) { if (!self.closed && !other.closed && other.handler) other.handler(text); },
      close() { self.closed = true; },
      onmessage(fn) { self.handler = fn; },
      get closed() { return self.closed; },
    };
  }
  return [face(ends[0], ends[1]), face(ends[1], ends[0])];
}

export function rtcAvailable() {
  return typeof globalThis.RTCPeerConnection === 'function';
}

/**
 * One WebRTC peer. `polite` is the joiner (the host creates the data channel).
 * `link` queues text until the channel is open. Returns null when this
 * runtime has no RTCPeerConnection.
 */
export function createPeerSession({ stun = false, polite = false, RTCPeerConnection: RTC = globalThis.RTCPeerConnection, onRemoteAudio } = {}) {
  if (typeof RTC !== 'function') return null;
  const pc = new RTC({ iceServers: iceServers(!!stun) });
  let channel = null;
  let handler = null;
  let audioSender = null;
  const queue = [];
  try {
    const transceiver = pc.addTransceiver('audio', { direction: 'sendrecv' });
    audioSender = transceiver && transceiver.sender;
  } catch { /* a stand-in connection may not carry audio */ }
  if (typeof pc.addEventListener === 'function' || 'ontrack' in pc) {
    pc.ontrack = (ev) => {
      if (typeof document === 'undefined' || typeof onRemoteAudio !== 'function') return;
      const track = ev && (ev.track || (ev.streams && ev.streams[0] && ev.streams[0].getAudioTracks && ev.streams[0].getAudioTracks()[0]));
      if (!track) return;
      const stream = ev.streams && ev.streams[0] ? ev.streams[0] : new MediaStream([track]);
      const audio = document.createElement('audio');
      audio.autoplay = true;
      audio.setAttribute('playsinline', '');
      audio.srcObject = stream;
      onRemoteAudio(audio);
    };
  }
  function flush() {
    if (!channel || channel.readyState !== 'open') return;
    while (queue.length) {
      try { channel.send(queue.shift()); } catch { break; }
    }
  }
  function attach(ch) {
    channel = ch;
    ch.onmessage = (e) => { if (handler) handler(e.data); };
    ch.onopen = flush;
    flush();
  }
  if (!polite) attach(pc.createDataChannel('oro'));
  else pc.ondatachannel = (ev) => { if (ev && ev.channel) attach(ev.channel); };
  function waitIce() {
    if (pc.iceGatheringState === 'complete') return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, 4000);
      const done = () => { clearTimeout(timer); resolve(); };
      pc.addEventListener('icegatheringstatechange', () => {
        if (pc.iceGatheringState === 'complete') done();
      });
    });
  }
  function desc() {
    const d = pc.localDescription;
    return d ? { type: d.type, sdp: d.sdp } : null;
  }
  return {
    pc,
    link: {
      send(text) {
        const s = String(text);
        if (channel && channel.readyState === 'open') {
          try { channel.send(s); } catch { queue.push(s); }
        } else queue.push(s);
      },
      close() { try { pc.close(); } catch { /* already closed */ } },
      onmessage(fn) { handler = fn; },
    },
    async offer() {
      const d = await pc.createOffer();
      await pc.setLocalDescription(d);
      await waitIce();
      return desc();
    },
    async answer(remote) {
      await pc.setRemoteDescription(remote);
      const d = await pc.createAnswer();
      await pc.setLocalDescription(d);
      await waitIce();
      return desc();
    },
    async acceptReply(remote) {
      await pc.setRemoteDescription(remote);
    },
    /** Swap the microphone without a second invite. Null sends silence. */
    async setMic(track) {
      if (audioSender && typeof audioSender.replaceTrack === 'function') await audioSender.replaceTrack(track || null);
    },
  };
}

