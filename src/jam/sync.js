// What the jam layer may send, and how a guest keeps their own session.

export const JAM_HISTORY_SOURCE = 'jam';
export const SOURCES_IGNORED = Object.freeze(['jam']);

const SKIP = new Set(['seq', 'preview', 'ghost', 'jam']);

/** Live playing only. Sequencer, preview, ghost and jam notes are not sent. */
export function shouldSendSched(source) {
  return !!source && !SKIP.has(source);
}

/** Play a remote note on the engine, not the router (chords and the arp would run twice). */
export function remoteNoteCall(msg, partIndex) {
  return [partIndex, msg.n, msg.v, msg.time, 'jam'];
}

/** While you are a guest, keep writing the session you had before you joined. */
export function guardAutosave(isGuest, preJoinSnapshot, next) {
  return isGuest ? preJoinSnapshot : next;
}

/**
 * After an undo, put back tracks this person does not own.
 * `remote` is { trackId: partObject }.
 */
export function reapplyUnowned(store, ownedIds, remote) {
  const own = new Set(ownedIds || []);
  const parts = store.get('parts') || [];
  parts.forEach((p, i) => {
    if (!p || own.has(p.id) || !remote || !remote[p.id]) return;
    store.set(`parts.${i}`, remote[p.id], { source: 'jam' });
  });
}
