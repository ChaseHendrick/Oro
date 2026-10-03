// v2.9 Kill screen quirk (Settings > Operator > Quirks): after a track's
// pattern has looped KILL_LOOPS times since Play, its playback starts to
// corrupt. Each pass a few more steps change degree or velocity or drop out.
// The corruption is a pure function of (loops, track, step), so the same run
// always sounds the same, and it only changes the copy the transport plays:
// the stored pattern is never touched. Stop resets the count.

export const KILL_LOOPS = 256;

function hash(a, b, c, salt) {
  let h = (Math.imul(a | 0, 0x9e3779b1) ^ Math.imul((b | 0) + 0x7f4a7c15, 0x85ebca6b) ^ Math.imul((c | 0) + salt, 0xc2b2ae35)) >>> 0;
  h ^= h >>> 16; h = Math.imul(h, 0x7feb352d) >>> 0;
  h ^= h >>> 15; h = Math.imul(h, 0x846ca68b) >>> 0;
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** Share of a pass's steps that go wrong after `loops` passes (0 before KILL_LOOPS). */
export function killChance(loops) {
  if (!(loops >= KILL_LOOPS)) return 0;
  return Math.min(0.5, 0.04 + (loops - KILL_LOOPS) * 0.004);
}

/**
 * The step to play on pass `loops` of track `part`, step `idx`: the step
 * itself, a changed copy, or null (it skips). Never modifies `step`.
 */
export function killStep(step, loops, part, idx) {
  if (!step || !step.on) return step;
  const chance = killChance(loops);
  if (chance <= 0 || hash(loops, part, idx, 1) >= chance) return step;
  const r = hash(loops, part, idx, 2);
  if (r < 0.4) {
    const d = 1 + Math.floor(hash(loops, part, idx, 3) * 3);
    return { ...step, degree: (Number(step.degree) || 0) + (hash(loops, part, idx, 4) < 0.5 ? -d : d) };
  }
  if (r < 0.75) return { ...step, accent: 0, vel: 0.15 + 0.8 * hash(loops, part, idx, 5) };
  return null;
}
