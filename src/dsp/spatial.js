// 2.12 3D sound: a small parametric head model for headphones, distance cues
// and amplitude panning across surround speaker layouts. Clean-room: built
// from textbook acoustics (a rigid sphere of average head size, the speed of
// sound, a one-pole shelf for the head's shadow), no measured data sets.
//
// Coordinates (degrees and metres):
//   azimuth    0 in front, +90 to the right, -90 to the left, +-180 behind
//   elevation  0 at ear height, +90 straight up, negative below
//   distance   metres from the centre of the head; 1 m is the reference
//              (gain 1, no air loss), so a track at 0 degrees, 0 elevation
//              and 1 m sounds exactly like the same track panned to centre.
//
// Per track (class Binaural, all buffers allocated in the constructor, which
// runs at message time, never inside process()):
//   mono       0.5 (L + R) of the track
//   distance   gain 1/d (clamped to +6 dB) and an "air" high shelf that dulls
//              far sources a little (optional)
//   behind     a gentle high shelf for sources behind you (the outer ear
//              shades sound from the back), the main front-back cue here
//   height     a moving notch (higher for sources above, lower below), only
//              while the elevation is not 0
//   each ear   interaural time difference (the sound reaches the far ear up
//              to ~0.66 ms later, Woodworth's spherical-head formula) and a
//              head-shadow shelf (near ear a little brighter, far ear darker)
//              plus a small broadband level difference
// Every gain and delay glides (about 10 ms), so moving a source never clicks.

export const SPACE_MODES = Object.freeze(['Off', 'Manual', 'Follow dot', 'Follow dot and distance']);
export const HEAD_RADIUS = 0.0875;         // m, an average adult head
export const SPEED_OF_SOUND = 343;         // m/s
export const ITD_MAX = (HEAD_RADIUS / SPEED_OF_SOUND) * (Math.PI / 2 + 1);   // ~0.656 ms
export const DIST_MIN = 0.5, DIST_MAX = 20, DIST_REF = 1;
export const DIST_GAIN_MAX = 2;            // +6 dB when very close
export const SHADOW_HZ = 1500;             // corner of the head-shadow shelf
export const NEAR_DB = 4;                  // near ear, source straight at it
export const FAR_DB = -16;                 // far ear, deepest shadow (150 degrees)
export const LOW_NEAR_DB = 1, LOW_FAR_DB = -3;   // broadband level difference, source straight at one ear
export const BACK_DB = -4;                 // high shelf for a source straight behind
export const BACK_HZ = 3000;
export const AIR_DB_PER_M = 0.5, AIR_DB_MAX = 10;
export const NOTCH_DB = -10, NOTCH_HZ = 8000;
const SMOOTH_S = 0.01;
const DEG = Math.PI / 180;
const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);
const dbToGain = (db) => Math.pow(10, db / 20);

/** Azimuth wrapped to [-180, 180). */
export function wrapAz(az) {
  const a = Number.isFinite(az) ? az : 0;
  return a - 360 * Math.floor((a + 180) / 360);
}

/** Unit direction {x: right, y: front, z: up} of a source. */
export function direction(azDeg, elDeg) {
  const a = wrapAz(azDeg) * DEG, e = clamp(Number.isFinite(elDeg) ? elDeg : 0, -90, 90) * DEG;
  return { x: Math.sin(a) * Math.cos(e), y: Math.cos(a) * Math.cos(e), z: Math.sin(e) };
}

/**
 * Interaural time difference in seconds, signed: positive when the source is
 * on the right (the left ear hears it later). Depends only on the lateral
 * angle, so a source in front and its mirror image behind get the same value.
 */
export function itdSeconds(azDeg, elDeg) {
  const lat = Math.asin(clamp(direction(azDeg, elDeg).x, -1, 1));
  return (HEAD_RADIUS / SPEED_OF_SOUND) * (lat + Math.sin(lat));
}

