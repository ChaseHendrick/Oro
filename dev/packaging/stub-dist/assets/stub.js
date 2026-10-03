// Self-test page for the Electron shell (stand-in for the real dist/ build).
// Each probe records a value; tests/e2e/electron-smoke.cjs reads window.__stub
// and decides what is a pass. The table is only there for the screenshot.

const results = {};
const violations = [];
document.addEventListener('securitypolicyviolation', (e) => {
  violations.push(`${e.effectiveDirective} ${e.blockedURI || 'inline'}`);
});

async function probe(name, fn) {
  try {
    results[name] = await fn();
  } catch (err) {
    results[name] = `error: ${err && err.name ? err.name + ': ' : ''}${err && err.message ? err.message : err}`;
  }
}

const loadImage = (src) => new Promise((resolve, reject) => {
  const img = new Image();
  img.onload = () => resolve(img.naturalWidth);
  img.onerror = () => reject(new Error(`could not load ${src}`));
  img.src = src;
});

const withTimeout = (promise, ms, label) => Promise.race([
  promise,
  new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out`)), ms)),
]);

await probe('href', () => location.href);
await probe('secureContext', () => isSecureContext);
await probe('inlineScript', () => window.__inlineRan === true);
await probe('css', () => getComputedStyle(document.documentElement).getPropertyValue('--stub-css').trim());
await probe('wasm', async () => {
  const { instance } = await WebAssembly.instantiateStreaming(fetch('./assets/add.wasm'));
  return instance.exports.add(2, 3);
});
await probe('json', async () => (await (await fetch('./assets/data.json')).json()).ok);
await probe('rangeRequest', async () => {
  const res = await fetch('./assets/data.json', { headers: { Range: 'bytes=0-5' } });
  return `${res.status} ${await res.text()}`;
});
await probe('png', () => loadImage('./icon-512.png'));
await probe('svg', () => loadImage('./favicon.svg'));
await probe('manifest', async () => (await (await fetch('./manifest.webmanifest')).json()).name);
await probe('worker', () => withTimeout(new Promise((resolve, reject) => {
  const url = URL.createObjectURL(new Blob(['onmessage = (e) => postMessage(e.data * 2);'], { type: 'text/javascript' }));
  const worker = new Worker(url);
  worker.onmessage = (e) => { resolve(e.data); worker.terminate(); };
  worker.onerror = (e) => reject(new Error(e.message || 'worker error'));
  worker.postMessage(21);
}), 5000, 'worker'));
await probe('audioWorklet', () => withTimeout((async () => {
  const ctx = new AudioContext();
  const src = "registerProcessor('stub-tone', class extends AudioWorkletProcessor { process() { return true; } });";
  const url = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
  await ctx.audioWorklet.addModule(url);
  const node = new AudioWorkletNode(ctx, 'stub-tone');
  node.connect(ctx.destination);
  await ctx.resume();
  const state = ctx.state;
  await ctx.close();
  return state;
})(), 8000, 'audioWorklet'));
await probe('localStorage', () => {
  const n = Number(localStorage.getItem('stub.launches') || 0) + 1;
  localStorage.setItem('stub.launches', String(n));
  return n;
});
await probe('midiPermission', async () => (await navigator.permissions.query({ name: 'midi' })).state);
await probe('sysexPermission', async () => (await navigator.permissions.query({ name: 'midi', sysex: true })).state);
await probe('midiAccess', () => withTimeout(navigator.requestMIDIAccess().then(
  (access) => `granted (${access.inputs.size} in, ${access.outputs.size} out)`,
), 8000, 'requestMIDIAccess'));
await probe('sysexAccess', () => withTimeout(navigator.requestMIDIAccess({ sysex: true }).then(() => 'granted'), 8000, 'sysex'));
await probe('microphoneCapture', () => withTimeout(navigator.mediaDevices.getUserMedia({ audio: true }).then((stream) => {
  stream.getTracks().forEach((t) => t.stop());
  return 'granted';
}), 8000, 'getUserMedia'));
await probe('geolocationPermission', async () => (await navigator.permissions.query({ name: 'geolocation' })).state);
await probe('injectedScriptBlocked', () => {
  const s = document.createElement('script');
  s.textContent = 'window.__injected = true;';
  document.head.appendChild(s);
  return window.__injected !== true;
});
await probe('remoteFetchBlocked', async () => {
  try {
    await fetch('https://example.com/');
    return false;
  } catch {
    return true;
  }
});
await probe('traversalStatus', async () => (await fetch('/..%2f..%2fpackage.json')).status);
await probe('missingStatus', async () => (await fetch('./assets/no-such-file.js')).status);
// Let violation events from the probes above arrive.
await new Promise((r) => setTimeout(r, 50));
results.cspViolations = violations.slice();

window.__stub = { done: true, results };
document.title = 'Oro stub ready';

const tbody = document.querySelector('#results tbody');
for (const [key, value] of Object.entries(results)) {
  const row = document.createElement('tr');
  const k = document.createElement('td');
  const v = document.createElement('td');
  k.textContent = key;
  v.textContent = Array.isArray(value) ? value.join(' | ') : String(value);
  v.className = /^error/.test(String(value)) ? 'fail' : 'pass';
  row.append(k, v);
  tbody.append(row);
}
