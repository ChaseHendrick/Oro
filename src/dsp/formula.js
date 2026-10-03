// Formula terrains (v2.3): type a height z = f(x, y) and the land is built
// from it. A small hand-written parser (no eval, no access to anything but
// maths): numbers, the variables below, + - * / % ^, unary minus,
// comparisons (< > <= >= give 1 or 0) and the functions in FUNCS.
//
//   x, y   position, -1 to 1 across the tile
//   r, th  distance from the centre and angle (radians)
//   t      0 for terrain A and 1 for terrain B when a formula fills both, so
//          Morph animates it
//   pi, e  constants

const FUNCS = {
  sin: [1, Math.sin], cos: [1, Math.cos], tan: [1, Math.tan], asin: [1, Math.asin], acos: [1, Math.acos],
  atan: [1, Math.atan], atan2: [2, Math.atan2], sinh: [1, Math.sinh], cosh: [1, Math.cosh], tanh: [1, Math.tanh],
  abs: [1, Math.abs], sqrt: [1, Math.sqrt], cbrt: [1, Math.cbrt], exp: [1, Math.exp], log: [1, Math.log],
  floor: [1, Math.floor], ceil: [1, Math.ceil], round: [1, Math.round], sign: [1, Math.sign],
  fract: [1, (a) => a - Math.floor(a)], min: [2, Math.min], max: [2, Math.max], pow: [2, Math.pow],
  mod: [2, (a, b) => a - b * Math.floor(a / b)], hypot: [2, Math.hypot],
  clamp: [3, (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v)], mix: [3, (a, b, k) => a + (b - a) * k],
  step: [2, (edge, v) => (v < edge ? 0 : 1)],
  smoothstep: [3, (a, b, v) => { const k = Math.min(1, Math.max(0, (v - a) / (b - a || 1e-9))); return k * k * (3 - 2 * k); }],
  noise: [2, valueNoise],
};
const VARS = ['x', 'y', 'r', 'th', 't'];
const CONSTS = { pi: Math.PI, e: Math.E, tau: 2 * Math.PI };
export const FORMULA_FUNCTIONS = Object.keys(FUNCS);
export const FORMULA_MAX_LENGTH = 400;

export const FORMULA_EXAMPLES = Object.freeze([
  { name: 'Ripples', src: 'sin(12*r - 3*t) / (1 + 4*r)' },
  { name: 'Egg crate', src: 'sin(6*x) * cos(6*y)' },
  { name: 'Saddle', src: 'x*x - y*y' },
  { name: 'Spiral', src: 'sin(5*th + 14*r)' },
  { name: 'Terraces', src: 'floor(6*noise(3*x, 3*y)) / 6' },
  { name: 'Interference', src: 'sin(20*hypot(x-0.4, y)) + sin(20*hypot(x+0.4, y))' },
]);

