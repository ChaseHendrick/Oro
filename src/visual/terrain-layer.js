// The land: one displaced plane covering 3 x 3 tiles so the wrap-around is
// visible. Heights come from the two terrain tables (A, B) as float textures,
// with exactly the warp and morph of the audio; normals, contours, the dot's
// glow ring, its contact shadow and the orbit footprint are all computed per
// pixel from the same function, so they hug the surface at any zoom.
//
// Terrain swaps crossfade on the GPU: each slot keeps its previous texture and
// blends it out over ~300 ms (the CPU HeightField mirrors the same fade).

import * as THREE from 'three';
import { W, EXTENT } from './heightfield.js';

export const MESH_RES = {
  // segments across the centre tile / across each neighbour tile
  high: [256, 64],
  medium: [160, 44],
  low: [96, 28],
};

// Vertex positions on a tensor grid: dense over the centre tile, coarser over
// the faded neighbours. One regular topology, so no T-junction cracks.
function axisCoords(center, outer) {
  const out = [];
  const half = W / 2;
  for (let i = 0; i < outer; i++) out.push(-EXTENT + (i / outer) * W);
  for (let i = 0; i < center; i++) out.push(-half + (i / center) * W);
  for (let i = 0; i <= outer; i++) out.push(half + (i / outer) * W);
  return out;
}

export function buildTerrainGeometry(level = 'high') {
  const [c, o] = MESH_RES[level] || MESH_RES.high;
  const xs = axisCoords(c, o);
  const n = xs.length;
  const pos = new Float32Array(n * n * 3);
  let k = 0;
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      pos[k++] = xs[i]; pos[k++] = 0; pos[k++] = xs[j];
    }
  }
  const quads = (n - 1) * (n - 1);
  const idx = n * n > 65535 ? new Uint32Array(quads * 6) : new Uint16Array(quads * 6);
  k = 0;
  for (let j = 0; j < n - 1; j++) {
    for (let i = 0; i < n - 1; i++) {
      const a = j * n + i, b = a + 1, d = a + n, e = d + 1;
      // alternate the diagonal so long ridges do not all fold the same way
      if ((i + j) & 1) { idx[k++] = a; idx[k++] = d; idx[k++] = b; idx[k++] = b; idx[k++] = d; idx[k++] = e; }
      else { idx[k++] = a; idx[k++] = d; idx[k++] = e; idx[k++] = a; idx[k++] = e; idx[k++] = b; }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), EXTENT * 1.5);
  return g;
}

/** Box-filtered mip chain down to 1 x 1 (GPU convention: texel i of level L+1 covers 2i, 2i+1). */
export function mipChain(data, size) {
  const levels = [{ data, width: size, height: size }];
  let cur = data, s = size;
  while (s > 1) {
    const h = s >> 1;
    const next = new Float32Array(h * h);
    for (let j = 0; j < h; j++) {
      const r0 = 2 * j * s, r1 = r0 + s;
      for (let i = 0; i < h; i++) {
        const c = 2 * i;
        next[j * h + i] = 0.25 * (cur[r0 + c] + cur[r0 + c + 1] + cur[r1 + c] + cur[r1 + c + 1]);
      }
    }
    levels.push({ data: next, width: h, height: h });
    cur = next; s = h;
  }
  return levels;
}

