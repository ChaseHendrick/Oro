// Map extras for v2.9, all hidden until used:
//   * the Golf hole (a flat ring with a cup and a small flag), the aim line
//     (a flat ribbon on the land, as long as the shot is strong) and the
//     driving range's distance flags (with their yards on a small label)
//   * the pet: one small sprite drawn in code (awake and asleep pictures),
//     moved by the pure logic in pet.js
// Everything is made once; update() moves things in place and allocates
// nothing. The pet's picture never animates by itself: it only changes when
// the pet falls asleep or wakes up.

import * as THREE from 'three';
import { W, uToX } from './heightfield.js';
import { createPet, petStep, petNote, petHopHeight } from './pet.js';
import { mulberry32 } from '../dsp/terrain-math.js';

const AIM_POINTS = 17;
const AIM_MAX = 4.5;          // world units of line at full power
const AIM_HALF_WIDTH = 0.08;
const PET_SIZE = 0.8;
const RANGE_FLAG_COUNT = 4;

function drawLabel(text) {
  const c = document.createElement('canvas');
  c.width = 96; c.height = 48;
  const g = c.getContext('2d');
  if (!g) return c;
  g.fillStyle = 'rgba(12, 14, 20, 0.78)';
  g.beginPath();
  if (g.roundRect) g.roundRect(4, 6, 88, 36, 10); else g.rect(4, 6, 88, 36);
  g.fill();
  g.fillStyle = '#ffffff';
  g.font = 'bold 24px system-ui, sans-serif';
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText(text, 48, 25);
  return c;
}

