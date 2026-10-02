// Orograph's 3D map.
//
//   const visuals = await createVisuals(containerEl, { store, engine });
//   visuals.resize(); visuals.setQuality('high' | 'medium' | 'low'); visuals.dispose();
//   visuals.setView('orbit' | 'top' | 'low'); visuals.toggleAutoRotate(); visuals.setAutoRotate(on)
//   visuals.setRenderStyle('relief' | 'wire' | 'contour' | 'heat'); visuals.setPalette(i); visuals.palettes
//
// Shows the selected part's terrain (warp / morph / lift driven by the
// engine's telemetry), its live orbit and the dot. Click or tap the land to
// glide the dot there, drag it to move it exactly, orbit with right / middle
// drag, two fingers or a left drag on the sky, zoom with the wheel or a pinch.
// Writes parts.N.params.centerX / centerY with { source: 'visual' }.
//
// Frame loop order: atmosphere -> transitions -> live parameters -> physics
// and pointer -> store writes -> orbit / dot / uniforms -> camera -> HUD ->
// render. Nothing in that loop allocates.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

import { NUM_PARTS } from '../core/params.js';
import { wrapDelta, wrap01 } from '../dsp/terrain-math.js';
import { HeightField, W, H, intersectRay, displayLift, uToX, wrapWorld } from './heightfield.js';
import { PALETTES, PALETTE_INFO, HEAT_RAMP, makeAtmosphere, blendAtmosphere, blendRamp, hexToLinear, sceneColorLinear } from './palettes.js';
import { LiveParams, TELE_STALE_MS, isModulated } from './modstate.js';
import { createPhysics, BALL_RADIUS, MODE_PIN, MODE_ROLL } from './physics.js';
import { createTerrainLayer } from './terrain-layer.js';
import { createSkyLayer } from './sky-layer.js';
import { createOrbitLayer, flowRate } from './orbit-layer.js';
import { createDotLayer } from './dot-layer.js';
import { createEnvironment } from './env.js';
import { createCameraRig, FOV, VIEW_NAMES } from './camera-rig.js';
import { createTerrainCache } from './terrain-cache.js';
import { createMinimap, createOverlay } from './hud.js';

export const QUALITY = {
  high: { pixelRatio: 2, bloom: true, samples: 4 },
  medium: { pixelRatio: 1.5, bloom: true, samples: 4 },
  low: { pixelRatio: 1, bloom: false, samples: 0 },
};
export const RENDER_STYLES = ['relief', 'wire', 'contour', 'heat', 'points'];
const META = Object.freeze({ source: 'visual' });
const FADE_SECONDS = 0.3;
const SWITCH_SECONDS = 0.35;
const WRITE_MS_SELECTED = 15;
const WRITE_MS_OTHER = 50;
const GLIDE_MS = 420;
const ARIA = 'Terrain map. Click or tap the land to move the dot there, or drag the dot. ' +
  'Drag the sky, right-drag or use two fingers to turn the view; scroll or pinch to zoom. ' +
  'Arrow keys nudge the dot; hold Shift for fine steps. Plus and minus zoom.';

function reducedMotionPreferred() {
  if (typeof document !== 'undefined' && document.documentElement.dataset.motion === 'reduce') return true;
  try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; }
}

function easeOutCubic(t) { return 1 - Math.pow(1 - t, 3); }

