// ADSR graph. The shape mirrors the knob positions (segment widths follow the
// knobs' normalised travel, so a short attack is still visible), eases to new
// shapes instead of jumping, and a bead follows the envelope of the notes you
// play on the selected part.

import { PART_PARAM_MAP, toNorm, clamp } from '../core/params.js';
import { s, createScope } from './dom.js';
import { schedule, addLoop } from './frame.js';
import { prefersReducedMotion } from './dom.js';

const W = 220, H = 74, PAD = 5;

/** Geometry of the graph for given ADSR values: points for each corner. */
export function envGeometry({ a, d, s: sus, r }, defs) {
  const na = toNorm(defs.a, a), nd = toNorm(defs.d, d), nr = toNorm(defs.r, r);
  const usable = W - PAD * 2;
  const wa = 0.04 + na * 0.26, wd = 0.04 + nd * 0.26, wr = 0.04 + nr * 0.26;
  const ws = 0.18;
  const total = wa + wd + ws + wr;
  const k = usable / Math.max(total, 1);
  const x0 = PAD, x1 = x0 + wa * k, x2 = x1 + wd * k, x3 = x2 + ws * k, x4 = x3 + wr * k;
  const top = PAD + 2, bottom = H - PAD;
  const ys = bottom - (bottom - top) * clamp(sus, 0, 1);
  return { x0, x1, x2, x3, x4, top, bottom, ys };
}

function shapePath(g) {
  // Attack bows upward slightly; decay and release are exponential-looking curves.
  return [
    `M${g.x0} ${g.bottom}`,
    `C${g.x0 + (g.x1 - g.x0) * 0.35} ${g.top + (g.bottom - g.top) * 0.25} ${g.x1 - (g.x1 - g.x0) * 0.25} ${g.top} ${g.x1} ${g.top}`,
    `C${g.x1 + (g.x2 - g.x1) * 0.25} ${g.ys} ${g.x1 + (g.x2 - g.x1) * 0.45} ${g.ys} ${g.x2} ${g.ys}`,
    `L${g.x3} ${g.ys}`,
    `C${g.x3 + (g.x4 - g.x3) * 0.25} ${g.bottom} ${g.x3 + (g.x4 - g.x3) * 0.45} ${g.bottom} ${g.x4} ${g.bottom}`,
  ].join(' ');
}

/** Envelope level and graph x for a note held `held` seconds, released `rel` seconds ago. */
export function envAt(vals, held, rel, releaseLevel) {
  const { a, d, s: sus, r } = vals;
  if (rel == null) {
    if (held < a) return { level: held / Math.max(a, 1e-4), stage: 'a', frac: held / Math.max(a, 1e-4) };
    const t = held - a;
    if (t < d) {
      const f = t / Math.max(d, 1e-4);
      return { level: sus + (1 - sus) * Math.exp(-4 * f) * (1 - f * 0.02), stage: 'd', frac: f };
    }
    return { level: sus, stage: 's', frac: Math.min(1, (t - d) / 1.5) };
  }
  const f = rel / Math.max(r, 1e-4);
  if (f >= 1) return { level: 0, stage: 'off', frac: 1 };
  return { level: releaseLevel * Math.exp(-4 * f) * (1 - f), stage: 'r', frac: f };
}

export function createEnvGraph(ctx, { ids, label }) {
  const scope = createScope();
  const defs = { a: PART_PARAM_MAP[ids[0]], d: PART_PARAM_MAP[ids[1]], s: PART_PARAM_MAP[ids[2]], r: PART_PARAM_MAP[ids[3]] };
  const gradId = 'envg-' + ids[0];
  const area = s('path', { class: 'env-area', fill: `url(#${gradId})` });
  const line = s('path', { class: 'env-line' });
  const guides = s('g', { class: 'env-guides' });
  const bead = s('circle', { class: 'env-bead', r: 3.4, cx: -10, cy: -10 });
  const svg = s('svg', { class: 'env-graph', viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': label },
    s('defs', null, s('linearGradient', { id: gradId, x1: 0, y1: 0, x2: 0, y2: 1 },
      s('stop', { offset: '0%', class: 'env-stop-a' }), s('stop', { offset: '100%', class: 'env-stop-b' }))),
    s('path', { class: 'env-base', d: `M${PAD} ${H - PAD}H${W - PAD}` }), guides, area, line, bead);

  const vals = () => {
    const p = ctx.store.get(`parts.${ctx.binder.selected()}.params`) || {};
    return { a: p[ids[0]] ?? defs.a.default, d: p[ids[1]] ?? defs.d.default, s: p[ids[2]] ?? defs.s.default, r: p[ids[3]] ?? defs.r.default };
  };

  let shown = null; // geometry currently drawn (animated towards target)
  let target = null;
  let animating = false;

  function draw(g) {
    const d = shapePath(g);
    line.setAttribute('d', d);
    area.setAttribute('d', `${d} L${g.x4} ${g.bottom} L${g.x0} ${g.bottom} Z`);
    guides.innerHTML = '';
    for (const x of [g.x1, g.x2, g.x3]) guides.appendChild(s('path', { d: `M${x.toFixed(1)} ${g.top}V${g.bottom}` }));
  }

  function update() {
    target = envGeometry(vals(), defs);
    if (!shown || prefersReducedMotion()) { shown = { ...target }; draw(shown); return; }
    if (!animating) {
      animating = true;
      const stop = addLoop(() => {
        let done = true;
        for (const k of Object.keys(target)) {
          const dv = target[k] - shown[k];
          if (Math.abs(dv) > 0.05) { shown[k] += dv * 0.3; done = false; } else shown[k] = target[k];
        }
        draw(shown);
        if (done) { animating = false; stop(); }
      });
    }
  }

  // Follow played notes on the selected part to animate the bead.
  let held = 0, onAt = 0, offAt = null, relLevel = 0, beadLoop = null;
  function beadFrame() {
    const g = shown || target;
    if (!g) return;
    const v = vals();
    const now = performance.now() / 1000;
    const st = offAt == null ? envAt(v, now - onAt, null, 0) : envAt(v, now - onAt, now - offAt, relLevel);
    if (st.stage === 'off') { bead.setAttribute('cx', -10); svg.classList.remove('is-playing'); beadLoop(); beadLoop = null; return; }
    let x;
    if (st.stage === 'a') x = g.x0 + (g.x1 - g.x0) * st.frac;
    else if (st.stage === 'd') x = g.x1 + (g.x2 - g.x1) * st.frac;
    else if (st.stage === 's') x = g.x2 + (g.x3 - g.x2) * st.frac;
    else x = g.x3 + (g.x4 - g.x3) * st.frac;
    const y = g.bottom - (g.bottom - g.top) * clamp(st.level, 0, 1);
    bead.setAttribute('cx', x.toFixed(1));
    bead.setAttribute('cy', y.toFixed(1));
    if (offAt == null) relLevel = st.level;
  }
  if (ctx.notes) {
    scope.add(ctx.notes.on(({ part, on }) => {
      if (part !== ctx.binder.selected()) return;
      const now = performance.now() / 1000;
      if (on) {
        if (held === 0 || offAt != null) { onAt = now; offAt = null; }
        held += 1;
      } else {
        held = Math.max(0, held - 1);
        if (held === 0) offAt = now;
      }
      svg.classList.add('is-playing');
      if (!beadLoop) beadLoop = addLoop(beadFrame);
    }));
  }
  scope.add(() => { if (beadLoop) beadLoop(); });

  for (const id of ids) scope.add(ctx.binder.partParam(id).subscribe(() => schedule(update)));
  update();
  return { el: svg, dispose: scope.dispose };
}