function drawPet(asleep) {
  const c = document.createElement('canvas');
  c.width = 64; c.height = 64;
  const g = c.getContext('2d');
  if (!g) return c;
  // feet
  g.fillStyle = '#7a4f2a';
  g.beginPath(); g.ellipse(23, 59, 7, 4, 0, 0, Math.PI * 2); g.fill();
  g.beginPath(); g.ellipse(41, 59, 7, 4, 0, 0, Math.PI * 2); g.fill();
  // ears
  g.fillStyle = '#d99a5b';
  g.beginPath(); g.moveTo(14, 26); g.lineTo(18, 6); g.lineTo(28, 20); g.closePath(); g.fill();
  g.beginPath(); g.moveTo(50, 26); g.lineTo(46, 6); g.lineTo(36, 20); g.closePath(); g.fill();
  // body
  g.fillStyle = '#e8b06f';
  g.beginPath(); g.ellipse(32, 38, 22, 20, 0, 0, Math.PI * 2); g.fill();
  g.fillStyle = '#f6dcb4';
  g.beginPath(); g.ellipse(32, 46, 12, 10, 0, 0, Math.PI * 2); g.fill();
  // face
  g.strokeStyle = '#2b1d12'; g.fillStyle = '#2b1d12'; g.lineWidth = 2.2; g.lineCap = 'round';
  if (asleep) {
    g.beginPath(); g.arc(24, 34, 3.5, 0.15 * Math.PI, 0.85 * Math.PI); g.stroke();
    g.beginPath(); g.arc(40, 34, 3.5, 0.15 * Math.PI, 0.85 * Math.PI); g.stroke();
    // a small z above the head
    g.lineWidth = 2.4; g.strokeStyle = '#ffffff';
    g.beginPath(); g.moveTo(50, 4); g.lineTo(60, 4); g.lineTo(50, 14); g.lineTo(60, 14); g.stroke();
  } else {
    g.beginPath(); g.arc(24, 33, 3.2, 0, Math.PI * 2); g.fill();
    g.beginPath(); g.arc(40, 33, 3.2, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#ffffff';
    g.beginPath(); g.arc(25, 32, 1.1, 0, Math.PI * 2); g.fill();
    g.beginPath(); g.arc(41, 32, 1.1, 0, Math.PI * 2); g.fill();
  }
  g.strokeStyle = '#2b1d12'; g.lineWidth = 1.8;
  g.beginPath(); g.arc(32, 39, 3, 0.2 * Math.PI, 0.8 * Math.PI); g.stroke();
  return c;
}

function texture(canvas) {
  const t = new THREE.CanvasTexture(canvas);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export function createFunLayer() {
  const group = new THREE.Group();
  group.name = 'fun';

  // ---------------------------------------------------------------- golf hole
  const hole = new THREE.Group();
  const ringGeo = new THREE.RingGeometry(0.27, 0.37, 40);
  ringGeo.rotateX(-Math.PI / 2);
  const ring = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({ color: 0xf4f1e8, side: THREE.DoubleSide, transparent: true, opacity: 0.95, depthWrite: false }));
  const cupGeo = new THREE.CircleGeometry(0.27, 32);
  cupGeo.rotateX(-Math.PI / 2);
  const cup = new THREE.Mesh(cupGeo, new THREE.MeshBasicMaterial({ color: 0x0c0c10, side: THREE.DoubleSide, transparent: true, opacity: 0.85, depthWrite: false }));
  const poleGeo = new THREE.CylinderGeometry(0.018, 0.018, 1, 6);
  const poleMat = new THREE.MeshBasicMaterial({ color: 0xf4f1e8 });
  const pole = new THREE.Mesh(poleGeo, poleMat);
  pole.position.y = 0.5;
  const flagShape = new THREE.Shape();
  flagShape.moveTo(0, 0); flagShape.lineTo(0.34, -0.11); flagShape.lineTo(0, -0.22); flagShape.closePath();
  const flagGeo = new THREE.ShapeGeometry(flagShape);
  const flag = new THREE.Mesh(flagGeo, new THREE.MeshBasicMaterial({ color: 0xff7a45, side: THREE.DoubleSide }));
  flag.position.y = 1;
  ring.renderOrder = 3; cup.renderOrder = 2;
  hole.add(cup, ring, pole, flag);
  hole.visible = false;
  let holeU = 0, holeV = 0;
  // range flags stand at fixed world offsets from one copy of the tee, picked
  // on the first frame after setFlags (when the ball is on the tee)
  let teeU = 0, teeV = 0, teeX = 0, teeZ = 0, anchorPending = false;

  // ---------------------------------------------------------------- aim ribbon
  const aimPos = new Float32Array(AIM_POINTS * 2 * 3);
  const aimGeo = new THREE.BufferGeometry();
  aimGeo.setAttribute('position', new THREE.BufferAttribute(aimPos, 3));
  const idx = [];
  for (let i = 0; i < AIM_POINTS - 1; i++) { const a = i * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
  aimGeo.setIndex(idx);
  const aim = new THREE.Mesh(aimGeo, new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide, transparent: true, opacity: 0.9, depthTest: false, depthWrite: false }));
  aim.renderOrder = 10;
  aim.frustumCulled = false;
  aim.visible = false;
  let aimAngle = 0, aimPower = 0;

  // ---------------------------------------------------------------- pet
  const awake = texture(drawPet(false));
  const asleep = texture(drawPet(true));
  const petMat = new THREE.SpriteMaterial({ map: awake, transparent: true, depthWrite: false });
  const sprite = new THREE.Sprite(petMat);
  sprite.center.set(0.5, 0.04);
  sprite.scale.set(PET_SIZE, PET_SIZE, 1);
  sprite.visible = false;
  sprite.renderOrder = 4;
  const pet = createPet();
  const rng = mulberry32(0x9e7);
  let petOn = false, petAsleep = false;

  // ---------------------------------------------------------------- range flags
  const rangeMat = new THREE.MeshBasicMaterial({ color: 0xf2c94c, side: THREE.DoubleSide });
  const rangeFlags = [];
  for (let i = 0; i < RANGE_FLAG_COUNT; i++) {
    const g = new THREE.Group();
    const p = new THREE.Mesh(poleGeo, poleMat);
    p.scale.y = 0.8; p.position.y = 0.4;
    const f = new THREE.Mesh(flagGeo, rangeMat);
    f.position.y = 0.8;
    const label = new THREE.Sprite(new THREE.SpriteMaterial({ transparent: true, depthWrite: false }));
    label.position.y = 1.2;
    label.scale.set(0.8, 0.4, 1);
    g.add(p, f, label);
    g.visible = false;
    rangeFlags.push({ g, label, dx: 0, dz: 0, text: '' });
  }

  group.add(hole, aim, sprite, ...rangeFlags.map(f => f.g));

  // slope for the pet: world rise per unit of run
  let field = null;
  const _g = { x: 0, z: 0 };
  const slope = (u, v) => {
    if (!field) return 0;
    field.gradient(uToX(u), uToX(v), _g);
    return Math.sqrt(_g.x * _g.x + _g.z * _g.z);
  };

  // the copy of (u, v) nearest to world (x, z): the map repeats every W
  const near = (u, ref) => { const x = uToX(u); return x + W * Math.round((ref - x) / W); };

  return {
    group,

    setHole(u, v) {
      if (u === null || u === undefined) { hole.visible = false; return; }
      holeU = u; holeV = v; hole.visible = true;
    },

    /** Driving range flags: [{ yards, dx, dz }] (up to four, world offsets from the tee at u, v), or null. */
    setFlags(list, u, v) {
      teeU = u || 0; teeV = v || 0; anchorPending = true;
      rangeFlags.forEach((f, i) => {
        const it = Array.isArray(list) ? list[i] : null;
        f.g.visible = !!it;
        if (!it) return;
        f.dx = it.dx; f.dz = it.dz;
        const text = String(it.yards);
        if (text !== f.text) {
          f.text = text;
          if (f.label.material.map) f.label.material.map.dispose();
          f.label.material.map = texture(drawLabel(text));
          f.label.material.needsUpdate = true;
        }
      });
    },

    /** Aim at `angle` (radians, world x towards z) with `power` 0..1; null hides the line. */
    setAim(angle, power) {
      if (angle === null || angle === undefined) { aim.visible = false; return; }
      aimAngle = angle; aimPower = Math.min(1, Math.max(0, power || 0));
      aim.visible = true;
    },

    setPet(on, u, v, now) {
      petOn = !!on;
      sprite.visible = petOn;
      if (petOn && Number.isFinite(u)) { pet.u = u; pet.v = v; pet.lastNote = now || 0; pet.state = 'wander'; pet.hop = 0; }
    },
    petNote(now, reduced) { if (petOn) petNote(pet, now, reduced); },
    petState() { return pet; },

    /** Once per frame. dotPos: the drawn marble (world); target: where the camera looks. */
    update(view, dotPos, target, dt, nowS, reduced) {
      if (hole.visible) {
        const x = near(holeU, dotPos.x), z = near(holeV, dotPos.z);
        hole.position.set(x, view.yAt(x, z) + 0.06, z);
      }
      if (anchorPending) { anchorPending = false; teeX = near(teeU, dotPos.x); teeZ = near(teeV, dotPos.z); }
      for (let i = 0; i < RANGE_FLAG_COUNT; i++) {
        const f = rangeFlags[i];
        if (!f.g.visible) continue;
        const x = teeX + f.dx, z = teeZ + f.dz;
        f.g.position.set(x, view.yAt(x, z), z);
      }
      if (aim.visible) {
        const len = 0.35 + AIM_MAX * aimPower;
        const c = Math.cos(aimAngle), s = Math.sin(aimAngle);
        const px = -s * AIM_HALF_WIDTH, pz = c * AIM_HALF_WIDTH;
        for (let i = 0; i < AIM_POINTS; i++) {
          const t = i / (AIM_POINTS - 1);
          const x = dotPos.x + c * len * t, z = dotPos.z + s * len * t;
          const y = view.yAt(x, z) + 0.12;
          const w = 1 - 0.7 * t;              // tapers towards the tip
          const k = i * 6;
          aimPos[k] = x + px * w; aimPos[k + 1] = y; aimPos[k + 2] = z + pz * w;
          aimPos[k + 3] = x - px * w; aimPos[k + 4] = y; aimPos[k + 5] = z - pz * w;
        }
        aimGeo.attributes.position.needsUpdate = true;
      }
      if (petOn) {
        field = view;
        petStep(pet, dt, nowS, slope, rng, reduced);
        const sleeping = pet.state === 'sleep';
        if (sleeping !== petAsleep) { petAsleep = sleeping; petMat.map = sleeping ? asleep : awake; petMat.needsUpdate = true; }
        const x = near(pet.u, target.x), z = near(pet.v, target.z);
        sprite.position.set(x, view.yAt(x, z) + petHopHeight(pet), z);
      }
    },

    dispose() {
      for (const o of [ring, cup, pole, flag, aim]) { o.geometry.dispose(); o.material.dispose(); }
      rangeMat.dispose();
      for (const f of rangeFlags) { if (f.label.material.map) f.label.material.map.dispose(); f.label.material.dispose(); }
      awake.dispose(); asleep.dispose(); petMat.dispose();
    },
  };
}
