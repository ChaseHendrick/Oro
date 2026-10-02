// Camera presets ('orbit', 'top', 'low') with eased transitions, framing that
// adapts to the viewport's aspect ratio, and a gentle idle auto-rotate that
// only starts once the user has left the view alone for a while.

import * as THREE from 'three';

export const VIEW_NAMES = ['orbit', 'top', 'low'];

const PRESETS = {
  orbit: { phi: 0.86, scale: 1.0 },
  top: { phi: 0.0006, scale: 1.0, theta: 0 },
  low: { phi: 1.27, scale: 0.8 },
};

export const FOV = 38;
const IDLE_BEFORE_ROTATE = 5; // seconds

function easeInOutCubic(t) {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

/** Polar angle for a view: portrait screens look down more, so the land fills the height. */
export function presetPhi(view, aspect) {
  const p = (PRESETS[view] || PRESETS.orbit).phi;
  if (view === 'top') return p;
  const a = Math.max(0.3, aspect || 1.5);
  const k = a >= 1.2 ? 0 : a <= 0.5 ? 1 : (1.2 - a) / 0.7;
  return p - k * (view === 'low' ? 0.3 : 0.26);
}

/** Distance that frames the centre tile for a view and aspect ratio. */
export function frameDistance(view, aspect) {
  const a = Math.max(0.3, aspect || 1.5);
  const tanHalf = Math.tan((FOV * Math.PI) / 360);
  if (view === 'top') {
    // fit a 11.6 x 11.6 square (tile plus margin) both ways
    const half = 5.8;
    return Math.max(half / tanHalf, half / (tanHalf * a));
  }
  const base = 19 * (PRESETS[view] || PRESETS.orbit).scale;
  // narrow viewports: make the tile (plus a little margin) fit the width
  const byWidth = 5.6 / (tanHalf * a) * (view === 'low' ? 0.85 : 1);
  return Math.min(44, Math.max(base, byWidth));
}

export function createCameraRig(camera, controls, clock = () => performance.now()) {
  const target = controls.target;
  const sph = new THREE.Spherical();
  const from = new THREE.Spherical();
  const to = new THREE.Spherical();
  const offset = new THREE.Vector3();
  let transition = null; // { t0, dur }
  let view = 'orbit';
  let idle = 0;
  let autoRotate = true;
  let reduced = false;
  let rotateGain = 0;
  let lastAspect = camera.aspect;

  controls.addEventListener('start', () => {
    transition = null;
    idle = 0;
  });

  function current(out) {
    offset.copy(camera.position).sub(target);
    out.setFromVector3(offset);
    return out;
  }

  function goal(name, out) {
    const p = PRESETS[name] || PRESETS.orbit;
    current(out);
    out.radius = frameDistance(name, camera.aspect);
    out.phi = presetPhi(name, camera.aspect);
    if (p.theta !== undefined) out.theta = p.theta;
    return out;
  }

  function apply(s) {
    offset.setFromSpherical(s);
    camera.position.copy(target).add(offset);
    camera.lookAt(target);
  }

  return {
    get view() { return view; },
    get transitioning() { return !!transition; },

    /** Animate to a preset (instant when animate is false or motion is reduced). */
    setView(name, animate = true) {
      const n = VIEW_NAMES.includes(name) ? name : 'orbit';
      // The UI and the store may both ask for the same view in one tick.
      if (n === view && transition && clock() - transition.t0 < 150) return;
      view = n;
      current(from);
      goal(n, to);
      // shortest way round in azimuth
      let d = to.theta - from.theta;
      d = Math.atan2(Math.sin(d), Math.cos(d));
      to.theta = from.theta + d;
      if (!animate || reduced) {
        apply(to);
        transition = null;
      } else {
        transition = { t0: clock(), dur: 1100 };
      }
      idle = 0;
    },

    setAutoRotate(on) { autoRotate = !!on; },
    get autoRotate() { return autoRotate; },
    setReducedMotion(on) { reduced = !!on; },

    /** Called when the viewport changes shape: keep the framing for the current view. */
    onAspect() {
      if (Math.abs(camera.aspect - lastAspect) < 1e-3) return;
      const before = frameDistance(view, lastAspect);
      const phiBefore = presetPhi(view, lastAspect);
      const prevAspect = lastAspect;
      lastAspect = camera.aspect;
      const after = frameDistance(view, camera.aspect);
      current(sph);
      sph.radius = Math.min(controls.maxDistance, Math.max(controls.minDistance, sph.radius * (after / before)));
      if (prevAspect > 0) sph.phi = Math.max(0.0006, sph.phi + presetPhi(view, camera.aspect) - phiBefore);
      apply(sph);
    },

    /** Mark user activity (pointer, keys) so auto-rotate waits. */
    poke() { idle = 0; },

    /** Per frame; returns true while a transition owns the camera. */
    update(dt, now = clock()) {
      idle += dt;
      const want = autoRotate && !reduced && view === 'orbit' && !transition && idle > IDLE_BEFORE_ROTATE;
      rotateGain += ((want ? 1 : 0) - rotateGain) * Math.min(1, dt * 0.8);
      controls.autoRotate = rotateGain > 0.002;
      controls.autoRotateSpeed = 0.32 * rotateGain;
      if (!transition) return false;
      const t = Math.min(1, Math.max(0, (now - transition.t0) / transition.dur));
      const e = easeInOutCubic(t);
      sph.radius = from.radius + (to.radius - from.radius) * e;
      sph.phi = from.phi + (to.phi - from.phi) * e;
      sph.theta = from.theta + (to.theta - from.theta) * e;
      apply(sph);
      if (t >= 1) transition = null;
      return true;
    },
  };
}
