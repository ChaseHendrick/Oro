// Host relay over link objects. Every message is schema-checked. Unknown
// types are dropped. The host does not run anything inside a message.

import { HOST_ID, PROTOCOL_VERSION, decodeMessage, encodeMessage, sanitizeName } from './protocol.js';
import { createModeration } from './moderation.js';
import { createChat } from './chat.js';

const GUEST_IDS = ['p1', 'p2', 'p3', 'p4', 'p5'];

export function createHostRoom({ name = 'Host', jam = 'jamroom1', now = () => Date.now() } = {}) {
  const mod = createModeration();
  const chat = createChat();
  const peers = new Map();
  const handlers = { chat: [], sys: [], roster: [] };
  function emit(type, detail) { for (const fn of handlers[type] || []) fn(detail); }

  function roster() {
    const list = [{ id: HOST_ID, name, role: 'owner', voice: false, micMuted: false, chatMuted: false, selfMuted: false, rtt: 0, fp: '' }];
    for (const [id, p] of peers) {
      list.push({
        id, name: p.name, role: mod.role(id), voice: false,
        micMuted: mod.micMuted(id), chatMuted: mod.chatMuted(id), selfMuted: false, rtt: null, fp: p.fp || '',
      });
    }
    return list;
  }

  function send(link, msg) {
    try { link.send(encodeMessage(msg)); } catch { /* closed */ }
  }

  function broadcast(msg, except) {
    for (const [id, p] of peers) if (id !== except) send(p.link, msg);
  }

  function nextId() {
    return GUEST_IDS.find((id) => !peers.has(id)) || null;
  }

  function accept(link, { fp = '' } = {}) {
    if (mod.locked()) return { ok: false, reason: 'lock' };
    if (fp && mod.isBanned(fp)) return { ok: false, reason: 'ban' };
    const id = nextId();
    if (!id) return { ok: false, reason: 'full' };
    const peer = { id, link, name: 'Guest', fp, hello: false };
    peers.set(id, peer);
    link.onmessage((raw) => onGuest(id, raw));
    return { ok: true, id };
  }

  function onGuest(id, raw) {
    const peer = peers.get(id);
    if (!peer) return;
    const msg = decodeMessage(raw, 'up');
    if (!msg) return;
    if (msg.t === 'hello') {
      peer.name = sanitizeName(msg.name) || 'Guest';
      peer.hello = true;
      send(peer.link, { t: 'welcome', v: PROTOCOL_VERSION, you: id, jam, host: name });
      const body = { t: 'roster', peers: roster(), locked: mod.locked() };
      broadcast(body);
      emit('roster', roster());
      return;
    }
    if (!peer.hello) return;
    if (msg.t === 'ping') {
      const t1 = now();
      send(peer.link, { t: 'pong', id: msg.id, t0: msg.t0, t1, t2: now() });
      return;
    }
    if (msg.t === 'note') {
      const down = { t: 'note', from: id, track: msg.track, n: msg.n, v: msg.v, at: msg.at };
      broadcast(down, id);
      emit('note', down);
      return;
    }
    if (msg.t === 'chat') {
      if (mod.chatMuted(id)) { emit('sys', { kind: 'chatMuted', who: id }); return; }
      const posted = chat.post({ from: id, text: msg.text, name: peer.name });
      if (!posted.ok) return;
      const down = { t: 'chat', from: id, text: msg.text, at: posted.entry.at, id: posted.entry.id };
      broadcast(down, id);
      emit('chat', down);
      return;
    }
    if (msg.t === 'bye') remove(id);
  }

  function remove(id) {
    const p = peers.get(id);
    if (!p) return;
    peers.delete(id);
    try { p.link.close(); } catch { /* already */ }
    broadcast({ t: 'sys', kind: 'leave', who: id, at: 0, name: p.name });
    emit('roster', roster());
  }

  return {
    mod, chat, accept, roster,
    muteChat(id) { return mod.act(HOST_ID, 'muteChat', { target: id }); },
    ban(fp) { return mod.act(HOST_ID, 'ban', { fp }); },
    localBlock: (id, on) => mod.localBlock(id, on),
    visible() { return chat.entries().filter((e) => !mod.localBlocked(e.from)); },
    on(type, fn) { (handlers[type] = handlers[type] || []).push(fn); },
    drop(id) { remove(id); },
    postLocal(text) {
      const posted = chat.post({ from: HOST_ID, text, name });
      if (!posted.ok) return posted;
      broadcast({ t: 'chat', from: HOST_ID, text, at: posted.entry.at, id: posted.entry.id });
      return posted;
    },
    postNote(msg) {
      if (!msg) return;
      broadcast({ t: 'note', from: HOST_ID, track: msg.track, n: msg.n, v: msg.v, at: msg.at });
    },
  };
}

export function createGuestRoom({ link, name = 'Guest', onNote, onChat, onPong, onRoster } = {}) {
  const chat = createChat();
  const seen = [];
  link.onmessage((raw) => {
    const msg = decodeMessage(raw, 'down');
    if (!msg) return;
    seen.push(msg);
    if (msg.t === 'chat') {
      chat.post({ from: msg.from, text: msg.text, at: msg.at, name: msg.from });
      if (typeof onChat === 'function') onChat(msg);
    }
    if (msg.t === 'note' && typeof onNote === 'function') onNote(msg);
    if (msg.t === 'pong' && typeof onPong === 'function') onPong(msg);
    if (msg.t === 'roster' && typeof onRoster === 'function') onRoster(msg);
  });
  link.send(encodeMessage({ t: 'hello', v: PROTOCOL_VERSION, name }));
  return {
    chat,
    seen: () => seen.slice(),
    say(text) { link.send(encodeMessage({ t: 'chat', text })); },
    send(msg) { link.send(encodeMessage(msg)); },
  };
}
