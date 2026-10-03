// 2.12 GPU Resonator controls in the Resonator card: Engine (CPU or GPU),
// GPU detail and a short status. Shown only where the browser has WebGPU.
// The choice lasts for the session (store ui.resoEngine / ui.resoGpuDetail).

import { h, createScope } from './dom.js';

const DETAILS = [[128, 'Fine (128)'], [192, 'Finer (192)'], [256, 'Finest (256)']];

export function hasWebGpu(nav = globalThis.navigator) {
  return !!(nav && nav.gpu && typeof nav.gpu.requestAdapter === 'function');
}

export function createResoEngineRow(ctx) {
  if (!hasWebGpu()) return null;
  const scope = createScope();
  const { store, engine } = ctx;
  const sel = (label, options) => h('select', { class: 'select-native', 'aria-label': label },
    ...options.map(([v, t]) => h('option', { value: String(v) }, t)));
  const engineSel = sel('Resonator engine', [['cpu', 'CPU'], ['gpu', 'GPU (WebGPU)']]);
  const detailSel = sel('GPU detail', DETAILS);
  const status = h('span', { class: 'section-aside reso-gpu-status', role: 'status' });
  const field = (label, el) => h('label', { class: 'sound-field' }, h('span', { class: 'mini-label' }, label), h('div', { class: 'select select--sm' }, el));
  const detailField = field('GPU detail', detailSel);
  const el = h('div', { class: 'sound-selects reso-engine' }, field('Engine', engineSel), detailField, status);
  let noticed = false, latency = 0;
  const render = () => {
    const gpu = store.get('ui.resoEngine') === 'gpu';
    engineSel.value = gpu ? 'gpu' : 'cpu';
    detailSel.value = String(store.get('ui.resoGpuDetail') || 128);
    detailField.hidden = !gpu;
    if (!gpu && !status.dataset.fallback) status.textContent = '';
  };
  scope.on(engineSel, 'change', () => { status.dataset.fallback = ''; store.set('ui.resoEngine', engineSel.value, { source: 'ui' }); if (engineSel.value === 'gpu') status.textContent = 'Starting the GPU...'; });
  scope.on(detailSel, 'change', () => store.set('ui.resoGpuDetail', Number(detailSel.value), { source: 'ui' }));
  scope.add(store.subscribe('ui.resoEngine', render));
  scope.add(store.subscribe('ui.resoGpuDetail', render));
  if (engine && typeof engine.on === 'function') {
    scope.add(engine.on('resoGpu', (m) => {
      if (m.ev === 'started') { latency = m.latencyMs; status.textContent = `Running, adds about ${Math.round(latency)} ms`; }
      else if (m.ev === 'status' && store.get('ui.resoEngine') === 'gpu') {
        status.textContent = !m.onGpu ? 'Starting the GPU...'
          : m.headroomMs < 3 ? `Falling behind (${Math.round(m.latencyMs)} ms latency)` : `Running, adds about ${Math.round(m.latencyMs)} ms`;
      } else if (m.ev === 'fallback') {
        status.dataset.fallback = '1';
        status.textContent = 'Back on the CPU';
        if (!noticed && ctx.toast) { noticed = true; ctx.toast('The Resonator is back on the CPU', { kind: 'info', detail: m.reason }); }
      }
    }));
  }
  render();
  return { el, dispose: scope.dispose };
}