/**
 * Head-shadow high-shelf gain in dB for an ear, from the angle (radians)
 * between the source and the line out of that ear: 0 facing the ear, pi/2
 * straight ahead (0 dB), deepest at 150 degrees, a little less straight
 * across (sound bends round the head and meets itself).
 */
export function shadowDb(beta) {
  const b = clamp(Number.isFinite(beta) ? beta : Math.PI / 2, 0, Math.PI);
  if (b <= Math.PI / 2) return NEAR_DB * Math.cos(b);
  if (b <= 5 * Math.PI / 6) return FAR_DB * Math.sin(((b - Math.PI / 2) / (Math.PI / 3)) * (Math.PI / 2));
  const t = (b - 5 * Math.PI / 6) / (Math.PI / 6);
  return FAR_DB + 4 * t * t;
}

/** Distance gain: 1 at 1 m, 1/d further away, at most +6 dB close up. */
export function distanceGain(d) {
  const x = clamp(Number.isFinite(d) ? d : DIST_REF, DIST_MIN, DIST_MAX);
  return Math.min(DIST_GAIN_MAX, DIST_REF / x);
}

/** High-frequency loss (dB, <= 0) from air beyond 1 m. */
export function airDb(d, on = true) {
  if (!on) return 0;
  const x = clamp(Number.isFinite(d) ? d : DIST_REF, DIST_MIN, DIST_MAX);
  return x <= DIST_REF ? 0 : -Math.min(AIR_DB_MAX, AIR_DB_PER_M * (x - DIST_REF));
}

/**
 * Everything the head model needs for one position, as plain numbers:
 * ear delays (seconds, the near ear 0), ear shelf gains (linear), the
 * distance gain, the shared back and air shelf gains and the height notch.
 */
export function spaceTargets(azDeg, elDeg, dist, air = true, out = {}) {
  const d = direction(azDeg, elDeg);
  const itd = itdSeconds(azDeg, elDeg);
  out.delayL = itd > 0 ? itd : 0;
  out.delayR = itd < 0 ? -itd : 0;
  out.shadowL = dbToGain(shadowDb(Math.acos(clamp(-d.x, -1, 1))));
  out.shadowR = dbToGain(shadowDb(Math.acos(clamp(d.x, -1, 1))));
  // the head also makes a small level difference at low frequencies
  out.levelL = dbToGain(d.x < 0 ? -d.x * LOW_NEAR_DB : d.x * LOW_FAR_DB);
  out.levelR = dbToGain(d.x > 0 ? d.x * LOW_NEAR_DB : -d.x * LOW_FAR_DB);
  out.dist = distanceGain(dist);
  out.back = dbToGain(BACK_DB * Math.max(0, -d.y));
  out.air = dbToGain(airDb(dist, air));
  const el = clamp(Number.isFinite(elDeg) ? elDeg : 0, -90, 90);
  out.notchDb = NOTCH_DB * Math.min(1, Math.abs(el) / 30);
  out.notchHz = NOTCH_HZ * Math.pow(2, clamp(el, -45, 60) / 60);
  return out;
}

/**
 * Direction (and a 0..1 radius) of the dot seen from the middle of the map,
 * for Follow dot. The map wraps, so the nearest copy of the dot counts.
 * Up the map (smaller y) is in front of you.
 */
export function dotToSpace(cx, cy) {
  const wrap = (v) => v - Math.floor(v + 0.5);
  const dx = wrap((Number.isFinite(cx) ? cx : 0.5) - 0.5);
  const dy = wrap((Number.isFinite(cy) ? cy : 0.5) - 0.5);
  const r = Math.min(1, Math.hypot(dx, dy) / 0.5);
  return { az: Math.atan2(dx, -dy) / DEG, r };
}

/** Distance (m) for Follow dot and distance: 0.5 m at the middle, 8 m at the edge. */
export function radiusToDistance(r) {
  return DIST_MIN * Math.pow(16, clamp(Number.isFinite(r) ? r : 0, 0, 1));
}

