// Jam chat. Plain text only. The host relay uses the same rate limit.

import { CHAT_MAX, CHAT_RATE } from './protocol.js';

export function createChat({ now = () => Date.now(), filterOn = false, words = [] } = {}) {
  const log = [];
  const stamps = new Map();
  let unread = 0;
  let on = !!filterOn;
  let list = words.map((w) => String(w).toLowerCase()).filter(Boolean);
  let seq = 1;

  function rateOk(id, t) {
    const prev = (stamps.get(id) || []).filter((x) => t - x < CHAT_RATE.windowMs);
    if (prev.length >= CHAT_RATE.count) { stamps.set(id, prev); return false; }
    prev.push(t);
    stamps.set(id, prev);
    return true;
  }

  return {
    setFilter(flag, nextWords) {
      on = !!flag;
      if (Array.isArray(nextWords)) list = nextWords.map((w) => String(w).toLowerCase()).filter(Boolean);
    },
    post({ from, text, at, system = false, name = '' }) {
      const raw = String(text || '').slice(0, CHAT_MAX);
      if (!raw.trim()) return { ok: false, reason: 'empty' };
      const t = Number.isFinite(at) ? at : now();
      if (!system && !rateOk(from || 'local', t)) return { ok: false, reason: 'rate' };
      if (on && !system) {
        const low = raw.toLowerCase();
        if (list.some((w) => w && low.includes(w))) return { ok: false, reason: 'filter' };
      }
      const mentions = [];
      raw.replace(/@([\w-]{1,24})/g, (_, n) => { mentions.push(n); return ''; });
      const entry = { id: seq++, from: from || '', name, text: raw, at: t, system: !!system, mentions };
      log.push(entry);
      if (!system) unread++;
      return { ok: true, entry };
    },
    markRead() { unread = 0; },
    get unread() { return unread; },
    entries() { return log.slice(); },
    clear() { log.length = 0; unread = 0; },
  };
}