const VERT = /* glsl */`
uniform sampler2D uA;
uniform sampler2D uA0;
uniform sampler2D uB;
uniform sampler2D uB0;
uniform vec4 uOff;      // half-texel offsets: A, A0, B, B0
uniform vec2 uFade;
uniform float uMorph;
uniform float uWarp;
uniform float uHeight;
varying vec3 vWorld;

const float TAU = 6.283185307179586;
const float TILE = ${W.toFixed(1)};

vec2 warpUV(vec2 uv) {
  if (uWarp <= 0.0) return uv;
  float w = uWarp * 0.06;
  return vec2(
    uv.x + w * (sin(TAU * 2.0 * uv.y) + 0.5 * sin(TAU * (3.0 * uv.y + 2.0 * uv.x))),
    uv.y + w * (sin(TAU * 2.0 * uv.x) + 0.5 * sin(TAU * (3.0 * uv.x - 2.0 * uv.y))));
}

float heightLod(vec2 uv) {
  uv = warpUV(uv);
  float a = textureLod(uA, uv + uOff.x, 0.0).r;
  if (uFade.x < 1.0) a = mix(textureLod(uA0, uv + uOff.y, 0.0).r, a, uFade.x);
  if (uMorph <= 0.0) return a;
  float b = textureLod(uB, uv + uOff.z, 0.0).r;
  if (uFade.y < 1.0) b = mix(textureLod(uB0, uv + uOff.w, 0.0).r, b, uFade.y);
  return uMorph >= 1.0 ? b : a + uMorph * (b - a);
}

void main() {
  vec3 p = position;
  p.y = heightLod(p.xz / TILE + 0.5) * uHeight;
  vec4 wp = modelMatrix * vec4(p, 1.0);
  vWorld = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

const FRAG = /* glsl */`
uniform sampler2D uA;
uniform sampler2D uA0;
uniform sampler2D uB;
uniform sampler2D uB0;
uniform vec4 uOff;
uniform vec2 uFade;
uniform float uMorph;
uniform float uWarp;
uniform float uHeight;
uniform float uEps;
uniform float uLift;
uniform float uFold;

uniform vec3 uRamp[6];
uniform vec3 uHeat[6];
uniform vec3 uPart;
uniform float uTint;
uniform int uStyle;          // 0 relief, 1 wire, 2 contour, 3 heat, 4 points

uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform float uSunI;
uniform vec3 uSkyAmb;
uniform vec3 uGroundAmb;
uniform float uAmbI;
uniform vec3 uRim;
uniform float uRimI;
uniform vec3 uContour;
uniform float uContourA;
uniform vec3 uGrid;
uniform float uGridA;
uniform vec3 uFog;
uniform float uFogDensity;
uniform float uFogStart;
uniform vec3 uEdge;
uniform float uThemeT;
uniform float uGlow;

uniform vec4 uDot;           // u, v, height above ground, visibility
uniform vec3 uGhost;         // u, v, visibility
uniform vec4 uFootInv;       // inverse path transform (a b; c d)
uniform float uFootA;
uniform float uTime;
uniform float uLevel;

varying vec3 vWorld;

const float TAU = 6.283185307179586;
const float PI = 3.141592653589793;
const float TILE = ${W.toFixed(1)};

vec2 warpUV(vec2 uv) {
  if (uWarp <= 0.0) return uv;
  float w = uWarp * 0.06;
  return vec2(
    uv.x + w * (sin(TAU * 2.0 * uv.y) + 0.5 * sin(TAU * (3.0 * uv.y + 2.0 * uv.x))),
    uv.y + w * (sin(TAU * 2.0 * uv.x) + 0.5 * sin(TAU * (3.0 * uv.x - 2.0 * uv.y))));
}

float heightAt(vec2 uv) {
  uv = warpUV(uv);
  float a = texture(uA, uv + uOff.x).r;
  if (uFade.x < 1.0) a = mix(texture(uA0, uv + uOff.y).r, a, uFade.x);
  if (uMorph <= 0.0) return a;
  float b = texture(uB, uv + uOff.z).r;
  if (uFade.y < 1.0) b = mix(texture(uB0, uv + uOff.w).r, b, uFade.y);
  return uMorph >= 1.0 ? b : a + uMorph * (b - a);
}

// Local mean height from a coarser mip: below it means a hollow (ambient
// occlusion), above it a crest. One extra fetch per slot instead of a kernel.
float heightBlur(vec2 uv) {
  uv = warpUV(uv);
  float a = texture(uA, uv + uOff.x, 3.0).r;
  if (uMorph <= 0.0) return a;
  float b = texture(uB, uv + uOff.z, 3.0).r;
  return mix(a, b, clamp(uMorph, 0.0, 1.0));
}

vec3 ramp6(vec3 r[6], float x) {
  float f = clamp(x, 0.0, 1.0) * 5.0;
  float i = min(floor(f), 4.0);
  float a = f - i;
  a = a * a * (3.0 - 2.0 * a);
  vec3 c0 = r[0], c1 = r[1];
  if (i >= 4.0) { c0 = r[4]; c1 = r[5]; }
  else if (i >= 3.0) { c0 = r[3]; c1 = r[4]; }
  else if (i >= 2.0) { c0 = r[2]; c1 = r[3]; }
  else if (i >= 1.0) { c0 = r[1]; c1 = r[2]; }
  return mix(c0, c1, a);
}

