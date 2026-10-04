// Jam together (2.12): splitting large messages into frames a data channel
// can carry (browsers cap a single message at 64 to 256 KB), and putting them
// back together with strict limits.
//
// A message that fits goes as it is (it starts with "{"). A larger one goes
// as frames "~<id>,<index>,<count>," + a slice of the text.

export const FRAME_CHARS = 48 * 1024;

/** Text -> list of frames. `id` tells the frames of one message apart. */
export function splitMessage(text, id, frameChars = FRAME_CHARS) {
  if (text.length <= frameChars) return [text];
  const n = Math.ceil(text.length / frameChars);
  const out = [];
  for (let i = 0; i < n; i++) out.push(`~${id},${i},${n},${text.slice(i * frameChars, (i + 1) * frameChars)}`);
  return out;
}

/**
 * Reassembler. push(frame) -> the whole message text when complete, else
 * null. A frame that breaks the rules (unknown shape, out of order, a
 * message larger than `maxChars`, too many messages at once) is dropped along
 * with the message it belongs to.
 */
export function createAssembler({ maxChars = 1024 * 1024, maxOpen = 4, frameChars = FRAME_CHARS } = {}) {
  const open = new Map();   // id -> { n, next, parts, size }
  let dropped = 0;
  function drop(id) { if (id != null) open.delete(id); dropped++; return null; }
  return {
    push(frame) {
      if (typeof frame !== 'string') return drop(null);
      if (frame[0] !== '~') return frame.length <= maxChars ? frame : drop(null);
      const m = /^~(\d{1,9}),(\d{1,6}),(\d{1,6}),/.exec(frame);
      if (!m) return drop(null);
      const id = m[1], i = Number(m[2]), n = Number(m[3]);
      const body = frame.slice(m[0].length);
      if (n < 2 || i >= n || n * frameChars > maxChars + frameChars || body.length > frameChars) return drop(id);
      let entry = open.get(id);
      if (!entry) {
        if (i !== 0) return drop(id);
        if (open.size >= maxOpen) return drop(id);
        entry = { n, next: 0, parts: [], size: 0 };
        open.set(id, entry);
      }
      if (entry.n !== n || entry.next !== i) return drop(id);
      entry.parts.push(body);
      entry.size += body.length;
      entry.next++;
      if (entry.size > maxChars) return drop(id);
      if (entry.next < n) return null;
      open.delete(id);
      return entry.parts.join('');
    },
    get dropped() { return dropped; },
    get pending() { return open.size; },
    clear() { open.clear(); },
  };
}