// ---- surround layouts -----------------------------------------------------------
// Channel order and masks follow the WAVE_FORMAT_EXTENSIBLE speaker bits:
// 5.1 = FL FR FC LFE BL BR (0x3F), 7.1 = FL FR FC LFE BL BR SL SR (0x63F).

export const SURROUND_LAYOUTS = Object.freeze({
  '5.1': Object.freeze({ id: '5.1', channels: 6, mask: 0x3F, lfe: 3, names: ['L', 'R', 'C', 'LFE', 'Ls', 'Rs'], az: [-30, 30, 0, null, -110, 110], rear: [4, 5] }),
  '7.1': Object.freeze({ id: '7.1', channels: 8, mask: 0x63F, lfe: 3, names: ['L', 'R', 'C', 'LFE', 'Lrs', 'Rrs', 'Lss', 'Rss'], az: [-30, 30, 0, null, -150, 150, -90, 90], rear: [4, 5] }),
});

const RINGS = {};
function ring(layout) {
  if (!RINGS[layout.id]) {
    RINGS[layout.id] = layout.az.map((a, ch) => ({ a, ch })).filter(s => s.a !== null).sort((p, q) => p.a - q.a);
  }
  return RINGS[layout.id];
}

/**
 * Pairwise constant-power amplitude panning: the two speakers either side of
 * the azimuth share the sound (cos / sin of the position between them), the
 * rest stay silent, the LFE always. Writes gains into `out` (length >=
 * channels) and returns it; the squares of the gains add up to 1.
 */
export function panSpeakers(azDeg, layout, out = new Float64Array(layout.channels)) {
  const R = ring(layout);
  const az = wrapAz(azDeg);
  for (let c = 0; c < layout.channels; c++) out[c] = 0;
  const n = R.length;
  for (let i = 0; i < n; i++) {
    const p = R[i], q = R[(i + 1) % n];
    const lo = p.a, hi = i + 1 < n ? q.a : q.a + 360;
    let x = az;
    if (i + 1 >= n && x < lo) x += 360;
    if (x >= lo && x <= hi) {
      const t = hi > lo ? (x - lo) / (hi - lo) : 0;
      out[p.ch] += Math.cos(t * Math.PI / 2);
      out[q.ch] += Math.sin(t * Math.PI / 2);
      return out;
    }
  }
  return out;
}

// ---- the per-track processor -------------------------------------------------------

/**
 * One track's 3D stage. process() works in place on the track's stereo
 * output. A fade (`w`) blends between the plain track and the 3D one when
 * 3D is switched on or off; at w = 0 and off, process() is never called.
 */
export class Binaural {
  constructor(sr) {
    this.sr = sr > 0 ? sr : 48000;
    let size = 8;
    while (size < Math.ceil(ITD_MAX * this.sr) + 4) size <<= 1;
    this.dl = new Float64Array(size);
    this.mask = size - 1;
    this.wp = 0;
    this.k = 1 - Math.exp(-1 / (SMOOTH_S * this.sr));
    const pole = (hz) => Math.exp(-2 * Math.PI * Math.min(hz, 0.45 * this.sr) / this.sr);
    this.aShadow = pole(SHADOW_HZ);
    this.aBack = pole(BACK_HZ);
    this.aAir = pole(5000);
    this.tailN = size + Math.ceil(0.05 * this.sr);
    this.T = spaceTargets(0, 0, DIST_REF, true, {});
    this.w = 0; this.wT = 0;    // 3D blend, glides like the gains
    this.el = 0;                // smoothed elevation (for the height notch)
    this.reset();
    // surround: per-speaker gains (current, per-sample step) for up to 8 channels
    this.sg = new Float64Array(8); this.dsg = new Float64Array(8); this.sgT = new Float64Array(8);
    this.sgFresh = true;
  }

