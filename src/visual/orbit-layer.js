// The live orbit: the selected part's path, drawn with exactly the transform
// the audio uses (src/dsp/terrain-math.js) and draped on the displayed land.
// Two Line2 passes: a soft, wide glow that also shows through hills (so the
// whole orbit is always readable) and a crisp depth-tested core whose colour
// carries a bright pulse travelling along the loop. One small bead with a
// short comet trail rides the path for every sounding voice.
//
// Buffers are allocated once; every frame writes into them in place.

import * as THREE from 'three';
import { Line2 } from 'three/addons/lines/Line2.js';
import { LineGeometry } from 'three/addons/lines/LineGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { pathPoint, paceWarp, syncPhase } from '../dsp/paths.js';
import { makeTransform, applyTransform } from '../dsp/terrain-math.js';
import { W } from './heightfield.js';

export const PATH_POINTS = { high: 512, medium: 384, low: 256 };
export const MAX_POINTS = 512;
const SCAN = 6;
export const LIFT_ABOVE = 0.05;
const TRAIL = 12;
const MAX_VOICES = 8;

/**
 * Compute the orbit polyline in world space. Pure apart from the inputs; used
 * by the layer and by the tests. Writes n points (x, y, z) into out and the
 * matching unwrapped (u, v) into uvOut when given. Returns n.
 */
export function computeOrbit(hf, shape, order, param, live, spinPhase, n, out, uvOut, xf, tmp) {
  makeTransform(live.stretch, live.size, live.rotate, spinPhase, live.centerX, live.centerY, xf);
  for (let i = 0; i < n; i++) {
    pathPoint(shape, i / n, order, param, tmp);
    applyTransform(xf, tmp.x, tmp.y, tmp);
    const u = tmp.u, v = tmp.v;
    out[i * 3] = (u - 0.5) * W;
    out[i * 3 + 1] = hf.y(u, v) + LIFT_ABOVE;
    out[i * 3 + 2] = (v - 0.5) * W;
    if (uvOut) { uvOut[i * 2] = u; uvOut[i * 2 + 1] = v; }
  }
  return n;
}

// LineMaterial patch: in screen-space mode vUv.x runs -1..1 across the line
// and |vUv.y| > 1 on the round caps. The glow pass turns that into a soft
// gaussian falloff. A dense polyline drawn wide overlaps itself many times,
// so the glow is not accumulated: at night it blends with MAX (a light that
// never exceeds its own peak), by day with MIN towards a tint (a soft
// coloured shade that reads on bright ground). Either way, no streaks.
function patchGlow(mat, uniforms) {
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uGlowMode = uniforms.uGlowMode;
    shader.fragmentShader = 'uniform float uGlowMode;\n' + shader.fragmentShader.replace(
      'gl_FragColor = vec4( diffuseColor.rgb, alpha );',
      `float gq = vUv.x * vUv.x + ( abs( vUv.y ) > 1.0 ? ( abs( vUv.y ) - 1.0 ) * ( abs( vUv.y ) - 1.0 ) : 0.0 );
       float glowA = exp( -gq * 3.2 ) * alpha;
       vec3 night = diffuseColor.rgb * glowA;
       vec3 day = mix( vec3( 1.0 ), diffuseColor.rgb, glowA );
       gl_FragColor = vec4( mix( night, day, uGlowMode ), 1.0 );`);
  };
  mat.customProgramCacheKey = () => 'orograph-glow';
}

function patchCore(mat) {
  mat.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace(
      'gl_FragColor = vec4( diffuseColor.rgb, alpha );',
      `float ex = abs( vUv.x );
       float aw = max( fwidth( vUv.x ), 1e-4 );
       float edgeA = 1.0 - smoothstep( 1.0 - 2.0 * aw, 1.0, ex );
       gl_FragColor = vec4( diffuseColor.rgb * ( 1.0 + 0.35 * ( 1.0 - ex ) ), alpha * edgeA );`);
  };
  mat.customProgramCacheKey = () => 'orograph-core';
}

