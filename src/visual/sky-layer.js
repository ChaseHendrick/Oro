// Atmosphere: a gradient sky dome with twinkling stars and faint aurora
// curtains at night, a soft dawn sky with sun glow and haze by day, and a
// cloud of drifting particles (fireflies at night, pollen motes by day).
// Everything animates in the shaders from a time uniform, so the CPU does no
// per-frame work beyond setting a handful of uniforms.

import * as THREE from 'three';
import { mulberry32 } from '../dsp/terrain-math.js';

const SKY_VERT = /* glsl */`
varying vec3 vDir;
void main() {
  vDir = normalize(position);
  vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  gl_Position = p.xyww;   // pinned to the far plane
}
`;

const SKY_FRAG = /* glsl */`
uniform vec3 uZenith;
uniform vec3 uHorizon;
uniform vec3 uGround;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform float uStars;
uniform float uAurora;
uniform float uSun;
uniform float uHaze;
uniform float uTime;
uniform vec3 uPart;
varying vec3 vDir;

const float PI = 3.141592653589793;

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
vec2 hash22(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.xx + p3.yz) * p3.zy);
}
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = hash12(i), b = hash12(i + vec2(1.0, 0.0));
  float c = hash12(i + vec2(0.0, 1.0)), d = hash12(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

// One layer of stars on an (azimuth, elevation) grid; each cell holds a star
// at a jittered position whose brightness and twinkle rate come from a hash.
float starLayer(vec2 sp, float scale, float density) {
  vec2 g = sp * scale;
  vec2 cell = floor(g);
  vec2 f = fract(g);
  float h = hash12(cell);
  if (h > density) return 0.0;
  vec2 pos = 0.2 + 0.6 * hash22(cell + 7.0);
  float d = length(f - pos);
  float size = 0.035 + 0.05 * hash12(cell + 3.1);
  float tw = 0.6 + 0.4 * sin(uTime * (0.6 + 2.2 * hash12(cell + 9.7)) + h * 40.0);
  float core = smoothstep(size, 0.0, d);
  return core * core * tw * (0.35 + 0.65 * hash12(cell + 1.3));
}

void main() {
  vec3 d = normalize(vDir);
  float y = d.y;
  vec3 col;
  if (y >= 0.0) {
    col = mix(uHorizon, uZenith, pow(y, 0.4));
  } else {
    col = mix(uHorizon, uGround, pow(min(-y * 3.0, 1.0), 0.6));
  }

  // Haze band hugging the horizon.
  col = mix(col, uHorizon * 1.04, uHaze * exp(-abs(y) * 9.0) * 0.6);

  // Sun (day) or a soft moon halo (night).
  vec3 sd = normalize(uSunDir);
  float mu = max(dot(d, sd), 0.0);
  float disc = smoothstep(0.9993, 0.99965, mu);
  col += uSunColor * (pow(mu, 9.0) * 0.32 + pow(mu, 90.0) * 0.6 + disc * 4.0) * uSun;
  col += uSunColor * (pow(mu, 30.0) * 0.06 + smoothstep(0.99955, 0.9998, mu) * 0.9) * (1.0 - uSun) * uStars;

  if (uStars > 0.001 && y > -0.02) {
    float az = atan(d.z, d.x) / PI;           // -1..1
    float el = asin(clamp(y, -1.0, 1.0)) / (0.5 * PI);
    vec2 sp = vec2(az * 2.0 * (0.35 + 0.65 * (1.0 - el)), el);
    float s = starLayer(sp, 70.0, 0.32) + starLayer(sp + 3.7, 140.0, 0.22) * 0.7;
    float fadeLow = smoothstep(0.0, 0.18, y);
    col += vec3(0.85, 0.9, 1.0) * s * 1.6 * uStars * fadeLow;

    // Aurora: soft vertical curtains folding along the azimuth.
    if (uAurora > 0.001) {
      float band = smoothstep(0.05, 0.22, y) * (1.0 - smoothstep(0.35, 0.75, y));
      float x = az * 6.0 + 0.6 * sin(az * 9.0 + uTime * 0.05) + uTime * 0.012;
      float curtain = vnoise(vec2(x * 2.2, uTime * 0.03)) * vnoise(vec2(x * 5.0 + 3.0, y * 2.0 - uTime * 0.04));
      curtain = smoothstep(0.12, 0.6, curtain);
      float rays = 0.65 + 0.35 * vnoise(vec2(x * 40.0, y * 3.0 + uTime * 0.1));
      vec3 green = vec3(0.12, 0.85, 0.55);
      vec3 violet = vec3(0.45, 0.25, 0.95);
      vec3 ac = mix(green, violet, smoothstep(0.12, 0.45, y));
      ac = mix(ac, uPart, 0.18);
      col += ac * curtain * rays * band * 0.16 * uAurora;
      // faint nebula wash
      float neb = vnoise(sp * vec2(3.0, 6.0) + 11.0) * vnoise(sp * vec2(7.0, 11.0) - 4.0);
      col += mix(vec3(0.25, 0.12, 0.45), uPart, 0.25) * smoothstep(0.2, 0.7, neb) * 0.05 * uAurora * smoothstep(0.1, 0.6, y);
    }
  }
  gl_FragColor = vec4(col, 1.0);
}
`;

