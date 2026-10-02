// One requestAnimationFrame loop for the whole UI. Components never write the
// DOM straight from store or telemetry callbacks; they mark themselves dirty
// and the write happens here, once per frame, so 60 Hz telemetry and fast knob
// drags never cause layout thrash.

const tasks = new Set();
const loops = new Set();
let handle = 0;

function tick(t) {
  handle = 0;
  if (tasks.size) {
    const run = [...tasks];
    tasks.clear();
    for (const fn of run) {
      try { fn(t); } catch (err) { console.warn('[ui] frame task failed', err); }
    }
  }
  for (const fn of loops) {
    try { fn(t); } catch (err) { console.warn('[ui] frame loop failed', err); }
  }
  if (tasks.size || loops.size) kick();
}

function kick() {
  if (!handle) handle = requestAnimationFrame(tick);
}

/** Run fn once on the next frame (deduplicated by function identity). */
export function schedule(fn) {
  tasks.add(fn);
  kick();
}

/** Run fn every frame until the returned disposer is called. */
export function addLoop(fn) {
  loops.add(fn);
  kick();
  return () => loops.delete(fn);
}
