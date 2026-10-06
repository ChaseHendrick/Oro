import { describe, it, expect } from 'vitest';
import { HeightField } from '../../src/visual/heightfield.js';
import { createPhysics, cruisePush, cruiseSpeed, MODE_ROLL, torusDistance } from '../../src/visual/physics.js';

// Rolling hills: a basin every tile, so a marble left alone settles in one.
function hills() {
  const size = 128, d = new Float32Array(size * size);
  for (let j = 0; j < size; j++) for (let i = 0; i < size; i++) d[j * size + i] = 0.5 * (Math.cos(2 * Math.PI * i / size) + Math.cos(2 * Math.PI * j / size));
  const hf = new HeightField();
  hf.setTable('A', d, size);
  hf.setShape(0, 0, 0.6);
  return hf;
}

describe('Roll > Keep rolling (2.17)', () => {
  it('pushes along the heading only while the marble is slower than its cruise speed', () => {
    const out = { x: 0, z: 0 };
    cruisePush(0, 1, 0, 0.5, 9.81, out);
    expect(out.x).toBeGreaterThan(0);
    expect(out.z).toBe(0);
    cruisePush(cruiseSpeed(0.5) + 1, 1, 0, 0.5, 9.81, out);
    expect(out.x).toBe(0);                    // never a brake
    cruisePush(0, 0, 1, 0, 9.81, out);
    expect(out.z).toBe(0);                    // off at 0
  });

  it('keeps a marble travelling over the hills instead of settling in a valley', () => {
    const fields = [hills(), hills()];
    const ph = createPhysics({ fieldFor: (p) => fields[p], rapier: false, parts: 2 });
    for (const p of [0, 1]) {
      ph.setParams(p, { gravity: 0.5, friction: 0.4, cruise: p === 1 ? 0.7 : 0 });
      ph.setMode(p, MODE_ROLL, 0.42, 0.5);
      ph.release(p, 3, 0);                    // a flick to the east aims Keep rolling
    }
    const start = [ph.state(0), ph.state(1)].map((s) => ({ u: s.u, v: s.v }));
    let travelled = 0, lastU = ph.state(1).u;
    for (let i = 0; i < 60 * 12; i++) {
      ph.step(1 / 60);
      const u = ph.state(1).u;
      let du = u - lastU; du -= Math.round(du);
      travelled += du; lastU = u;
    }
    // the plain marble ends up resting in a basin; the cruising one has crossed several tiles east
    expect(Math.hypot(ph.state(0).vx, ph.state(0).vz)).toBeLessThan(0.2);
    expect(travelled).toBeGreaterThan(2);
    expect(torusDistance(start[0].u, start[0].v, ph.state(0).u, ph.state(0).v)).toBeLessThan(0.5);
  });
});
