// The dot: a glossy marble in the part colour that rolls visibly when it moves,
// a soft halo for the bloom, a thin vertical light beam so it can be found from
// any angle, and a faint ghost marble where the dot sits before modulation.
// The ground ring, pulse and contact shadow live in the terrain shader.

import * as THREE from 'three';
import { BALL_RADIUS } from './physics.js';

const BEAM_VERT = /* glsl */`
uniform float uHeight;
uniform float uWidth;
varying vec2 vUv;
void main() {
  // Cylindrical billboard: always faces the camera around the vertical axis.
  vec3 base = (modelMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
  vec3 toCam = cameraPosition - base;
  toCam.y = 0.0;
  vec3 side = normalize(cross(vec3(0.0, 1.0, 0.0), normalize(toCam + vec3(1e-4, 0.0, 0.0))));
  vec3 p = base + side * position.x * uWidth + vec3(0.0, position.y * uHeight, 0.0);
  vUv = vec2(position.x, position.y);
  gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
}
`;
const BEAM_FRAG = /* glsl */`
uniform vec3 uColor;
uniform float uAlpha;
uniform float uTime;
varying vec2 vUv;
void main() {
  float across = exp(-vUv.x * vUv.x * 9.0);
  float up = pow(1.0 - vUv.y, 2.2) * smoothstep(0.0, 0.04, vUv.y);
  float shimmer = 0.85 + 0.15 * sin(vUv.y * 40.0 - uTime * 3.0);
  float a = across * up * shimmer * uAlpha;
  gl_FragColor = vec4(uColor * a, a);
}
`;

function haloTexture() {
  const n = 64;
  const data = new Uint8Array(n * n * 4);
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const x = (i + 0.5) / n * 2 - 1, y = (j + 0.5) / n * 2 - 1;
      const r = Math.sqrt(x * x + y * y);
      const a = Math.max(0, Math.exp(-r * r * 4.5) - 0.011);
      const o = (j * n + i) * 4;
      data[o] = data[o + 1] = data[o + 2] = 255;
      data[o + 3] = Math.round(a * 255);
    }
  }
  const t = new THREE.DataTexture(data, n, n, THREE.RGBAFormat);
  t.needsUpdate = true;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearFilter;
  return t;
}

