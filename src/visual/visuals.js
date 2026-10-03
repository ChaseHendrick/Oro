// Oro's 3D map.
//
//   const visuals = await createVisuals(containerEl, { store, engine, music? });
//   visuals.resize(); visuals.setQuality('high' | 'medium' | 'low'); visuals.dispose();
//   visuals.setView('orbit' | 'top' | 'low'); visuals.toggleAutoRotate(); visuals.setAutoRotate(on)
//   visuals.setRenderStyle('relief' | 'wire' | 'contour' | 'heat' | 'points'); visuals.setPalette(i)
//   visuals.palettes() -> [{ name, dark: ['#rrggbb' x6], light: [...] }]
//   visuals.on('extremum', fn({ part, kind: 'peak' | 'valley', height, x, y, speed })) -> off(); visuals.off(type, fn)
//   visuals.setMusic(music)   (dot-lock flashes and Tour sync; picked up from window.orograph when not given)
//
// Shows the selected part's terrain (warp / morph / lift driven by the
// engine's telemetry), its live orbit (plus the knob-only base orbit and
// per-voice orbits when they differ), the dot, Tour waypoints with their
// route, dot-lock badges and Explore pings. Click or tap the land to glide
// the dot there, drag it to move it exactly, orbit with right / middle drag,
// two fingers or a left drag on the sky, zoom with the wheel or a pinch.
// On the dot: Shift-drag sets Size, Alt-drag sets Rotate, the wheel sets
// Size; [ and ] set Size while the map has focus. With ui.editWaypoints on,
// clicks add Tour waypoints (up to 8), drags move them, right-click or a long
// press deletes one.
//
// Dot moves are written to parts.N.params.centerX / centerY by dot-sim.js:
// a person's moves with { source: 'visual', user: true }, Roll / Drift /
// Explore / Tour with { source: 'physics', user: false }.
//
// Frame loop order: atmosphere -> transitions -> live parameters -> physics
// and pointer -> store writes -> orbit / dot / markers / uniforms -> camera ->
// HUD -> render. Nothing in that loop allocates.

import * as THREE from 'three';
import { budgetPixelRatio, quantizeRatio, createDynamicScale, RENDER_SCALES } from './resolution.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';

import { MAX_PARTS, MAX_WAYPOINTS, activeSeq, PART_PARAM_MAP, toNorm, fromNorm, formatValue } from '../core/params.js';
import { wrapDelta, wrap01 } from '../dsp/terrain-math.js';
import { HeightField, W, H, EXTENT, intersectRay, displayLift, uToX, wrapWorld } from './heightfield.js';
import { PALETTES, PALETTE_INFO, HEAT_RAMP, makeAtmosphere, blendAtmosphere, blendRamp, hexToLinear, sceneColorLinear } from './palettes.js';
import { LiveParams, TELE_STALE_MS, isModulated, voiceLive, orbitDifference, ORBIT_IDS } from './modstate.js';
import { BALL_RADIUS, MODE_PIN, MODE_TOUR } from './physics.js';
import { createDotSim, USER_META } from './dot-sim.js';
import { createFunLayer } from './fun-layer.js';
import { stepTint } from './day-night.js';
import { partCount, watchTracks, permute } from '../core/tracks.js';
import { makePlan, buildPlan, sampleRoute } from './tour.js';
import { createTerrainLayer } from './terrain-layer.js';
import { createSkyLayer } from './sky-layer.js';
import { createOrbitLayer, flowRate } from './orbit-layer.js';
import { createDotLayer } from './dot-layer.js';
import { createMarkersLayer, ROUTE_PER_LEG } from './markers-layer.js';
import { createEnvironment } from './env.js';
import { createCameraRig, FOV, VIEW_NAMES } from './camera-rig.js';
import { createTerrainCache } from './terrain-cache.js';
import { createMinimap, createOverlay } from './hud.js';

