// Map markers for the selected part, drawn over the land:
//   * Tour waypoints: numbered round pins in the part colour, joined by a
//     dashed route that is exactly the path the dot travels (tour.js)
//   * dot locks: numbered square badges at every locked sequencer step's
//     spot, flashing when that step plays
//   * Explore pings: a ring that opens where the marble passed a peak or a
//     valley (bright for peaks, deeper for valleys)
//
// Pins and badges keep a constant size on screen and are never hidden by
// hills. Like map pins, a small tip dot marks the exact spot and the numbered
// badge floats just above it, so the marble passing a waypoint or arriving at
// a lock is never covered. All buffers, sprites and textures are made once;
// the per-frame update only writes numbers into them.

import * as THREE from 'three';
import { Line2 } from 'three/addons/lines/Line2.js';
import { LineGeometry } from 'three/addons/lines/LineGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { MAX_WAYPOINTS, SEQ_STEPS } from '../core/params.js';
import { W, wrapWorld } from './heightfield.js';
import { FOV } from './camera-rig.js';

export const ROUTE_PER_LEG = 24;
const MAX_ROUTE = MAX_WAYPOINTS * ROUTE_PER_LEG + 1;
const MAX_SEGS = 2 * MAX_ROUTE;          // every segment may be drawn twice where it crosses a seam
const PINGS = 6;
const WP_PX = 26, LOCK_PX = 21, TIP_PX = 7;
const LIFT = 0.12;
// Sprite anchors: badges sit above their spot (pins straight up, lock badges
// up and to the right so a waypoint and a lock on one spot stay apart).
const PIN_CY = -0.22, LOCK_CX = -0.2, LOCK_CY = -0.2;

/** Badge texture: a white shape with a dark ring and a dark number (tinted by the sprite colour). */
function badgeTexture(label, square) {
  const n = 96;
  const c = document.createElement('canvas');
  c.width = c.height = n;
  const g = c.getContext('2d');
  g.clearRect(0, 0, n, n);
  const r = n * 0.4;
  const path = () => {
    g.beginPath();
    if (square) {
      const s = r * 0.92, k = r * 0.32, x0 = n / 2 - s, y0 = n / 2 - s, x1 = n / 2 + s, y1 = n / 2 + s;
      g.moveTo(x0 + k, y0); g.lineTo(x1 - k, y0); g.quadraticCurveTo(x1, y0, x1, y0 + k);
      g.lineTo(x1, y1 - k); g.quadraticCurveTo(x1, y1, x1 - k, y1); g.lineTo(x0 + k, y1);
      g.quadraticCurveTo(x0, y1, x0, y1 - k); g.lineTo(x0, y0 + k); g.quadraticCurveTo(x0, y0, x0 + k, y0);
    } else {
      g.arc(n / 2, n / 2, r, 0, Math.PI * 2);
    }
    g.closePath();
  };
  // soft shadow so pins read on bright ground
  g.save();
  g.shadowColor = 'rgba(0,0,0,0.55)';
  g.shadowBlur = n * 0.07;
  path();
  g.fillStyle = '#ffffff';
  g.fill();
  g.restore();
  path();
  g.lineWidth = n * 0.055;
  g.strokeStyle = 'rgba(10,12,20,0.85)';
  g.stroke();
  g.fillStyle = '#0b0e16';
  g.font = `700 ${Math.round(n * (label.length > 1 ? 0.4 : 0.48))}px system-ui, -apple-system, "Segoe UI", sans-serif`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(label, n / 2, n / 2 + n * 0.02);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.anisotropy = 2;
  return t;
}