const PARTICLE_VERT = /* glsl */`
attribute vec4 aSeed;        // phase, speed, size, hue
uniform float uTime;
uniform float uScale;
uniform float uMode;         // 0 fireflies, 1 pollen
varying float vAlpha;
varying float vHue;
void main() {
  float t = uTime * aSeed.y;
  vec3 p = position;
  p.x += sin(t + aSeed.x * 6.283) * 0.6 + sin(t * 0.37 + aSeed.x * 17.0) * 0.4;
  p.z += cos(t * 0.83 + aSeed.x * 11.0) * 0.6;
  p.y += sin(t * 0.61 + aSeed.x * 23.0) * 0.35 + mix(0.0, sin(t * 0.21) * 0.25, uMode);
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
  float blink = 0.5 + 0.5 * sin(uTime * (0.7 + aSeed.y * 1.3) + aSeed.x * 40.0);
  vAlpha = mix(pow(blink, 3.0), 0.55 + 0.45 * blink, uMode);
  vHue = aSeed.w;
  gl_PointSize = aSeed.z * uScale / max(-mv.z, 0.5);
}
`;

const PARTICLE_FRAG = /* glsl */`
uniform vec3 uColA;
uniform vec3 uColB;
uniform float uOpacity;
varying float vAlpha;
varying float vHue;
void main() {
  vec2 c = gl_PointCoord - 0.5;
  float d = length(c);
  float a = smoothstep(0.5, 0.0, d);
  a *= a;
  vec3 col = mix(uColA, uColB, vHue);
  gl_FragColor = vec4(col * (0.6 + 0.8 * a), a * vAlpha * uOpacity);
}
`;

export const PARTICLE_COUNT = { high: 520, medium: 260, low: 90 };