function makeLine(maxPts, material) {
  const geo = new LineGeometry();
  // One allocation for the lifetime of the layer: positions and colours for
  // maxPts segments (a closed loop needs as many segments as points).
  geo.setPositions(new Float32Array((maxPts + 1) * 3));
  geo.setColors(new Float32Array((maxPts + 1) * 3));
  const line = new Line2(geo, material);
  line.frustumCulled = false;
  return line;
}

const BEAD_VERT = /* glsl */`
attribute float aAlpha;
attribute float aSize;
uniform float uScale;
varying float vA;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  vA = aAlpha;
  gl_PointSize = aSize * uScale / max(-mv.z, 0.5);
}
`;
const BEAD_FRAG = /* glsl */`
uniform vec3 uColor;
uniform vec3 uCore;
varying float vA;
void main() {
  float d = length(gl_PointCoord - 0.5) * 2.0;
  float halo = exp(-d * d * 3.5);
  float core = 1.0 - smoothstep(0.18, 0.34, d);
  vec3 c = mix(uColor * halo, uCore, core);
  float a = max(halo, core) * vA;
  if (a < 0.003) discard;
  gl_FragColor = vec4(c, a);
}
`;

export function createOrbitLayer(quality = 'high') {
  let nPts = PATH_POINTS[quality] || PATH_POINTS.high;

  const glowUniforms = { uGlowMode: { value: 0 } };
  const glowMat = new LineMaterial({
    color: 0xffffff, linewidth: 14, vertexColors: true, transparent: true, opacity: 0.5,
    depthTest: false, depthWrite: false, worldUnits: false,
  });
  glowMat.blending = THREE.CustomBlending;
  glowMat.blendEquation = THREE.MaxEquation;
  patchGlow(glowMat, glowUniforms);
  const coreMat = new LineMaterial({
    color: 0xffffff, linewidth: 2.6, vertexColors: true, transparent: true, opacity: 1,
    depthTest: true, depthWrite: false, worldUnits: false,
  });
  patchCore(coreMat);

  const glow = makeLine(MAX_POINTS, glowMat);
  const core = makeLine(MAX_POINTS, coreMat);
  glow.renderOrder = 6;
  core.renderOrder = 7;

  const group = new THREE.Group();
  group.add(glow, core);

  const segPos = glow.geometry.attributes.instanceStart.data.array;
  const segCol = glow.geometry.attributes.instanceColorStart.data.array;
  const corePos = core.geometry.attributes.instanceStart.data.array;
  const coreCol = core.geometry.attributes.instanceColorStart.data.array;

  // Beads: MAX_VOICES * TRAIL points.
  const beadCount = MAX_VOICES * TRAIL;
  const bPos = new Float32Array(beadCount * 3);
  const bAlpha = new Float32Array(beadCount);
  const bSize = new Float32Array(beadCount);
  const beadGeo = new THREE.BufferGeometry();
  beadGeo.setAttribute('position', new THREE.BufferAttribute(bPos, 3));
  beadGeo.setAttribute('aAlpha', new THREE.BufferAttribute(bAlpha, 1));
  beadGeo.setAttribute('aSize', new THREE.BufferAttribute(bSize, 1));
  const beadUniforms = {
    uScale: { value: 100 }, uColor: { value: new THREE.Vector3(1, 0.6, 0.3) }, uCore: { value: new THREE.Vector3(2, 2, 2) },
  };
  const beadMat = new THREE.ShaderMaterial({
    vertexShader: BEAD_VERT, fragmentShader: BEAD_FRAG, uniforms: beadUniforms,
    transparent: true, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending,
  });
  const beads = new THREE.Points(beadGeo, beadMat);
  beads.frustumCulled = false;
  beads.renderOrder = 8;
  group.add(beads);

  const pts = new Float32Array(MAX_POINTS * 3);
  const uvs = new Float32Array(MAX_POINTS * 2);
  const xf = { a: 0, b: 0, c: 0, d: 0, cx: 0, cy: 0 };
  const tmp = { x: 0, y: 0, u: 0, v: 0 };
  const color = [1, 0.5, 0.3];
  let glowGain = 1;
  let pixelRatioNow = 1;
  let day = false;
  let visibility = 1;
  let count = 0;
  let closed = true;
  const voicePhase = new Float64Array(MAX_VOICES);
  const voiceAmp = new Float64Array(MAX_VOICES);
  const voiceSeen = new Uint8Array(MAX_VOICES);

  function writeSegments() {
    // Segment i joins point i to point i+1 (wrapping for closed paths).
    const segs = closed ? count : count - 1;
    for (let i = 0; i < segs; i++) {
      const a = i * 3, b = ((i + 1) % count) * 3, o = i * 6;
      segPos[o] = pts[a]; segPos[o + 1] = pts[a + 1]; segPos[o + 2] = pts[a + 2];
      segPos[o + 3] = pts[b]; segPos[o + 4] = pts[b + 1]; segPos[o + 5] = pts[b + 2];
      corePos[o] = pts[a]; corePos[o + 1] = pts[a + 1]; corePos[o + 2] = pts[a + 2];
      corePos[o + 3] = pts[b]; corePos[o + 4] = pts[b + 1]; corePos[o + 5] = pts[b + 2];
    }
    glow.geometry.instanceCount = segs;
    core.geometry.instanceCount = segs;
    glow.geometry.attributes.instanceStart.data.needsUpdate = true;
    core.geometry.attributes.instanceStart.data.needsUpdate = true;
  }

  // Colour per segment: a dim base with a bright head and a fading tail
  // travelling along the loop. HDR values (> 1) feed the bloom.
  function writeColors(head, base, peak) {
    const segs = glow.geometry.instanceCount;
    const r = color[0], g = color[1], b = color[2];
    for (let i = 0; i < segs; i++) {
      const o = i * 6;
      for (let e = 0; e < 2; e++) {
        const s = (i + e) / count;
        let d = head - s;
        d -= Math.floor(d);                 // distance behind the head, 0..1
        const d2 = d > 0.5 ? 0 : d;
        const pulse = Math.exp(-d2 * 14) + 0.5 * Math.exp(-((d - 0.5) * (d - 0.5)) * 900);
        const c = o + e * 3;
        if (day) {
          // Day: a deep, saturated core and a pale tint for the MIN-blended halo.
          const kd = 0.8 + 0.45 * pulse;
          coreCol[c] = r * kd; coreCol[c + 1] = g * kd; coreCol[c + 2] = b * kd;
          const tint = 0.55 + 0.35 * pulse;
          segCol[c] = 1 - (1 - r) * tint; segCol[c + 1] = 1 - (1 - g) * tint; segCol[c + 2] = 1 - (1 - b) * tint;
        } else {
          const k = (base + peak * pulse) * glowGain;
          coreCol[c] = r * k + pulse * 0.25 * glowGain;
          coreCol[c + 1] = g * k + pulse * 0.25 * glowGain;
          coreCol[c + 2] = b * k + pulse * 0.25 * glowGain;
          const kg = (0.55 + 0.9 * pulse) * glowGain;
          segCol[c] = r * kg; segCol[c + 1] = g * kg; segCol[c + 2] = b * kg;
        }
      }
    }
    glow.geometry.attributes.instanceColorStart.data.needsUpdate = true;
    core.geometry.attributes.instanceColorStart.data.needsUpdate = true;
  }

  return {
    group,
    points: pts,
    uvs,
    get count() { return count; },
    get closed() { return closed; },

    setColor(lin) {
      color[0] = lin[0]; color[1] = lin[1]; color[2] = lin[2];
      beadUniforms.uColor.value.set(lin[0] * 2.2, lin[1] * 2.2, lin[2] * 2.2);
    },

    /** Theme: additive glow at night; on the light theme lines are normal-blended and less hot. */
    setTheme(t, gain) {
      glowGain = gain;
      day = t > 0.5;
      glowMat.blendEquation = day ? THREE.MinEquation : THREE.MaxEquation;
      glowUniforms.uGlowMode.value = day ? 1 : 0;
      glowMat.opacity = (day ? 0.85 : 0.75) * visibility;
      coreMat.linewidth = (day ? 3.4 : 2.6) * pixelRatioNow;
      beadMat.blending = day ? THREE.NormalBlending : THREE.AdditiveBlending;
      beadUniforms.uCore.value.setScalar(day ? 1.0 : 2.4);
    },

    setVisibility(v) {
      visibility = v;
      coreMat.opacity = v;
      glowMat.opacity = (day ? 0.85 : 0.75) * v;
      group.visible = v > 0.002;
    },

    setResolution(w, h, pixelRatio) {
      glowMat.resolution.set(w, h);
      coreMat.resolution.set(w, h);
      pixelRatioNow = pixelRatio;
      glowMat.linewidth = 14 * pixelRatio;
      coreMat.linewidth = (day ? 3.4 : 2.6) * pixelRatio;
      beadUniforms.uScale.value = h * 0.9;
    },

    setQuality(q) { nPts = PATH_POINTS[q] || PATH_POINTS.high; },

    /** Rebuild the polyline for this frame. */
    update(hf, shape, order, param, live, spinPhase, head, energy) {
      count = computeOrbit(hf, shape, order, param, live, spinPhase, nPts, pts, uvs, xf, tmp);
      closed = shape !== SCAN;
      writeSegments();
      writeColors(head, 0.55 + 0.25 * energy, 1.6 + 1.2 * energy);
    },

    /**
     * Voice beads. voices: telemetry list [{id, note, amp}] (may be null).
     * Each bead advances along the loop at a slowed, pitch-related rate.
     */
    updateBeads(hf, shape, order, param, live, spinPhase, voices, dt, pace = 0, paceShape = 0, laps = 1) {
      voiceSeen.fill(0);
      if (voices) {
        for (let i = 0; i < voices.length; i++) {
          const v = voices[i];
          const id = v.id | 0;
          if (id < 0 || id >= MAX_VOICES) continue;
          voiceSeen[id] = 1;
          const rate = beadRate(v.note);
          voicePhase[id] = (voicePhase[id] + rate * dt) % 1;
          voiceAmp[id] += (Math.min(1, (v.amp || 0) * 2.2) - voiceAmp[id]) * Math.min(1, dt * 18);
        }
      }
      let k = 0;
      makeTransform(live.stretch, live.size, live.rotate, spinPhase, live.centerX, live.centerY, xf);
      for (let id = 0; id < MAX_VOICES; id++) {
        if (!voiceSeen[id]) voiceAmp[id] *= Math.exp(-dt * 6);
        const amp = voiceAmp[id];
        for (let j = 0; j < TRAIL; j++, k++) {
          if (amp < 0.01) { bAlpha[k] = 0; continue; }
          // the bead's slowed cycle phase, through Pace and Laps exactly as the oscillator
          let ph = voicePhase[id] - j * 0.0065;
          ph -= Math.floor(ph);
          const t = syncPhase(paceWarp(ph, pace, paceShape), laps);
          pathPoint(shape, t, order, param, tmp);
          applyTransform(xf, tmp.x, tmp.y, tmp);
          bPos[k * 3] = (tmp.u - 0.5) * W;
          bPos[k * 3 + 1] = hf.y(tmp.u, tmp.v) + LIFT_ABOVE * 1.6;
          bPos[k * 3 + 2] = (tmp.v - 0.5) * W;
          const fall = 1 - j / TRAIL;
          bAlpha[k] = amp * fall * fall * visibility;
          bSize[k] = j === 0 ? 0.42 : 0.26 * fall + 0.05;
        }
      }
      beadGeo.attributes.position.needsUpdate = true;
      beadGeo.attributes.aAlpha.needsUpdate = true;
      beadGeo.attributes.aSize.needsUpdate = true;
    },

    dispose() {
      glow.geometry.dispose(); core.geometry.dispose();
      glowMat.dispose(); coreMat.dispose();
      beadGeo.dispose(); beadMat.dispose();
    },
  };
}

/** Bead speed in loops per second for a MIDI note: slowed far below audio rate, half an octave per octave. */
export function beadRate(note) {
  const n = Number.isFinite(note) ? note : 60;
  return Math.min(1.6, Math.max(0.05, 0.24 * Math.pow(2, (n - 60) / 24)));
}

/** Flow pulse speed (loops per second) from the playing pitch, or an idle drift. */
export function flowRate(note) {
  if (!Number.isFinite(note)) return 0.09;
  return Math.min(1.2, Math.max(0.08, 0.32 * Math.pow(2, (note - 60) / 18)));
}
