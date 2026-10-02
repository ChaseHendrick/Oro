// Captures tests/dsp/fixtures/reference-v1.f32: the reference scenes rendered
// by the engine as it is NOW. Run it only to re-baseline on purpose (the
// fixture is the "previous engine" the features test compares against):
//   node dev/dsp/capture-reference.mjs
// Layout: for each scene in REF_SCENES order, REF_FRAMES L samples then
// REF_FRAMES R samples, little-endian float32.
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { REF_SCENES, REF_FRAMES, renderScene } from '../../tests/dsp/fixtures/reference-scenes.js';
import { makeDSP, render } from '../../tests/dsp/helpers.js';

const out = new Float32Array(REF_SCENES.length * 2 * REF_FRAMES);
REF_SCENES.forEach((s, i) => {
  const r = renderScene(s, { makeDSP, render });
  out.set(r.L, (2 * i) * REF_FRAMES);
  out.set(r.R, (2 * i + 1) * REF_FRAMES);
  let pk = 0;
  for (let k = 0; k < REF_FRAMES; k++) pk = Math.max(pk, Math.abs(r.L[k]), Math.abs(r.R[k]));
  console.log(`${s.name.padEnd(26)} peak ${pk.toFixed(4)}`);
});
const file = fileURLToPath(new URL('../../tests/dsp/fixtures/reference-v1.f32', import.meta.url));
const bytes = new Uint8Array(out.buffer);
// float32 arrays are little-endian on every platform Node runs on; check anyway
if (new Uint8Array(new Float32Array([1]).buffer)[3] !== 0x3f) throw new Error('big-endian host');
writeFileSync(file, bytes);
console.log('wrote', file, bytes.length, 'bytes');