export function createSkyLayer(quality = 'high') {
  const skyUniforms = {
    uZenith: { value: new THREE.Vector3() },
    uHorizon: { value: new THREE.Vector3() },
    uGround: { value: new THREE.Vector3() },
    uSunDir: { value: new THREE.Vector3(0, 1, 0) },
    uSunColor: { value: new THREE.Vector3(1, 1, 1) },
    uStars: { value: 1 }, uAurora: { value: 1 }, uSun: { value: 0 }, uHaze: { value: 0.2 },
    uTime: { value: 0 },
    uPart: { value: new THREE.Vector3(1, 0.5, 0.3) },
  };
  const sky = new THREE.Mesh(
    new THREE.SphereGeometry(400, 48, 24),
    new THREE.ShaderMaterial({
      vertexShader: SKY_VERT, fragmentShader: SKY_FRAG, uniforms: skyUniforms,
      side: THREE.BackSide, depthWrite: false, depthTest: false,
    }),
  );
  sky.frustumCulled = false;
  sky.renderOrder = -10;

  const pUniforms = {
    uTime: { value: 0 }, uScale: { value: 60 }, uMode: { value: 0 },
    uColA: { value: new THREE.Vector3(1, 0.85, 0.4) }, uColB: { value: new THREE.Vector3(0.5, 1, 0.8) },
    uOpacity: { value: 1 },
  };
  const pMat = new THREE.ShaderMaterial({
    vertexShader: PARTICLE_VERT, fragmentShader: PARTICLE_FRAG, uniforms: pUniforms,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  });
  let points = null;

  function buildParticles(q) {
    const n = PARTICLE_COUNT[q] || PARTICLE_COUNT.high;
    const rng = mulberry32(4242);
    const pos = new Float32Array(n * 3);
    const seed = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) {
      // Mostly over the centre tile, thinning out over the neighbours.
      const r = 2 + Math.pow(rng(), 0.7) * 10;
      const a = rng() * Math.PI * 2;
      pos[i * 3] = Math.cos(a) * r * (0.6 + 0.4 * rng());
      pos[i * 3 + 1] = 0.3 + Math.pow(rng(), 1.6) * 4.2;
      pos[i * 3 + 2] = Math.sin(a) * r * (0.6 + 0.4 * rng());
      seed[i * 4] = rng();
      seed[i * 4 + 1] = 0.15 + rng() * 0.45;
      seed[i * 4 + 2] = 0.6 + rng() * 1.6;
      seed[i * 4 + 3] = rng();
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('aSeed', new THREE.BufferAttribute(seed, 4));
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 30);
    if (points) { points.geometry.dispose(); points.geometry = g; }
    else { points = new THREE.Points(g, pMat); points.frustumCulled = false; points.renderOrder = 5; }
  }
  buildParticles(quality);

  return {
    sky,
    get points() { return points; },
    skyUniforms,
    particleUniforms: pUniforms,
    particleMaterial: pMat,

    /** Apply a blended atmosphere (see palettes.js) and theme blend t (0 night .. 1 day). */
    applyAtmosphere(atm, t) {
      skyUniforms.uZenith.value.fromArray(atm.zenith);
      skyUniforms.uHorizon.value.fromArray(atm.horizon);
      skyUniforms.uGround.value.fromArray(atm.ground);
      skyUniforms.uSunDir.value.fromArray(atm.sunDir).normalize();
      skyUniforms.uSunColor.value.fromArray(atm.sunColor);
      skyUniforms.uStars.value = atm.stars;
      skyUniforms.uAurora.value = atm.aurora;
      skyUniforms.uSun.value = atm.sun;
      skyUniforms.uHaze.value = atm.haze;
      // Fireflies at night (additive glow), pollen by day (soft, normally blended).
      const day = t > 0.5;
      pUniforms.uMode.value = t;
      pMat.blending = day ? THREE.NormalBlending : THREE.AdditiveBlending;
      if (day) {
        pUniforms.uColA.value.set(1.0, 0.97, 0.9);
        pUniforms.uColB.value.set(1.0, 0.88, 0.62);
        pUniforms.uOpacity.value = 0.32 * (t - 0.5) * 2;
      } else {
        pUniforms.uColA.value.set(1.0, 0.62, 0.18);
        pUniforms.uColB.value.set(0.45, 1.0, 0.55);
        pUniforms.uOpacity.value = 0.8 * (0.5 - t) * 2;
      }
    },

    setPart(lin) { skyUniforms.uPart.value.fromArray(lin); },

    setTime(t) {
      skyUniforms.uTime.value = t;
      pUniforms.uTime.value = t;
    },

    setPixelScale(pxPerUnit) { pUniforms.uScale.value = pxPerUnit; },

    setQuality(q) { buildParticles(q); },

    dispose() {
      sky.geometry.dispose();
      sky.material.dispose();
      if (points) points.geometry.dispose();
      pMat.dispose();
    },
  };
}
