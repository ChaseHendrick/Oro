// HUD elements laid over the 3D view: a top-down minimap (click or drag on it
// to place the dot precisely), a small coordinate / height readout that
// follows the pointer, and a keyboard focus ring. Class names are prefixed
// 'og-hud-'; inline styles are minimal and lean on the UI's CSS variables so
// the UI can restyle everything.

import { sampleRamp, linearToSrgb } from './palettes.js';

const IMG_RES = 112;
/** Longest cross-fade from the previous terrain image to a new one (ms). */
export const TERRAIN_FADE_MS = 60;
const MAX_WP = 8, MAX_LOCKS = 16;

function el(tag, cls, style) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (style) e.setAttribute('style', style);
  return e;
}

export function createMinimap(container, { onPick, label = 'Minimap: click or drag to place the dot' } = {}) {
  const wrap = el('div', 'og-hud-minimap',
    'position:absolute;right:12px;top:58px;z-index:3;border-radius:10px;overflow:hidden;' +
    'background:var(--glass, rgba(10,14,25,0.64));border:1px solid var(--border-2, rgba(148,166,214,0.18));' +
    'box-shadow:var(--shadow-2, 0 6px 22px rgba(0,0,0,0.35));touch-action:none;cursor:crosshair;user-select:none;');
  wrap.setAttribute('role', 'img');
  wrap.setAttribute('aria-label', label);
  const canvas = el('canvas', 'og-hud-minimap-canvas', 'display:block;width:100%;height:100%;');
  wrap.appendChild(canvas);
  container.appendChild(wrap);
  const ctx = canvas.getContext('2d');

  const img = document.createElement('canvas');
  img.width = img.height = IMG_RES;
  const ictx = img.getContext('2d');
  const imageData = ictx.createImageData(IMG_RES, IMG_RES);
  // The previous terrain image, cross-faded under the new one so a moving
  // terrain (morph, warp, lift) glides instead of stepping between renders.
  const prev = document.createElement('canvas');
  prev.width = IMG_RES; prev.height = IMG_RES;
  const pctx = prev.getContext('2d');
  let imgAt = -Infinity, havePrev = false, fadeMs = TERRAIN_FADE_MS;
  const grid = new Float32Array(IMG_RES * IMG_RES);
  const col = [0, 0, 0];
  let size = 120, dpr = 1;
  let pressed = false;
  let wedge = null, wedgeKey = -1;
  // Markers (kept here so draw() needs no arguments for them and allocates nothing).
  const wpU = new Float64Array(MAX_WP), wpV = new Float64Array(MAX_WP);
  let wpN = 0;
  const lkU = new Float64Array(MAX_LOCKS), lkV = new Float64Array(MAX_LOCKS);
  const lkOn = new Uint8Array(MAX_LOCKS);
  let route = null, routeN = 0, showWp = false, showLocks = false;
  const DASH = [3, 2.5], GHOST_DASH = [2, 2], NO_DASH = [];
  const LABELS = ['1', '2', '3', '4', '5', '6', '7', '8'];
  let font = '', fontDpr = 0;

  function setSize(px) {
    size = Math.round(px);
    dpr = Math.min(2, window.devicePixelRatio || 1);
    wrap.style.width = size + 'px';
    wrap.style.height = size + 'px';
    canvas.width = Math.round(size * dpr);
    canvas.height = Math.round(size * dpr);
  }
  setSize(120);

  function uvFromEvent(e) {
    const r = canvas.getBoundingClientRect();
    return {
      u: Math.min(0.9999, Math.max(0, (e.clientX - r.left) / Math.max(1, r.width))),
      v: Math.min(0.9999, Math.max(0, (e.clientY - r.top) / Math.max(1, r.height))),
    };
  }
  const down = (e) => {
    if (e.button !== undefined && e.button !== 0) return;
    pressed = true;
    try { wrap.setPointerCapture(e.pointerId); } catch { /* not capturable */ }
    const p = uvFromEvent(e);
    if (onPick) onPick(p.u, p.v, 'start');
    e.preventDefault();
    e.stopPropagation();
  };
  const move = (e) => {
    if (!pressed) return;
    const p = uvFromEvent(e);
    if (onPick) onPick(p.u, p.v, 'move');
    e.stopPropagation();
  };
  const up = (e) => {
    if (!pressed) return;
    pressed = false;
    const p = uvFromEvent(e);
    if (onPick) onPick(p.u, p.v, 'end');
    e.stopPropagation();
  };
  wrap.addEventListener('pointerdown', down);
  wrap.addEventListener('pointermove', move);
  wrap.addEventListener('pointerup', up);
  wrap.addEventListener('pointercancel', up);
  wrap.addEventListener('wheel', (e) => e.stopPropagation(), { passive: true });

  function drawMarkers(W_, H_, css, themeT) {
    const ink = themeT > 0.5 ? 'rgba(20,16,10,0.9)' : 'rgba(5,8,16,0.9)';
    if (showLocks) {
      const s = 3.2 * dpr;
      ctx.lineWidth = 1 * dpr;
      ctx.strokeStyle = ink;
      ctx.fillStyle = themeT > 0.5 ? '#fdf8ef' : '#e8ecf6';
      for (let i = 0; i < MAX_LOCKS; i++) {
        if (!lkOn[i]) continue;
        const x = lkU[i] * W_, y = lkV[i] * H_;
        ctx.fillRect(x - s, y - s, 2 * s, 2 * s);
        ctx.strokeRect(x - s, y - s, 2 * s, 2 * s);
      }
    }
    if (!showWp) return;
    if (route && routeN > 1) {
      // the route is unwrapped: draw it at each copy that touches the map
      let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
      for (let i = 0; i < routeN; i++) {
        const u = route[2 * i], v = route[2 * i + 1];
        if (u < minU) minU = u; if (u > maxU) maxU = u;
        if (v < minV) minV = v; if (v > maxV) maxV = v;
      }
      DASH[0] = 3 * dpr; DASH[1] = 2.5 * dpr;
      ctx.setLineDash(DASH);
      ctx.strokeStyle = css;
      ctx.lineWidth = 1.4 * dpr;
      for (let oy = -2; oy <= 1; oy++) {
        if (maxV + oy < 0 || minV + oy > 1) continue;
        for (let ox = -2; ox <= 1; ox++) {
          if (maxU + ox < 0 || minU + ox > 1) continue;
          ctx.beginPath();
          for (let i = 0; i < routeN; i++) {
            const x = (route[2 * i] + ox) * W_, y = (route[2 * i + 1] + oy) * H_;
            if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
          }
          ctx.stroke();
        }
      }
      ctx.setLineDash(NO_DASH);
    }
    const r = 4.6 * dpr;
    if (fontDpr !== dpr) { fontDpr = dpr; font = `700 ${Math.round(6.5 * dpr)}px system-ui, sans-serif`; }
    ctx.font = font;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (let i = 0; i < wpN; i++) {
      const x = wpU[i] * W_, y = wpV[i] * H_;
      ctx.fillStyle = css;
      ctx.strokeStyle = ink;
      ctx.lineWidth = 1 * dpr;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = ink;
      ctx.fillText(LABELS[i], x, y + 0.3 * dpr);
    }
  }

  return {
    el: wrap,
    setSize,

    /** Tour waypoints [{x, y}] of the selected part. */
    setWaypoints(list) {
      wpN = Math.min(MAX_WP, Array.isArray(list) ? list.length : 0);
      for (let i = 0; i < wpN; i++) { wpU[i] = list[i].x; wpV[i] = list[i].y; }
    },

    /** Sequencer steps [{lock, lx, ly}] of the selected part. */
    setLocks(steps) {
      for (let i = 0; i < MAX_LOCKS; i++) {
        const st = Array.isArray(steps) ? steps[i] : null;
        lkOn[i] = st && st.lock ? 1 : 0;
        if (lkOn[i]) { lkU[i] = st.lx; lkV[i] = st.ly; }
      }
    },

    /** What to show this frame: the route (unwrapped u, v pairs) and whether waypoints / locks are visible. */
    setMarkers(routeUV, n, waypointsOn, locksOn) {
      route = routeUV; routeN = n; showWp = !!waypointsOn; showLocks = !!locksOn;
    },

    /** Rebuild the terrain image (call when the land changes, a few times a second at most). */
    renderTerrain(hf, ramp, tint, tintAmt, sun) {
      const d = imageData.data;
      const n = IMG_RES;
      const e = 1 / n;
      const pl = Math.max(0.04, 0.2126 * tint[0] + 0.7152 * tint[1] + 0.0722 * tint[2]);
      const lx = sun[0], lz = sun[2];
      const ll = Math.hypot(lx, lz) || 1;
      // One height lookup per pixel; slopes come from the neighbouring pixel
      // (the terrain tiles, so the grid wraps). Cheap enough to run every frame.
      for (let j = 0; j < n; j++) {
        const v = (j + 0.5) / n;
        for (let i = 0; i < n; i++) grid[j * n + i] = hf.ready ? hf.norm((i + 0.5) / n, v) : 0;
      }
      const sk = 0.035 / ll * hf.lift / e;
      for (let j = 0; j < n; j++) {
        const jn = j === n - 1 ? 0 : j + 1;
        for (let i = 0; i < n; i++) {
          const h = grid[j * n + i];
          sampleRamp(ramp, h * 0.5 + 0.5, col);
          const lum = 0.2126 * col[0] + 0.7152 * col[1] + 0.0722 * col[2];
          const k = tintAmt * (0.35 + 0.65 * (h * 0.5 + 0.5));
          let r = col[0] + (lum * tint[0] / pl - col[0]) * k;
          let g = col[1] + (lum * tint[1] / pl - col[1]) * k;
          let b = col[2] + (lum * tint[2] / pl - col[2]) * k;
          // simple hill shade from the sun's horizontal direction
          const gx = grid[j * n + (i === n - 1 ? 0 : i + 1)] - h;
          const gz = grid[jn * n + i] - h;
          const shade = Math.max(0.55, Math.min(1.25, 1 - sk * (gx * lx + gz * lz)));
          r *= shade; g *= shade; b *= shade;
          const o = (j * n + i) * 4;
          d[o] = Math.round(linearToSrgb(r) * 255);
          d[o + 1] = Math.round(linearToSrgb(g) * 255);
          d[o + 2] = Math.round(linearToSrgb(b) * 255);
          d[o + 3] = 255;
        }
      }
      pctx.clearRect(0, 0, IMG_RES, IMG_RES);
      pctx.drawImage(img, 0, 0);
      const t = performance.now();
      havePrev = imgAt > -Infinity;
      // fade over the gap between renders: instant when rebuilt every frame, smooth when spaced out
      fadeMs = havePrev ? Math.min(TERRAIN_FADE_MS, t - imgAt) : 0;
      ictx.putImageData(imageData, 0, 0);
      imgAt = t;
    },

    /**
     * Draw one frame. uvs: unwrapped path (u, v) pairs, count points; dot and
     * ghost in [0, 1); camAz: camera azimuth in radians (0 = looking towards -z).
     */
    draw(uvs, count, closed, dotU, dotV, ghostU, ghostV, ghostA, css, camAz, themeT) {
      const W_ = canvas.width, H_ = canvas.height;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.imageSmoothingEnabled = true;
      const fade = havePrev && fadeMs > 0 ? Math.min(1, (performance.now() - imgAt) / fadeMs) : 1;
      if (fade < 1) {
        ctx.drawImage(prev, 0, 0, W_, H_);
        ctx.globalAlpha = fade;
        ctx.drawImage(img, 0, 0, W_, H_);
        ctx.globalAlpha = 1;
      } else ctx.drawImage(img, 0, 0, W_, H_);

      // Orbit, drawn at each periodic copy that touches the map.
      if (count > 1) {
        let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
        for (let i = 0; i < count; i++) {
          const u = uvs[2 * i], v = uvs[2 * i + 1];
          if (u < minU) minU = u; if (u > maxU) maxU = u;
          if (v < minV) minV = v; if (v > maxV) maxV = v;
        }
        ctx.lineJoin = 'round';
        ctx.lineCap = 'round';
        const step = count > 256 ? 2 : 1;
        for (let pass = 0; pass < 2; pass++) {
          ctx.strokeStyle = pass === 0 ? (themeT > 0.5 ? 'rgba(255,255,255,0.7)' : 'rgba(0,0,0,0.55)') : css;
          ctx.lineWidth = (pass === 0 ? 3.2 : 1.6) * dpr;
          for (let oy = -1; oy <= 1; oy++) {
            if (maxV + oy < 0 || minV + oy > 1) continue;
            for (let ox = -1; ox <= 1; ox++) {
              if (maxU + ox < 0 || minU + ox > 1) continue;
              ctx.beginPath();
              for (let i = 0; i < count; i += step) {
                const x = (uvs[2 * i] + ox) * W_, y = (uvs[2 * i + 1] + oy) * H_;
                if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
              }
              if (closed) ctx.closePath();
              ctx.stroke();
            }
          }
        }
      }

      // Camera heading: a soft wedge from the map centre.
      const cx = W_ / 2, cy = H_ / 2;
      const dirx = -Math.sin(camAz), diry = -Math.cos(camAz);
      const gkey = W_ * 2 + (themeT > 0.5 ? 1 : 0);
      if (gkey !== wedgeKey) {
        wedgeKey = gkey;
        wedge = ctx.createRadialGradient(cx, cy, 0, cx, cy, W_ * 0.42);
        wedge.addColorStop(0, themeT > 0.5 ? 'rgba(60,40,20,0.20)' : 'rgba(255,255,255,0.16)');
        wedge.addColorStop(1, 'rgba(255,255,255,0)');
      }
      ctx.fillStyle = wedge;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      const a0 = Math.atan2(diry, dirx);
      ctx.arc(cx, cy, W_ * 0.42, a0 - 0.45, a0 + 0.45);
      ctx.closePath();
      ctx.fill();

      if (ghostA > 0.01) {
        GHOST_DASH[0] = GHOST_DASH[1] = 2 * dpr;
        ctx.setLineDash(GHOST_DASH);
        ctx.strokeStyle = css;
        ctx.globalAlpha = ghostA;
        ctx.lineWidth = 1.2 * dpr;
        ctx.beginPath();
        ctx.arc(ghostU * W_, ghostV * H_, 3.5 * dpr, 0, Math.PI * 2);
        ctx.stroke();
        ctx.setLineDash(NO_DASH);
        ctx.globalAlpha = 1;
      }
      drawMarkers(W_, H_, css, themeT);
      // Dot with a contrasting ring.
      ctx.fillStyle = css;
      ctx.strokeStyle = themeT > 0.5 ? '#ffffff' : 'rgba(10,14,25,0.9)';
      ctx.lineWidth = 1.6 * dpr;
      ctx.beginPath();
      ctx.arc(dotU * W_, dotV * H_, 4.2 * dpr, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    },

    get pressed() { return pressed; },

    dispose() { wrap.remove(); },
  };
}

/** Pointer readout and keyboard focus ring. */
export function createOverlay(container) {
  const readout = el('div', 'og-hud-readout',
    'position:absolute;left:0;top:0;z-index:4;pointer-events:none;padding:3px 7px;border-radius:6px;' +
    'font:11px/1.3 var(--font-mono, ui-monospace, monospace);color:var(--text, #e8ecf6);' +
    'background:var(--glass-strong, rgba(10,14,25,0.82));border:1px solid var(--border, rgba(148,166,214,0.11));' +
    'white-space:nowrap;opacity:0;transition:opacity 120ms;will-change:transform;');
  readout.setAttribute('aria-hidden', 'true');
  const focus = el('div', 'og-hud-focus',
    'position:absolute;inset:0;z-index:1;pointer-events:none;border-radius:inherit;opacity:0;' +
    'box-shadow:inset 0 0 0 2px var(--focus, #a6c5ff);transition:opacity 120ms;');
  container.append(focus, readout);
  let shown = false;
  let lastText = '';

  return {
    readout,
    focus,
    show(x, y, text) {
      if (text !== lastText) { readout.textContent = text; lastText = text; }
      const w = container.clientWidth;
      const ox = x + 16 + 130 > w ? x - 140 : x + 16;
      readout.style.transform = `translate(${Math.round(ox)}px, ${Math.round(y + 14)}px)`;
      if (!shown) { readout.style.opacity = '1'; shown = true; }
    },
    hide() {
      if (shown) { readout.style.opacity = '0'; shown = false; }
    },
    setFocus(on) { focus.style.opacity = on ? '1' : '0'; },
    dispose() { readout.remove(); focus.remove(); },
  };
}
