// A tiny generated environment for the marble's reflections: a gradient dome
// in the current sky colours plus a few soft "windows" (key, fill, horizon
// strip), pre-filtered with PMREM. Rebuilt when the theme changes.

import * as THREE from 'three';

const DOME_FRAG = /* glsl */`
uniform vec3 uTop;
uniform vec3 uHorizon;
uniform vec3 uBottom;
varying vec3 vDir;
void main() {
  vec3 d = normalize(vDir);
  vec3 c = d.y > 0.0 ? mix(uHorizon, uTop, pow(d.y, 0.6)) : mix(uHorizon, uBottom, pow(-d.y, 0.5));
  gl_FragColor = vec4(c, 1.0);
}
`;
const DOME_VERT = /* glsl */`
varying vec3 vDir;
void main() {
  vDir = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

export function createEnvironment(renderer) {
  const pmrem = new THREE.PMREMGenerator(renderer);
  const scene = new THREE.Scene();
  const domeUniforms = {
    uTop: { value: new THREE.Vector3() },
    uHorizon: { value: new THREE.Vector3() },
    uBottom: { value: new THREE.Vector3() },
  };
  const dome = new THREE.Mesh(
    new THREE.SphereGeometry(10, 32, 16),
    new THREE.ShaderMaterial({ vertexShader: DOME_VERT, fragmentShader: DOME_FRAG, uniforms: domeUniforms, side: THREE.BackSide, depthWrite: false }),
  );
  scene.add(dome);

  const panelGeo = new THREE.PlaneGeometry(1, 1);
  const panels = [];
  function panel(w, h, pos, intensity) {
    const m = new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide });
    const p = new THREE.Mesh(panelGeo, m);
    p.scale.set(w, h, 1);
    p.position.copy(pos);
    p.lookAt(0, 0, 0);
    p.userData.intensity = intensity;
    scene.add(p);
    panels.push(p);
    return p;
  }
  panel(4, 2.4, new THREE.Vector3(-4, 5, -4), 6);      // key (matches the scene's light side)
  panel(3, 1.6, new THREE.Vector3(5, 2.5, 3), 2.2);     // fill
  panel(14, 0.5, new THREE.Vector3(0, 0.6, 8), 1.4);    // horizon strip, gives the rim
  panel(2, 2, new THREE.Vector3(0, 9, 0), 1.8);         // top

  let target = null;

  return {
    /** Re-render for an atmosphere (see palettes.js). Returns the env texture. */
    update(atm) {
      domeUniforms.uTop.value.fromArray(atm.zenith).multiplyScalar(1.3);
      domeUniforms.uHorizon.value.fromArray(atm.horizon).multiplyScalar(1.15);
      domeUniforms.uBottom.value.fromArray(atm.groundAmb).multiplyScalar(0.8);
      const key = panels[0];
      key.position.set(atm.sunDir[0] * 6, Math.max(2, atm.sunDir[1] * 6), atm.sunDir[2] * 6);
      key.lookAt(0, 0, 0);
      for (const p of panels) {
        p.material.color.setRGB(atm.sunColor[0], atm.sunColor[1], atm.sunColor[2]).multiplyScalar(p.userData.intensity);
      }
      const next = pmrem.fromScene(scene, 0.02);
      if (target) target.dispose();
      target = next;
      return target.texture;
    },
    get texture() { return target ? target.texture : null; },
    dispose() {
      if (target) target.dispose();
      pmrem.dispose();
      dome.geometry.dispose(); dome.material.dispose();
      panelGeo.dispose();
      for (const p of panels) p.material.dispose();
    },
  };
}
