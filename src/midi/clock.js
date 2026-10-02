// MIDI clock in and out.
//
// Clock in: incoming 0xF8 pulses jitter by a millisecond or two over USB, so
// the follower fits a straight line (least squares) through the last couple
// of beats of pulse times. The slope gives a steady tempo and the line gives a
// de-jittered time for the latest pulse, which the transport uses as its
// anchor. A sudden tempo change is detected and the window restarts so it
// catches up within a few pulses rather than two beats.
//
// Clock out: the transport emits 'clock' events (start / tick / stop) with
// AudioContext times; the sender turns them into bytes with matching
// performance.now() timestamps.

export const PPQ = 24;
export const CLOCK = 0xf8;
export const START = 0xfa;
export const CONTINUE = 0xfb;
export const STOP = 0xfc;
export const SONG_POSITION = 0xf2;

const WINDOW = 48;            // pulses in the regression (two beats)
const GAP_RESET_MS = 400;     // a pause this long means the clock stopped: start a fresh window
const JUMP = 0.2;             // a pulse interval 20% off the fit counts as a tempo jump...
const JUMP_COUNT = 3;         // ...when it happens this many times in a row

export function createClockFollower() {
  let points = [];            // [pulseNo, perfMs]
  let pulseNo = 0;
  let position = 0;           // pulses since song start (musical position of the next pulse)
  let running = false;
  let lastPulseMs = -Infinity;
  let slope = 0;              // ms per pulse
  let smoothBpm = 0;
  let jumpRun = 0;

  function fit() {
    const n = points.length;
    if (n < 2) return null;
    let si = 0, st = 0;
    for (const [i, t] of points) { si += i; st += t; }
    const mi = si / n, mt = st / n;
    let num = 0, den = 0;
    for (const [i, t] of points) { num += (i - mi) * (t - mt); den += (i - mi) * (i - mi); }
    if (den <= 0) return null;
    const s = num / den;
    return { slope: s, at: (i) => mt + s * (i - mi) };
  }

  /** One 0xF8 pulse received at performance time `ms`. Returns the tick info. */
  function pulse(ms) {
    if (ms - lastPulseMs > GAP_RESET_MS) { points = []; jumpRun = 0; }
    if (slope > 0 && points.length >= 4) {
      const dt = ms - lastPulseMs;
      if (Math.abs(dt - slope) > slope * JUMP) jumpRun++;
      else jumpRun = 0;
      if (jumpRun >= JUMP_COUNT) { points = points.slice(-JUMP_COUNT); jumpRun = 0; }
    }
    lastPulseMs = ms;
    pulseNo++;
    points.push([pulseNo, ms]);
    if (points.length > WINDOW) points.shift();
    const f = fit();
    let time = ms;
    if (f && f.slope > 0) {
      slope = f.slope;
      // Only trust the fitted time once the window holds a few pulses.
      if (points.length >= 6) time = f.at(pulseNo);
      const bpm = 60000 / (slope * PPQ);
      smoothBpm = smoothBpm ? smoothBpm + (bpm - smoothBpm) * 0.25 : bpm;
    }
    const beat = position / PPQ;
    if (running) position++;
    return { beat, time, bpm: slope > 0 ? 60000 / (slope * PPQ) : 0, running };
  }

  return {
    pulse,
    start() { position = 0; running = true; },
    continue() { running = true; },
    stop() { running = false; },
    /** Song Position Pointer, in MIDI beats (16th notes). */
    songPosition(sixteenths) { position = Math.max(0, sixteenths) * 6; },
    reset() { points = []; slope = 0; smoothBpm = 0; lastPulseMs = -Infinity; running = false; position = 0; jumpRun = 0; },
    get running() { return running; },
    get position() { return position; },
    /** Tempo from the fit (fast) and a smoothed version for display. */
    bpm() { return slope > 0 ? 60000 / (slope * PPQ) : 0; },
    displayBpm() { return Math.round(smoothBpm * 10) / 10; },
    active(nowMs) { return nowMs - lastPulseMs < 500; },
    lastPulseMs: () => lastPulseMs,
  };
}

/** Bytes for a transport clock event. */
export function clockBytes(type) {
  switch (type) {
    case 'start': return [START];
    case 'stop': return [STOP];
    case 'continue': return [CONTINUE];
    case 'tick': return [CLOCK];
    default: return null;
  }
}

/** Parse a Song Position Pointer message into 16th notes. */
export function parseSongPosition(data) {
  return ((data[2] & 0x7f) << 7) | (data[1] & 0x7f);
}