/** Deterministic smooth value noise, about -1..1. */
function hash(i, j) {
  let h = (Math.imul(i | 0, 374761393) + Math.imul(j | 0, 668265263)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295 * 2 - 1;
}
function valueNoise(x, y) {
  const i = Math.floor(x), j = Math.floor(y), fx = x - i, fy = y - j;
  const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
  const a = hash(i, j), b = hash(i + 1, j), c = hash(i, j + 1), d = hash(i + 1, j + 1);
  return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
}

function tokenize(src) {
  const out = [];
  const re = /\s*(?:(\d+\.?\d*(?:e[+-]?\d+)?|\.\d+(?:e[+-]?\d+)?)|([a-z_][a-z0-9_]*)|(<=|>=|[-+*/%^(),<>]))/iy;
  let pos = 0;
  while (pos < src.length) {
    if (/^\s*$/.test(src.slice(pos))) break;
    re.lastIndex = pos;
    const m = re.exec(src);
    if (!m) throw new Error(`Unexpected "${src.slice(pos).trim()[0]}" at position ${pos + 1}`);
    if (m[1] !== undefined) out.push({ k: 'num', v: parseFloat(m[1]) });
    else if (m[2] !== undefined) out.push({ k: 'id', v: m[2].toLowerCase() });
    else out.push({ k: 'op', v: m[3] });
    pos = re.lastIndex;
  }
  return out;
}

/**
 * Compile a formula to a function (x, y, r, th, t) -> number. Throws an
 * Error with a readable message when the formula is not valid.
 */
export function compileFormula(src) {
  if (typeof src !== 'string' || !src.trim()) throw new Error('Type a formula, for example sin(6*x) * cos(6*y)');
  if (src.length > FORMULA_MAX_LENGTH) throw new Error(`A formula can be at most ${FORMULA_MAX_LENGTH} characters`);
  const toks = tokenize(src);
  let i = 0;
  const peek = () => toks[i], take = () => toks[i++];
  const isOp = (v) => toks[i] && toks[i].k === 'op' && toks[i].v === v;
  const expect = (v) => { if (!isOp(v)) throw new Error(`Expected "${v}"`); i++; };
  const BIN = { '<': 1, '>': 1, '<=': 1, '>=': 1, '+': 2, '-': 2, '*': 3, '/': 3, '%': 3, '^': 5 };
  const OPF = {
    '<': (a, b) => (a < b ? 1 : 0), '>': (a, b) => (a > b ? 1 : 0), '<=': (a, b) => (a <= b ? 1 : 0), '>=': (a, b) => (a >= b ? 1 : 0),
    '+': (a, b) => a + b, '-': (a, b) => a - b, '*': (a, b) => a * b, '/': (a, b) => a / b,
    '%': (a, b) => a - b * Math.floor(a / b), '^': (a, b) => Math.pow(a, b),
  };
  function primary() {
    const tk = take();
    if (!tk) throw new Error('The formula ends too early');
    if (tk.k === 'num') { const v = tk.v; return () => v; }
    if (tk.k === 'op' && tk.v === '(') { const e = expr(0); expect(')'); return e; }
    if (tk.k === 'op' && tk.v === '-') { const e = expr(4); return (s) => -e(s); }
    if (tk.k === 'op' && tk.v === '+') return expr(4);
    if (tk.k === 'id') {
      const name = tk.v;
      if (isOp('(')) {
        const f = Object.hasOwn(FUNCS, name) ? FUNCS[name] : null;
        if (!f) throw new Error(`Unknown function "${name}"`);
        i++;
        const args = [];
        if (!isOp(')')) { args.push(expr(0)); while (isOp(',')) { i++; args.push(expr(0)); } }
        expect(')');
        if (args.length !== f[0]) throw new Error(`${name}() takes ${f[0]} value${f[0] === 1 ? '' : 's'}`);
        const fn = f[1];
        if (args.length === 1) { const a = args[0]; return (s) => fn(a(s)); }
        if (args.length === 2) { const [a, b] = args; return (s) => fn(a(s), b(s)); }
        const [a, b, c] = args; return (s) => fn(a(s), b(s), c(s));
      }
      const vi = VARS.indexOf(name);
      if (vi >= 0) return (s) => s[vi];
      if (Object.hasOwn(CONSTS, name)) { const v = CONSTS[name]; return () => v; }
      throw new Error(`Unknown name "${name}". Use x, y, r, th, t or a function`);
    }
    throw new Error(`Unexpected "${tk.v}"`);
  }
  function expr(minPrec) {
    let left = primary();
    for (;;) {
      const tk = peek();
      if (!tk || tk.k !== 'op' || !(tk.v in BIN)) break;
      const prec = BIN[tk.v];
      if (prec < minPrec) break;
      i++;
      const right = expr(tk.v === '^' ? prec : prec + 1);     // ^ is right-associative
      const f = OPF[tk.v], l = left;
      left = (s) => f(l(s), right(s));
    }
    return left;
  }
  const root = expr(0);
  if (i < toks.length) throw new Error(`Unexpected "${toks[i].v}"`);
  const st = new Float64Array(5);
  return (x, y, r, th, t) => { st[0] = x; st[1] = y; st[2] = r; st[3] = th; st[4] = t; return root(st); };
}

/**
 * Evaluate a formula on an n x n grid (x, y from -1 to 1) at time t.
 * Returns heights (non-finite results become 0) and whether the result
 * is flat.
 */
export function formulaHeights(src, n = 512, t = 0) {
  const f = compileFormula(src);
  const out = new Float32Array(n * n);
  let lo = Infinity, hi = -Infinity;
  for (let j = 0; j < n; j++) {
    const y = (j + 0.5) / n * 2 - 1;
    for (let i = 0; i < n; i++) {
      const x = (i + 0.5) / n * 2 - 1;
      let v = f(x, y, Math.hypot(x, y), Math.atan2(y, x), t);
      if (!Number.isFinite(v)) v = 0;
      out[j * n + i] = v;
      if (v < lo) lo = v; if (v > hi) hi = v;
    }
  }
  return { heights: out, flat: !(hi - lo > 1e-9) };
}
