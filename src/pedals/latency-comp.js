// Latency compensation for the pedal loop (v1.1, docs/PEDALS.md). The Ping in
// Settings > Pedals measures the round trip out to the pedals and back; with
// Compensate on, that amount (plus a manual offset) is used two ways:
//
// * Sequenced notes (step sequencer, and the arp while the transport runs) of
//   parts that go through the pedals are sent to the engine earlier by the
//   round trip, so what comes back from the pedals lands on the grid. Step
//   announcements, dot locks and MIDI out stay on the heard (grid) time.
// * Parts in Send mode (Pedal send above 0, Insert off) also have their dry
//   sound, and its delay and reverb sends, delayed by the round trip inside the
//   DSP, so the dry part and its pedal return line up. Together with the early
//   scheduling, a sequenced Send part is on the grid too.
//
// Notes played live (keys, MIDI in, a free-running arp with the transport
// stopped) cannot be sent earlier: an Insert part is heard a round trip late,
// and the dry sound of a Send part is delayed to match its return.
//
// Pure helpers, shared by the rig (src/ui/pedal-rig.js), the router and tests.

/** Largest compensation applied (ms), whatever the ping or the offset say. */
export const MAX_COMP_MS = 500;

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const finite = (v, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

/**
 * Total compensation in ms from the rig settings: the last measured round
 * trip plus the manual offset, 0 when Compensate is off. Without a ping the
 * offset alone is used, so a known latency can be typed in.
 */
export function compensationMs(rig) {
  if (!rig || !rig.compensate) return 0;
  const base = Number.isFinite(rig.lastLatencyMs) ? rig.lastLatencyMs : 0;
  return clamp(base + finite(rig.compOffsetMs), 0, MAX_COMP_MS);
}

/** How a part uses the pedals: 'insert', 'send' (send above 0, not Insert) or null. */
export function pedalMode(params) {
  if (!params) return null;
  if (finite(Number(params.pedalInsert)) >= 0.5) return 'insert';
  if (finite(Number(params.pedalSend)) > 0) return 'send';
  return null;
}

/**
 * Seconds a part's sequenced notes go out early. `active`: the pedal send is
 * really running on its own outputs (otherwise nothing goes through the pedals
 * and nothing moves).
 */
export function partLeadSeconds(params, compMs, active) {
  if (!active || !(compMs > 0)) return 0;
  return pedalMode(params) ? clamp(compMs, 0, MAX_COMP_MS) / 1000 : 0;
}

/** Dry delay for Send mode parts, in samples at `sampleRate` (0 when off). */
export function dryDelaySamples(compMs, sampleRate) {
  if (!(compMs > 0) || !(sampleRate > 0)) return 0;
  return Math.round((clamp(compMs, 0, MAX_COMP_MS) / 1000) * sampleRate);
}
