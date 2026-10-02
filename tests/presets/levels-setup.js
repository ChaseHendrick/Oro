// How each patch category is auditioned for the level check, and the loudness
// each category aims for (loudest 400 ms window, dBFS RMS of the dry output).
// Percussive sounds aim a little lower: they read as louder than their RMS.

const PHRASES = {
  Bass: [[36, 0, 0.45], [43, 0.5, 0.95], [38, 1.0, 1.45]],
  Lead: [[64, 0, 0.55], [67, 0.6, 1.15], [69, 1.2, 1.5]],
  Pad: [[57, 0, 1.5], [60, 0, 1.5], [64, 0, 1.5]],
  Keys: [[57, 0, 1.2], [60, 0, 1.2], [64, 0, 1.2]],
  Pluck: [[60, 0, 0.2], [64, 0.25, 0.45], [67, 0.5, 0.7], [72, 0.75, 0.95]],
  Bell: [[60, 0, 0.5], [67, 0.5, 1.0]],
  Texture: [[57, 0, 1.5], [64, 0, 1.5]],
  Drone: [[45, 0, 1.5], [52, 0, 1.5]],
  FX: [[60, 0, 0.8]],
  Arp: [[60, 0, 0.12], [64, 0.125, 0.245], [67, 0.25, 0.37], [72, 0.375, 0.495], [67, 0.5, 0.62], [64, 0.625, 0.745], [60, 0.75, 0.87]],
};

export const TARGET = {
  Bass: -24, Lead: -24, Pad: -24, Drone: -24, Texture: -24,
  Keys: -26, Pluck: -27, Bell: -27, Arp: -27, FX: -27,
};

/**
 * Engine messages for auditioning `patch` and the render length. Slow
 * attacks get their phrase stretched so the sound reaches full level.
 */
export function NOTES(patch) {
  const phrase = PHRASES[patch.category] || PHRASES.Keys;
  const attack = (patch.params && patch.params.attack) || 0.005;
  const stretch = Math.max(1, (attack + 1.2) / 1.5);
  const events = [];
  for (const [note, on, off] of phrase) {
    events.push({ t: 'noteOn', part: 0, note, vel: 0.8, time: 0.01 + on * stretch });
    events.push({ t: 'noteOff', part: 0, note, time: 0.01 + off * stretch });
  }
  return { events, length: 1.5 * stretch + 0.5 };
}