function ringTexture() {
  const n = 128;
  const c = document.createElement('canvas');
  c.width = c.height = n;
  const g = c.getContext('2d');
  g.lineWidth = n * 0.06;
  g.strokeStyle = '#ffffff';
  g.beginPath();
  g.arc(n / 2, n / 2, n * 0.42, 0, Math.PI * 2);
  g.stroke();
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function tipTexture() {
  const n = 32;
  const c = document.createElement('canvas');
  c.width = c.height = n;
  const g = c.getContext('2d');
  g.beginPath();
  g.arc(n / 2, n / 2, n * 0.36, 0, Math.PI * 2);
  g.fillStyle = '#ffffff';
  g.fill();
  g.lineWidth = n * 0.12;
  g.strokeStyle = 'rgba(10,12,20,0.85)';
  g.stroke();
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function sprite(map, order, cx = 0.5, cy = 0.5) {
  const mat = new THREE.SpriteMaterial({ map, transparent: true, depthTest: false, depthWrite: false, sizeAttenuation: false });
  const s = new THREE.Sprite(mat);
  s.center.set(cx, cy);
  s.renderOrder = order;
  s.visible = false;
  s.frustumCulled = false;
  return s;
}

export function createMarkersLayer() {
  const group = new THREE.Group();

  // ---- waypoint pins and lock badges
  const wpTex = [], lockTex = [];
  const pins = [], badges = [], pinTips = [], lockTips = [];
  const tipTex = tipTexture();
  for (let i = 0; i < MAX_WAYPOINTS; i++) {
    wpTex.push(badgeTexture(String(i + 1), false));
    const s = sprite(wpTex[i], 21, 0.5, PIN_CY);
    pins.push(s);
    const t = sprite(tipTex, 21);
    pinTips.push(t);
    group.add(s, t);
  }
  for (let i = 0; i < SEQ_STEPS; i++) {
    lockTex.push(badgeTexture(String(i + 1), true));
    const s = sprite(lockTex[i], 20, LOCK_CX, LOCK_CY);
    badges.push(s);
    const t = sprite(tipTex, 20);
    lockTips.push(t);
    group.add(s, t);
  }
  const wpU = new Float64Array(MAX_WAYPOINTS), wpV = new Float64Array(MAX_WAYPOINTS);
  let wpCount = 0;
  const lockOn = new Uint8Array(SEQ_STEPS);
  const lockU = new Float64Array(SEQ_STEPS), lockV = new Float64Array(SEQ_STEPS);
  const flash = new Float64Array(SEQ_STEPS);
  let lockDim = false;
  let hoverWp = -1, activeWp = -1;

  // ---- dashed route
  const routeMat = new LineMaterial({
    color: 0xffffff, linewidth: 2.2, transparent: true, opacity: 0.9, dashed: true,
    dashSize: 0.16, gapSize: 0.11, depthTest: false, depthWrite: false, worldUnits: false,
  });
  const routeGeo = new LineGeometry();
  routeGeo.setPositions(new Float32Array((MAX_SEGS + 1) * 3));
  const route = new Line2(routeGeo, routeMat);
  route.computeLineDistances();               // allocates the distance buffer once
  route.frustumCulled = false;
  route.renderOrder = 19;
  route.visible = false;
  group.add(route);
  const segPos = routeGeo.attributes.instanceStart.data.array;
  const segDist = routeGeo.attributes.instanceDistanceStart.data.array;
  routeGeo.instanceCount = 0;

  // ---- pings
  const ringTex = ringTexture();
  const pings = [];
  for (let i = 0; i < PINGS; i++) {
    const mat = new THREE.SpriteMaterial({ map: ringTex, transparent: true, depthTest: false, depthWrite: false, blending: THREE.AdditiveBlending });
    const s = new THREE.Sprite(mat);
    s.renderOrder = 18;
    s.visible = false;
    group.add(s);
    pings.push({ s, age: 1, peak: true, u: 0, v: 0 });
  }
  let pingNext = 0;

  // ---- colours and sizes
  const part = new THREE.Color(1, 0.6, 0.3);
  const lockCol = new THREE.Color(1, 1, 1);
  const tmp = new THREE.Color();
  let themeT = 0;
  let pxScale = 0.002;          // sprite scale per pixel of marker size (set from the viewport height)
  const projV = new THREE.Vector3();

  function setXZ(s, u, v, hf, lift) {
    const x = wrapWorld((u - 0.5) * W), z = wrapWorld((v - 0.5) * W);
    s.position.set(x, hf.yAt(x, z) + lift, z);
  }

  return {
    group,
    get waypointCount() { return wpCount; },
    get lockCount() { let n = 0; for (let i = 0; i < SEQ_STEPS; i++) n += lockOn[i]; return n; },

    setColor(lin, t) {
      part.setRGB(lin[0], lin[1], lin[2]);
      themeT = t;
      // Lock badges: a pale tint of the part colour at night, a deeper one by day.
      // (by day a paler tint vanishes into the ivory land, so it stays saturated)
      lockCol.copy(part).lerp(tmp.setRGB(1, 1, 1), t > 0.5 ? 0.12 : 0.55);
      routeMat.color.copy(part).multiplyScalar(t > 0.5 ? 0.8 : 1.5);
    },

    /** Viewport height in device pixels: keeps pins the same size on screen. */
    setResolution(w, h, pixelRatio) {
      routeMat.resolution.set(w, h);
      routeMat.linewidth = 2.2 * pixelRatio;
      const f = 1 / Math.tan((FOV * Math.PI) / 360);
      pxScale = (2 * pixelRatio) / (Math.max(1, h) * f);
    },

    /** Waypoints [{x, y}] (only positions are used here). */
    setWaypoints(list) {
      wpCount = Math.min(MAX_WAYPOINTS, Array.isArray(list) ? list.length : 0);
      for (let i = 0; i < wpCount; i++) { wpU[i] = list[i].x; wpV[i] = list[i].y; }
    },

    /** Sequencer steps [{lock, lx, ly}] of the selected part; dim when the sequencer is off. */
    setLocks(steps, enabled) {
      for (let i = 0; i < SEQ_STEPS; i++) {
        const st = Array.isArray(steps) ? steps[i] : null;
        lockOn[i] = st && st.lock ? 1 : 0;
        if (lockOn[i]) { lockU[i] = st.lx; lockV[i] = st.ly; }
      }
      lockDim = !enabled;
    },

    /** A locked step just played. */
    flashLock(i) { if (i >= 0 && i < SEQ_STEPS) flash[i] = 1; },

    /** Explore passed a peak (or valley) at (u, v). */
    ping(u, v, peak) {
      const p = pings[pingNext];
      pingNext = (pingNext + 1) % PINGS;
      p.age = 0; p.peak = peak; p.u = u; p.v = v;
    },

    setHover(i) { hoverWp = i; },
    setActive(i) { activeWp = i; },

    /**
     * Route points (unwrapped u, v pairs, n of them) for the dashed line;
     * n = 0 hides it. Segments crossing a tile seam are drawn on both sides.
     */
    setRoute(uv, n, hf) {
      let k = 0, dist = 0;
      for (let i = 0; i + 1 < n; i++) {
        const u0 = uv[2 * i], v0 = uv[2 * i + 1], u1 = uv[2 * i + 2], v1 = uv[2 * i + 3];
        const ax = (u0 - 0.5) * W, az = (v0 - 0.5) * W;
        const sx = wrapWorld(ax) - ax, sz = wrapWorld(az) - az;     // shift into the centre tile
        const bx = (u1 - 0.5) * W, bz = (v1 - 0.5) * W;
        const len = Math.hypot(bx - ax, bz - az);
        const half = W / 2;
        // the copy that starts in the centre tile, plus the copy the end lands in when it leaves it
        for (let c = 0; c < 2; c++) {
          let ox = sx, oz = sz;
          if (c === 1) {
            const ex = bx + sx, ez = bz + sz;
            if (ex >= -half && ex < half && ez >= -half && ez < half) break;
            ox = sx + (ex >= half ? -W : ex < -half ? W : 0);
            oz = sz + (ez >= half ? -W : ez < -half ? W : 0);
          }
          if (k >= MAX_SEGS) break;
          const o = k * 6;
          const x0 = ax + ox, z0 = az + oz, x1 = bx + ox, z1 = bz + oz;
          segPos[o] = x0; segPos[o + 1] = hf.yAt(x0, z0) + LIFT * 0.6; segPos[o + 2] = z0;
          segPos[o + 3] = x1; segPos[o + 4] = hf.yAt(x1, z1) + LIFT * 0.6; segPos[o + 5] = z1;
          segDist[k * 2] = dist; segDist[k * 2 + 1] = dist + len;
          k++;
        }
        dist += len;
      }
      routeGeo.instanceCount = k;
      routeGeo.attributes.instanceStart.data.needsUpdate = true;
      routeGeo.attributes.instanceDistanceStart.data.needsUpdate = true;
      route.visible = k > 0;
    },

    /**
     * Per frame: place pins and badges on the land, run flashes and pings.
     * showWaypoints: Tour mode or editing; time: seconds (dash march).
     */
    update(hf, dt, showWaypoints, time, reduced) {
      const pinScale = WP_PX * pxScale, badgeScale = LOCK_PX * pxScale, tipScale = TIP_PX * pxScale;
      for (let i = 0; i < MAX_WAYPOINTS; i++) {
        const s = pins[i], t = pinTips[i];
        s.visible = t.visible = showWaypoints && i < wpCount;
        if (!s.visible) continue;
        setXZ(s, wpU[i], wpV[i], hf, LIFT);
        t.position.copy(s.position);
        const k = i === activeWp ? 1.3 : i === hoverWp ? 1.15 : 1;
        s.scale.setScalar(pinScale * k);
        t.scale.setScalar(tipScale * k);
        s.material.color.copy(part);
        if (themeT <= 0.5) s.material.color.multiplyScalar(1.25);
        t.material.color.copy(s.material.color);
      }
      route.visible = route.visible && showWaypoints && wpCount > 1;
      routeMat.opacity = themeT > 0.5 ? 0.85 : 0.9;
      if (!reduced) routeMat.dashOffset = -time * 0.35;
      const fade = Math.exp(-dt / 0.16);
      for (let i = 0; i < SEQ_STEPS; i++) {
        const s = badges[i], t = lockTips[i];
        flash[i] *= fade;
        s.visible = t.visible = lockOn[i] === 1;
        if (!s.visible) continue;
        setXZ(s, lockU[i], lockV[i], hf, LIFT * 0.8);
        t.position.copy(s.position);
        t.scale.setScalar(tipScale * 0.85);
        t.material.color.copy(lockCol);
        const f = flash[i];
        s.scale.setScalar(badgeScale * (1 + 0.55 * f));
        s.material.color.copy(lockCol).lerp(tmp.setRGB(1, 1, 1), f * 0.7);
        if (themeT <= 0.5) s.material.color.multiplyScalar(1 + 1.4 * f);
        // with the sequencer off the locks will not play: quieter, but still findable
        s.material.opacity = (lockDim ? (themeT > 0.5 ? 0.7 : 0.6) : 0.95) + 0.05 * f;
      }
      for (let i = 0; i < PINGS; i++) {
        const p = pings[i];
        if (p.age >= 1) { p.s.visible = false; continue; }
        p.age = Math.min(1, p.age + dt / (reduced ? 0.5 : 0.9));
        const a = p.age;
        p.s.visible = true;
        setXZ(p.s, p.u, p.v, hf, 0.05);
        p.s.scale.setScalar(0.35 + (reduced ? 0.4 : 1.4) * Math.sqrt(a));
        p.s.material.color.copy(part).multiplyScalar(p.peak ? 1.6 : 0.7);
        p.s.material.blending = themeT > 0.5 ? THREE.NormalBlending : THREE.AdditiveBlending;
        p.s.material.opacity = (1 - a) * (1 - a) * (p.peak ? 1 : 0.8);
      }
    },

    /**
     * Index of the waypoint pin under a client point (or -1). Generous radius
     * for fingers. rect: canvas client rect.
     */
    pickWaypoint(camera, rect, clientX, clientY, touch) {
      let best = -1, bestD = Infinity;
      const radius = (touch ? 26 : 16);
      // the badge floats (0.5 - PIN_CY) of its size above the spot
      const lift = (0.5 - PIN_CY) * WP_PX;
      for (let i = 0; i < wpCount; i++) {
        const s = pins[i];
        if (!s.visible) continue;
        projV.copy(s.position).project(camera);
        if (projV.z > 1) continue;
        const sx = rect.left + (projV.x * 0.5 + 0.5) * rect.width;
        const sy = rect.top + (-projV.y * 0.5 + 0.5) * rect.height;
        const d = Math.min(Math.hypot(clientX - sx, clientY - sy), Math.hypot(clientX - sx, clientY - (sy - lift)));
        if (d < radius && d < bestD) { best = i; bestD = d; }
      }
      return best;
    },

    dispose() {
      for (const t of wpTex) t.dispose();
      for (const t of lockTex) t.dispose();
      for (const s of pins) s.material.dispose();
      for (const s of badges) s.material.dispose();
      for (const s of pinTips) s.material.dispose();
      for (const s of lockTips) s.material.dispose();
      tipTex.dispose();
      for (const p of pings) p.s.material.dispose();
      ringTex.dispose();
      routeGeo.dispose();
      routeMat.dispose();
    },
  };
}
