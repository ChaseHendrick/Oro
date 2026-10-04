// Jam together (2.12): who may change what.
//
// People own tracks; only a track's owner edits it and plays it for the
// others. A track nobody has claimed is free: it stays the host's to edit,
// and anyone can claim it. The global settings (tempo, scale, master
// effects, tuning, the transport) belong to the host unless the host hands
// them to someone. When a person leaves, their tracks become free and global
// control goes back to the host.

import { HOST_ID, isPeerId, isTrackId } from './protocol.js';

export const MAX_TRACKS_EACH = 4;

export function createOwnership() {
  let tracks = new Map();   // track id -> peer id
  let global = HOST_ID;

  const ownerOf = (track) => tracks.get(track) || null;
  return {
    ownerOf,
    get global() { return global; },
    /** May `peer` edit track `track`? (A free track is the host's.) */
    canEditTrack(peer, track) {
      const o = ownerOf(track);
      return o ? o === peer : peer === HOST_ID;
    },
    canEditGlobal: (peer) => peer === global,
    tracksOf: (peer) => [...tracks].filter(([, p]) => p === peer).map(([t]) => t),
    /** Claim a free track that exists. Returns true when it is now theirs. */
    claim(peer, track, exists = () => true) {
      if (!isPeerId(peer) || !isTrackId(track) || !exists(track)) return false;
      if (tracks.has(track)) return tracks.get(track) === peer;
      if (this.tracksOf(peer).length >= MAX_TRACKS_EACH) return false;
      tracks.set(track, peer);
      return true;
    },
    /** Let go of one of your tracks. */
    release(peer, track) {
      if (tracks.get(track) !== peer) return false;
      tracks.delete(track);
      return true;
    },
    /** Give a track to someone (owner and moderators). */
    give(track, peer, exists = () => true) {
      if (!isPeerId(peer) || !isTrackId(track) || !exists(track)) return false;
      tracks.set(track, peer);
      return true;
    },
    /** Make a track free again (owner and moderators). */
    reclaim(track) { return tracks.delete(track); },
    handGlobal(peer) { if (!isPeerId(peer)) return false; global = peer; return true; },
    /** Someone left: their tracks are free, and global control comes back to the host. */
    dropPeer(peer) {
      let changed = false;
      for (const [t, p] of [...tracks]) if (p === peer) { tracks.delete(t); changed = true; }
      if (global === peer) { global = HOST_ID; changed = true; }
      return changed;
    },
    /** Forget tracks that no longer exist. */
    prune(exists) {
      let changed = false;
      for (const t of [...tracks.keys()]) if (!exists(t)) { tracks.delete(t); changed = true; }
      return changed;
    },
    toJSON: () => ({ tracks: Object.fromEntries(tracks), global }),
    /** Replace everything from a (sanitized) owners message. */
    load(o) {
      tracks = new Map(Object.entries((o && o.tracks) || {}).filter(([t, p]) => isTrackId(t) && isPeerId(p)));
      global = o && isPeerId(o.global) ? o.global : HOST_ID;
    },
  };
}