export function createDotLayer() {
  const group = new THREE.Group();

  const marbleMat = new THREE.MeshPhysicalMaterial({
    color: 0xffffff,
    roughness: 0.12,
    metalness: 0.05,
    clearcoat: 1,
    clearcoatRoughness: 0.04,
    iridescence: 0.35,
    iridescenceIOR: 1.6,
    sheen: 0.4,
    sheenRoughness: 0.35,
    emissive: 0xffffff,
    emissiveIntensity: 0.4,
    envMapIntensity: 1.25,
  });
  const marble = new THREE.Mesh(new THREE.SphereGeometry(BALL_RADIUS, 48, 32), marbleMat);
  marble.renderOrder = 4;

  // Inner swirl band: a slightly smaller, brighter equator ring seen through
  // the clearcoat sells the rolling motion.
  const bandMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9 });
  const band = new THREE.Mesh(new THREE.TorusGeometry(BALL_RADIUS * 0.985, BALL_RADIUS * 0.08, 10, 48), bandMat);
  marble.add(band);
  const band2 = band.clone();
  band2.rotation.y = Math.PI / 2;
  band2.scale.setScalar(0.995);
  marble.add(band2);

  const haloTex = haloTexture();
  const haloMat = new THREE.SpriteMaterial({ map: haloTex, color: 0xffffff, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0.6 });
  const halo = new THREE.Sprite(haloMat);
  halo.scale.setScalar(BALL_RADIUS * 7);
  halo.renderOrder = 9;

  const beamUniforms = {
    uHeight: { value: 7 }, uWidth: { value: 0.1 },
    uColor: { value: new THREE.Vector3(1, 0.6, 0.3) }, uAlpha: { value: 0.6 }, uTime: { value: 0 },
  };
  const beamGeo = new THREE.PlaneGeometry(2, 1, 1, 16);
  beamGeo.translate(0, 0.5, 0);
  const beam = new THREE.Mesh(beamGeo, new THREE.ShaderMaterial({
    vertexShader: BEAM_VERT, fragmentShader: BEAM_FRAG, uniforms: beamUniforms,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
  }));
  beam.frustumCulled = false;
  beam.renderOrder = 9;

  const ghostMat = new THREE.MeshPhysicalMaterial({
    color: 0xffffff, roughness: 0.25, metalness: 0, clearcoat: 1, transparent: true, opacity: 0.28,
    emissive: 0xffffff, emissiveIntensity: 0.2, depthWrite: false,
  });
  const ghost = new THREE.Mesh(new THREE.SphereGeometry(BALL_RADIUS * 0.62, 24, 16), ghostMat);
  ghost.renderOrder = 3;
  ghost.visible = false;

  group.add(marble, halo, beam, ghost);

  const roll = new THREE.Quaternion();
  const axis = new THREE.Vector3();
  const tmpColor = new THREE.Color();
  let lastX = 0, lastZ = 0, primed = false;

  return {
    group,
    marble,
    ghost,

    setColor(lin, themeT) {
      tmpColor.setRGB(lin[0], lin[1], lin[2]);
      // Body slightly deeper than the glow so the clearcoat highlights read.
      marbleMat.color.copy(tmpColor).multiplyScalar(0.55 + 0.25 * themeT);
      marbleMat.emissive.copy(tmpColor);
      marbleMat.sheenColor.copy(tmpColor);
      bandMat.color.copy(tmpColor).multiplyScalar(themeT > 0.5 ? 1.1 : 2.2);
      haloMat.color.copy(tmpColor);
      beamUniforms.uColor.value.set(lin[0], lin[1], lin[2]);
      ghostMat.color.copy(tmpColor);
      ghostMat.emissive.copy(tmpColor);
    },

    setEnv(envMap) {
      marbleMat.envMap = envMap;
      ghostMat.envMap = envMap;
      marbleMat.needsUpdate = true;
      ghostMat.needsUpdate = true;
    },

    /**
     * Place the marble. Rotation integrates the ground distance travelled, so
     * the marble visibly rolls in the direction it moves.
     */
    update(x, y, z, level, time, themeT, visibility) {
      if (primed) {
        const dx = x - lastX, dz = z - lastZ;
        const dist = Math.sqrt(dx * dx + dz * dz);
        // big jumps are wraps or teleports, not rolling
        if (dist > 1e-5 && dist < 1.5) {
          axis.set(dz, 0, -dx).normalize();
          roll.setFromAxisAngle(axis, dist / BALL_RADIUS);
          marble.quaternion.premultiply(roll);
        }
      }
      lastX = x; lastZ = z; primed = true;
      marble.position.set(x, y, z);
      halo.position.set(x, y, z);
      beam.position.set(x, y - BALL_RADIUS * 0.6, z);
      const pulse = 0.5 + 0.5 * Math.sin(time * 2.4);
      const day = themeT;
      marbleMat.emissiveIntensity = (0.32 + 0.5 * level + 0.08 * pulse) * (1 - 0.55 * day);
      haloMat.opacity = (0.35 + 0.45 * level + 0.08 * pulse) * (1 - 0.6 * day) * visibility;
      halo.scale.setScalar(BALL_RADIUS * (6 + 2.5 * level));
      beamUniforms.uAlpha.value = (0.75 - 0.4 * day) * visibility;
      beamUniforms.uTime.value = time;
      marble.visible = visibility > 0.01;
      marbleMat.opacity = 1;
    },

    setGhost(x, y, z, alpha) {
      ghost.visible = alpha > 0.01;
      ghost.position.set(x, y, z);
      ghostMat.opacity = 0.32 * alpha;
    },

    dispose() {
      marble.geometry.dispose(); marbleMat.dispose();
      band.geometry.dispose(); bandMat.dispose();
      haloTex.dispose(); haloMat.dispose();
      beam.geometry.dispose(); beam.material.dispose();
      ghost.geometry.dispose(); ghostMat.dispose();
    },
  };
}
