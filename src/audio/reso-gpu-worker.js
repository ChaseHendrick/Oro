// GPU Resonator (2.12) worker: the host (reso-gpu-host.js) in a dedicated
// worker, where the browser offers WebGPU to workers. Bundled into a string
// by vite.config.js (virtual:worklet:...) and started from a Blob URL.

import { ResoGpuHost, openDevice } from './reso-gpu-host.js';

let host = null;
self.onmessage = async (e) => {
  const m = e.data;
  if (!m) return;
  if (m.t === 'init') {
    try {
      const device = await openDevice(self.navigator && self.navigator.gpu);
      host = new ResoGpuHost({ device, onStatus: (s) => self.postMessage({ t: 'status', s }) });
      self.postMessage({ t: 'hello', ok: true });
    } catch (err) {
      self.postMessage({ t: 'hello', ok: false, reason: String((err && err.message) || err) });
    }
  } else if (m.t === 'port' && host) {
    host.attachPort(m.port);
  } else if (m.t === 'offline' && host) {
    try {
      const wet = await host.renderOffline(m.job);
      self.postMessage({ t: 'offline', id: m.id, wet }, [wet.buffer]);
    } catch (err) {
      self.postMessage({ t: 'offline', id: m.id, error: String((err && err.message) || err) });
    }
  } else if (m.t === 'dispose' && host) {
    host.dispose(); host = null;
  }
};