  reset() {
    this.dl.fill(0);
    this.wp = 0;
    this.zL = 0; this.zR = 0; this.zB = 0; this.zA = 0;
    this.n1 = 0; this.n2 = 0; this.m1 = 0; this.m2 = 0;
    this.b0 = 1; this.b1 = 0; this.b2 = 0; this.a1 = 0; this.a2 = 0;
    this.notchOn = false;
    const T = this.T;
    this.cDL = T.delayL * this.sr; this.cDR = T.delayR * this.sr;
    this.cSL = T.shadowL; this.cSR = T.shadowR; this.cDist = T.dist; this.cBack = T.back; this.cAir = T.air;
    this.cLL = T.levelL; this.cLR = T.levelR;
  }

  /** New position (once per control block). snap jumps straight there (a note or 3D just starting). */
  target(az, el, dist, air, snap) {
    el = Number.isFinite(el) ? clamp(el, -90, 90) : 0;
    spaceTargets(az, el, dist, air, this.T);
    const T = this.T;
    if (snap) {
      this.cDL = T.delayL * this.sr; this.cDR = T.delayR * this.sr;
      this.cSL = T.shadowL; this.cSR = T.shadowR; this.cDist = T.dist; this.cBack = T.back; this.cAir = T.air;
      this.cLL = T.levelL; this.cLR = T.levelR;
      this.el = el;
    } else this.el += (el - this.el) * Math.min(1, this.k * 64);
    // height notch: a peaking cut (RBJ cookbook form), only while it does something
    const depth = NOTCH_DB * Math.min(1, Math.abs(this.el) / 30);
    if (Math.abs(depth) < 0.05) {
      // a cut this small is inaudible: switch the notch off (the step is far below hearing)
      this.notchOn = false;
      this.n1 = this.n2 = this.m1 = this.m2 = 0;
      return;
    }
    const f = Math.min(0.45 * this.sr, NOTCH_HZ * Math.pow(2, clamp(this.el, -45, 60) / 60));
    const A = Math.pow(10, depth / 40), w0 = 2 * Math.PI * f / this.sr, al = Math.sin(w0) / (2 * 1.2);
    const cw = Math.cos(w0), a0 = 1 + al / A;
    this.b0 = (1 + al * A) / a0; this.b1 = (-2 * cw) / a0; this.b2 = (1 - al * A) / a0;
    this.a1 = (-2 * cw) / a0; this.a2 = (1 - al / A) / a0;
    this.notchOn = true;
  }