/** Replaces NaN / Inf with black and clamps HDR colour before bloom (see buildComposer). */
export const SANITIZE_SHADER = {
  name: 'OroSanitize',
  uniforms: { tDiffuse: { value: null } },
  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse;
    varying vec2 vUv;
    void main() {
      vec3 v = texture2D(tDiffuse, vUv).rgb;
      // NaN fails both comparisons (this also works where isnan() is optimised away): it becomes 0.
      v = vec3(v.r >= 0.0 || v.r < 0.0 ? v.r : 0.0, v.g >= 0.0 || v.g < 0.0 ? v.g : 0.0, v.b >= 0.0 || v.b < 0.0 ? v.b : 0.0);
      // +Inf (an overflowed highlight) stays a bright highlight; negatives are dropped.
      gl_FragColor = vec4(clamp(v, 0.0, 64.0), 1.0);
    }`,
};

/** Minimum gap between minimap terrain rebuilds while the land moves (ms); 0 = every frame. */
export const MINIMAP_TERRAIN_MS = 0;

/**
 * The map is endless. The sound only uses the position within one tile (the
 * terrain wraps), so the dot can travel any distance over the copies, and the
 * displayed plane follows the camera, which follows the dot. Play-area
 * coordinates are tile units (0 .. 1 is one copy); PLAY_LIMIT only keeps them
 * far from float trouble (ten thousand tiles each way).
 */
export const PLAY_LIMIT = 1e4;
export function clampEdge(x) {
  return Number.isFinite(x) ? Math.min(PLAY_LIMIT, Math.max(-PLAY_LIMIT, x)) : 0.5;
}

export const QUALITY = {
  high: { pixelRatio: 2, bloom: true, samples: 4 },
  medium: { pixelRatio: 1.5, bloom: true, samples: 4 },
  low: { pixelRatio: 1, bloom: false, samples: 0 },
};
/** Frame-rate caps for the 3D map (Settings > General). 0 = uncapped, the default. */
export const FPS_CAPS = [0, 30, 60, 120];

/**
 * Opt-in frame pacing: shouldPaint(now, cap) says whether this display frame
 * should be drawn. It learns the display's frame time (a moving average of
 * the gaps between calls) and paints once at least 1/cap minus half a display
 * frame has passed, so a 60 cap on a 60 Hz screen still paints every frame
 * and on a 120 Hz screen every other one. Skipped frames cost nothing; the
 * next painted frame advances everything by the real elapsed time.
 */
export function createPacer() {
  let frameMs = 1000 / 60, prev = NaN, lastPaint = -Infinity;
  return {
    shouldPaint(now, cap) {
      if (Number.isFinite(prev)) {
        const d = now - prev;
        if (d > 0 && d < 100) frameMs += (d - frameMs) * 0.1;
      }
      prev = now;
      if (!(cap > 0) || now - lastPaint >= 1000 / cap - frameMs * 0.5) { lastPaint = now; return true; }
      return false;
    },
    get frameMs() { return frameMs; },
  };
}
export const RENDER_STYLES = ['relief', 'wire', 'contour', 'heat', 'points', 'normals'];
const META = Object.freeze({ source: 'visual' });
const FADE_SECONDS = 0.3;
const SWITCH_SECONDS = 0.35;
const GLIDE_MS = 420;
const LONG_PRESS_MS = 550;
// Endless map: the camera follows the dot once it leaves the middle 70% of
// the view, at up to FOLLOW_RATE (per second, scaled by how far out it is).
const FOLLOW_BOX = 0.7;
const FOLLOW_RATE = 3;
const SIZE_DRAG_PX = 220;           // a Shift-drag this tall sweeps the whole Size range
const SIZE_STEP = 0.03;             // normalised Size per wheel notch or [ / ] press
const MAX_POLAR = 1.4;              // radians from straight down
const CAMERA_CLEARANCE = 0.9;       // world units the camera keeps above the land under it
const ARIA = 'Terrain map. Click or tap the land to move the dot there, or drag the dot. ' +
  'Drag the sky, right-drag or use two fingers to turn the view; scroll or pinch to zoom. ' +
  'Arrow keys nudge the dot; hold Shift for fine steps. Plus and minus zoom. ' +
  'Left and right square brackets change the orbit size. While editing waypoints, Enter adds one at the dot and Delete removes the last.';
const SIZE_DEF = PART_PARAM_MAP.size, ROTATE_DEF = PART_PARAM_MAP.rotate;

function reducedMotionPreferred() {
  const pref = typeof document !== 'undefined' ? document.documentElement.dataset.motion : '';
  if (pref === 'reduce') return true;
  if (pref === 'full') return false;
  try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; }
}

function easeOutCubic(t) { return 1 - Math.pow(1 - t, 3); }

// Photosensitivity guard (visual only; the sound is never touched). Fast
// modulation such as a per-note envelope on Morph can reshape the whole map
// several times a second, and a level-driven bloom can pulse the whole
// screen with every note. The map's shape and the scene glow therefore ease
// in on these time constants, which keep large-area changes well under three
// a second (WCAG 2.3.1) whatever the patch does. Reduced motion eases more.
export const CALM = Object.freeze({
  shapeTau: 0.2, shapeTauReduced: 0.45,    // s: Morph, Warp, Lift, Fold on the map
  glowRise: 0.22, glowFall: 0.6,           // s: bloom, orbit and terrain glow following the level
  bloomBase: 0.85, bloomSwing: 0.3,        // bloom strength = base * (bloomBase + bloomSwing * glow)
  reducedSwing: 0.35,                      // how much of the glow swing reduced motion keeps
});
const SHAPE_IDS = ['morph', 'warp', 'lift', 'fold'];

/** One step of the calm shape filter: a one-pole low-pass per shape value. */
export function calmShapeStep(cur, target, dt, reduced) {
  const k = 1 - Math.exp(-Math.max(0, dt) / (reduced ? CALM.shapeTauReduced : CALM.shapeTau));
  for (const id of SHAPE_IDS) {
    const t = Number(target[id]) || 0;
    cur[id] = Number.isFinite(cur[id]) ? cur[id] + (t - cur[id]) * k : t;
  }
  return cur;
}

/** One step of the scene glow: follows the output level, slowly. */
export function calmGlowStep(glow, level, dt) {
  const tau = level > glow ? CALM.glowRise : CALM.glowFall;
  return glow + (level - glow) * (1 - Math.exp(-Math.max(0, dt) / tau));
}

export async function createVisuals(container, { store, engine = null, quality, music: musicIn = null } = {}) {
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
  // Never level with or below the land; keepAboveLand() also lifts the camera out of hills.
  controls.maxPolarAngle = MAX_POLAR;
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
  const markers = createMarkersLayer();
  const fun = createFunLayer();
  const env = createEnvironment(renderer);
  scene.add(sky.sky, terrain.mesh, sky.points, orbit.group, dot.group, markers.group, fun.group);
  for (let i = 0; i < 6; i++) terrain.uniforms.uHeat.value[i].fromArray(HEAT_RAMP[i]);

  // Lights for the physical materials (marble, ghost); the terrain shader
  // reads the same colours from its own uniforms.
  const keyLight = new THREE.DirectionalLight(0xffffff, 1);
  const hemi = new THREE.HemisphereLight(0xffffff, 0x222222, 0.5);
  scene.add(keyLight, hemi);

  // ------------------------------------------------------------------ post
  let composer = null, bloom = null, renderPass = null, outputPass = null, sanitizePass = null;
  // Chrome on Apple GPUs (ANGLE on Metal) has shown flat gray blocks over the
  // map with a multisampled half-float target; Retina screens already render
  // at 2x, so those GPUs skip MSAA.
  const appleGpu = (() => {
    try {
      const gl = renderer.getContext();
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      const name = String(ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
      return /apple/i.test(name);
    } catch { return false; }
  })();
  let width = 1, height = 1, pixelRatio = 1;
  const readRenderScale = () => (RENDER_SCALES.includes(store.get('ui.renderScale')) ? store.get('ui.renderScale') : 'auto');
  let renderScale = readRenderScale();
  const dyn = createDynamicScale();
  let prevPaint = NaN;

  function buildComposer() {
    if (composer) {
      composer.renderTarget1.dispose();
      composer.renderTarget2.dispose();
      if (bloom) bloom.dispose();
      if (outputPass) outputPass.dispose();
      if (sanitizePass) sanitizePass.dispose();
    }
    const q = QUALITY[qualityName];
    const rt = new THREE.WebGLRenderTarget(Math.max(1, width * pixelRatio), Math.max(1, height * pixelRatio), {
      type: THREE.HalfFloatType, samples: appleGpu ? 0 : q.samples,
    });
    composer = new EffectComposer(renderer, rt);
    renderPass = new RenderPass(scene, camera);
    composer.addPass(renderPass);
    // Additive glows can overflow half floats to Inf on some GPUs; bloom's
    // downsampled blurs then spread Inf / NaN into gray rectangles. Clamp to
    // a finite HDR range and drop invalid pixels before bloom sees them.
    sanitizePass = new ShaderPass(SANITIZE_SHADER);
    composer.addPass(sanitizePass);
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
  let fields = Array.from({ length: MAX_PARTS }, () => new HeightField()); // physics, per track slot
  const live = new LiveParams();
  const atm = makeAtmosphere();
  const ramp = Array.from({ length: 6 }, () => [0, 0, 0]);
  const partLin = Array.from({ length: MAX_PARTS }, (_, i) => hexToLinear(store.get(`parts.${i}.color`) || '#ffffff'));
  const colCur = [1, 0.5, 0.3];      // displayed part colour (scene-adjusted), eased
  const colTarget = [1, 0.5, 0.3];
  const colCss = { value: '#ffffff' };

  let refs = [];                     // cached store sub-objects per part
  function refreshRefs() {
    refs = [];
    // every slot gets a ref (empty past the track list), so refs[p] is always safe
    for (let p = 0; p < MAX_PARTS; p++) {
      const part = store.get(`parts.${p}`) || {};
      refs.push({ params: part.params || {}, mods: part.mods || {}, dot: part.dot || {}, links: part.links || null, color: part.color || '#ffffff' });
    }
  }
  refreshRefs();

  let sel = clampPart(store.get('ui.selectedPart'));
  let selId = store.get(`parts.${sel}.id`);
  let themeT = document.documentElement.dataset.theme === 'light' ? 1 : 0;
  let themeTarget = themeT;
  let themeDirty = true;
  // Day and night tint over the palette (v2.9): 1, 1, 1 when off.
  const DAY_STEP_MS = 200, DAY_STEP = 0.012;
  const dayTint = [1, 1, 1], dayTarget = [1, 1, 1];
  let dayMoving = false, dayAt = -Infinity;
  // Golf (v2.9): while set, pointer presses on the ball go here.
  let funInput = null;
  // Animation clock (ms): advances with every frame (and the off-screen
  // physics timer). Glides, camera moves and write throttles run on it, so
  // test stepping (debug.advance) and real frames behave identically.
  let clock = 0;
  let glideTimer = 0;
  let envT = -1;
  let paletteIndex = Number.isInteger(store.get('ui.palette')) ? store.get('ui.palette') : 0;
  let styleIndex = Math.max(0, RENDER_STYLES.indexOf(store.get('ui.renderStyle')));
  let reduced = reducedMotionPreferred();
  rig.setReducedMotion(reduced);
  rig.setAutoRotate(store.get('ui.autoRotate') !== 0 && store.get('ui.autoRotate') !== false);

  let tele = null, teleAt = -1e9, teleSpin = 0, teleSpinAt = 0;
  let spinPhase = 0, flowHead = 0, level = 0, levelTarget = 0, time = 0, glow = 0;
  const shapeShown = {};
  let switchT = 1;                   // 0..1 progress of a part switch
  const dispOffset = { u: 0, v: 0 }; // decaying display offset after a part switch
  let dotSrc = 'base';               // which source placed the dot this frame (debug)
  // Which of the 3 x 3 tile copies each part's dot is drawn on (-1, 0 or 1 per axis).
  // per track slot; moved with the tracks on reorder (see watchTracks below)
  let tile = Array.from({ length: MAX_PARTS }, () => ({ u: 0, v: 0 }));
  let lastWrapped = Array.from({ length: MAX_PARTS }, () => ({ u: NaN, v: NaN }));
  const fade = { A: 1, B: 1 };
  const ghost = { a: 0 };
  const dotPos = { u: 0.5, v: 0.5, x: 0, y: 0, z: 0 };
  let dotScale = 1;
  // World centre of the displayed plane (and the markers): the tile copy
  // under the camera, so the land never runs out (see recentrePlane()).
  const planeOrigin = { x: 0, z: 0 };
  // opt-in frame-rate cap (0 = uncapped)
  const pacer = createPacer();
  const readFpsCap = () => { const c = Number(store.get('ui.fpsCap')); return FPS_CAPS.includes(c) ? c : 0; };
  let fpsCap = readFpsCap();
  // Orbits: the live one (newest voice), the knob-only base and one per voice.
  const orbitLive = { stretch: 0, size: 0.22, rotate: 0, centerX: 0.5, centerY: 0.5, pathParam: 0.5, pathWindow: 0, pathMangle: 0, pathMirror: 0 };
  const baseLive = { stretch: 0, size: 0.22, rotate: 0, centerX: 0.5, centerY: 0.5, pathParam: 0.5, pathWindow: 0, pathMangle: 0, pathMirror: 0 };
  const voiceLives = Array.from({ length: 8 }, () => ({ stretch: 0, size: 0.22, rotate: 0, centerX: 0.5, centerY: 0.5, pathParam: 0.5, pathWindow: 0, pathMangle: 0, pathMirror: 0 }));
  const voiceSlots = new Array(8).fill(null);
  const voiceAmps = new Float64Array(8);
  const voiceOrder = new Float64Array(8), voiceNote = new Float64Array(8).fill(NaN);
  const voiceSeen = new Uint8Array(8);
  let voiceCounter = 0;
  // Markers: the selected part's route (unwrapped u, v pairs) and lock data.
  const routePlan = makePlan();
  const routeUV = new Float64Array(2 * (MAX_WAYPOINTS * ROUTE_PER_LEG + 1));
  let routeN = 0;
  let markersDirty = true;
  const _tmpUV = { u: 0, v: 0 };
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

  // The track list changed shape: height fields and cached tables move with
  // their tracks (before the dot simulation below re-reads the store), so a
  // reorder rebuilds nothing.
  const offTracks = watchTracks(store, ({ perm, fresh }) => {
    fields = permute(fields, perm, fresh, () => new HeightField());
    tile = permute(tile, perm, fresh, () => ({ u: 0, v: 0 }));
    lastWrapped = permute(lastWrapped, perm, fresh, () => ({ u: NaN, v: NaN }));
    cache.remap(perm, fresh);
  });

  function loadPart(p, crossfade) {
    for (const slot of ['A', 'B']) {
      const e = cache.get(p, slot);
      fields[p].setTable(slot, e.data, e.size, false);
      if (p === sel) showTable(slot, e, crossfade);
    }
  }

  // ------------------------------------------------------------------ events
  const handlers = new Map();
  function emit(type, ev) {
    const set = handlers.get(type);
    if (!set || set.size === 0) return;
    for (const fn of [...set]) {
      try { fn(ev); } catch (err) { console.error('[visuals] listener error', err); }
    }
  }

  // ------------------------------------------------------------------ simulation
  // Roll / Drift / Explore / Tour for every part, their store writes and the
  // engine's marble telemetry (dot-sim.js). A part that starts moving needs
  // its land, even when it is not shown.
  const sim = createDotSim({
    store, engine,
    clock: () => clock,               // the animation clock, so debug.advance() drives it too
    fieldFor: (p) => fields[p],
    ensureField(p) {
      if (fields[p].ready) return;
      for (const slot of ['A', 'B']) { const e = cache.get(p, slot); fields[p].setTable(slot, e.data, e.size, false); }
    },
    getMusic: () => music,
    emit(type, ev) {
      if (type === 'extremum' && ev.part === sel) markers.ping(ev.x, ev.y, ev.kind === 'peak');
      emit(type, ev);
    },
  });

  // ------------------------------------------------------------------ music
  // Dot-lock flashes come from the transport's 'step' events and Tour follows
  // its beat. main.js may hand music over later (setMusic) or not at all; the
  // app's debug hook (window.orograph) is used as a fallback so both work.
  let music = null, offStep = null, musicGiven = false, musicLookAt = 0;
  function setMusic(m) {
    if (m === music) return;
    if (offStep) { offStep(); offStep = null; }
    music = m || null;
    const tr = music && music.transport;
    if (tr && typeof tr.on === 'function') {
      try {
        const off = tr.on('step', onStep);
        offStep = () => {
          try { if (typeof off === 'function') off(); else if (typeof tr.off === 'function') tr.off('step', onStep); } catch { /* gone */ }
        };
      } catch (err) { console.warn('[visuals] cannot follow the sequencer', err); }
    }
  }
  function onStep(ev) {
    if (ev && ev.lock && ev.part === sel) markers.flashLock(ev.step);
  }
  if (musicIn) { musicGiven = true; setMusic(musicIn); }

  // ------------------------------------------------------------------ HUD
  const overlay = createOverlay(container);
  let minimapDirty = true;
  let minimapAt = 0, minimapImgAt = 0;
  let mmWp = -1;                     // waypoint being dragged on the minimap
  const minimap = createMinimap(container, {
    onPick(u, v, phase) {
      rig.poke();
      if (funInput) return;           // Golf: the ball only moves by a shot
      if (editing()) { minimapWaypoint(u, v, phase); return; }
      cancelGlide();
      // the minimap shows one copy of the land: use the copy nearest the dot
      // (the map is endless, so the dot may be many tiles from the first one)
      const refU = ctl.mode !== 'idle' ? ctl.u : dotPos.u, refV = ctl.mode !== 'idle' ? ctl.v : dotPos.v;
      ctl.mode = phase === 'end' ? 'idle' : 'drag';
      ctl.u = clampEdge(u + Math.round(refU - u)); ctl.v = clampEdge(v + Math.round(refV - v));
      if (phase === 'end') {
        if (sim.isActive(sel)) sim.release(sel, 0, 0);
      } else if (sim.isActive(sel)) {
        sim.hold(sel, u, v);
      }
      sim.userWrite(sel, u, v, true, clock);
    },
  });

  // ------------------------------------------------------------------ helpers
  function num(v, d) { return typeof v === 'number' && Number.isFinite(v) ? v : d; }
  function clampPart(p) { const n = Math.round(num(p, 0)); const max = partCount(store) - 1; return n < 0 ? 0 : n > max ? max : n; }
  // read every frame: cached from the store (store.get splits its path each call)
  let editOn = !!store.get('ui.editWaypoints');
  function editing() { return editOn; }

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
  // v2.9 ghost replay: where each track's ghost has the dot (null when no ghost plays)
  const ghostDot = Array.from({ length: MAX_PARTS }, () => null);

  /** A person changed a path knob from the map (Size / Rotate gestures). */
  function writeParam(id, v) {
    store.set(`parts.${sel}.params.${id}`, v, USER_META);
  }

  function nudgeSize(dn, clientX, clientY) {
    const cur = num(refs[sel].params.size, SIZE_DEF.default);
    const n = Math.min(1, Math.max(0, toNorm(SIZE_DEF, cur) + dn));
    const v = Math.round(fromNorm(SIZE_DEF, n) * 1e5) / 1e5;
    writeParam('size', v);
    showReadout(clientX, clientY, `${SIZE_DEF.label} ${formatValue(SIZE_DEF, v)}`);
  }

  let readoutHideAt = 0;
  function showReadout(clientX, clientY, text) {
    if (!Number.isFinite(clientX)) {
      // keyboard: next to the dot
      projV.set(dotPos.x, dotPos.y, dotPos.z).project(camera);
      clientX = rect.left + (projV.x * 0.5 + 0.5) * rect.width;
      clientY = rect.top + (-projV.y * 0.5 + 0.5) * rect.height;
    }
    overlay.show(clientX - rect.left, clientY - rect.top, text);
    readoutHideAt = clock + 1400;
  }

  // ------------------------------------------------------------------ waypoints
  function waypointsPath() { return `parts.${sel}.dot.waypoints`; }
  function waypoints() { const w = store.get(waypointsPath()); return Array.isArray(w) ? w : []; }

  function setWaypoints(list) {
    store.set(waypointsPath(), list, USER_META);
    markersDirty = true;
  }

  function addWaypoint(u, v) {
    const list = waypoints();
    if (list.length >= MAX_WAYPOINTS) return -1;
    const beats = list.length ? num(list[list.length - 1].beats, 2) : 2;
    setWaypoints([...list.map(w => ({ ...w })), { x: tidy(u), y: tidy(v), beats }]);
    return list.length;
  }

  function moveWaypoint(i, u, v) {
    const list = waypoints();
    if (!(i >= 0 && i < list.length)) return;
    const x = tidy(u), y = tidy(v);
    if (list[i].x === x && list[i].y === y) return;
    setWaypoints(list.map((w, k) => (k === i ? { ...w, x, y } : { ...w })));
  }

  function deleteWaypoint(i) {
    const list = waypoints();
    if (!(i >= 0 && i < list.length)) return;
    setWaypoints(list.filter((_, k) => k !== i).map(w => ({ ...w })));
    markers.setHover(-1);
  }

  function tidy(x) { const r = Math.round(wrap01(x) * 1e5) / 1e5; return r >= 1 ? 0 : r; }

  function minimapWaypoint(u, v, phase) {
    if (phase === 'start') {
      const list = waypoints();
      mmWp = -1;
      for (let i = 0; i < list.length; i++) {
        if (Math.hypot(wrapDelta(list[i].x, u), wrapDelta(list[i].y, v)) < 0.035) { mmWp = i; break; }
      }
      if (mmWp < 0) mmWp = addWaypoint(u, v);
      if (mmWp < 0) showReadout(rect.left + rect.width / 2, rect.top + 40, `Up to ${MAX_WAYPOINTS} waypoints`);
    } else if (mmWp >= 0) {
      moveWaypoint(mmWp, u, v);
      if (phase === 'end') mmWp = -1;
    }
  }

  // ------------------------------------------------------------------ picking
  function rayAt(clientX, clientY) {
    ndc.x = ((clientX - rect.left) / Math.max(1, rect.width)) * 2 - 1;
    ndc.y = -((clientY - rect.top) / Math.max(1, rect.height)) * 2 + 1;
    raycaster.setFromCamera(ndc, camera);
    return raycaster.ray;
  }

  function pickTerrain(clientX, clientY, out) {
    const ray = rayAt(clientX, clientY);
    return intersectRay(view, ray.origin.x, ray.origin.y, ray.origin.z, ray.direction.x, ray.direction.y, ray.direction.z, out, EXTENT, planeOrigin.x, planeOrigin.z);
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
    // in play-area coordinates (ctl already is; the others add the part's tile)
    if (ctl.mode !== 'idle') { out.u = ctl.u; out.v = ctl.v; return out; }
    if (sim.isActive(sel)) { const s = sim.state(sel); out.u = s.u + tile[sel].u; out.v = s.v + tile[sel].v; return out; }
    baseCenter(out); out.u += tile[sel].u; out.v += tile[sel].v;
    return out;
  }

  function startGlide(u, v) {
    currentBase(_base);
    ctl.fromU = _base.u; ctl.fromV = _base.v;
    // straight to the target, never across the seam
    ctl.toU = clampEdge(u);
    ctl.toV = clampEdge(v);
    ctl.t0 = clock;
    const d = Math.hypot(ctl.toU - ctl.fromU, ctl.toV - ctl.fromV);
    ctl.dur = reduced ? 140 : Math.min(620, GLIDE_MS * (0.6 + d * 2));
    ctl.mode = 'glide';
    ctl.u = _base.u; ctl.v = _base.v;
    // The glide advances per frame; if frames stall (slow GPU, hidden tab) the
    // dot must still land, because the sound follows the store, not the picture.
    clearTimeout(glideTimer);
    const part = sel;
    glideTimer = setTimeout(() => {
      if (disposed || ctl.mode !== 'glide' || part !== sel) return;
      ctl.u = ctl.toU; ctl.v = ctl.toV;
      ctl.mode = 'idle';
      settleTile(part);
      sim.userWrite(part, wrap01(ctl.u), wrap01(ctl.v), true, clock);
      if (sim.isActive(part)) sim.release(part, 0, 0);
    }, ctl.dur + 120);
  }

  /** After a person's move, remember which tile copy the dot ended on (play-area coordinates in ctl). */
  function settleTile(p) {
    tile[p].u = Math.floor(ctl.u);
    tile[p].v = Math.floor(ctl.v);
    lastWrapped[p].u = wrap01(ctl.u); lastWrapped[p].v = wrap01(ctl.v);
  }

  function cancelGlide() { clearTimeout(glideTimer); if (ctl.mode === 'glide') ctl.mode = 'idle'; }

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

  /** Screen position of the dot (client px) into out.x / out.y. */
  function dotScreen(out) {
    projV.set(dotPos.x, dotPos.y, dotPos.z).project(camera);
    out.x = rect.left + (projV.x * 0.5 + 0.5) * rect.width;
    out.y = rect.top + (-projV.y * 0.5 + 0.5) * rect.height;
    return out;
  }
  const _scr = { x: 0, y: 0 };

  // ------------------------------------------------------------------ pointer
  const pointer = { x: 0, y: 0, inside: false, moved: false, touch: false, buttons: 0 };
  // press.kind: 'dot' drag | 'terrain' click-glide | 'size' / 'rotate' gestures | 'wp' waypoint drag
  let press = null;
  const touchIds = new Set();
  let longPress = 0;
  let rightBlocked = false;

  function blockCamera() {
    // Tell OrbitControls to ignore this button / finger but keep tracking it,
    // so a second finger still makes a pinch.
    controls.mouseButtons.LEFT = -1;
    controls.touches.ONE = -1;
  }

  function clearLongPress() { if (longPress) { clearTimeout(longPress); longPress = 0; } }

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
    const edit = editing();
    if (!isTouch && e.button === 2 && edit) {
      // right-click on a waypoint deletes it (and does not turn the camera)
      const i = markers.pickWaypoint(camera, rect, e.clientX, e.clientY, false);
      if (i >= 0) {
        deleteWaypoint(i);
        controls.mouseButtons.RIGHT = -1;
        rightBlocked = true;
        e.preventDefault();
      }
      return;
    }
    if (!isTouch && e.button !== 0) return; // right / middle: camera
    if (!isTouch) { try { canvas.focus({ preventScroll: true }); } catch { /* old browsers */ } }

    if (funInput) {
      // Golf: a drag from the ball aims, anywhere else turns the camera
      if (overDot(e.clientX, e.clientY, isTouch) && funInput('down', e.clientX, e.clientY)) {
        blockCamera();
        press = { id: e.pointerId, kind: 'fun', sx: e.clientX, sy: e.clientY, moved: false };
        canvas.style.cursor = 'crosshair';
        overlay.hide();
        return;
      }
      controls.mouseButtons.LEFT = THREE.MOUSE.ROTATE;
      controls.touches.ONE = THREE.TOUCH.ROTATE;
      return;
    }

    if (edit) {
      let i = markers.pickWaypoint(camera, rect, e.clientX, e.clientY, isTouch);
      if (i < 0 && pickTerrain(e.clientX, e.clientY, hit)) {
        i = addWaypoint(hit.u, hit.v);
        if (i < 0) {
          showReadout(e.clientX, e.clientY, `Up to ${MAX_WAYPOINTS} waypoints`);
          blockCamera();
          press = { id: e.pointerId, kind: 'none', sx: e.clientX, sy: e.clientY, moved: false };
          return;
        }
      }
      if (i >= 0) {
        blockCamera();
        press = { id: e.pointerId, kind: 'wp', index: i, sx: e.clientX, sy: e.clientY, moved: false };
        markers.setActive(i);
        canvas.style.cursor = 'grabbing';
        if (isTouch) {
          // a long press without moving deletes the waypoint
          clearLongPress();
          const id = e.pointerId;
          longPress = setTimeout(() => {
            longPress = 0;
            if (press && press.id === id && press.kind === 'wp' && !press.moved) {
              deleteWaypoint(press.index);
              press.kind = 'none';
              markers.setActive(-1);
            }
          }, LONG_PRESS_MS);
        }
        overlay.hide();
        return;
      }
      // empty sky: fall through to the camera
    }

    let kind = null;
    if (!edit && overDot(e.clientX, e.clientY, isTouch)) kind = e.shiftKey ? 'size' : e.altKey ? 'rotate' : 'dot';
    else if (!edit && pickTerrain(e.clientX, e.clientY, hit)) kind = 'terrain';

    if (!kind) {
      // empty sky: left drag orbits
      controls.mouseButtons.LEFT = THREE.MOUSE.ROTATE;
      controls.touches.ONE = THREE.TOUCH.ROTATE;
      return;
    }
    blockCamera();
    press = { id: e.pointerId, kind, sx: e.clientX, sy: e.clientY, moved: false, offU: 0, offV: 0, n0: 0, r0: 0, ang: 0, acc: 0 };
    ctl.histN = 0;
    if (kind === 'size') {
      press.n0 = toNorm(SIZE_DEF, num(refs[sel].params.size, SIZE_DEF.default));
      canvas.style.cursor = 'ns-resize';
      showReadout(e.clientX, e.clientY, `${SIZE_DEF.label} ${formatValue(SIZE_DEF, num(refs[sel].params.size, SIZE_DEF.default))}`);
      return;
    }
    if (kind === 'rotate') {
      press.r0 = num(refs[sel].params.rotate, 0);
      // The press starts on the dot, where there is no angle yet: the first
      // move far enough from its centre sets the reference.
      press.ang = NaN;
      canvas.style.cursor = 'grabbing';
      showReadout(e.clientX, e.clientY, `${ROTATE_DEF.label} ${formatValue(ROTATE_DEF, press.r0)}`);
      return;
    }
    if (kind === 'dot') {
      // grab the dot where it is drawn (a modulated or easing dot is not at its knob centre)
      _base.u = dotPos.u; _base.v = dotPos.v;
      dispOffset.u = 0; dispOffset.v = 0;
      if (pickTerrain(e.clientX, e.clientY, hit)) {
        press.offU = _base.u - hit.u;
        press.offV = _base.v - hit.v;
      }
      ctl.mode = 'drag';
      ctl.u = _base.u; ctl.v = _base.v;
      if (sim.isActive(sel)) sim.hold(sel, wrap01(ctl.u), wrap01(ctl.v));
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
    ctl.u = clampEdge(hit.u + press.offU);
    ctl.v = clampEdge(hit.v + press.offV);
    recordHist(hit.x, hit.z);
    if (sim.isActive(sel)) sim.hold(sel, wrap01(ctl.u), wrap01(ctl.v));
    sim.userWrite(sel, wrap01(ctl.u), wrap01(ctl.v), false, clock);
  }

  function onPointerMove(e) {
    pointer.x = e.clientX; pointer.y = e.clientY;
    pointer.inside = true; pointer.moved = true;
    pointer.touch = e.pointerType === 'touch';
    pointer.buttons = e.buttons;
    if (!press || e.pointerId !== press.id) return;
    if (!press.moved && Math.hypot(e.clientX - press.sx, e.clientY - press.sy) > (pointer.touch ? 8 : 4)) {
      press.moved = true;
      clearLongPress();
    }
    switch (press.kind) {
      case 'size': {
        const n = Math.min(1, Math.max(0, press.n0 - (e.clientY - press.sy) / SIZE_DRAG_PX));
        const v = Math.round(fromNorm(SIZE_DEF, n) * 1e5) / 1e5;
        writeParam('size', v);
        showReadout(e.clientX, e.clientY, `${SIZE_DEF.label} ${formatValue(SIZE_DEF, v)}`);
        break;
      }
      case 'rotate': {
        dotScreen(_scr);
        const dx = e.clientX - _scr.x, dy = e.clientY - _scr.y;
        if (dx * dx + dy * dy < 144) break;          // too close to the centre to read an angle
        const ang = Math.atan2(dy, dx);
        if (!Number.isFinite(press.ang)) { press.ang = ang; break; }
        let d = ang - press.ang;
        d -= 2 * Math.PI * Math.round(d / (2 * Math.PI));
        press.acc += d;
        press.ang = ang;
        let r = press.r0 + (press.acc * 180) / Math.PI;
        r -= 360 * Math.floor(r / 360);
        r = Math.round(r * 100) / 100;
        writeParam('rotate', r >= 360 ? 0 : r);
        showReadout(e.clientX, e.clientY, `${ROTATE_DEF.label} ${formatValue(ROTATE_DEF, r)}`);
        break;
      }
      case 'wp':
        if (press.moved && pickTerrain(e.clientX, e.clientY, hit)) moveWaypoint(press.index, hit.u, hit.v);
        break;
      case 'dot': case 'terrain':
        if (press.kind === 'dot' || press.moved) dragTo(e.clientX, e.clientY);
        break;
      case 'fun':
        if (funInput) funInput('move', e.clientX, e.clientY);
        break;
      default: break;
    }
  }

  function endPress(commit) {
    const p = press;
    press = null;
    clearLongPress();
    if (!p) return;
    if (p.kind === 'wp') markers.setActive(-1);
    if (p.kind === 'fun') {
      if (funInput) funInput(commit ? 'up' : 'cancel', 0, 0);
      canvas.style.cursor = '';
      return;
    }
    if (ctl.mode === 'drag') {
      ctl.mode = 'idle';
      settleTile(sel);
      sim.userWrite(sel, wrap01(ctl.u), wrap01(ctl.v), true, clock);
      if (sim.isActive(sel)) {
        flickVelocity(_flick);
        if (!commit) { _flick.x = 0; _flick.z = 0; }
        sim.release(sel, _flick.x, _flick.z);
      }
    }
    canvas.style.cursor = '';
  }

  function onPointerUp(e) {
    touchIds.delete(e.pointerId);
    if (rightBlocked && e.button === 2) { rightBlocked = false; controls.mouseButtons.RIGHT = THREE.MOUSE.ROTATE; }
    if (press && e.pointerId === press.id) endPress(true);
  }

  function onPointerLeave() { pointer.inside = false; overlay.hide(); markers.setHover(-1); }

  function onWheel(e) {
    rig.poke();
    if (editing() || funInput) return;
    rect = canvas.getBoundingClientRect();
    if (!overDot(e.clientX, e.clientY, false)) return;
    // over the dot the wheel sets Size instead of zooming
    e.preventDefault();
    e.stopImmediatePropagation();
    const dy = e.deltaMode === 1 ? e.deltaY * 33 : e.deltaMode === 2 ? e.deltaY * 400 : e.deltaY;
    if (dy === 0) return;
    nudgeSize(-Math.sign(dy) * Math.min(1, Math.abs(dy) / 100) * SIZE_STEP, e.clientX, e.clientY);
  }

  function onKeyDown(e) {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const k = e.key;
    if (k === 'ArrowLeft' || k === 'ArrowRight' || k === 'ArrowUp' || k === 'ArrowDown') {
      const step = e.shiftKey ? 0.0025 : 0.01;
      currentBase(_base);
      const du = k === 'ArrowLeft' ? -step : k === 'ArrowRight' ? step : 0;
      const dv = k === 'ArrowUp' ? -step : k === 'ArrowDown' ? step : 0;
      cancelGlide();
      const u = clampEdge(_base.u + du), v = clampEdge(_base.v + dv);
      ctl.u = u; ctl.v = v; settleTile(sel);
      if (sim.isActive(sel)) sim.teleport(sel, wrap01(u), wrap01(v));
      sim.userWrite(sel, wrap01(u), wrap01(v), true, clock);
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
    } else if (e.code === 'BracketLeft' || e.code === 'BracketRight' || k === '[' || k === ']') {
      const up = e.code === 'BracketRight' || k === ']';
      nudgeSize((up ? 1 : -1) * (e.shiftKey ? SIZE_STEP / 4 : SIZE_STEP), NaN, NaN);
      rig.poke();
      e.preventDefault();
      e.stopPropagation();
    } else if (editing() && k === 'Enter') {
      currentBase(_base);
      if (addWaypoint(_base.u, _base.v) < 0) showReadout(NaN, NaN, `Up to ${MAX_WAYPOINTS} waypoints`);
      e.preventDefault();
      e.stopPropagation();
    } else if (editing() && (k === 'Delete' || k === 'Backspace')) {
      const n = waypoints().length;
      if (n) deleteWaypoint(n - 1);
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
  // capture + non-passive: runs before OrbitControls' zoom and can stop it over the dot
  canvas.addEventListener('wheel', onWheel, { capture: true, passive: false });

  // ------------------------------------------------------------------ store
  function applyColors() {
    for (let p = 0; p < MAX_PARTS; p++) partLin[p] = hexToLinear(refs[p].color);
    colorDirty = true;
  }
  let colorDirty = true;

  function selectPart(p, animate) {
    const prev = sel;
    if (p === prev && animate) return;
    // keep the dot where it was on screen and let it glide to its new home
    const oldU = dotPos.u, oldV = dotPos.v;
    sel = p;
    selId = store.get(`parts.${p}.id`);
    if (press) endPress(false);
    ctl.mode = 'idle';
    loadPart(p, animate);
    live.primed = false;
    const t = teleFresh(performance.now());
    live.setTargets(refs[p].params, refs[p].mods, t, refs[p].links);
    currentBase(_base);
    if (animate && !reduced) {
      // both in play-area coordinates (currentBase adds the new part's tile)
      dispOffset.u = oldU - _base.u;
      dispOffset.v = oldV - _base.v;
      switchT = 0;
    } else {
      dispOffset.u = dispOffset.v = 0;
      switchT = 1;
    }
    colorDirty = true;
    minimapDirty = true;
    markersDirty = true;
    markers.setHover(-1);
    sim.setSelected(p);
  }

  const offStore = store.subscribe('', (path, value, meta) => {
    if (path === '' || path === 'parts' || /^parts\.\d+$/.test(path) || /^parts\.\d+\.(params|dot|mods|links|patterns|activePattern|seqOn)$/.test(path)) {
      // dot-sim.js re-syncs the dots itself (it listens to the same store)
      refreshRefs();
      applyColors();
      cache.invalidateAll();
      markersDirty = true;
      schedule();
      if (path === '' || path === 'parts') {
        // a different track may now sit at the selected index (one was removed or moved)
        const p = clampPart(store.get('ui.selectedPart'));
        if (store.get(`parts.${p}.id`) !== selId) sel = -1;
        selectPart(p, true);
      }
      return;
    }
    if (path.startsWith('ui')) {
      if (path === 'ui' ) { applyUi(); return; }
      switch (path) {
        case 'ui.selectedPart': selectPart(clampPart(store.get('ui.selectedPart')), true); break;
        case 'ui.view': if (!meta || meta.source !== 'visual') api.setView(store.get('ui.view')); break;
        case 'ui.quality': api.setQuality(store.get('ui.quality')); break;
        case 'ui.fpsCap': fpsCap = readFpsCap(); dyn.settle(performance.now()); break;
        case 'ui.renderScale': api.setRenderScale(store.get('ui.renderScale')); break;
        case 'ui.autoRotate': rig.setAutoRotate(!!store.get('ui.autoRotate')); break;
        case 'ui.renderStyle': api.setRenderStyle(store.get('ui.renderStyle')); break;
        case 'ui.palette': api.setPalette(store.get('ui.palette')); break;
        case 'ui.editWaypoints':
          editOn = !!store.get('ui.editWaypoints');
          // leaving edit mode mid-drag must not leave a waypoint grabbed
          if (press && press.kind === 'wp') endPress(false);
          markersDirty = true;
          pointer.moved = true;
          break;
        default: break;
      }
      return;
    }
    const m = /^parts\.(\d+)\.(\w+)(?:\.(\w+))?/.exec(path);
    if (!m) return;
    const p = Number(m[1]);
    if (!(p >= 0 && p < partCount(store))) return;
    const branch = m[2], leaf = m[3];
    if (branch === 'color') { refs[p].color = store.get(path) || refs[p].color; applyColors(); return; }
    if (branch === 'userTerrain') { cache.invalidate(p); return; }
    if (branch === 'dot') { if (p === sel) markersDirty = true; schedule(); return; }
    if (branch === 'patterns' || branch === 'activePattern' || branch === 'seqOn') { if (p === sel) markersDirty = true; return; }
    if (branch === 'params') {
      if (leaf === 'terrainA' || leaf === 'terrainB' || leaf === 'seed' || leaf === 'detail') { cache.invalidate(p); return; }
      // someone else moved the dot (a lock, a knob): a click-glide in flight gives way
      if ((leaf === 'centerX' || leaf === 'centerY') && !sim.writing && meta !== USER_META && p === sel && ctl.mode === 'glide') ctl.mode = 'idle';
    }
  });

  function applyUi() {
    editOn = !!store.get('ui.editWaypoints');
    selectPart(clampPart(store.get('ui.selectedPart')), true);
    api.setQuality(store.get('ui.quality'));
    fpsCap = readFpsCap();
    api.setRenderScale(store.get('ui.renderScale'));
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
    if (dayTint[0] !== 1 || dayTint[1] !== 1 || dayTint[2] !== 1) {
      for (let i = 0; i < 6; i++) for (let c = 0; c < 3; c++) ramp[i][c] *= dayTint[c];
    }
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
    markers.setColor(colCur, themeT);
    sky.setPart(colCur);
    colorDirty = Math.abs(colTarget[0] - colCur[0]) + Math.abs(colTarget[1] - colCur[1]) + Math.abs(colTarget[2] - colCur[2]) > 1e-4;
    colCss.value = refs[sel].color;
  }

  // ------------------------------------------------------------------ sizing
  function resize() {
    const w = Math.max(1, Math.round(container.clientWidth));
    const h = Math.max(1, Math.round(container.clientHeight));
    // 2.11 render budget: Auto caps the drawing buffer and scales it with the
    // dynamic resolution; Full is device pixels up to the quality cap.
    const budget = budgetPixelRatio(w, h, window.devicePixelRatio || 1, QUALITY[qualityName].pixelRatio, renderScale);
    const pr = renderScale === 'full' ? budget : quantizeRatio(budget * dyn.scale);
    if (w === width && h === height && pr === pixelRatio && composer) return;
    if (w !== width || h !== height) dyn.settle(performance.now());
    width = w; height = h; pixelRatio = pr;
    renderer.setPixelRatio(pr);
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    if (!composer) buildComposer();
    composer.setPixelRatio(pr);
    composer.setSize(w, h);
    orbit.setResolution(w * pr, h * pr, pr);
    markers.setResolution(w * pr, h * pr, pr);
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
  // 2.11: compile every scene shader up front, off the main thread where the
  // browser has KHR_parallel_shader_compile. The first frame used to link the
  // sky and marble programs synchronously, which froze start-up for seconds
  // on software GL. Without the extension this resolves at once and the first
  // frame compiles as before (nothing is compiled ahead of time).
  let shadersReady = false;
  function warmShaders() {
    const done = () => { shadersReady = true; };
    let p = null;
    try { if (renderer.extensions.has('KHR_parallel_shader_compile')) p = renderer.compileAsync(scene, camera); } catch { p = null; }
    if (!p || typeof p.then !== 'function') { done(); return; }
    p.then(done, done);
    setTimeout(done, 20000); // never wait on a stuck status query forever
  }
  function shouldRender() {
    return !held && !disposed && !contextLost && onScreen && document.visibilityState !== 'hidden' && width > 1 && height > 1;
  }

  function schedule() {
    const want = shouldRender();
    if (want && !running) {
      running = true;
      dyn.settle(performance.now());
      last = performance.now();
      raf = requestAnimationFrame(frame);
    } else if (!want && running) {
      running = false;
      clearTimeout(glideTimer);
      cancelAnimationFrame(raf);
    }
    // Keep rolling / drifting dots alive (they shape the sound) while the map
    // is scrolled away; the browser throttles this when the tab is hidden.
    const needPhysics = !want && !held && !disposed && sim.anyActive();
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
    for (let p = 0; p < partCount(store); p++) {
      if (p === sel) continue;
      const pr = refs[p].params;
      fields[p].setShape(num(pr.morph, 0), num(pr.warp, 0), num(pr.lift, 1));
    }
    if (ctl.mode === 'glide') {
      const t = Math.min(1, (now - ctl.t0) / ctl.dur);
      const e = easeOutCubic(t);
      ctl.u = ctl.fromU + (ctl.toU - ctl.fromU) * e;
      ctl.v = ctl.fromV + (ctl.toV - ctl.fromV) * e;
      if (sim.isActive(sel)) sim.hold(sel, wrap01(ctl.u), wrap01(ctl.v));
      sim.userWrite(sel, wrap01(ctl.u), wrap01(ctl.v), false, now);
      if (t >= 1) {
        ctl.mode = 'idle';
        settleTile(sel);
        sim.userWrite(sel, wrap01(ctl.u), wrap01(ctl.v), true, now);
        if (sim.isActive(sel)) sim.release(sel, 0, 0);
      }
    }
    // the selected part's dot is the person's while they glide or drag it
    sim.step(dt, now, ctl.mode !== 'idle' ? sel : -1);
  }

  /**
   * Follow the telemetry voices: which are sounding, their notes and levels,
   * and which one started last (its values are what telemetry reports).
   * Returns the newest voice's note, or NaN when nothing sounds.
   */
  function trackVoices(voices) {
    let newest = -1, bestOrder = -1;
    for (let id = 0; id < 8; id++) voiceAmps[id] = 0;
    const was = voiceSeen;
    let seenMask = 0;
    if (voices) {
      for (let i = 0; i < voices.length; i++) {
        const v = voices[i];
        const id = v.id | 0;
        if (id < 0 || id >= 8 || !Number.isFinite(v.note)) continue;
        seenMask |= 1 << id;
        if (!was[id] || voiceNote[id] !== v.note) voiceOrder[id] = ++voiceCounter;
        voiceNote[id] = v.note;
        voiceAmps[id] = Math.min(1, (v.amp || 0) * 2.2);
        if (voiceOrder[id] > bestOrder) { bestOrder = voiceOrder[id]; newest = id; }
      }
    }
    for (let id = 0; id < 8; id++) voiceSeen[id] = (seenMask >> id) & 1;
    return newest >= 0 ? voiceNote[newest] : NaN;
  }

  /** Waypoints, the route and the lock badges of the selected part, after a store change. */
  function refreshMarkers() {
    markersDirty = false;
    const d = refs[sel].dot || {};
    const list = Array.isArray(d.waypoints) ? d.waypoints : [];
    markers.setWaypoints(list);
    buildPlan(list, Math.round(num(d.tourMode, 0)), routePlan);
    routeN = sampleRoute(routePlan, ROUTE_PER_LEG, routeUV, _tmpUV);
    const seq = activeSeq(store.get(`parts.${sel}`)) || {};
    markers.setLocks(seq.steps, !!seq.enabled);
    minimap.setWaypoints(list);
    minimap.setLocks(seq.steps);
  }

  /** Mouse hover: cursor and the coordinate readout. */
  function hover() {
    if (readoutHideAt) return;          // a gesture readout is showing
    if (editing()) {
      const i = markers.pickWaypoint(camera, rect, pointer.x, pointer.y, false);
      markers.setHover(i);
      if (i >= 0) {
        canvas.style.cursor = 'grab';
        const w = waypoints()[i];
        overlay.show(pointer.x - rect.left, pointer.y - rect.top, `Waypoint ${i + 1} · ${w ? num(w.beats, 2) : 2} beat${w && w.beats === 1 ? '' : 's'}`);
      } else if (pickTerrain(pointer.x, pointer.y, hit)) {
        canvas.style.cursor = waypoints().length >= MAX_WAYPOINTS ? 'not-allowed' : 'copy';
        overlay.hide();
      } else {
        canvas.style.cursor = '';
        overlay.hide();
      }
      return;
    }
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

  /**
   * The camera never sinks into a hill or below the map: if the land under
   * it (plus a margin) is higher than the camera, lift it along its orbit
   * sphere, keeping the distance and the heading.
   */
  const _off = new THREE.Vector3();
  const _sph = new THREE.Spherical();
  /**
   * Keep the dot on screen: once it leaves the middle of the view (|NDC| over
   * FOLLOW_BOX), pan the camera and its target together towards it, faster
   * the further out it is. The orbit (distance, heading, tilt) is unchanged.
   */
  function followDot(dt) {
    projV.set(dotPos.x, dotPos.y, dotPos.z).project(camera);
    const behind = !(projV.z < 1);
    const ex = behind ? 2 : Math.max(Math.abs(projV.x) - FOLLOW_BOX, Math.abs(projV.y) - FOLLOW_BOX, 0) / (1 - FOLLOW_BOX);
    if (ex <= 0) return;
    const k = reduced ? 1 : Math.min(1, dt * FOLLOW_RATE * Math.min(2, Math.max(0.25, ex)));
    const dx = (dotPos.x - controls.target.x) * k, dz = (dotPos.z - controls.target.z) * k;
    if (!(Math.abs(dx) + Math.abs(dz) > 1e-6)) return;
    controls.target.x += dx; controls.target.z += dz;
    camera.position.x += dx; camera.position.z += dz;
  }

  /**
   * Centre the displayed plane on the tile copy under the camera's target.
   * Every copy is the same land, so moving it by whole tiles changes nothing
   * on screen; a little hysteresis stops it flipping at a tile edge.
   */
  function recentrePlane() {
    const tx = controls.target.x / W, tz = controls.target.z / W;
    if (Math.abs(tx - planeOrigin.x / W) > 0.6) planeOrigin.x = Math.round(tx) * W;
    if (Math.abs(tz - planeOrigin.z / W) > 0.6) planeOrigin.z = Math.round(tz) * W;
    terrain.mesh.position.set(planeOrigin.x, 0, planeOrigin.z);
    markers.group.position.set(planeOrigin.x, 0, planeOrigin.z);
    terrain.uniforms.uOrigin.value.set(planeOrigin.x, planeOrigin.z);
  }

  function keepAboveLand() {
    const cp = camera.position;
    // the land repeats in every direction, so there is always land under the camera
    const floor = Math.max(0, view.yAt(cp.x, cp.z)) + CAMERA_CLEARANCE;
    if (cp.y >= floor) return;
    _off.copy(cp).sub(controls.target);
    _sph.setFromVector3(_off);
    const c = (floor - controls.target.y) / Math.max(1e-6, _sph.radius);
    _sph.phi = Math.acos(c >= 1 ? 1 : c <= -1 ? -1 : c);
    _sph.makeSafe();
    _off.setFromSpherical(_sph);
    cp.copy(controls.target).add(_off);
    camera.lookAt(controls.target);
  }

  function frame(now) {
    if (!running) return;
    raf = requestAnimationFrame(frame);
    if (!pacer.shouldPaint(now, fpsCap)) return;
    // Until the shaders have compiled in the background the frame still runs
    // (dots move, sound follows) but skips the GPU work that would block on them.
    tick(now, shadersReady);
    // Dynamic resolution (Auto): the gap between painted frames against the
    // display frame or the frame-rate cap, whichever is longer.
    if (shadersReady && renderScale === 'auto') {
      const target = Math.max(pacer.frameMs, fpsCap > 0 ? 1000 / fpsCap : 0);
      if (dyn.frame(now, now - prevPaint, target)) resize();
    }
    prevPaint = now;
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
    // Day and night (v2.9): small steps a fifth of a second apart, so a change
    // of tint takes several seconds and never flickers.
    if (dayMoving && clock - dayAt >= DAY_STEP_MS) {
      dayAt = clock;
      dayMoving = stepTint(dayTint, dayTarget, DAY_STEP);
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
    const S = calmShapeStep(shapeShown, L, dt, reduced);
    view.setShape(terrain.hasB() ? S.morph : 0, S.warp, S.lift);
    fields[sel].setShape(terrain.hasB() ? L.morph : 0, L.warp, L.lift);   // physics keeps the live shape: the dot moves as before

    // ---- physics, glides, writes
    stepSimulation(dt, now);

    // ---- where the dot is shown
    const simActive = sim.isActive(sel);
    // When what places the dot changes (grabbing a modulated or rolling dot,
    // letting it go, a glide starting), start from where it was drawn and let
    // the display offset ease it to the new place instead of jumping there.
    const prevU = dotPos.u, prevV = dotPos.v, prevSrc = dotSrc;
    const centreMod = isModulated(r.mods, 'centerX', r.links) || isModulated(r.mods, 'centerY', r.links);
    if (ctl.mode !== 'idle') { dotPos.u = ctl.u; dotPos.v = ctl.v; dotSrc = 'ctl'; }
    else {
      let wu, wv;
      if (simActive) { const s = sim.state(sel); wu = s.u; wv = s.v; dotSrc = 'sim'; }
      else if (ghostDot[sel]) { wu = ghostDot[sel].u; wv = ghostDot[sel].v; dotSrc = 'ghost'; }
      else if (centreMod) { wu = L.centerX; wv = L.centerY; dotSrc = 'live'; }
      else { baseCenter(_base); wu = _base.u; wv = _base.v; dotSrc = 'base'; }
      wu = wrap01(wu); wv = wrap01(wv);
      // A rolling marble or a modulated centre that crosses a tile seam moves
      // on to the neighbouring copy instead of jumping back across the tile
      // (the map is endless, so it can keep going).
      const tp = tile[sel], lw = lastWrapped[sel];
      if (dotSrc !== prevSrc && Number.isFinite(prevU)) {
        // control changed hands (released, a glide or physics took over): show
        // the dot on the copy nearest to where it was drawn
        tp.u = Math.round(prevU - wu);
        tp.v = Math.round(prevV - wv);
      } else if (Number.isFinite(lw.u)) {
        if (wu - lw.u > 0.5) tp.u -= 1; else if (wu - lw.u < -0.5) tp.u += 1;
        if (wv - lw.v > 0.5) tp.v -= 1; else if (wv - lw.v < -0.5) tp.v += 1;
      }
      lw.u = wu; lw.v = wv;
      dotPos.u = wu + tp.u; dotPos.v = wv + tp.v;
    }
    if (dotSrc !== prevSrc && switchT >= 1 && Number.isFinite(prevU)) {
      dispOffset.u = prevU - dotPos.u;
      dispOffset.v = prevV - dotPos.v;
      if (Math.abs(dispOffset.u) > 1 || Math.abs(dispOffset.v) > 1) { dispOffset.u = 0; dispOffset.v = 0; }
    }
    dotPos.u += dispOffset.u;
    dotPos.v += dispOffset.v;
    dotPos.x = uToX(dotPos.u);
    dotPos.z = uToX(dotPos.v);
    const ground = view.yAt(dotPos.x, dotPos.z);
    // Zoomed far out the marble keeps a findable size on screen; it grows
    // around its contact point so it still sits on the land.
    const camDist = camera.position.distanceTo(controls.target);
    dotScale = Math.max(1, camDist / 20);
    let dy = ground + BALL_RADIUS * dotScale + 0.01;
    if (sim.isMarble(sel) && ctl.mode === 'idle') {
      const s = sim.state(sel);
      if (s.y > dy) dy = s.y;       // airborne after a bounce
    }
    dotPos.y = dy;

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
    glow = calmGlowStep(glow, level, dt);
    const glowShown = glow * (reduced ? CALM.reducedSwing : 1);

    // ---- orbits: the newest voice (bright), the knobs alone (thin), every voice
    const refNote = trackVoices(voices);
    const noteSize = num(r.params.noteSize, 0);
    if (Number.isFinite(refNote)) voiceLive(L, refNote, refNote, r.links, noteSize, orbitLive);
    else for (let i = 0; i < ORBIT_IDS.length; i++) orbitLive[ORBIT_IDS[i]] = L[ORBIT_IDS[i]];
    // the orbit is centred on the dot as shown, so it follows drags exactly
    orbitLive.centerX = dotPos.u; orbitLive.centerY = dotPos.v;
    let voiceShow = 0;
    for (let id = 0; id < 8; id++) {
      if (!voiceSeen[id]) { voiceSlots[id] = null; continue; }
      const vl = voiceLive(L, voiceNote[id], refNote, r.links, noteSize, voiceLives[id]);
      vl.centerX = dotPos.u + (vl.centerX - L.centerX);
      vl.centerY = dotPos.v + (vl.centerY - L.centerY);
      voiceSlots[id] = vl;
      if (orbitDifference(vl, orbitLive) > 1) voiceShow = 1;
    }
    const pr0 = r.params;
    baseLive.stretch = num(pr0.stretch, 0); baseLive.size = num(pr0.size, 0.22); baseLive.rotate = num(pr0.rotate, 0);
    baseLive.pathParam = num(pr0.pathParam, 0.5);
    baseLive.pathWindow = num(pr0.pathWindow, 0); baseLive.pathMangle = num(pr0.pathMangle, 0); baseLive.pathMirror = num(pr0.pathMirror, 0);
    baseCenter(_base);
    // the knob-only orbit sits at the knob centre (a held dot's knob centre is ctl)
    baseLive.centerX = centreMod && !simActive ? (ctl.mode === 'idle' ? _base.u + tile[sel].u : ctl.u) : dotPos.u;
    baseLive.centerY = centreMod && !simActive ? (ctl.mode === 'idle' ? _base.v + tile[sel].v : ctl.v) : dotPos.v;
    const baseShow = switchT >= 1 && orbitDifference(baseLive, orbitLive) > 1 ? 1 : 0;

    const shape = Math.round(num(r.params.pathShape, 0));
    const order = Math.round(num(r.params.pathOrder, 2));
    const bdt = dt * (reduced ? 0.4 : 1);
    orbit.update(view, shape, order, orbitLive.pathParam, orbitLive, spinPhase, flowHead, glowShown);
    orbit.updateBase(view, shape, order, baseLive.pathParam, baseLive, spinPhase, baseShow, dt);
    orbit.updateVoices(view, shape, order, voiceSlots, voiceAmps, spinPhase, voiceShow, dt);
    orbit.updateBeads(view, shape, order, orbitLive.pathParam, orbitLive, spinPhase, voices, bdt,
      num(L.pace, 0), Math.round(num(r.params.paceShape, 0)), Math.max(1, num(L.laps, 1)),
      Math.round(num(r.params.direction, 0)), Math.round(num(r.params.traverse, 0)));
    orbit.setVisibility(switchT < 1 ? 0.55 + 0.45 * switchT : 1);

    // ---- colours
    if (colorDirty || switchT < 1) applyPartColor(dt);

    // ---- the dot
    dot.update(dotPos.x, dotPos.y, dotPos.z, level, time, themeT, 1, dotScale);
    const gd = Math.hypot(wrapDelta(_base.u, dotPos.u), wrapDelta(_base.v, dotPos.v));
    const ghostWant = ctl.mode === 'idle' && switchT >= 1 && !simActive && gd > 0.004 ? 1 : 0;
    ghost.a += (ghostWant - ghost.a) * Math.min(1, dt * 6);
    const gx = dotPos.x + wrapDelta(_base.u, dotPos.u) * W, gz = dotPos.z + wrapDelta(_base.v, dotPos.v) * W;
    dot.setGhost(gx, view.yAt(gx, gz) + BALL_RADIUS * 0.62 + 0.01, gz, ghost.a);

    // ---- markers: waypoints and route, dot locks, Explore pings
    if (markersDirty) refreshMarkers();
    const mode = Math.round(num(r.dot.mode, MODE_PIN));
    const showWp = mode === MODE_TOUR || editing();
    { const gd = ghostDot[sel]; markers.setGhost(gd ? gd.u : null, gd ? gd.v : null); }
    if (showWp && routeN > 1) markers.setRoute(routeUV, routeN, view);
    else markers.setRoute(routeUV, 0, view);
    markers.update(view, dt, showWp, time, reduced);
    fun.update(view, dotPos, controls.target, dt, clock / 1000, reduced);

    // ---- terrain uniforms
    const u = terrain.uniforms;
    u.uMorph.value = terrain.hasB() ? S.morph : 0;
    u.uWarp.value = S.warp;
    u.uHeight.value = H * displayLift(S.lift);
    u.uLift.value = S.lift;
    u.uFold.value = S.fold;
    u.uStyle.value = styleIndex;
    u.uDot.value.set(dotPos.u, dotPos.v, dotPos.y - ground - BALL_RADIUS * dotScale, 1);
    u.uGhost.value.set(_base.u, _base.v, ghost.a);
    u.uTime.value = time;
    u.uLevel.value = glowShown;
    u.uFogStart.value = camera.position.distanceTo(controls.target) * 0.8;
    // footprint: inverse of the path transform's linear part
    {
      const ax = Math.pow(2, orbitLive.stretch * 1.5);
      const sx = ax * orbitLive.size, sy = orbitLive.size / ax;
      const th = (orbitLive.rotate / 360 + spinPhase) * Math.PI * 2;
      const c = Math.cos(th), s = Math.sin(th);
      const a = sx * c, b = -sy * s, cc = sx * s, d = sy * c;
      const det = a * d - b * cc;
      if (orbitLive.size > 0.004 && Math.abs(det) > 1e-9) {
        u.uFootInv.value.set(d / det, -b / det, -cc / det, a / det);
        u.uFootA.value = 0.7 * Math.min(1, orbitLive.size * 12);
      } else u.uFootA.value = 0;
    }
    sky.setTime(time);

    // ---- pointer hover (mouse only, not while pressing)
    if (pointer.moved && pointer.inside && !press && !pointer.touch && !pointer.buttons) {
      pointer.moved = false;
      hover();
    }
    if (readoutHideAt && clock > readoutHideAt && !press) { readoutHideAt = 0; overlay.hide(); pointer.moved = true; }

    // ---- camera
    const owned = rig.update(dt, now);
    // the map is endless: when the dot heads off screen (rolling, drifting,
    // gliding, a tour, a modulated centre, or let go near the edge), the view
    // follows it; never while a person is dragging it
    if (!owned && ctl.mode !== 'drag') followDot(dt);
    if (!owned) controls.update(dt);
    keepAboveLand();
    recentrePlane();

    // ---- HUD
    if ((minimapDirty || view.version !== minimapVersion) && now - minimapImgAt >= MINIMAP_TERRAIN_MS) {
      minimapImgAt = now;
      minimapDirty = false;
      minimapVersion = view.version;
      minimap.renderTerrain(view, styleIndex === 3 ? HEAT_RAMP : ramp, colCur, styleIndex === 3 ? 0 : PALETTES[paletteIndex].tint, atm.sunDir);
    }
    {
      minimapAt = now;
      const camAz = Math.atan2(camera.position.x - controls.target.x, camera.position.z - controls.target.z);
      minimap.setMarkers(showWp ? routeUV : null, showWp ? routeN : 0, showWp, markers.lockCount > 0);
      minimap.draw(orbit.uvs, orbit.count, orbit.closed, wrap01(dotPos.u), wrap01(dotPos.v), _base.u, _base.v, ghost.a, colCss.value, camAz, themeT);
    }
    if (!musicGiven && !music && now - musicLookAt > 1000) {
      musicLookAt = now;
      const g = typeof window !== 'undefined' ? window.orograph : null;
      if (g && g.visuals === api && g.music) setMusic(g.music);
    }

    // ---- post
    if (bloom && bloom.enabled) bloom.strength = atm.bloomStrength * (CALM.bloomBase + CALM.bloomSwing * glowShown);
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

    /** v2.9 ghost replay: track `part`'s dot follows the ghost at (u, v); null gives it back. */
    setGhost(part, pos) {
      if (!(part >= 0 && part < MAX_PARTS)) return;
      if (!pos || !Number.isFinite(pos.u) || !Number.isFinite(pos.v)) { ghostDot[part] = null; return; }
      const g = ghostDot[part] || (ghostDot[part] = { u: 0, v: 0 });
      g.u = pos.u; g.v = pos.v;
    },

    /** 'auto' (pixel budget + dynamic resolution, the default) or 'full'. */
    setRenderScale(mode) {
      const m = RENDER_SCALES.includes(mode) ? mode : 'auto';
      if (m === renderScale) return;
      renderScale = m;
      dyn.reset();
      dyn.settle(performance.now());
      resize();
    },

    setQuality(q) {
      const name = QUALITY[q] ? q : 'high';
      if (name === qualityName && composer) return;
      qualityName = name;
      terrain.setQuality(name);
      sky.setQuality(name);
      orbit.setQuality(name);
      buildComposer();
      width = 0;
      dyn.reset();
      resize();
      themeDirty = true;
    },

    captureCameraView() { return rig.capture(); },
    /**
     * The camera for "remember where I was" (v2.1). The land repeats every W
     * world units and a saved session keeps the dot in the home copy, so the
     * view is moved by whole copies to look at that copy (it looks the same).
     */
    captureLastCamera() {
      const c = rig.capture();
      if (!c || !Array.isArray(c.target) || !Array.isArray(c.position)) return c;
      const dx = -W * Math.round(c.target[0] / W), dz = -W * Math.round(c.target[2] / W);
      c.target = [c.target[0] + dx, c.target[1], c.target[2] + dz];
      c.position = [c.position[0] + dx, c.position[1], c.position[2] + dz];
      return c;
    },
    /** Put the camera back on launch without switching auto-rotate off for good. */
    restoreLastCamera(saved) {
      if (!rig.restore(saved)) return false;
      if (store.get('ui.view') !== rig.view) store.set('ui.view', rig.view, META);
      return true;
    },
    restoreCameraView(saved) {
      if (!rig.restore(saved)) return false;
      api.setAutoRotate(false);
      if (store.get('ui.view') !== rig.view) store.set('ui.view', rig.view, META);
      return true;
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

    /** Listen to map events ('extremum'). Returns a function that stops listening. */
    on(type, fn) {
      if (typeof fn !== 'function') return () => {};
      if (!handlers.has(type)) handlers.set(type, new Set());
      handlers.get(type).add(fn);
      return () => api.off(type, fn);
    },

    off(type, fn) {
      const set = handlers.get(type);
      if (set) set.delete(fn);
    },

    /** Follow the sequencer (dot-lock flashes, Tour on the beat). */
    setMusic(m) { musicGiven = !!m; setMusic(m); },

    /** Day and night (v2.9): tint the palette by [r, g, b] (linear), eased slowly; null for none. */
    setDayTint(rgb) {
      for (let c = 0; c < 3; c++) dayTarget[c] = Array.isArray(rgb) && Number.isFinite(rgb[c]) ? Math.min(1.5, Math.max(0.3, rgb[c])) : 1;
      dayMoving = dayTarget[0] !== dayTint[0] || dayTarget[1] !== dayTint[1] || dayTarget[2] !== dayTint[2];
    },
    dayTint: () => dayTint.slice(),

    /**
     * Hooks for the v2.9 extras (Golf and the pet). Nothing here
     * writes the session: the ball moves like a Roll marble (source
     * 'physics') and the golf dot settings are an override in the sim.
     */
    fun: {
      part: () => sel,
      setOverride: (p, dotSettings) => sim.setOverride(p, dotSettings),
      /** The selected part's ball: u, v (wrapped), speed (world units / s). */
      ball(out = {}) {
        const s = sim.state(sel);
        out.u = s.u; out.v = s.v; out.speed = Math.hypot(s.vx || 0, s.vz || 0);
        return out;
      },
      /** Put the ball at (u, v) and keep it there until shoot() (a simulated move, not an edit). */
      place(u, v) {
        cancelGlide();
        if (!sim.isActive(sel)) return;
        sim.teleport(sel, wrap01(u), wrap01(v));
        sim.hold(sel, wrap01(u), wrap01(v));
        sim.simWrite(sel, u, v, clock);
      },
      /** Let the ball go with velocity (vx, vz) in world units / s. */
      shoot(vx, vz) { if (sim.isActive(sel)) sim.release(sel, vx, vz); },
      /** Normalised land height (-1..1) at (u, v). */
      height: (u, v) => view.norm(u, v),
      ready: () => view.A.data !== null && view.A.data !== undefined,
      /** World offset from the drawn ball to the land under the pointer; false off the land. */
      aimAt(clientX, clientY, out) {
        rect = canvas.getBoundingClientRect();
        if (!pickTerrain(clientX, clientY, hit)) return false;
        out.dx = hit.x - dotPos.x; out.dz = hit.z - dotPos.z;
        return true;
      },
      /** Screen position of the drawn ball (client pixels). */
      ballScreen(out = {}) {
        rect = canvas.getBoundingClientRect();
        projV.set(dotPos.x, dotPos.y, dotPos.z).project(camera);
        out.x = rect.left + (projV.x * 0.5 + 0.5) * rect.width;
        out.y = rect.top + (-projV.y * 0.5 + 0.5) * rect.height;
        return out;
      },
      /** Angle (radians, world x towards z) the camera looks along, flattened. */
      viewAngle: () => Math.atan2(controls.target.z - camera.position.z, controls.target.x - camera.position.x),
      setInput(fn) { funInput = typeof fn === 'function' ? fn : null; if (!funInput && press && press.kind === 'fun') press = null; },
      setHole: (u, v) => fun.setHole(u, v),
      setFlags: (list, u, v) => fun.setFlags(list, u, v),
      setAim: (angle, power) => fun.setAim(angle, power),
      setPet(on) { fun.setPet(on, wrap01(dotPos.u + 0.04), wrap01(dotPos.v + 0.03), clock / 1000); },
      petNote() { fun.petNote(clock / 1000, reduced); },
      petState: () => fun.petState(),
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      running = false;
      cancelAnimationFrame(raf);
      if (physicsTimer) clearInterval(physicsTimer);
      funInput = null;
      fun.dispose();
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
      canvas.removeEventListener('focus', onFocusChange);
      canvas.removeEventListener('blur', onFocusChange);
      canvas.removeEventListener('wheel', onWheel, { capture: true });
      canvas.removeEventListener('webglcontextlost', onLost);
      canvas.removeEventListener('webglcontextrestored', onRestored);
      clearLongPress();
      if (offStep) offStep();
      handlers.clear();
      rig.dispose(); controls.dispose();
      sim.dispose();
      offTracks();
      cache.dispose();
      terrain.dispose(); sky.dispose(); orbit.dispose(); dot.dispose(); markers.dispose(); env.dispose();
      if (composer) { composer.renderTarget1.dispose(); composer.renderTarget2.dispose(); }
      if (bloom) bloom.dispose();
      if (outputPass) outputPass.dispose();
      if (sanitizePass) sanitizePass.dispose();
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
      dot() { return { u: dotPos.u, v: dotPos.v, x: dotPos.x, y: dotPos.y, z: dotPos.z, src: dotSrc, offset: [dispOffset.u, dispOffset.v] }; },
      /** The camera's target and the displayed plane's centre (world units; the plane follows the camera). */
      viewCentre() { return { target: [controls.target.x, controls.target.z], plane: [planeOrigin.x, planeOrigin.z] }; },
      /** Client coordinates of the marble's centre as drawn. */
      dotScreen() { rect = canvas.getBoundingClientRect(); return dotScreen({ x: 0, y: 0 }); },
      stats() {
        const info = renderer.info;
        return {
          frames, fps, cpuMsPerFrame: frames ? cpuMs / frames : 0,
          // average since resetStats(): frames over wall time
          fpsAvg: frames ? (frames * 1000) / Math.max(1, performance.now() - statsAt) : 0,
          drawCalls: info.render.calls, triangles: info.render.triangles,
          quality: qualityName, view: rig.view, themeT, running, autoRotate: controls.autoRotate,
          reducedMotion: reduced, selectedPart: sel,
          physics: Array.from({ length: partCount(store) }, (_, p) => sim.engineName(p)),
          music: !!music,
          floatLinear: terrain.floatLinear, size: [width, height, pixelRatio],
          resolution: { mode: renderScale, scale: dyn.scale, pixelRatio, buffer: [canvas.width, canvas.height] },
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
      /** Markers as shown: waypoint count, lock badges, route points, the camera's height over the land. */
      markers() {
        const cp = camera.position;
        return {
          waypoints: markers.waypointCount, locks: markers.lockCount, route: routeN,
          cameraClearance: cp.y - Math.max(0, view.yAt(cp.x, cp.z)),
          cameraPolar: Math.acos(Math.min(1, Math.max(-1, (cp.y - controls.target.y) / cp.distanceTo(controls.target)))),
        };
      },
      /** Client coordinates of waypoint i's pin (null when hidden). */
      waypoint(i) {
        const w = waypoints()[i];
        if (!w) return null;
        const x = wrapWorld(uToX(w.x)), z = wrapWorld(uToX(w.y));
        projV.set(x, view.yAt(x, z) + 0.12, z).project(camera);
        const r = canvas.getBoundingClientRect();
        return { x: r.left + (projV.x * 0.5 + 0.5) * r.width, y: r.top + (-projV.y * 0.5 + 0.5) * r.height };
      },
      /** Client coordinates of the dot. */
      dotScreen() { rect = canvas.getBoundingClientRect(); return dotScreen({ x: 0, y: 0 }); },
      orbits() { return { base: orbit.baseVisible, voices: orbit.voicesVisible, voiceSegments: orbit.voiceSegments }; },
      camera() { return { x: camera.position.x, y: camera.position.y, z: camera.position.z }; },
      /** Put the camera somewhere (tests: try to push it under the land). */
      setCamera(x, y, z) { camera.position.set(x, y, z); camera.lookAt(controls.target); },
    },
  };

  // ------------------------------------------------------------------ start
  resize();
  if (!composer) buildComposer();
  applyAtmosphere();
  loadPart(sel, false);
  sim.setSelected(sel);
  // other parts' tables are only needed once they move on their own (the sim
  // asked for them already through ensureField)
  live.setTargets(refs[sel].params, refs[sel].mods, null, refs[sel].links);
  applyPartColor(1);
  rig.setView(VIEW_NAMES.includes(store.get('ui.view')) ? store.get('ui.view') : 'orbit', false);
  api.setRenderStyle(store.get('ui.renderStyle'));
  warmShaders();
  schedule();
  return api;
}
