// Jam together. A side panel, not a modal, so the keyboard still plays.
// Invite codes carry a network address. Voice never enters the synth engine.

import { h, createScope, setText, isTypingTarget } from './dom.js';
import { packCode, unpackCode } from '../jam/codes.js';
import { createHostRoom, createGuestRoom } from '../jam/relay.js';
import { createPeerSession, rtcAvailable } from '../jam/rtc.js';
import { createVoicePolicy, createVoiceSink, DEFAULT_PTT_KEY } from '../jam/voice.js';
import { createSpeaking } from '../jam/speaking.js';
import { guardAutosave, shouldSendSched } from '../jam/sync.js';
import '../styles/jam.css';

export function createJamPanel(ctx) {
  const scope = createScope();
  const voice = createVoicePolicy();
  const speaking = createSpeaking();
  const sink = createVoiceSink();
  let host = null;
  let guest = null;
  let session = null;
  let preJoin = null;
  let open = false;
  let unread = 0;
  let captureKey = false;
  let noteOff = null;

  const nameInput = h('input', { class: 'jam-name', maxlength: '24', value: 'Player', 'aria-label': 'Your name' });
  const stun = h('input', { type: 'checkbox', 'aria-label': 'Use a public STUN server' });
  const inviteOut = h('textarea', { class: 'jam-code', readOnly: true, 'aria-label': 'Invite code' });
  const joinIn = h('textarea', { class: 'jam-code', 'aria-label': 'Paste a code' });
  const replyOut = h('textarea', { class: 'jam-code', readOnly: true, hidden: true, 'aria-label': 'Reply code' });
  const status = h('p', { class: 'jam-status', role: 'status' });
  const log = h('div', { class: 'jam-log', 'aria-live': 'polite' });
  const chatInput = h('input', { class: 'jam-chat', maxlength: '500', 'aria-label': 'Chat message' });
  const badge = h('span', { class: 'jam-unread', hidden: true });
  const roster = h('ul', { class: 'jam-roster' });
  const ring = h('span', { class: 'jam-ring', 'aria-hidden': 'true' });
  const modBox = h('div', { class: 'jam-mod' },
    h('button', { type: 'button', class: 'btn btn--ghost btn--sm', dataset: { act: 'muteChat' } }, 'Mute chat'),
    h('button', { type: 'button', class: 'btn btn--ghost btn--sm', dataset: { act: 'muteMic' } }, 'Mute mic'),
    h('button', { type: 'button', class: 'btn btn--ghost btn--sm', dataset: { act: 'remove' } }, 'Remove'),
    h('button', { type: 'button', class: 'btn btn--ghost btn--sm', dataset: { act: 'ban' } }, 'Ban'),
    h('button', { type: 'button', class: 'btn btn--ghost btn--sm', dataset: { act: 'lock' } }, 'Lock'),
    h('button', { type: 'button', class: 'btn btn--ghost btn--sm', dataset: { act: 'clearChat' } }, 'Clear chat'),
    h('button', { type: 'button', class: 'btn btn--ghost btn--sm', dataset: { act: 'reclaim' } }, 'Reclaim'));

  const button = h('button', { type: 'button', class: 'btn btn--ghost btn--sm jam-open', 'aria-pressed': 'false' }, 'Jam', badge);
  const el = h('aside', { class: 'jam-panel', hidden: true, 'aria-label': 'Jam together' },
    h('header', { class: 'jam-head' }, h('h2', null, 'Jam'), h('button', { type: 'button', class: 'btn btn--ghost btn--sm jam-close' }, 'Close')),
    h('label', { class: 'jam-field' }, 'Name', nameInput),
    h('label', { class: 'jam-field' }, stun, 'Use a public STUN server'),
    h('p', { class: 'jam-hint' }, 'Some networks need a relay. Oro does not provide one, so Join can fail.'),
    h('div', { class: 'jam-row' },
      h('button', { type: 'button', class: 'btn btn--sm jam-start' }, 'Start jam'),
      h('button', { type: 'button', class: 'btn btn--sm jam-join' }, 'Join'),
      h('button', { type: 'button', class: 'btn btn--sm jam-reply-apply' }, 'Apply reply')),
    h('p', { class: 'jam-hint' }, 'Send this code to a friend. It contains your network address.'),
    inviteOut,
    h('p', { class: 'jam-hint' }, 'Paste the code you were sent.'),
    joinIn,
    h('p', { class: 'jam-hint jam-reply', hidden: true }, 'Send this reply back to the host.'),
    replyOut,
    status, roster, log,
    h('div', { class: 'jam-row' }, chatInput, h('button', { type: 'button', class: 'btn btn--sm jam-send' }, 'Send')),
    h('section', { class: 'jam-voice', 'aria-label': 'Voice' },
      h('button', { type: 'button', class: 'btn btn--sm jam-voice-join' }, 'Join voice'),
      h('p', { class: 'jam-hint' }, 'Headphones recommended.'),
      h('label', null, h('input', { type: 'radio', name: 'jam-mic', checked: true, dataset: { mode: 'ptt' } }), 'Push to talk'),
      h('label', null, h('input', { type: 'radio', name: 'jam-mic', dataset: { mode: 'open' } }), 'Open mic'),
      h('span', null, 'Key '),
      h('button', { type: 'button', class: 'btn btn--ghost btn--sm jam-key' }, DEFAULT_PTT_KEY.toUpperCase()),
      ring,
      h('button', { type: 'button', class: 'btn btn--ghost btn--sm jam-mute' }, 'Mute'),
      h('button', { type: 'button', class: 'btn btn--ghost btn--sm jam-deafen' }, 'Deafen')),
    modBox,
    h('button', { type: 'button', class: 'btn btn--ghost btn--sm jam-leave' }, 'Leave'));
  el.hidden = true;

  function setOpen(on) {
    open = !!on;
    el.hidden = !open;
    button.setAttribute('aria-pressed', open ? 'true' : 'false');
    if (open) { unread = 0; badge.hidden = true; }
  }

  function note(text) { setText(status, text); }

  function addLine(text) {
    log.appendChild(h('p', { class: 'jam-line' }, text));
    if (!open) { unread++; badge.hidden = false; badge.textContent = String(unread); }
  }

  function rememberSession() {
    if (preJoin || !ctx.store) return;
    preJoin = ctx.store.serialize();
    if (ctx.autosave && ctx.autosave.setPayload) {
      ctx.autosave.setPayload(() => guardAutosave(true, preJoin, null));
    }
    if (ctx.history && ctx.history.pause) ctx.history.pause(true);
    if (typeof ctx.pauseVersions === 'function') ctx.pauseVersions(true);
  }

  function restoreSession() {
    if (ctx.autosave && ctx.autosave.setPayload) ctx.autosave.setPayload(null);
    if (ctx.history && ctx.history.pause) ctx.history.pause(false);
    if (typeof ctx.pauseVersions === 'function') ctx.pauseVersions(false);
    if (preJoin && ctx.store) {
      try { ctx.store.load(preJoin, { source: 'jam' }); } catch { /* keep current */ }
    }
    preJoin = null;
    if (typeof ctx.onJamLeave === 'function') ctx.onJamLeave();
  }

  function jamId() {
    const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
    try {
      const bytes = crypto.getRandomValues(new Uint8Array(8));
      let s = '';
      for (const b of bytes) s += alphabet[b % alphabet.length];
      return s;
    } catch { return 'jamroom1'; }
  }

  function playRemote(msg) {
    if (!msg || !ctx.engine || !ctx.store) return;
    const parts = ctx.store.get('parts') || [];
    const idx = parts.findIndex((p) => p && p.id === msg.track);
    if (idx < 0 || !Number.isFinite(msg.n)) return;
    if (msg.v > 0 && typeof ctx.engine.noteOn === 'function') ctx.engine.noteOn(idx, msg.n, msg.v, 0, 'jam');
    else if (typeof ctx.engine.noteOff === 'function') ctx.engine.noteOff(idx, msg.n, 0, 'jam');
  }

  function watchLocalNotes() {
    const router = ctx.music && ctx.music.router;
    if (noteOff || !router || typeof router.on !== 'function') return;
    noteOff = router.on('sched', (ev) => {
      if (!ev || !shouldSendSched(ev.source)) return;
      const part = ctx.store && ctx.store.get(`parts.${ev.part}`);
      const track = part && part.id;
      if (!track) return;
      const msg = { t: 'note', track, n: ev.note, v: ev.on ? ev.vel : 0, at: Math.max(0, Number(ev.time) || 0) };
      if (host && host.postNote) host.postNote(msg);
      else if (guest && guest.send) guest.send(msg);
    });
  }

  function stopNotes() {
    if (noteOff) { noteOff(); noteOff = null; }
  }

  scope.on(button, 'click', () => setOpen(!open));
  scope.on(el.querySelector('.jam-close'), 'click', () => setOpen(false));
  scope.on(el.querySelector('.jam-start'), 'click', async () => {
    if (!rtcAvailable()) { note('This browser cannot open a direct connection.'); return; }
    note('Looking for a friend.');
    session = createPeerSession({ stun: !!stun.checked });
    if (!session) { note('This browser cannot open a direct connection.'); return; }
    const id = jamId();
    host = createHostRoom({ name: nameInput.value || 'Host', jam: id });
    guest = null;
    host.accept(session.link);
    host.on('chat', (msg) => addLine(msg.text));
    host.on('note', playRemote);
    rememberSession();
    watchLocalNotes();
    try {
      const desc = await session.offer();
      const code = await packCode('invite', { v: 1, jam: id, slot: 'p1', host: nameInput.value || 'Host', desc });
      inviteOut.value = code;
      note('Send this code to a friend. It contains your network address.');
    } catch (err) {
      note(err && err.message ? err.message : 'The invite could not be made.');
    }
  });
  scope.on(el.querySelector('.jam-join'), 'click', async () => {
    if (!rtcAvailable()) { note('This browser cannot open a direct connection.'); return; }
    try {
      const got = await unpackCode(joinIn.value, 'invite');
      session = createPeerSession({ stun: !!stun.checked, polite: true });
      if (!session) { note('This browser cannot open a direct connection.'); return; }
      const desc = await session.answer(got.payload.desc);
      guest = createGuestRoom({ link: session.link, name: nameInput.value || 'Guest', onNote: playRemote });
      host = null;
      rememberSession();
      watchLocalNotes();
      const code = await packCode('reply', { v: 1, jam: got.payload.jam, slot: 'p1', desc });
      replyOut.hidden = false;
      replyOut.value = code;
      const replyHint = el.querySelector('.jam-reply');
      if (replyHint) replyHint.hidden = false;
      note('Send this reply back to the host.');
    } catch (err) {
      note(err && err.message ? err.message : 'That code could not be read.');
    }
  });
  scope.on(el.querySelector('.jam-reply-apply'), 'click', async () => {
    if (!session || !host) { note('Start a jam before applying a reply.'); return; }
    try {
      const got = await unpackCode(joinIn.value, 'reply');
      await session.acceptReply(got.payload.desc);
      note('Reply applied. Chat and notes use the direct connection.');
    } catch (err) {
      note(err && err.message ? err.message : 'That reply could not be read.');
    }
  });
  scope.on(el.querySelector('.jam-send'), 'click', () => {
    const text = chatInput.value;
    if (!text.trim()) return;
    if (host) host.postLocal(text);
    else if (guest) guest.say(text);
    else addLine(text);
    log.appendChild(h('p', { class: 'jam-line' }, text));
    chatInput.value = '';
  });
  scope.on(el.querySelector('.jam-voice-join'), 'click', () => {
    voice.join(!voice.joined);
    note(voice.joined ? 'Voice is on. Headphones recommended.' : 'Voice is off.');
  });
  scope.on(el.querySelector('.jam-key'), 'click', () => { captureKey = true; note('Press the new push to talk key.'); });
  function onTalkKey(e) {
    if (captureKey && e.type === 'keydown' && !e.repeat) {
      const k = (e.key || '').toLowerCase();
      if (k.length === 1 && !isTypingTarget(e.target)) {
        e.preventDefault();
        captureKey = false;
        voice.setKey(k);
        const keyBtn = el.querySelector('.jam-key');
        if (keyBtn) keyBtn.textContent = k.toUpperCase();
        note(`Push to talk is ${k.toUpperCase()}.`);
      }
      return;
    }
    if (!voice.joined || voice.mode !== 'ptt' || isTypingTarget(e.target)) return;
    const hit = (e.key || '').toLowerCase() === voice.key || e.code === `Key${voice.key.toUpperCase()}`;
    if (!hit) return;
    if (e.type === 'keydown' && !e.repeat) voice.keyDown(voice.key);
    if (e.type === 'keyup') voice.keyUp(voice.key);
  }
  document.addEventListener('keydown', onTalkKey);
  document.addEventListener('keyup', onTalkKey);
  scope.add(() => {
    document.removeEventListener('keydown', onTalkKey);
    document.removeEventListener('keyup', onTalkKey);
  });
  scope.on(el.querySelector('.jam-mute'), 'click', () => voice.setMuted(true));
  scope.on(el.querySelector('.jam-deafen'), 'click', () => voice.setDeaf(true));
  scope.on(el.querySelector('.jam-leave'), 'click', () => {
    stopNotes();
    if (session && session.link) { try { session.link.close(); } catch { /* already */ } }
    session = null;
    host = null; guest = null;
    restoreSession();
    note('You left the jam.');
    setOpen(false);
  });
  // Keep the sink referenced so a later voice path cannot be pointed at the engine.
  sink.play({ kind: 'element' });
  speaking.push(0);

  return {
    el, button, voice, sink, iceServers,
    open: () => setOpen(true), close: () => setOpen(false), dispose: scope.dispose,
  };
}