  /** Binaural render of oL/oR[pos, pos + seg) in place. */
  process(oL, oR, pos, seg) {
    const D = this.dl, mask = this.mask, T = this.T, sr = this.sr, k = this.k;
    const tDL = T.delayL * sr, tDR = T.delayR * sr, tSL = T.shadowL, tSR = T.shadowR;
    const tLL = T.levelL, tLR = T.levelR, tDist = T.dist, tBack = T.back, tAir = T.air;
    const aS = this.aShadow, aB = this.aBack, aA = this.aAir;
    let wp = this.wp, cDL = this.cDL, cDR = this.cDR, cSL = this.cSL, cSR = this.cSR;
    let cDist = this.cDist, cBack = this.cBack, cAir = this.cAir, w = this.w, cLL = this.cLL, cLR = this.cLR;
    let zL = this.zL, zR = this.zR, zB = this.zB, zA = this.zA;
    let n1 = this.n1, n2 = this.n2, m1 = this.m1, m2 = this.m2;
    const notch = this.notchOn, b0 = this.b0, b1 = this.b1, b2 = this.b2, a1 = this.a1, a2 = this.a2;
    const wT = this.wT;
    const full = wT === 1 && w >= 0.999999;
    for (let n = pos; n < pos + seg; n++) {
      cDL += (tDL - cDL) * k; cDR += (tDR - cDR) * k;
      cSL += (tSL - cSL) * k; cSR += (tSR - cSR) * k;
      cLL += (tLL - cLL) * k; cLR += (tLR - cLR) * k;
      cDist += (tDist - cDist) * k; cBack += (tBack - cBack) * k; cAir += (tAir - cAir) * k;
      const dryL = oL[n], dryR = oR[n];
      let x = 0.5 * (dryL + dryR) * cDist;
      // back and air: one-pole high shelves (low part kept, high part scaled)
      zB = x + (zB - x) * aB; x = zB + cBack * (x - zB);
      zA = x + (zA - x) * aA; x = zA + cAir * (x - zA);
      if (notch) { const y = b0 * x + b1 * n1 + b2 * n2 - a1 * m1 - a2 * m2; n2 = n1; n1 = x; m2 = m1; m1 = y; x = y; }
      D[wp] = x;
      // fractional delay per ear (linear interpolation); the delay is >= 0, so
      // wp - delay + mask + 1 stays positive and truncation is floor
      let p = wp - cDL + mask + 1, i0 = p | 0, f = p - i0;
      let d0 = D[i0 & mask];
      const eL = d0 + f * (D[(i0 + 1) & mask] - d0);
      p = wp - cDR + mask + 1; i0 = p | 0; f = p - i0;
      d0 = D[i0 & mask];
      const eR = d0 + f * (D[(i0 + 1) & mask] - d0);
      wp = (wp + 1) & mask;
      // head shadow: high shelf per ear, then the broadband level difference
      zL = eL + (zL - eL) * aS; const yL = (zL + cSL * (eL - zL)) * cLL;
      zR = eR + (zR - eR) * aS; const yR = (zR + cSR * (eR - zR)) * cLR;
      if (full) { oL[n] = yL; oR[n] = yR; }
      else { w += (wT - w) * k; oL[n] = dryL + w * (yL - dryL); oR[n] = dryR + w * (yR - dryR); }
    }
    if (wT === 1 && w > 0.999999) w = 1;
    if (wT === 0 && w < 1e-6) w = 0;
    this.wp = wp; this.cDL = cDL; this.cDR = cDR; this.cSL = cSL; this.cSR = cSR;
    this.cDist = cDist; this.cBack = cBack; this.cAir = cAir; this.w = w; this.cLL = cLL; this.cLR = cLR;
    // flush tiny filter states to zero (denormals are slow on some CPUs)
    const tiny = (v) => (v < 1e-20 && v > -1e-20 ? 0 : v);
    this.zL = tiny(zL); this.zR = tiny(zR); this.zB = tiny(zB); this.zA = tiny(zA);
    this.n1 = tiny(n1); this.n2 = tiny(n2); this.m1 = tiny(m1); this.m2 = tiny(m2);
  }

  /**
   * Surround (speakers instead of headphones): the mono source with distance
   * gain and air, no head. Writes it to both oL and oR (the sends hear it
   * centred); the speaker gains come from surroundTarget().
   */
  processMono(oL, oR, pos, seg) {
    const T = this.T, k = this.k, aA = this.aAir;
    let cDist = this.cDist, cAir = this.cAir, zA = this.zA;
    for (let n = pos; n < pos + seg; n++) {
      cDist += (T.dist - cDist) * k; cAir += (T.air - cAir) * k;
      let x = 0.5 * (oL[n] + oR[n]) * cDist;
      zA = x + (zA - x) * aA; x = zA + cAir * (x - zA);
      oL[n] = x; oR[n] = x;
    }
    this.cDist = cDist; this.cAir = cAir; this.zA = zA;
  }

  /** Speaker gains for the next control block (ctrlN samples), scaled by sqrt 2 so a point source is as loud as the same track panned to centre in stereo. */
  surroundTarget(az, layout, ctrlN) {
    panSpeakers(az, layout, this.sgT);
    const inv = 1 / Math.max(1, ctrlN);
    for (let c = 0; c < 8; c++) {
      const t = c < layout.channels ? this.sgT[c] * Math.SQRT2 : 0;
      if (this.sgFresh) { this.sg[c] = t; this.dsg[c] = 0; } else this.dsg[c] = (t - this.sg[c]) * inv;
      this.sgT[c] = t;
    }
    this.sgFresh = false;
  }
}
