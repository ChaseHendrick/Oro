// Main-thread bridge for a bounded stream of mono samples. One worker job is
// in flight; eight queued chunks cover startup without accumulating latency.
import code from 'virtual:worklet:src/pedals/guitar-chord-worker.js';
import { createGuitarAnalysis } from './guitar-analysis.js';

export const CHORD_QUEUE_LIMIT = 8;
const START_TIMEOUT_MS = 4000;

function startWorker(url, onCancel) {
  return new Promise(resolve => {
    let worker;
    try { worker = new Worker(url); } catch { resolve(null); return; }
    let settled = false;
    const finish = ok => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker.onmessage = null; worker.onerror = null;
      if (!ok) worker.terminate();
      resolve(ok ? worker : null);
    };
    const timer = setTimeout(() => finish(false), START_TIMEOUT_MS);
    onCancel(() => finish(false));
    worker.onmessage = event => { if (event.data?.t === 'pong') finish(true); };
    worker.onerror = event => { event?.preventDefault?.(); finish(false); };
    try { worker.postMessage({ t: 'ping' }); } catch { finish(false); }
  });
}

export function createChordRunner({ sampleRate, tracker = {}, emit, onReset = () => {} } = {}) {
  let config = { ...tracker }, revision = 0, nextId = 1;
  let worker = null, inline = null, disposed = false, inFlight = null;
  let cancelStartup = null;
  let mode = 'starting', dropouts = 0;
  const queue = [];
  const configureMessage = () => ({ t: 'config', sampleRate, tracker: config, revision });
  const deliver = message => {
    if (disposed) return;
    for (const event of message.events || []) emit(event);
    if (message.pitch) emit(message.pitch);
  };

  function runInline(data, time) {
    const before = inline.samples;
    const events = inline.process(data).map(event => ({ ...event, t: event.type, mode: 'chords', time: time + (event.sample - before) / sampleRate }));
    deliver({ events, pitch: { t: 'pitch', ...inline.pitch, time: time + data.length / sampleRate } });
  }
  function drain() {
    if (disposed || inFlight || mode === 'starting') return;
    if (inline) {
      while (queue.length) { const next = queue.shift(); runInline(next.data, next.time); }
      return;
    }
    if (!worker || !queue.length) return;
    const next = queue.shift();
    inFlight = { id: nextId++, revision };
    try {
      worker.postMessage({ t: 'samples', ...inFlight, sampleRate, ...next }, [next.data.buffer]);
    } catch { fallback(); }
  }
  function reset() {
    revision++;
    queue.length = 0;
    if (inline) inline = createGuitarAnalysis({ sampleRate, guitarMode: 'chords', tracker: config });
    if (worker) { try { worker.postMessage(configureMessage()); } catch { fallback(); } }
    onReset();
  }
  function fallback() {
    if (disposed) return;
    if (worker) { worker.onmessage = null; worker.onerror = null; worker.terminate(); }
    worker = null; inFlight = null; mode = 'inline';
    revision++;
    inline = createGuitarAnalysis({ sampleRate, guitarMode: 'chords', tracker: config });
    onReset();
    drain();
  }

  (async () => {
    if (typeof Worker !== 'function') { fallback(); return; }
    let blobUrl = null;
    try { blobUrl = URL.createObjectURL(new Blob([code], { type: 'text/javascript' })); } catch { /* use data URL */ }
    const candidates = [...(blobUrl ? [blobUrl] : []), 'data:text/javascript;charset=utf-8,' + encodeURIComponent(code)];
    for (const url of candidates) {
      const candidate = await startWorker(url, cancel => { cancelStartup = cancel; });
      cancelStartup = null;
      if (disposed) { candidate?.terminate(); break; }
      if (!candidate) continue;
      worker = candidate; mode = 'worker';
      worker.onmessage = event => {
        const m = event.data;
        if (disposed || !m || !inFlight || m.id !== inFlight.id) return;
        const matches = m.revision === revision;
        inFlight = null;
        if (m.t === 'error') { fallback(); return; }
        if (matches) deliver(m);
        drain();
      };
      worker.onerror = event => { event?.preventDefault?.(); fallback(); };
      try { worker.postMessage(configureMessage()); } catch { fallback(); }
      drain();
      break;
    }
    if (blobUrl) { try { URL.revokeObjectURL(blobUrl); } catch { /* ignore */ } }
    if (!disposed && mode === 'starting') fallback();
  })();

  return {
    process(data, time) {
      if (disposed) return;
      if (inline) { runInline(data, time); return; }
      if (queue.length >= CHORD_QUEUE_LIMIT) { dropouts++; reset(); }
      queue.push({ data, time });
      drain();
    },
    configure(update = {}, { restart = false } = {}) {
      if (disposed) return;
      config = { ...config, ...update };
      if (restart) reset();
      else if (inline) inline.configure({ tracker: config });
      else if (worker) { try { worker.postMessage(configureMessage()); } catch { fallback(); } }
    },
    get mode() { return mode; },
    get dropouts() { return dropouts; },
    get queued() { return queue.length; },
    dispose() {
      if (disposed) return;
      disposed = true; queue.length = 0;
      cancelStartup?.(); cancelStartup = null;
      if (worker) { worker.onmessage = null; worker.onerror = null; worker.terminate(); }
      worker = null; inline = null;
    },
  };
}
