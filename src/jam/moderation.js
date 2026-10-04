// Host moderation and a person's own local block. Moderation is enforced
// again by the host relay. A local block only changes this computer.

const MOD = new Set(['muteMic', 'unmuteMic', 'muteChat', 'unmuteChat', 'remove', 'ban', 'lock', 'unlock', 'clearChat', 'reclaim', 'makeMod', 'unmakeMod', 'giveTrack', 'handGlobal']);

export function createModeration() {
  let locked = false;
  const banned = new Set();
  const chatMuted = new Set();
  const micMuted = new Set();
  const mods = new Set();
  const local = new Set();
  const roles = new Map();

  function role(id) { return id === 'h' ? 'owner' : (mods.has(id) ? 'mod' : 'member'); }
  function staff(id) { return role(id) === 'owner' || role(id) === 'mod'; }

  return {
    role,
    locked: () => locked,
    isBanned: (fp) => !!(fp && banned.has(fp)),
    chatMuted: (id) => chatMuted.has(id),
    micMuted: (id) => micMuted.has(id),
    localBlocked: (id) => local.has(id),
    localBlock(id, on = true) { if (on) local.add(id); else local.delete(id); },
    act(by, action, { target, fp, track } = {}) {
      if (!MOD.has(action) || !staff(by)) return { ok: false, reason: 'role' };
      if (action === 'lock') locked = true;
      else if (action === 'unlock') locked = false;
      else if (action === 'muteChat' && target) chatMuted.add(target);
      else if (action === 'unmuteChat' && target) chatMuted.delete(target);
      else if (action === 'muteMic' && target) micMuted.add(target);
      else if (action === 'unmuteMic' && target) micMuted.delete(target);
      else if (action === 'ban' && fp) banned.add(fp);
      else if (action === 'makeMod' && target && target !== 'h') mods.add(target);
      else if (action === 'unmakeMod' && target) mods.delete(target);
      else if (action === 'remove' || action === 'clearChat' || action === 'reclaim' || action === 'giveTrack' || action === 'handGlobal') {
        /* the relay performs the side effect; this records that it was allowed */
      } else if (action !== 'ban') return { ok: false, reason: 'missing' };
      roles.set(by, role(by));
      return { ok: true, kind: action, by, target, fp, track };
    },
  };
}