export async function createVisuals(container, { store, engine = null, quality } = {}) {
  if (!container) throw new Error('createVisuals needs a container element');

  // ------------------------------------------------------------------ renderer
  const renderer = new THREE.WebGLRenderer({ antialias: false, alpha: false, powerPreference: 'high-performance', stencil: false });
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.setClearColor(0x05070f, 1);
  renderer.info.autoReset = false;  // count every pass of a frame, reset once per frame
  const canvas = renderer.domElement;
  canvas.className = 'og-canvas';
  canvas.tabIndex = 0;
  canvas.setAttribute('role', 'application');
  canvas.setAttribute('aria-label', ARIA);
  canvas.setAttribute('aria-roledescription', '3D terrain map');
  canvas.style.cssText = 'display:block;width:100%;height:100%;touch-action:none;outline:none;';
  container.insertBefore(canvas, container.firstChild);
  if (getComputedStyle(container).position === 'static') container.style.position = 'relative';

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(FOV, 1.6, 0.1, 1200);
  camera.position.set(0, 10, 13);

  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.enablePan = false;
  controls.minDistance = 4.5;
  controls.maxDistance = 46;
  controls.maxPolarAngle = 1.42;
  controls.rotateSpeed = 0.62;
  controls.zoomSpeed = 0.9;
  controls.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.ROTATE, RIGHT: THREE.MOUSE.ROTATE };
  controls.touches = { ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_ROTATE };
  const rig = createCameraRig(camera, controls, () => clock);

  // ------------------------------------------------------------------ layers
  let qualityName = QUALITY[quality] ? quality : (QUALITY[store.get('ui.quality')] ? store.get('ui.quality') : 'high');
  const terrain = createTerrainLayer(renderer, qualityName);
  const sky = createSkyLayer(qualityName);
  const orbit = createOrbitLayer(qualityName);
  const dot = createDotLayer();
  const env = createEnvironment(renderer);
  scene.add(sky.sky, terrain.mesh, sky.points, orbit.group, dot.group);
  for (let i = 0; i < 6; i++) terrain.uniforms.uHeat.value[i].fromArray(HEAT_RAMP[i]);

  // Lights for the physical materials (marble, ghost); the terrain shader
  // reads the same colours from its own uniforms.
  const keyLight = new THREE.DirectionalLight(0xffffff, 1);
  const hemi = new THREE.HemisphereLight(0xffffff, 0x222222, 0.5);
  scene.add(keyLight, hemi);

  // ------------------------------------------------------------------ post
  let composer = null, bloom = null, renderPass = null, outputPass = null;
  let width = 1, height = 1, pixelRatio = 1;

  function buildComposer() {
    if (composer) {
      composer.renderTarget1.dispose();
      composer.renderTarget2.dispose();
      if (bloom) bloom.dispose();
      if (outputPass) outputPass.dispose();
    }
    const q = QUALITY[qualityName];
    const rt = new THREE.WebGLRenderTarget(Math.max(1, width * pixelRatio), Math.max(1, height * pixelRatio), {
      type: THREE.HalfFloatType, samples: q.samples,
    });
    composer = new EffectComposer(renderer, rt);
    renderPass = new RenderPass(scene, camera);
    composer.addPass(renderPass);
    bloom = new UnrealBloomPass(new THREE.Vector2(Math.max(1, width), Math.max(1, height)), 0.5, 0.5, 0.7);
    bloom.enabled = q.bloom;
    composer.addPass(bloom);
    outputPass = new OutputPass();
    composer.addPass(outputPass);
    composer.setPixelRatio(pixelRatio);
    composer.setSize(Math.max(1, width), Math.max(1, height));
  }

  // ------------------------------------------------------------------ state
  const view = new HeightField();                       // what is displayed (with crossfades)
  const fields = Array.from({ length: NUM_PARTS }, () => new HeightField()); // physics, per part
  const live = new LiveParams();
  const atm = makeAtmosphere();
  const ramp = Array.from({ length: 6 }, () => [0, 0, 0]);
  const partLin = Array.from({ length: NUM_PARTS }, (_, i) => hexToLinear(store.get(`parts.${i}.color`) || '#ffffff'));
  const colCur = [1, 0.5, 0.3];      // displayed part colour (scene-adjusted), eased
  const colTarget = [1, 0.5, 0.3];
  const colCss = { value: '#ffffff' };
  const PATH_CX = [], PATH_CY = [];
  for (let p = 0; p < NUM_PARTS; p++) { PATH_CX.push(`parts.${p}.params.centerX`); PATH_CY.push(`parts.${p}.params.centerY`); }

  let refs = [];                     // cached store sub-objects per part
  function refreshRefs() {
    refs = [];
    for (let p = 0; p < NUM_PARTS; p++) {
      const part = store.get(`parts.${p}`) || {};
      refs.push({ params: part.params || {}, mods: part.mods || {}, dot: part.dot || {}, links: part.links || null, color: part.color || '#ffffff' });
    }
  }
  refreshRefs();

  let sel = clampPart(store.get('ui.selectedPart'));
  let themeT = document.documentElement.dataset.theme === 'light' ? 1 : 0;
  let themeTarget = themeT;
  let themeDirty = true;
  // Animation clock (ms): advances with every frame (and the off-screen
  // physics timer). Glides, camera moves and write throttles run on it, so
  // test stepping (debug.advance) and real frames behave identically.
  let clock = 0;
  let envT = -1;
  let paletteIndex = Number.isInteger(store.get('ui.palette')) ? store.get('ui.palette') : 0;
  let styleIndex = Math.max(0, RENDER_STYLES.indexOf(store.get('ui.renderStyle')));
  let reduced = reducedMotionPreferred();
  rig.setReducedMotion(reduced);
  rig.setAutoRotate(store.get('ui.autoRotate') !== 0 && store.get('ui.autoRotate') !== false);

  let tele = null, teleAt = -1e9, teleSpin = 0, teleSpinAt = 0;
  let spinPhase = 0, flowHead = 0, level = 0, levelTarget = 0, time = 0;
  let switchT = 1;                   // 0..1 progress of a part switch
  const dispOffset = { u: 0, v: 0 }; // decaying display offset after a part switch
  const fade = { A: 1, B: 1 };
  const lastWrite = new Float64Array(NUM_PARTS);
  const pendingWrite = new Uint8Array(NUM_PARTS);
  const pendU = new Float64Array(NUM_PARTS), pendV = new Float64Array(NUM_PARTS);
  const ghost = { a: 0 };
  const dotPos = { u: 0.5, v: 0.5, x: 0, y: 0, z: 0 };
  let dotScale = 1;
  const orbitLive = { stretch: 0, size: 0.22, rotate: 0, centerX: 0.5, centerY: 0.5 };
  const clearColor = new THREE.Color();
  let minimapVersion = -1;
  const hit = { x: 0, y: 0, z: 0, t: 0, u: 0, v: 0 };
  const ndc = new THREE.Vector2();
  const raycaster = new THREE.Raycaster();
  const projV = new THREE.Vector3();
  let rect = canvas.getBoundingClientRect();

  // Dot control for the selected part: idle | glide | drag.
  const ctl = {
    mode: 'idle', u: 0.5, v: 0.5,
    fromU: 0, fromV: 0, toU: 0, toV: 0, t0: 0, dur: GLIDE_MS,
    hist: new Float64Array(8 * 3), histN: 0, histI: 0,
  };

  // ------------------------------------------------------------------ physics
  const physics = createPhysics({ fieldFor: (p) => fields[p] });
  function syncPhysicsPart(p) {
    const r = refs[p];
    physics.setParams(p, r.dot);
    const mode = Number.isFinite(r.dot.mode) ? r.dot.mode : MODE_PIN;
    // a part that starts rolling needs its land, even when it is not shown
    if (mode !== MODE_PIN && !fields[p].ready) {
      for (const slot of ['A', 'B']) { const e = cache.get(p, slot); fields[p].setTable(slot, e.data, e.size, false); }
    }
    physics.setMode(p, mode, num(r.params.centerX, 0.5), num(r.params.centerY, 0.5));
    schedule(); // a rolling part keeps simulating even while the map is off-screen
  }

  // ------------------------------------------------------------------ terrain
  const cache = createTerrainCache({
    store, engine,
    onChange(part, slot, entry) {
      fields[part].setTable(slot, entry.data, entry.size, false);
      if (part === sel) showTable(slot, entry, true);
      minimapDirty = true;
    },
  });

  function showTable(slot, entry, crossfade) {
    const xf = crossfade && !reduced;
    view.setTable(slot, entry.data, entry.size, xf);
    terrain.setTable(slot, entry.data, entry.size, xf);
    fade[slot] = xf ? 0 : 1;
    terrain.setFade(fade.A, fade.B);
  }

  function loadPart(p, crossfade) {
    for (const slot of ['A', 'B']) {
      const e = cache.get(p, slot);
      fields[p].setTable(slot, e.data, e.size, false);
      if (p === sel) showTable(slot, e, crossfade);
    }
  }

  // ------------------------------------------------------------------ HUD
  const overlay = createOverlay(container);
  let minimapDirty = true;
  let minimapAt = 0, minimapImgAt = 0;
  const minimap = createMinimap(container, {
    onPick(u, v, phase) {
      rig.poke();
      cancelGlide();
      ctl.mode = phase === 'end' ? 'idle' : 'drag';
      ctl.u = u; ctl.v = v;
      if (phase === 'end') {
        if (physics.isActive(sel)) physics.release(sel, 0, 0);
      } else if (physics.isActive(sel)) {
        physics.hold(sel, u, v);
      }
      queueWrite(sel, u, v, true);
    },
  });

  // ------------------------------------------------------------------ helpers
  function num(v, d) { return typeof v === 'number' && Number.isFinite(v) ? v : d; }
  function clampPart(p) { const n = Math.round(num(p, 0)); return n < 0 ? 0 : n >= NUM_PARTS ? NUM_PARTS - 1 : n; }

  function queueWrite(p, u, v, now) {
    pendU[p] = wrap01(u); pendV[p] = wrap01(v);
    pendingWrite[p] = 1;
    if (now) flushWrite(p, clock, true);
  }

  function flushWrite(p, t, force) {
    if (!pendingWrite[p]) return;
    const interval = p === sel ? WRITE_MS_SELECTED : WRITE_MS_OTHER;
    if (!force && t - lastWrite[p] < interval) return;
    const u = Math.round(pendU[p] * 1e6) / 1e6, v = Math.round(pendV[p] * 1e6) / 1e6;
    pendingWrite[p] = 0;
    lastWrite[p] = t;
    const params = refs[p].params;
    if (params.centerX === u && params.centerY === v) return;
    wPart = p; wU = u === 1 ? 0 : u; wV = v === 1 ? 0 : v;
    writing = true;
    try { store.batch(writeBatch); } finally { writing = false; }
  }
  // Batched write without a fresh closure per call (this runs up to 60 Hz per part).
  let writing = false, wPart = 0, wU = 0, wV = 0;
  function writeBatch() {
    store.set(PATH_CX[wPart], wU, META);
    store.set(PATH_CY[wPart], wV, META);
  }

  function teleFresh(now) {
    return tele && tele.part === sel && now - teleAt < TELE_STALE_MS ? tele : null;
  }

  function baseCenter(out) {
    const params = refs[sel].params;
    out.u = num(params.centerX, 0.5);
    out.v = num(params.centerY, 0.5);
    return out;
  }
  const _base = { u: 0, v: 0 };

  // ------------------------------------------------------------------ picking
  function rayAt(clientX, clientY) {
    ndc.x = ((clientX - rect.left) / Math.max(1, rect.width)) * 2 - 1;
    ndc.y = -((clientY - rect.top) / Math.max(1, rect.height)) * 2 + 1;
    raycaster.setFromCamera(ndc, camera);
    return raycaster.ray;
  }

  function pickTerrain(clientX, clientY, out) {
    const ray = rayAt(clientX, clientY);
    return intersectRay(view, ray.origin.x, ray.origin.y, ray.origin.z, ray.direction.x, ray.direction.y, ray.direction.z, out);
  }

  /** Screen-space test against the marble, generous for fingers. */
  function overDot(clientX, clientY, touch) {
    projV.set(dotPos.x, dotPos.y, dotPos.z).project(camera);
    if (projV.z > 1) return false;
    const sx = rect.left + (projV.x * 0.5 + 0.5) * rect.width;
    const sy = rect.top + (-projV.y * 0.5 + 0.5) * rect.height;
    const dist = camera.position.distanceTo(projV.set(dotPos.x, dotPos.y, dotPos.z));
    const pxR = ((BALL_RADIUS * dotScale) / (dist * Math.tan((FOV * Math.PI) / 360))) * rect.height * 0.5;
    const radius = Math.max(touch ? 30 : 18, pxR * 1.7);
    const dx = clientX - sx, dy = clientY - sy;
    return dx * dx + dy * dy <= radius * radius;
  }

  // ------------------------------------------------------------------ dot control
  function currentBase(out) {
    if (ctl.mode !== 'idle') { out.u = ctl.u; out.v = ctl.v; return out; }
    if (physics.isActive(sel)) { const s = physics.state(sel); out.u = s.u; out.v = s.v; return out; }
    return baseCenter(out);
  }

  function startGlide(u, v) {
    currentBase(_base);
    ctl.fromU = _base.u; ctl.fromV = _base.v;
    ctl.toU = _base.u + wrapDelta(wrap01(u), _base.u);
    ctl.toV = _base.v + wrapDelta(wrap01(v), _base.v);
    ctl.t0 = clock;
    const d = Math.hypot(ctl.toU - ctl.fromU, ctl.toV - ctl.fromV);
    ctl.dur = reduced ? 140 : Math.min(620, GLIDE_MS * (0.6 + d * 2));
    ctl.mode = 'glide';
    ctl.u = _base.u; ctl.v = _base.v;
  }

  function cancelGlide() { if (ctl.mode === 'glide') ctl.mode = 'idle'; }

  function recordHist(x, z) {
    const i = ctl.histI;
    ctl.hist[i * 3] = performance.now();
    ctl.hist[i * 3 + 1] = x;
    ctl.hist[i * 3 + 2] = z;
    ctl.histI = (i + 1) % 8;
    ctl.histN = Math.min(8, ctl.histN + 1);
  }

  /** Throw velocity from the last ~90 ms of drag (world units / s). */
  function flickVelocity(out) {
    out.x = 0; out.z = 0;
    if (ctl.histN < 2) return out;
    const newest = (ctl.histI + 7) % 8;
    const tN = ctl.hist[newest * 3];
    if (performance.now() - tN > 120) return out; // pointer stopped before release
    let oldest = newest;
    for (let k = 1; k < ctl.histN; k++) {
      const j = (newest - k + 8) % 8;
      if (tN - ctl.hist[j * 3] > 90) break;
      oldest = j;
    }
    const dt = (tN - ctl.hist[oldest * 3]) / 1000;
    if (dt < 0.008) return out;
    out.x = (ctl.hist[newest * 3 + 1] - ctl.hist[oldest * 3 + 1]) / dt;
    out.z = (ctl.hist[newest * 3 + 2] - ctl.hist[oldest * 3 + 2]) / dt;
    return out;
  }
  const _flick = { x: 0, z: 0 };

  // ------------------------------------------------------------------ pointer
  const pointer = { x: 0, y: 0, inside: false, moved: false, touch: false, buttons: 0 };
  let press = null; // { id, kind: 'dot' | 'terrain', sx, sy, moved, offU, offV }
  const touchIds = new Set();

  function onPointerDown(e) {
    rect = canvas.getBoundingClientRect();
    rig.poke();
    if (e.pointerType === 'touch') touchIds.add(e.pointerId);
    if (touchIds.size >= 2) {
      // second finger: hand the gesture to the camera
      if (press) endPress(false);
      overlay.hide();
      return;
    }
    const isTouch = e.pointerType === 'touch' || e.pointerType === 'pen';
    if (!isTouch && e.button !== 0) return; // right / middle: camera
    if (!isTouch) { try { canvas.focus({ preventScroll: true }); } catch { /* old browsers */ } }

    let kind = null;
    if (overDot(e.clientX, e.clientY, isTouch)) kind = 'dot';
    else if (pickTerrain(e.clientX, e.clientY, hit)) kind = 'terrain';

    if (!kind) {
      // empty sky: left drag orbits
      controls.mouseButtons.LEFT = THREE.MOUSE.ROTATE;
      controls.touches.ONE = THREE.TOUCH.ROTATE;
      return;
    }
    // Ours: tell OrbitControls to ignore this button / finger but keep tracking
    // it, so a second finger still makes a pinch.
    controls.mouseButtons.LEFT = -1;
    controls.touches.ONE = -1;
    press = { id: e.pointerId, kind, sx: e.clientX, sy: e.clientY, moved: false, offU: 0, offV: 0 };
    ctl.histN = 0;
    if (kind === 'dot') {
      currentBase(_base);
      if (pickTerrain(e.clientX, e.clientY, hit)) {
        press.offU = wrapDelta(_base.u, wrap01(hit.u));
        press.offV = wrapDelta(_base.v, wrap01(hit.v));
      }
      ctl.mode = 'drag';
      ctl.u = _base.u; ctl.v = _base.v;
      if (physics.isActive(sel)) physics.hold(sel, ctl.u, ctl.v);
      canvas.style.cursor = 'grabbing';
    } else {
      startGlide(hit.u, hit.v);
      recordHist(hit.x, hit.z);
    }
    overlay.hide();
  }

  function dragTo(clientX, clientY) {
    if (!pickTerrain(clientX, clientY, hit)) return;
    ctl.mode = 'drag';
    ctl.u = wrap01(hit.u + press.offU);
    ctl.v = wrap01(hit.v + press.offV);
    recordHist(hit.x, hit.z);
    if (physics.isActive(sel)) physics.hold(sel, ctl.u, ctl.v);
    queueWrite(sel, ctl.u, ctl.v, false);
  }

  function onPointerMove(e) {
    pointer.x = e.clientX; pointer.y = e.clientY;
    pointer.inside = true; pointer.moved = true;
    pointer.touch = e.pointerType === 'touch';
    pointer.buttons = e.buttons;
    if (!press || e.pointerId !== press.id) return;
    if (!press.moved && Math.hypot(e.clientX - press.sx, e.clientY - press.sy) > 4) press.moved = true;
    if (press.kind === 'dot' || press.moved) dragTo(e.clientX, e.clientY);
  }

  function endPress(commit) {
    const p = press;
    press = null;
    if (!p) return;
    if (ctl.mode === 'drag') {
      ctl.mode = 'idle';
      queueWrite(sel, ctl.u, ctl.v, true);
      if (physics.isActive(sel)) {
        flickVelocity(_flick);
        if (!commit) { _flick.x = 0; _flick.z = 0; }
        physics.release(sel, _flick.x, _flick.z);
      }
    }
    canvas.style.cursor = '';
  }

  function onPointerUp(e) {
    touchIds.delete(e.pointerId);
    if (press && e.pointerId === press.id) endPress(true);
  }

  function onPointerLeave() { pointer.inside = false; overlay.hide(); }

  function onKeyDown(e) {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const k = e.key;
    if (k === 'ArrowLeft' || k === 'ArrowRight' || k === 'ArrowUp' || k === 'ArrowDown') {
      const step = e.shiftKey ? 0.0025 : 0.01;
      currentBase(_base);
      const du = k === 'ArrowLeft' ? -step : k === 'ArrowRight' ? step : 0;
      const dv = k === 'ArrowUp' ? -step : k === 'ArrowDown' ? step : 0;
      cancelGlide();
      const u = wrap01(_base.u + du), v = wrap01(_base.v + dv);
      if (physics.isActive(sel)) physics.teleport(sel, u, v);
      queueWrite(sel, u, v, true);
      rig.poke();
      e.preventDefault();
      e.stopPropagation();
    } else if (k === '+' || k === '=' || k === '-' || k === '_') {
      const zoomIn = k === '+' || k === '=';
      const d = camera.position.distanceTo(controls.target) * (zoomIn ? 0.88 : 1 / 0.88);
      const clamped = Math.min(controls.maxDistance, Math.max(controls.minDistance, d));
      camera.position.sub(controls.target).setLength(clamped).add(controls.target);
      rig.poke();
      e.preventDefault();
      e.stopPropagation();
    }
  }

  function onFocusChange() {
    let visible = false;
    try { visible = document.activeElement === canvas && canvas.matches(':focus-visible'); } catch { visible = document.activeElement === canvas; }
    overlay.setFocus(visible);
  }

  canvas.addEventListener('pointerdown', onPointerDown, { capture: true });
  canvas.addEventListener('pointermove', onPointerMove);
  window.addEventListener('pointerup', onPointerUp);
  window.addEventListener('pointercancel', onPointerUp);
  canvas.addEventListener('pointerleave', onPointerLeave);
  canvas.addEventListener('keydown', onKeyDown);
  canvas.addEventListener('focus', onFocusChange);
  canvas.addEventListener('blur', onFocusChange);
  canvas.addEventListener('wheel', () => rig.poke(), { passive: true });

  // ------------------------------------------------------------------ store
  function applyColors() {
    for (let p = 0; p < NUM_PARTS; p++) partLin[p] = hexToLinear(refs[p].color);
    colorDirty = true;
  }
  let colorDirty = true;

  function selectPart(p, animate) {
    const prev = sel;
    if (p === prev && animate) return;
    // keep the dot where it was on screen and let it glide to its new home
    const oldU = dotPos.u, oldV = dotPos.v;
    sel = p;
    if (press) endPress(false);
    ctl.mode = 'idle';
    loadPart(p, animate);
    live.primed = false;
    const t = teleFresh(performance.now());
    live.setTargets(refs[p].params, refs[p].mods, t, refs[p].links);
    currentBase(_base);
    if (animate && !reduced) {
      dispOffset.u = wrapDelta(oldU, _base.u);
      dispOffset.v = wrapDelta(oldV, _base.v);
      switchT = 0;
    } else {
      dispOffset.u = dispOffset.v = 0;
      switchT = 1;
    }
    colorDirty = true;
    minimapDirty = true;
  }

  const offStore = store.subscribe('', (path, value, meta) => {
    if (path === '' || path === 'parts' || /^parts\.\d+$/.test(path) || /^parts\.\d+\.(params|dot|mods|links)$/.test(path)) {
      refreshRefs();
      applyColors();
      cache.invalidateAll();
      for (let p = 0; p < NUM_PARTS; p++) {
        // a scene or patch load replaces the dot position wholesale: put
        // rolling / drifting dots where the new state says
        const wasActive = physics.isActive(p);
        syncPhysicsPart(p);
        if (wasActive && physics.isActive(p)) physics.teleport(p, num(refs[p].params.centerX, 0.5), num(refs[p].params.centerY, 0.5));
      }
      if (path === '') selectPart(clampPart(store.get('ui.selectedPart')), true);
      return;
    }
    if (path.startsWith('ui')) {
      if (path === 'ui' ) { applyUi(); return; }
      switch (path) {
        case 'ui.selectedPart': selectPart(clampPart(store.get('ui.selectedPart')), true); break;
        case 'ui.view': if (!meta || meta.source !== 'visual') api.setView(store.get('ui.view')); break;
        case 'ui.quality': api.setQuality(store.get('ui.quality')); break;
        case 'ui.autoRotate': rig.setAutoRotate(!!store.get('ui.autoRotate')); break;
        case 'ui.renderStyle': api.setRenderStyle(store.get('ui.renderStyle')); break;
        case 'ui.palette': api.setPalette(store.get('ui.palette')); break;
        default: break;
      }
      return;
    }
    const m = /^parts\.(\d+)\.(\w+)(?:\.(\w+))?/.exec(path);
    if (!m) return;
    const p = Number(m[1]);
    if (!(p >= 0 && p < NUM_PARTS)) return;
    const branch = m[2], leaf = m[3];
    if (branch === 'color') { refs[p].color = store.get(path) || refs[p].color; applyColors(); return; }
    if (branch === 'userTerrain') { cache.invalidate(p); return; }
    if (branch === 'dot') { syncPhysicsPart(p); return; }
    if (branch === 'params') {
      if (leaf === 'terrainA' || leaf === 'terrainB' || leaf === 'seed' || leaf === 'detail') { cache.invalidate(p); return; }
      if ((leaf === 'centerX' || leaf === 'centerY') && !writing && (!meta || meta.source !== 'visual')) {
        const params = refs[p].params;
        if (physics.isActive(p)) physics.teleport(p, num(params.centerX, 0.5), num(params.centerY, 0.5));
        if (p === sel && ctl.mode === 'glide') ctl.mode = 'idle';
      }
    }
  });

  function applyUi() {
    selectPart(clampPart(store.get('ui.selectedPart')), true);
    api.setQuality(store.get('ui.quality'));
    rig.setAutoRotate(!!store.get('ui.autoRotate'));
    api.setRenderStyle(store.get('ui.renderStyle'));
    api.setPalette(store.get('ui.palette'));
    const v = store.get('ui.view');
    if (v !== rig.view) api.setView(v);
  }

  // ------------------------------------------------------------------ engine
  const engineOffs = [];
  function listen(type, fn) {
    if (!engine || typeof engine.on !== 'function') return;
    try {
      const off = engine.on(type, fn);
      engineOffs.push(() => {
        try { if (typeof off === 'function') off(); else if (typeof engine.off === 'function') engine.off(type, fn); } catch { /* gone */ }
      });
    } catch (err) { console.warn('[visuals] cannot listen to engine', type, err); }
  }
  listen('terrain', (ev) => cache.onEngineTerrain(ev));
  listen('tele', (t) => {
    if (!t || typeof t !== 'object') return;
    tele = t;
    teleAt = performance.now();
    if (typeof t.spinPhase === 'number' && Number.isFinite(t.spinPhase)) { teleSpin = t.spinPhase; teleSpinAt = teleAt; }
  });

  // ------------------------------------------------------------------ theme
  function onTheme(e) {
    const th = (e && e.detail && e.detail.theme) || document.documentElement.dataset.theme;
    themeTarget = th === 'light' ? 1 : 0;
  }
  window.addEventListener('orograph:theme', onTheme);
  let motionMq = null;
  const onMotion = () => { reduced = reducedMotionPreferred(); rig.setReducedMotion(reduced); };
  try { motionMq = window.matchMedia('(prefers-reduced-motion: reduce)'); motionMq.addEventListener('change', onMotion); } catch { motionMq = null; }
  const motionObserver = new MutationObserver(() => {
    onMotion();
    const th = document.documentElement.dataset.theme === 'light' ? 1 : 0;
    if (th !== themeTarget) themeTarget = th;
  });
  motionObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-motion', 'data-theme'] });

  function applyAtmosphere() {
    blendAtmosphere(themeT, atm);
    sky.applyAtmosphere(atm, themeT);
    const u = terrain.uniforms;
    u.uSunDir.value.fromArray(atm.sunDir).normalize();
    u.uSunColor.value.fromArray(atm.sunColor);
    u.uSunI.value = atm.sunIntensity;
    u.uSkyAmb.value.fromArray(atm.skyAmb);
    u.uGroundAmb.value.fromArray(atm.groundAmb);
    u.uAmbI.value = atm.ambIntensity;
    u.uRim.value.fromArray(atm.rim);
    u.uRimI.value = atm.rimIntensity;
    u.uContour.value.fromArray(atm.contour);
    u.uContourA.value = atm.contourAlpha;
    u.uGrid.value.fromArray(atm.grid);
    u.uGridA.value = atm.gridAlpha;
    u.uFog.value.fromArray(atm.fog);
    u.uFogDensity.value = atm.fogDensity;
    u.uEdge.value.fromArray(atm.edgeFade);
    u.uThemeT.value = themeT;
    u.uGlow.value = atm.glow;
    keyLight.position.fromArray(atm.sunDir).multiplyScalar(10);
    keyLight.color.setRGB(atm.sunColor[0], atm.sunColor[1], atm.sunColor[2]);
    keyLight.intensity = atm.sunIntensity * 1.6;
    hemi.color.setRGB(atm.skyAmb[0], atm.skyAmb[1], atm.skyAmb[2]);
    hemi.groundColor.setRGB(atm.groundAmb[0], atm.groundAmb[1], atm.groundAmb[2]);
    hemi.intensity = atm.ambIntensity * 1.4;
    renderer.toneMappingExposure = atm.exposure;
    renderer.setClearColor(clearColor.setRGB(atm.horizon[0], atm.horizon[1], atm.horizon[2]), 1);
    orbit.setTheme(themeT, atm.glow);
    if (bloom) {
      bloom.radius = atm.bloomRadius;
      bloom.threshold = atm.bloomThreshold;
    }
    blendRamp(paletteIndex, themeT, ramp);
    for (let i = 0; i < 6; i++) u.uRamp.value[i].fromArray(ramp[i]);
    u.uTint.value = PALETTES[paletteIndex].tint;
    // Reflections: rebuild at the start, midway and end of a theme change.
    const envKey = themeT <= 0 ? 0 : themeT >= 1 ? 1 : 0.5;
    if (envKey !== envT) {
      envT = envKey;
      dot.setEnv(env.update(atm));
    }
    colorDirty = true;
    minimapDirty = true;
  }

  function applyPartColor(dt) {
    sceneColorLinear(partLin[sel], themeT, colTarget);
    const k = colorDirty && switchT >= 1 ? 1 : Math.min(1, dt * 9);
    for (let i = 0; i < 3; i++) colCur[i] += (colTarget[i] - colCur[i]) * k;
    terrain.uniforms.uPart.value.fromArray(colCur);
    orbit.setColor(colCur);
    dot.setColor(colCur, themeT);
    sky.setPart(colCur);
    colorDirty = Math.abs(colTarget[0] - colCur[0]) + Math.abs(colTarget[1] - colCur[1]) + Math.abs(colTarget[2] - colCur[2]) > 1e-4;
    colCss.value = refs[sel].color;
  }

  // ------------------------------------------------------------------ sizing
  function resize() {
    const w = Math.max(1, Math.round(container.clientWidth));
    const h = Math.max(1, Math.round(container.clientHeight));
    const pr = Math.min(window.devicePixelRatio || 1, QUALITY[qualityName].pixelRatio);
    if (w === width && h === height && pr === pixelRatio && composer) return;
    width = w; height = h; pixelRatio = pr;
    renderer.setPixelRatio(pr);
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    if (!composer) buildComposer();
    composer.setPixelRatio(pr);
    composer.setSize(w, h);
    orbit.setResolution(w * pr, h * pr, pr);
    sky.setPixelScale(((h * pr) / (2 * Math.tan((FOV * Math.PI) / 360))) * 0.035);
    minimap.setSize(Math.round(Math.min(140, Math.max(84, Math.min(w, h) * 0.2))));
    rect = canvas.getBoundingClientRect();
    rig.onAspect();
  }
  const ro = new ResizeObserver(() => resize());
  ro.observe(container);

  // ------------------------------------------------------------------ loop
  let raf = 0, running = false, onScreen = true, contextLost = false, disposed = false;
  let last = performance.now();
  let frames = 0, cpuMs = 0, fpsFrames = 0, fpsAt = performance.now(), fps = 0, statsAt = performance.now();
  let physicsTimer = 0;

  let held = false; // paused by debug.pause() (deterministic test stepping)
  function shouldRender() {
    return !held && !disposed && !contextLost && onScreen && document.visibilityState !== 'hidden' && width > 1 && height > 1;
  }

  function schedule() {
    const want = shouldRender();
    if (want && !running) {
      running = true;
      last = performance.now();
      raf = requestAnimationFrame(frame);
    } else if (!want && running) {
      running = false;
      cancelAnimationFrame(raf);
    }
    // Keep rolling / drifting dots alive (they shape the sound) while the map
    // is scrolled away; the browser throttles this when the tab is hidden.
    const needPhysics = !want && !held && !disposed && physics.anyActive();
    if (needPhysics && !physicsTimer) {
      let prev = performance.now();
      physicsTimer = setInterval(() => {
        const t = performance.now();
        const dt = Math.min(0.1, (t - prev) / 1000);
        prev = t;
        clock += dt * 1000;
        stepSimulation(dt, clock);
      }, 33);
    } else if (!needPhysics && physicsTimer) {
      clearInterval(physicsTimer);
      physicsTimer = 0;
    }
  }

  const io = new IntersectionObserver((entries) => {
    for (const en of entries) onScreen = en.isIntersecting;
    schedule();
  });
  io.observe(container);
  const onVisibility = () => schedule();
  document.addEventListener('visibilitychange', onVisibility);
  const onLost = (e) => { e.preventDefault(); contextLost = true; schedule(); };
  const onRestored = () => { contextLost = false; schedule(); };
  canvas.addEventListener('webglcontextlost', onLost);
  canvas.addEventListener('webglcontextrestored', onRestored);

  /** Physics, glides and store writes: everything that affects the sound. */
  function stepSimulation(dt, now) {
    // non-selected parts roll on their stored morph / warp / lift
    for (let p = 0; p < NUM_PARTS; p++) {
      if (p === sel) continue;
      const pr = refs[p].params;
      fields[p].setShape(num(pr.morph, 0), num(pr.warp, 0), num(pr.lift, 1));
    }
    if (ctl.mode === 'glide') {
      const t = Math.min(1, (now - ctl.t0) / ctl.dur);
      const e = easeOutCubic(t);
      ctl.u = wrap01(ctl.fromU + (ctl.toU - ctl.fromU) * e);
      ctl.v = wrap01(ctl.fromV + (ctl.toV - ctl.fromV) * e);
      if (physics.isActive(sel)) physics.hold(sel, ctl.u, ctl.v);
      queueWrite(sel, ctl.u, ctl.v, false);
      if (t >= 1) {
        ctl.mode = 'idle';
        queueWrite(sel, ctl.u, ctl.v, true);
        if (physics.isActive(sel)) physics.release(sel, 0, 0);
      }
    }
    physics.step(dt);
    const report = hasMarble && now - marbleAt >= 33;
    if (report) marbleAt = now;
    for (let p = 0; p < NUM_PARTS; p++) {
      if (physics.isActive(p) && !(p === sel && ctl.mode !== 'idle')) {
        const s = physics.state(p);
        if (!s.held) queueWrite(p, s.u, s.v, false);
        if (report && physics.mode(p) === MODE_ROLL) {
          const sp = Math.sqrt(s.vx * s.vx + s.vz * s.vz) / 8;
          try { engine.marble(p, sp > 1 ? 1 : sp, fields[p].norm(s.u, s.v)); } catch { /* engine busy */ }
        }
      }
      flushWrite(p, now, false);
    }
  }
  // Round D: rolling marbles tell the engine their speed and height (if it listens).
  const hasMarble = !!engine && typeof engine.marble === 'function';
  let marbleAt = 0;

  function frame(now) {
    if (!running) return;
    raf = requestAnimationFrame(frame);
    tick(now, true);
  }

  /** One frame of everything; `draw` false skips the GPU work (test stepping). */
  function tick(frameTime, draw) {
    const t0 = performance.now();
    const wall = t0;                       // telemetry arrives in real time
    // Long frames still move animations on (up to half a second), but the
    // physics and smoothing never take more than a 0.1 s step.
    const dtRaw = Math.min(0.5, Math.max(0, (frameTime - last) / 1000));
    const dt = Math.min(0.1, dtRaw);
    last = frameTime;
    clock += dtRaw * 1000;
    const now = clock;
    time += dt * (reduced ? 0.5 : 1);

    // ---- theme
    if (themeT !== themeTarget) {
      const step = dtRaw * (reduced ? 8 : 1.6);
      themeT += Math.sign(themeTarget - themeT) * Math.min(Math.abs(themeTarget - themeT), step);
      themeDirty = true;
    }
    if (themeDirty) { applyAtmosphere(); themeDirty = false; }

    // ---- terrain crossfades
    if (fade.A < 1 || fade.B < 1) {
      fade.A = Math.min(1, fade.A + dt / FADE_SECONDS);
      fade.B = Math.min(1, fade.B + dt / FADE_SECONDS);
      view.setFade('A', fade.A);
      view.setFade('B', fade.B);
      terrain.setFade(fade.A, fade.B);
      minimapDirty = true;
    }

    // ---- part switch
    if (switchT < 1) {
      switchT = Math.min(1, switchT + dt / SWITCH_SECONDS);
    }
    const decay = Math.exp(-dt / 0.11);
    dispOffset.u *= decay; dispOffset.v *= decay;

    // ---- live parameters
    const t = teleFresh(wall);
    const r = refs[sel];
    live.setTargets(r.params, r.mods, t, r.links);
    live.step(dt, switchT < 1 ? 0.12 : 0.03);
    const L = live.cur;
    view.setShape(terrain.hasB() ? L.morph : 0, L.warp, L.lift);
    fields[sel].setShape(terrain.hasB() ? L.morph : 0, L.warp, L.lift);

    // ---- physics, glides, writes
    stepSimulation(dt, now);

    // ---- where the dot is shown
    if (ctl.mode !== 'idle') { dotPos.u = ctl.u; dotPos.v = ctl.v; }
    else if (physics.isActive(sel)) { const s = physics.state(sel); dotPos.u = s.u; dotPos.v = s.v; }
    else if (isModulated(r.mods, 'centerX', r.links) || isModulated(r.mods, 'centerY', r.links)) { dotPos.u = L.centerX; dotPos.v = L.centerY; }
    else { baseCenter(_base); dotPos.u = _base.u; dotPos.v = _base.v; }
    dotPos.u = wrap01(dotPos.u + dispOffset.u);
    dotPos.v = wrap01(dotPos.v + dispOffset.v);
    dotPos.x = wrapWorld(uToX(dotPos.u));
    dotPos.z = wrapWorld(uToX(dotPos.v));
    const ground = view.yAt(dotPos.x, dotPos.z);
    // Zoomed far out the marble keeps a findable size on screen; it grows
    // around its contact point so it still sits on the land.
    const camDist = camera.position.distanceTo(controls.target);
    dotScale = Math.max(1, camDist / 20);
    let dy = ground + BALL_RADIUS * dotScale + 0.01;
    if (physics.mode(sel) === MODE_ROLL && ctl.mode === 'idle') {
      const s = physics.state(sel);
      if (s.y > dy) dy = s.y;
    }
    dotPos.y = dy;
    // the orbit is centred on the dot as shown, so it follows drags exactly
    orbitLive.stretch = L.stretch; orbitLive.size = L.size; orbitLive.rotate = L.rotate;
    orbitLive.centerX = dotPos.u; orbitLive.centerY = dotPos.v;

    // ---- spin and flow
    const spin = num(r.params.spin, 0);
    if (t && wall - teleSpinAt < TELE_STALE_MS) {
      let target = teleSpin + spin * (wall - teleSpinAt) / 1000;
      target -= Math.floor(target);
      let d = target - spinPhase;
      d -= Math.floor(d + 0.5);
      spinPhase += d * Math.min(1, dt * 20);
    } else {
      spinPhase += spin * dt;
    }
    spinPhase -= Math.floor(spinPhase);
    let note = NaN, best = 0;
    const voices = t && Array.isArray(t.voices) ? t.voices : null;
    if (voices) for (let i = 0; i < voices.length; i++) if (voices[i].amp > best) { best = voices[i].amp; note = voices[i].note; }
    flowHead = (flowHead + flowRate(best > 0.001 ? note : NaN) * dt * (reduced ? 0.4 : 1)) % 1;
    if (engine && typeof engine.level === 'function') {
      try { levelTarget = Math.min(1, Math.max(0, Number(engine.level()) || 0)); } catch { levelTarget = 0; }
    } else if (t && t.peak) {
      levelTarget = Math.min(1, Math.max(t.peak[0] || 0, t.peak[1] || 0));
    } else levelTarget = 0;
    level += (levelTarget - level) * Math.min(1, dt * (levelTarget > level ? 18 : 4));

    // ---- orbit and beads
    const shape = Math.round(num(r.params.pathShape, 0));
    const order = Math.round(num(r.params.pathOrder, 2));
    orbit.update(view, shape, order, L.pathParam, orbitLive, spinPhase, flowHead, level);
    orbit.updateBeads(view, shape, order, L.pathParam, orbitLive, spinPhase, voices, dt * (reduced ? 0.4 : 1),
      num(L.pace, 0), Math.round(num(r.params.paceShape, 0)), Math.max(1, num(L.laps, 1)));
    orbit.setVisibility(switchT < 1 ? 0.55 + 0.45 * switchT : 1);

    // ---- colours
    if (colorDirty || switchT < 1) applyPartColor(dt);

    // ---- the dot
    dot.update(dotPos.x, dotPos.y, dotPos.z, level, time, themeT, 1, dotScale);
    baseCenter(_base);
    const gd = Math.hypot(wrapDelta(_base.u, dotPos.u), wrapDelta(_base.v, dotPos.v));
    const ghostWant = ctl.mode === 'idle' && switchT >= 1 && !physics.isActive(sel) && gd > 0.004 ? 1 : 0;
    ghost.a += (ghostWant - ghost.a) * Math.min(1, dt * 6);
    const gx = dotPos.x + wrapDelta(_base.u, dotPos.u) * W, gz = dotPos.z + wrapDelta(_base.v, dotPos.v) * W;
    dot.setGhost(gx, view.yAt(gx, gz) + BALL_RADIUS * 0.62 + 0.01, gz, ghost.a);

    // ---- terrain uniforms
    const u = terrain.uniforms;
    u.uMorph.value = terrain.hasB() ? L.morph : 0;
    u.uWarp.value = L.warp;
    u.uHeight.value = H * displayLift(L.lift);
    u.uLift.value = L.lift;
    u.uFold.value = L.fold;
    u.uStyle.value = styleIndex;
    u.uDot.value.set(dotPos.u, dotPos.v, dotPos.y - ground - BALL_RADIUS * dotScale, 1);
    u.uGhost.value.set(_base.u, _base.v, ghost.a);
    u.uTime.value = time;
    u.uLevel.value = level;
    u.uFogStart.value = camera.position.distanceTo(controls.target) * 0.8;
    // footprint: inverse of the path transform's linear part
    {
      const ax = Math.pow(2, L.stretch * 1.5);
      const sx = ax * L.size, sy = L.size / ax;
      const th = (L.rotate / 360 + spinPhase) * Math.PI * 2;
      const c = Math.cos(th), s = Math.sin(th);
      const a = sx * c, b = -sy * s, cc = sx * s, d = sy * c;
      const det = a * d - b * cc;
      if (L.size > 0.004 && Math.abs(det) > 1e-9) {
        u.uFootInv.value.set(d / det, -b / det, -cc / det, a / det);
        u.uFootA.value = 0.7 * Math.min(1, L.size * 12);
      } else u.uFootA.value = 0;
    }
    sky.setTime(time);

    // ---- pointer hover (mouse only, not while pressing)
    if (pointer.moved && pointer.inside && !press && !pointer.touch && !pointer.buttons) {
      pointer.moved = false;
      if (overDot(pointer.x, pointer.y, false)) {
        canvas.style.cursor = 'grab';
        overlay.hide();
      } else if (pickTerrain(pointer.x, pointer.y, hit)) {
        canvas.style.cursor = 'crosshair';
        const hu = wrap01(hit.u), hv = wrap01(hit.v);
        const hh = view.norm(hit.u, hit.v);
        overlay.show(pointer.x - rect.left, pointer.y - rect.top, `${hu.toFixed(3)}, ${hv.toFixed(3)}  h ${hh >= 0 ? '+' : ''}${hh.toFixed(2)}`);
      } else {
        canvas.style.cursor = '';
        overlay.hide();
      }
    }

    // ---- camera
    const owned = rig.update(dt, now);
    if (!owned) controls.update(dt);

    // ---- HUD
    if ((minimapDirty || view.version !== minimapVersion) && now - minimapImgAt > 160) {
      minimapImgAt = now;
      minimapDirty = false;
      minimapVersion = view.version;
      minimap.renderTerrain(view, styleIndex === 3 ? HEAT_RAMP : ramp, colCur, styleIndex === 3 ? 0 : PALETTES[paletteIndex].tint, atm.sunDir);
    }
    if (now - minimapAt > 33) {
      minimapAt = now;
      const camAz = Math.atan2(camera.position.x - controls.target.x, camera.position.z - controls.target.z);
      minimap.draw(orbit.uvs, orbit.count, orbit.closed, dotPos.u, dotPos.v, _base.u, _base.v, ghost.a, colCss.value, camAz, themeT);
    }

    // ---- post
    if (bloom && bloom.enabled) bloom.strength = atm.bloomStrength * (0.8 + 0.7 * level);
    if (!draw) return;
    renderer.info.reset();
    composer.render(dt);

    frames++;
    fpsFrames++;
    cpuMs += performance.now() - t0;
    if (wall - fpsAt >= 1000) { fps = (fpsFrames * 1000) / (wall - fpsAt); fpsFrames = 0; fpsAt = wall; }
  }

  // ------------------------------------------------------------------ API
  const api = {
    get canvas() { return canvas; },
    /** Palette list for the settings: [{ name, dark: ['#rrggbb' x6], light: [...] }], valley to peak. */
    palettes() { return PALETTE_INFO.map(p => ({ name: p.name, dark: p.dark.slice(), light: p.light.slice() })); },

    resize() { width = 0; resize(); },

    setQuality(q) {
      const name = QUALITY[q] ? q : 'high';
      if (name === qualityName && composer) return;
      qualityName = name;
      terrain.setQuality(name);
      sky.setQuality(name);
      orbit.setQuality(name);
      buildComposer();
      width = 0;
      resize();
      themeDirty = true;
    },

    setView(name, animate = true) {
      const v = VIEW_NAMES.includes(name) ? name : 'orbit';
      rig.setView(v, animate);
      if (store.get('ui.view') !== v) store.set('ui.view', v, META);
    },

    setAutoRotate(on) {
      rig.setAutoRotate(!!on);
      const v = on ? 1 : 0;
      if (store.get('ui.autoRotate') !== v) store.set('ui.autoRotate', v, META);
    },

    toggleAutoRotate() {
      api.setAutoRotate(!rig.autoRotate);
      return rig.autoRotate;
    },

    setRenderStyle(style) {
      const i = RENDER_STYLES.indexOf(style);
      styleIndex = i < 0 ? 0 : i;
      minimapDirty = true;
    },

    setPalette(i) {
      const n = Math.round(num(i, 0));
      paletteIndex = ((n % PALETTES.length) + PALETTES.length) % PALETTES.length;
      themeDirty = true;
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      running = false;
      cancelAnimationFrame(raf);
      if (physicsTimer) clearInterval(physicsTimer);
      offStore();
      engineOffs.forEach(f => f());
      window.removeEventListener('orograph:theme', onTheme);
      if (motionMq) motionMq.removeEventListener('change', onMotion);
      motionObserver.disconnect();
      ro.disconnect();
      io.disconnect();
      document.removeEventListener('visibilitychange', onVisibility);
      canvas.removeEventListener('pointerdown', onPointerDown, { capture: true });
      canvas.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('pointercancel', onPointerUp);
      canvas.removeEventListener('pointerleave', onPointerLeave);
      canvas.removeEventListener('keydown', onKeyDown);
      canvas.removeEventListener('webglcontextlost', onLost);
      canvas.removeEventListener('webglcontextrestored', onRestored);
      controls.dispose();
      physics.dispose();
      cache.dispose();
      terrain.dispose(); sky.dispose(); orbit.dispose(); dot.dispose(); env.dispose();
      if (composer) { composer.renderTarget1.dispose(); composer.renderTarget2.dispose(); }
      if (bloom) bloom.dispose();
      if (outputPass) outputPass.dispose();
      minimap.dispose();
      overlay.dispose();
      renderer.dispose();
      canvas.remove();
    },

    /** Test and debugging hooks (used by tests/e2e/visual.cjs). */
    debug: {
      /** Client coordinates of the land at terrain (u, v) in the centre tile. */
      project(u, v) {
        const x = uToX(u), z = uToX(v);
        projV.set(x, view.yAt(x, z), z).project(camera);
        const r = canvas.getBoundingClientRect();
        return { x: r.left + (projV.x * 0.5 + 0.5) * r.width, y: r.top + (-projV.y * 0.5 + 0.5) * r.height, z: projV.z };
      },
      pick(clientX, clientY) {
        rect = canvas.getBoundingClientRect();
        return pickTerrain(clientX, clientY, hit) ? { u: wrap01(hit.u), v: wrap01(hit.v), y: hit.y } : null;
      },
      dot() { return { u: dotPos.u, v: dotPos.v, x: dotPos.x, y: dotPos.y, z: dotPos.z }; },
      stats() {
        const info = renderer.info;
        return {
          frames, fps, cpuMsPerFrame: frames ? cpuMs / frames : 0,
          // average since resetStats(): frames over wall time
          fpsAvg: frames ? (frames * 1000) / Math.max(1, performance.now() - statsAt) : 0,
          drawCalls: info.render.calls, triangles: info.render.triangles,
          quality: qualityName, view: rig.view, themeT, running, autoRotate: controls.autoRotate,
          reducedMotion: reduced, selectedPart: sel,
          physics: Array.from({ length: NUM_PARTS }, (_, p) => physics.engineName(p)),
          floatLinear: terrain.floatLinear, size: [width, height, pixelRatio],
        };
      },
      resetStats() { frames = 0; cpuMs = 0; statsAt = performance.now(); },
      /** Stop the frame loop (tests drive time with advance()). */
      pause() { held = true; schedule(); },
      resume() { held = false; schedule(); },
      /**
       * Simulate `seconds` of time in fixed steps without drawing, then draw
       * one frame. Lets slow software-GL test runs settle transitions,
       * physics and camera moves deterministically.
       */
      advance(seconds = 1, step = 1 / 30) {
        const n = Math.max(1, Math.round(seconds / step));
        let t = last;
        for (let i = 0; i < n; i++) {
          t += step * 1000;
          tick(t, i === n - 1);
        }
        return api.debug.stats();
      },
      heightAt(u, v) { return view.norm(u, v); },
    },
  };

  // ------------------------------------------------------------------ start
  resize();
  if (!composer) buildComposer();
  applyAtmosphere();
  loadPart(sel, false);
  for (let p = 0; p < NUM_PARTS; p++) {
    if (p !== sel) {
      // other parts' tables are only needed once they roll or drift
      if (num(refs[p].dot.mode, 0) !== MODE_PIN) loadPart(p, false);
    }
    syncPhysicsPart(p);
  }
  live.setTargets(refs[sel].params, refs[sel].mods, null, refs[sel].links);
  applyPartColor(1);
  rig.setView(VIEW_NAMES.includes(store.get('ui.view')) ? store.get('ui.view') : 'orbit', false);
  api.setRenderStyle(store.get('ui.renderStyle'));
  schedule();
  return api;
}