float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }

// Anti-aliased iso-line of x at integer values, about w pixels wide.
float isoLine(float x, float w) {
  float fw = max(fwidth(x), 1e-5);
  float d = abs(fract(x - 0.5) - 0.5) / fw;
  return 1.0 - smoothstep(w * 0.5 - 0.5, w * 0.5 + 0.5, d);
}

float gridLine(vec2 x, float w) {
  vec2 fw = max(fwidth(x), vec2(1e-5));
  vec2 d = abs(fract(x - 0.5) - 0.5) / fw;
  vec2 l = 1.0 - smoothstep(vec2(w * 0.5 - 0.5), vec2(w * 0.5 + 0.5), d);
  return max(l.x, l.y);
}

void main() {
  vec2 uv = vWorld.xz / TILE + 0.5;
  float h = heightAt(uv);

  // Normal from central differences of the exact displayed function. When
  // the land is minified the step widens to the pixel footprint, which keeps
  // fine detail from sparkling into grain.
  float e = max(uEps, 0.75 * length(fwidth(uv)));
  float hx1 = heightAt(uv + vec2(e, 0.0));
  float hz1 = heightAt(uv + vec2(0.0, e));
#if NORMAL_TAPS == 4
  float hx0 = heightAt(uv - vec2(e, 0.0));
  float hz0 = heightAt(uv - vec2(0.0, e));
  float gx = (hx1 - hx0) / (2.0 * e);
  float gz = (hz1 - hz0) / (2.0 * e);
#else
  float gx = (hx1 - h) / e;
  float gz = (hz1 - h) / e;
#endif
  float k = uHeight / TILE;
  vec3 N = normalize(vec3(-gx * k, 1.0, -gz * k));
  vec3 V = normalize(cameraPosition - vWorld);
  vec3 L = normalize(uSunDir);

  // Base colour from height, with a hint of the folder: where Fold would
  // bend the wave back, the ramp shimmers into bands.
  float t = clamp(0.5 + 0.7 * h, 0.0, 1.0);
  if (uFold > 0.0) {
    float y = h * uLift;
    float folded = sin(PI * 0.5 * y * (1.0 + 4.0 * uFold));
    t = mix(t, folded * 0.5 + 0.5, uFold * 0.45);
  }
  vec3 albedo = uStyle == 3 ? ramp6(uHeat, t) : ramp6(uRamp, t);
  if (uStyle != 3) {
    float pl = max(luma(uPart), 0.04);
    vec3 tinted = luma(albedo) * (uPart / pl);
    albedo = mix(albedo, tinted, uTint * (0.35 + 0.65 * smoothstep(0.15, 0.9, t)));
  }

  // Steep faces lean towards a darker, cooler rock tone.
  float steep = smoothstep(0.35, 0.85, 1.0 - N.y);
  albedo = mix(albedo, albedo * vec3(0.68, 0.7, 0.78), steep * 0.55);

  // Ambient occlusion from the local mean height.
  float cavity = clamp((heightBlur(uv) - h) * uLift * 1.6, -1.0, 1.0);
  float ao = clamp(1.0 - max(cavity, 0.0) * 0.65 + max(-cavity, 0.0) * 0.08, 0.35, 1.08);

  // Soft sun shadow: march a few steps towards the light over the heightfield.
  float shadow = 1.0;
#if SHADOW_STEPS > 0
  {
    vec2 ld = normalize(L.xz + vec2(1e-5));
    float tanE = L.y / max(length(L.xz), 1e-3);
    float h0 = h * uHeight;
    float occ = 0.0;
    float dist = 0.06;
    for (int i = 0; i < SHADOW_STEPS; i++) {
      vec2 suv = uv + ld * (dist / TILE);
      float hs = heightAt(suv) * uHeight;
      float rayH = h0 + dist * tanE;
      occ = max(occ, (hs - rayH) / dist);
      dist *= 1.75;
    }
    shadow = 1.0 - smoothstep(0.0, 0.35, occ);
  }
#endif

  vec3 col;
  float ndl = dot(N, L);
  float diff = clamp(ndl * 0.82 + 0.18, 0.0, 1.0);
  vec3 amb = mix(uGroundAmb, uSkyAmb, N.y * 0.5 + 0.5) * uAmbI;
  vec3 Hv = normalize(L + V);
  float spec = pow(max(dot(N, Hv), 0.0), 48.0) * (0.05 + 0.08 * (1.0 - uThemeT)) * shadow;
  float fres = pow(1.0 - max(dot(N, V), 0.0), 4.0);

  if (uStyle == 1) {
    // Wire: a dark (or paper) body with a lattice that follows the land, in
    // the palette's colours so the part-coloured orbit stays the hero.
    float lit = 0.35 + 0.65 * diff * shadow;
    vec3 body = mix(vec3(0.010, 0.013, 0.026), vec3(0.88, 0.85, 0.80), uThemeT);
    col = body * (0.6 + 0.4 * lit) * ao;
    float far = 1.0 - smoothstep(18.0, 40.0, length(cameraPosition - vWorld));
    float fine = gridLine(uv * 32.0, 1.0) * (0.35 + 0.65 * far);
    float coarse = gridLine(uv * 8.0, 1.5);
    vec3 lineDark = ramp6(uRamp, 0.35 + 0.55 * t) * (0.7 + 0.9 * lit) * 1.5;
    vec3 lineLight = ramp6(uRamp, 0.15 + 0.4 * t) * (0.55 + 0.25 * lit);
    vec3 wcol = mix(lineDark, lineLight, uThemeT);
    col = mix(col, wcol, fine * 0.85);
    col = mix(col, wcol * mix(1.35, 0.8, uThemeT), coarse * 0.7);
  } else if (uStyle == 4) {
    // Points: the land as a field of glowing samples, larger on high ground.
    float lit = 0.4 + 0.6 * diff * shadow;
    vec3 body = mix(vec3(0.008, 0.01, 0.02), vec3(0.9, 0.87, 0.82), uThemeT);
    col = body * (0.7 + 0.3 * lit);
    vec2 g = uv * 40.0;
    vec2 cell = fract(g) - 0.5;
    float px = length(cell / max(fwidth(g), vec2(1e-4)));
    float rad = mix(1.0, 3.2, t);
    float spot = 1.0 - smoothstep(rad - 0.7, rad + 0.7, px);
    vec3 pc = mix(ramp6(uRamp, 0.3 + 0.7 * t) * (0.8 + 0.8 * lit) * 1.6, ramp6(uRamp, 0.1 + 0.45 * t) * 0.7, uThemeT);
    col = mix(col, pc, spot);
  } else if (uStyle == 2) {
    // Contour: a topographic sheet, lightly hill-shaded.
    float hs = 0.62 + 0.38 * diff * shadow;
    vec3 paper = mix(albedo * 0.55 + 0.03, mix(vec3(0.94, 0.91, 0.85), albedo, 0.25), uThemeT);
    col = paper * hs * mix(1.0, ao, 0.5);
  } else {
    col = albedo * (amb * ao + uSunColor * uSunI * diff * shadow) + uSunColor * spec;
    col += uRim * fres * uRimI * (0.4 + 0.6 * t) * ao;
    // At night the high ground holds a faint glow of its own.
    col += albedo * smoothstep(0.62, 1.0, t) * 0.1 * (1.0 - uThemeT);
  }

  // Contour lines: minor every 0.125, major every 0.5, faded where they
  // crowd (steep or distant land) so they never turn into moire.
  float camDist = length(cameraPosition - vWorld);
  {
    float cs = uStyle == 2 ? 0.0625 : 0.125;
    float x = h / cs;
    float crowd = 1.0 - smoothstep(0.12, 0.42, fwidth(x));
    float minor = isoLine(x, uStyle == 2 ? 1.2 : 1.0) * crowd;
    float xm = h / 0.5;
    float major = isoLine(xm, uStyle == 2 ? 2.0 : 1.4) * (1.0 - smoothstep(0.15, 0.5, fwidth(xm)));
    float ca = uContourA * (uStyle == 2 ? 2.4 : uStyle == 1 ? 0.5 : 1.0);
    float far = 1.0 - smoothstep(16.0, 34.0, camDist);
    vec3 cc = uStyle == 2 ? mix(uContour, mix(uPart, uContour, 0.4), 0.5) : uContour;
    col = mix(col, cc, clamp((minor * 0.45 + major * 1.25) * ca * far, 0.0, 0.85));
  }

  // Faint coordinate grid (eighths of a tile) and the tile seams.
  {
    float g = gridLine(uv * 8.0, 1.0) * uGridA;
    float seam = gridLine(uv, 1.6) * uGridA * 2.2;
    col = mix(col, uGrid, clamp(g + seam, 0.0, 0.6));
  }

  // Orbit footprint: the ellipse the path's outer radius sweeps.
  if (uFootA > 0.0) {
    vec2 d = uv - uDot.xy;
    d -= floor(d + 0.5);
    vec2 q = vec2(uFootInv.x * d.x + uFootInv.y * d.y, uFootInv.z * d.x + uFootInv.w * d.y);
    float r = length(q);
    float inside = 1.0 - smoothstep(0.96, 1.04, r);
    float rimLine = (1.0 - smoothstep(0.0, 1.4, abs(r - 1.0) / max(fwidth(r), 1e-5)));
    col = mix(col, col * 1.08 + uPart * 0.03 * uGlow, inside * uFootA);
    col = mix(col, mix(col, uPart, 0.5), rimLine * 0.28 * uFootA);
  }

  // The dot: contact shadow, glow pool, crisp ring and a slow pulse ring.
  // Nearest periodic copy, so faded echoes appear in the neighbour tiles.
  if (uDot.w > 0.0) {
    vec2 d = uv - uDot.xy;
    vec2 dw = d - floor(d + 0.5);
    float primary = 1.0 - step(1e-4, abs(d.x - dw.x) + abs(d.y - dw.y));
    float r = length(dw) * TILE;
    float echo = mix(0.35, 1.0, primary) * uDot.w;
    float sig = 0.12 + 0.22 * clamp(uDot.z, 0.0, 2.0);
    col *= 1.0 - 0.55 * primary * uDot.w * exp(-r * r / (2.0 * sig * sig));
    float pool = exp(-r * r / 0.5);
    col += uPart * pool * (0.22 + 0.25 * uLevel) * uGlow * echo;
    float fw = max(fwidth(r), 1e-4);
    float ring = 1.0 - smoothstep(0.01, 0.01 + 1.5 * fw, abs(r - 0.34));
    col = mix(col, uPart * mix(2.4, 0.95, uThemeT), ring * 0.85 * echo);
    float ph = fract(uTime * 0.45);
    float rr = 0.34 + 1.5 * ph;
    float pulse = (1.0 - smoothstep(0.012, 0.012 + 2.0 * fw, abs(r - rr))) * (1.0 - ph) * (1.0 - ph);
    col += uPart * pulse * mix(1.4, 0.55, uThemeT) * uGlow * echo;
  }

  // Ghost: where the dot sits before modulation, tied to the dot by a
  // dashed thread so the modulation's reach is visible.
  if (uGhost.z > 0.0) {
    vec2 d = uv - uGhost.xy;
    d -= floor(d + 0.5);
    float r = length(d) * TILE;
    float fw = max(fwidth(r), 1e-4);
    float ring = 1.0 - smoothstep(0.01, 0.01 + 1.5 * fw, abs(r - 0.26));
    float dash = step(0.5, fract(atan(d.y, d.x) * 5.0 / PI - uTime * 0.2));
    vec3 gc = mix(uPart, vec3(1.0), 0.35 * (1.0 - uThemeT));
    col = mix(col, gc, ring * dash * 0.85 * uGhost.z);
    // thread from the ghost to the dot (shortest way round)
    vec2 g2d = uDot.xy - uGhost.xy;
    g2d -= floor(g2d + 0.5);
    float len = length(g2d);
    if (len > 1e-4) {
      vec2 dir = g2d / len;
      float along = clamp(dot(d, dir), 0.0, len);
      float off = length(d - dir * along) * TILE;
      float fw2 = max(fwidth(off), 1e-4);
      float thread = 1.0 - smoothstep(0.004, 0.004 + 1.4 * fw2, off);
      float dashes = step(0.45, fract(along * TILE * 4.0 - uTime * 0.8));
      float ends = smoothstep(0.26, 0.4, along * TILE) * smoothstep(0.3, 0.45, (len - along) * TILE);
      col = mix(col, gc, thread * dashes * ends * 0.6 * uGhost.z);
    }
  }

  // Neighbour tiles: the same land (it wraps), shown as a quieter echo that
  // fades out towards the edges of the 3 x 3 plane.
  float out_ = max(abs(vWorld.x), abs(vWorld.z)) - TILE * 0.5;
  float edge = clamp(out_ / TILE, 0.0, 1.0);
  float lum = luma(col);
  float echoK = smoothstep(0.0, 0.06, edge);
  vec3 echoCol = mix(vec3(lum), col, 0.45);
  // night: the echoes sink into darkness; day: they dissolve into the haze
  echoCol = mix(echoCol * 0.34, mix(echoCol, uEdge, 0.55), uThemeT);
  col = mix(col, echoCol, echoK * 0.92);
  col = mix(col, uEdge, smoothstep(0.2, 0.95, edge) * 0.55);
  // A fine frame around the playable tile.
  {
    float fw = max(fwidth(out_), 1e-4);
    float frame = 1.0 - smoothstep(0.5 * fw, 1.8 * fw, abs(out_));
    vec3 fc = mix(mix(uGrid, uPart, 0.35) * 1.6, mix(uContour, uPart, 0.3), uThemeT);
    col = mix(col, fc, frame * mix(0.42, 0.45, uThemeT));
  }

  // Distance fog, matched to the sky's horizon.
  // Starts a little short of the orbit target, so the playable tile stays
  // crisp at any zoom and only the far echoes melt into the sky.
  float dist = max(camDist - uFogStart, 0.0);
  float fogF = 1.0 - exp(-pow(dist * uFogDensity * 1.6, 2.0));
  col = mix(col, uFog, clamp(fogF, 0.0, 1.0));

  float alpha = 1.0 - smoothstep(0.35, 0.95, edge);
  gl_FragColor = vec4(col, alpha);
}
`;

function zeroTexture() {
  const t = new THREE.DataTexture(new Float32Array([0]), 1, 1, THREE.RedFormat, THREE.FloatType);
  t.needsUpdate = true;
  return t;
}

/**
 * createTerrainLayer(renderer, quality) -> { mesh, uniforms, setTable(slot, data, size, crossfade),
 *   setQuality(q), dispose() }
 */
export function createTerrainLayer(renderer, quality = 'high') {
  const floatLinear = renderer.extensions.has('OES_texture_float_linear');
  const maxAniso = Math.min(8, renderer.capabilities.getMaxAnisotropy ? renderer.capabilities.getMaxAnisotropy() : 1);
  const blank = zeroTexture();

  const vec3s = (n) => Array.from({ length: n }, () => new THREE.Vector3());
  const uniforms = {
    uA: { value: blank }, uA0: { value: blank }, uB: { value: blank }, uB0: { value: blank },
    uOff: { value: new THREE.Vector4() },
    uFade: { value: new THREE.Vector2(1, 1) },
    uMorph: { value: 0 }, uWarp: { value: 0 }, uHeight: { value: 1.6 }, uEps: { value: 1 / 512 },
    uLift: { value: 1 }, uFold: { value: 0 },
    uRamp: { value: vec3s(6) }, uHeat: { value: vec3s(6) },
    uPart: { value: new THREE.Vector3(1, 0.5, 0.3) }, uTint: { value: 0.2 }, uStyle: { value: 0 },
    uSunDir: { value: new THREE.Vector3(-0.4, 0.6, -0.7) }, uSunColor: { value: new THREE.Vector3(1, 1, 1) }, uSunI: { value: 1 },
    uSkyAmb: { value: new THREE.Vector3() }, uGroundAmb: { value: new THREE.Vector3() }, uAmbI: { value: 0.5 },
    uRim: { value: new THREE.Vector3() }, uRimI: { value: 0.5 },
    uContour: { value: new THREE.Vector3() }, uContourA: { value: 0.2 },
    uGrid: { value: new THREE.Vector3() }, uGridA: { value: 0.1 },
    uFog: { value: new THREE.Vector3() }, uFogDensity: { value: 0.02 }, uFogStart: { value: 12 },
    uEdge: { value: new THREE.Vector3() }, uThemeT: { value: 0 }, uGlow: { value: 1 },
    uDot: { value: new THREE.Vector4(0.5, 0.5, 0, 1) },
    uGhost: { value: new THREE.Vector3(0.5, 0.5, 0) },
    uFootInv: { value: new THREE.Vector4(1, 0, 0, 1) }, uFootA: { value: 0 },
    uTime: { value: 0 }, uLevel: { value: 0 },
  };

  const defines = (q) => ({
    NORMAL_TAPS: q === 'low' ? 2 : 4,
    SHADOW_STEPS: q === 'high' ? 6 : 0,
  });

  const material = new THREE.ShaderMaterial({
    vertexShader: VERT,
    fragmentShader: FRAG,
    uniforms,
    defines: defines(quality),
    transparent: true,
    depthWrite: true,
    extensions: {},
  });

  let geometry = buildTerrainGeometry(quality);
  const mesh = new THREE.Mesh(geometry, material);
  mesh.frustumCulled = false;
  mesh.renderOrder = 0;
  let currentQuality = quality;

  // slot -> { cur: {tex, size}, prev: {tex, size} }
  const slots = { A: { cur: null, prev: null }, B: { cur: null, prev: null } };

  function makeTexture(data, size) {
    const levels = mipChain(data, size);
    let tex;
    if (floatLinear) {
      tex = new THREE.DataTexture(data, size, size, THREE.RedFormat, THREE.FloatType);
      tex.mipmaps = levels;
    } else {
      // Half floats always filter linearly in WebGL2.
      const half = levels.map(l => {
        const out = new Uint16Array(l.data.length);
        for (let i = 0; i < out.length; i++) out[i] = THREE.DataUtils.toHalfFloat(l.data[i]);
        return { data: out, width: l.width, height: l.height };
      });
      tex = new THREE.DataTexture(half[0].data, size, size, THREE.RedFormat, THREE.HalfFloatType);
      tex.mipmaps = half;
    }
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.magFilter = THREE.LinearFilter;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.generateMipmaps = false;
    tex.anisotropy = maxAniso;
    tex.colorSpace = THREE.NoColorSpace;
    tex.needsUpdate = true;
    return tex;
  }

  function bind() {
    const a = slots.A, b = slots.B;
    uniforms.uA.value = a.cur ? a.cur.tex : blank;
    uniforms.uA0.value = a.prev ? a.prev.tex : uniforms.uA.value;
    uniforms.uB.value = b.cur ? b.cur.tex : blank;
    uniforms.uB0.value = b.prev ? b.prev.tex : uniforms.uB.value;
    const off = (s) => (s ? 0.5 / s.size : 0);
    uniforms.uOff.value.set(off(a.cur), off(a.prev || a.cur), off(b.cur), off(b.prev || b.cur));
    const res = Math.max(a.cur ? a.cur.size : 0, b.cur ? b.cur.size : 0, 64);
    // 1.5 texels: keeps every feature but does not shade single-texel grain
    uniforms.uEps.value = 1.5 / res;
  }

  function release(entry) {
    if (entry && entry.tex) entry.tex.dispose();
  }

  return {
    mesh,
    uniforms,
    material,
    floatLinear,

    /** Upload a table. With crossfade the old table stays bound as the fade source. */
    setTable(slot, data, size, crossfade) {
      const s = slots[slot === 'B' || slot === 1 ? 'B' : 'A'];
      if (!data) return;
      const entry = { tex: makeTexture(data, size), size, data };
      if (crossfade && s.cur) {
        release(s.prev);
        s.prev = s.cur;
      } else {
        release(s.prev);
        s.prev = null;
        if (s.cur) release(s.cur);
      }
      s.cur = entry;
      bind();
    },

    /** Fade progress per slot (0..1); drops the old texture when done. */
    setFade(fa, fb) {
      uniforms.uFade.value.set(slots.A.prev ? fa : 1, slots.B.prev ? fb : 1);
      let changed = false;
      if (fa >= 1 && slots.A.prev) { release(slots.A.prev); slots.A.prev = null; changed = true; }
      if (fb >= 1 && slots.B.prev) { release(slots.B.prev); slots.B.prev = null; changed = true; }
      if (changed) bind();
    },

    hasB() { return !!slots.B.cur; },

    setQuality(q) {
      if (q === currentQuality) return;
      currentQuality = q;
      const old = geometry;
      geometry = buildTerrainGeometry(q);
      mesh.geometry = geometry;
      old.dispose();
      material.defines = defines(q);
      material.needsUpdate = true;
    },

    dispose() {
      for (const s of Object.values(slots)) { release(s.cur); release(s.prev); s.cur = s.prev = null; }
      blank.dispose();
      geometry.dispose();
      material.dispose();
    },
  };
}
