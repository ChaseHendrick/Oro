// Jam together. A side panel, not a modal, so the keyboard still plays.
// Invite codes carry a network address. Voice never enters the synth engine.

import { h, createScope, setText, isTypingTarget } from './dom.js';
import { packCode, unpackCode, readReply } from '../jam/codes.js';
import { createHostRoom, createGuestRoom } from '../jam/relay.js';
import { createPeerSession, rtcAvailable } from '../jam/rtc.js';
import { createVoicePolicy, createVoiceSink, DEFAULT_PTT_KEY } from '../jam/voice.js';
import { createSpeaking } from '../jam/speaking.js';
import { guardAutosave, shouldSendSched } from '../jam/sync.js';
import { createClockSync, pingInterval } from '../jam/clock.js';
import { createJitterBuffer, scheduleNote } from '../jam/jitter.js';
import '../styles/jam.css';

export function createJamPanel(ctx) {
  const scope = createScope();
  const voice = createVoicePolicy();
  const speaking = createSpeaking();
  const sink = createVoiceSink();
  let host = null;
  let guest = null;
  let sessions = [];
  let pending = null;
  let preJoin = null;
  let open = false;
  let unread = 0;
  let captureKey = false;
  let noteOff = null;
  let pingTimer = 0;
  let pingId = 1;
  let selectedPeer = '';
  let jamEpoch = 0;
  const heldJam = new Set();
  const onAt = new Map();
  const waitingOff = new Map();
  const heldLocal = new Set();
  const pendingBySlot = new Map();
  let pingFn = null;
  let micStream = null;
  let micTrack = null;
  const clock = createClockSync();
  const buffers = new Map();
  const remoteAudios = [];
  let people = [];

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
      h('button', { type: 'button', class: 'btn btn--sm jam-another', hidden: true }, 'Invite another'),
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

  const another = el.querySelector('.jam-another');
  another.hidden = true;

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

  function renderRoster(list) {
    people = Array.isArray(list) ? list : [];
    roster.replaceChildren(...people.map((p) => {
      const late = p.rtt == null ? '' : ` ${p.rtt} ms`;
      const li = h('li', null, h('button', { type: 'button', class: p.id === selectedPeer ? 'jam-person is-on' : 'jam-person' }, `${p.name}${late}`));
      li.querySelector('button').addEventListener('click', () => { selectedPeer = p.id; renderRoster(people); });
      return li;
    }));
  }

  function personName(id) {
    const list = host && typeof host.roster === 'function' ? host.roster() : people;
    const found = list.find((p) => p.id === id);
    return (found && found.name) || 'Friend';
  }

  function hearRemote(audio) {
    remoteAudios.push(audio);
    audio.muted = voice.deaf;
    sink.play(audio);
  }

  function applySend() {
    if (micTrack) micTrack.enabled = voice.sending();
    for (const audio of remoteAudios) audio.muted = voice.deaf;
  }

  async function pushMic() {
    applySend();
    for (const session of sessions) {
      if (session.setMic) await session.setMic(voice.joined ? micTrack : null);
    }
  }

  async function releaseMic() {
    for (const session of sessions) {
      try { if (session.setMic) await session.setMic(null); } catch { /* already closed */ }
    }
    if (micStream) for (const track of micStream.getTracks()) track.stop();
    micStream = null;
    micTrack = null;
  }

  function dropRemoteAudio() {
    for (const audio of remoteAudios) audio.srcObject = null;
    remoteAudios.length = 0;
  }

  function dropLinks() {
    for (const session of sessions) {
      try { session.link.close(); } catch { /* already */ }
    }
    sessions = [];
    pending = null;
    pendingBySlot.clear();
    heldLocal.clear();
    guest = null;
    if (pingTimer) { clearInterval(pingTimer); pingTimer = 0; }
    clock.reset();
    buffers.clear();
  }

  function sessionOpts(extra) {
    return { stun: !!stun.checked, onRemoteAudio: hearRemote, ...extra };
  }

  function jamKey(who, idx, n) { return `${who}\t${idx}\t${n}`; }
  function localKey(track, n) { return `${track}\t${n}`; }

  function silenceFrom(who) {
    if (!(ctx.engine && typeof ctx.engine.noteOff === 'function')) {
      if (who == null) heldJam.clear();
      return;
    }
    for (const key of [...heldJam]) {
      const parts = key.split('\t');
      if (who != null && parts[0] !== who) continue;
      ctx.engine.noteOff(Number(parts[1]), Number(parts[2]), 0, 'jam');
      heldJam.delete(key);
      onAt.delete(key);
      waitingOff.delete(key);
    }
  }

  function silenceJam() { silenceFrom(null); }

  function playEngine(msg) {
    const parts = ctx.store.get('parts') || [];
    const idx = parts.findIndex((p) => p && p.id === msg.track);
    if (idx < 0 || !Number.isFinite(msg.n)) return;
    const key = jamKey(msg.from || 'remote', idx, msg.n);
    if (msg.v > 0 && typeof ctx.engine.noteOn === 'function') {
      ctx.engine.noteOn(idx, msg.n, msg.v, 0, 'jam');
      heldJam.add(key);
    } else if (typeof ctx.engine.noteOff === 'function') {
      if (!heldJam.has(key)) return;
      ctx.engine.noteOff(idx, msg.n, 0, 'jam');
      heldJam.delete(key);
    }
  }

  function playRemote(msg) {
    if (!msg || !ctx.engine || !ctx.store || !Number.isFinite(msg.at)) return;
    const localNow = performance.now();
    const jamNow = guest ? clock.toHost(localNow) : localNow;
    const who = msg.from || 'remote';
    let buffer = buffers.get(who);
    if (!buffer) { buffer = createJitterBuffer(); buffers.set(who, buffer); }
    buffer.observe(msg.at, jamNow, clock.jitter || 0);
    const parts = ctx.store.get('parts') || [];
    const idx = parts.findIndex((p) => p && p.id === msg.track);
    const noteKey = idx >= 0 && Number.isFinite(msg.n) ? jamKey(who, idx, msg.n) : null;
    const on = msg.v > 0;
    if (!on && noteKey && !onAt.has(noteKey)) {
      waitingOff.set(noteKey, msg);
      return;
    }
    const plan = scheduleNote({ at: msg.at, on, now: jamNow, buffer, onAt: !on && noteKey ? onAt.get(noteKey) : null });
    if (!plan) return;
    if (on && noteKey) onAt.set(noteKey, plan.at);
    else if (noteKey) onAt.delete(noteKey);
    const localAt = guest ? clock.toLocal(plan.at) : plan.at;
    const delay = Math.max(0, localAt - localNow);
    const epoch = jamEpoch;
    setTimeout(() => { if (epoch === jamEpoch) playEngine(msg); }, delay);
    if (on && noteKey && waitingOff.has(noteKey)) {
      const off = waitingOff.get(noteKey);
      waitingOff.delete(noteKey);
      playRemote(off);
    }
  }

  function releaseSent() {
    const localNow = performance.now();
    const at = guest ? clock.toHost(localNow) : localNow;
    for (const key of heldLocal) {
      const cut = key.indexOf('\t');
      const msg = { t: 'note', track: key.slice(0, cut), n: Number(key.slice(cut + 1)), v: 0, at };
      if (host && host.postNote) host.postNote(msg);
      else if (guest && guest.send) guest.send(msg);
    }
    heldLocal.clear();
    try {
      if (guest && guest.send) guest.send({ t: 'bye' });
      else if (host && host.postBye) host.postBye();
    } catch { /* already closed */ }
  }

  function watchLocalNotes() {
    const router = ctx.music && ctx.music.router;
    if (noteOff || !router || typeof router.on !== 'function') return;
    noteOff = router.on('sched', (ev) => {
      if (!ev || !shouldSendSched(ev.source)) return;
      const part = ctx.store && ctx.store.get(`parts.${ev.part}`);
      const track = part && part.id;
      if (!track) return;
      const localNow = performance.now();
      const msg = { t: 'note', track, n: ev.note, v: ev.on ? ev.vel : 0, at: guest ? clock.toHost(localNow) : localNow };
      const key = localKey(track, ev.note);
      if (ev.on) heldLocal.add(key);
      else heldLocal.delete(key);
      if (host && host.postNote) host.postNote(msg);
      else if (guest && guest.send) guest.send(msg);
    });
  }

  function stopNotes() {
    jamEpoch++;
    silenceJam();
    onAt.clear();
    waitingOff.clear();
    if (noteOff) { noteOff(); noteOff = null; }
    if (pingTimer) { clearInterval(pingTimer); pingTimer = 0; }
  }

  async function offerSlot() {
    if (!host) return;
    if (sessions.length >= 5) { note('This jam already has five friends.'); return; }
    const session = createPeerSession(sessionOpts());
    if (!session) { note('This browser cannot open a direct connection.'); return; }
    const joined = host.accept(session.link);
    if (!joined.ok) {
      try { session.link.close(); } catch { /* already */ }
      note(joined.reason === 'full' ? 'This jam already has five friends.' : 'Nobody else can join right now.');
      return;
    }
    sessions.push(session);
    session.peerId = joined.id;
    pending = session;
    pendingBySlot.set(joined.id, session);
    if (micTrack && session.setMic) await session.setMic(micTrack);
    try {
      const desc = await session.offer();
      const code = await packCode('invite', { v: 1, jam: hostJam, slot: joined.id, host: nameInput.value || 'Host', desc });
      inviteOut.value = code;
      another.hidden = sessions.length >= 5;
      note('Send this code to a friend. It contains your network address.');
    } catch (err) {
      sessions = sessions.filter((s) => s !== session);
      pendingBySlot.delete(joined.id);
      if (pending === session) pending = null;
      try { host.drop(joined.id); } catch { /* already */ }
      try { session.link.close(); } catch { /* already */ }
      another.hidden = sessions.length >= 5;
      note(err && err.message ? err.message : 'The invite could not be made.');
    }
  }

  let hostJam = '';

  scope.on(button, 'click', () => setOpen(!open));
  scope.on(el.querySelector('.jam-close'), 'click', () => setOpen(false));
  scope.on(el.querySelector('.jam-start'), 'click', async () => {
    if (!rtcAvailable()) { note('This browser cannot open a direct connection.'); return; }
    if (host) { await offerSlot(); return; }
    if (guest || sessions.length) {
      releaseSent();
      stopNotes();
      dropLinks();
    }
    note('Looking for a friend.');
    hostJam = jamId();
    host = createHostRoom({ name: nameInput.value || 'Host', jam: hostJam, now: () => performance.now() });
    guest = null;
    host.on('chat', (msg) => addLine(`${personName(msg.from)}: ${msg.text}`));
    host.on('note', playRemote);
    host.on('bye', ({ id }) => silenceFrom(id));
    host.on('roster', (list) => {
      const ids = new Set((Array.isArray(list) ? list : []).map((p) => p.id));
      sessions = sessions.filter((s) => !s.peerId || ids.has(s.peerId));
      for (const id of [...pendingBySlot.keys()]) if (!ids.has(id)) pendingBySlot.delete(id);
      if (pending && pending.peerId && !ids.has(pending.peerId)) pending = null;
      another.hidden = sessions.length >= 5;
      renderRoster(list);
    });
    rememberSession();
    watchLocalNotes();
    another.hidden = false;
    await offerSlot();
  });
  scope.on(another, 'click', () => { offerSlot(); });
  scope.on(el.querySelector('.jam-join'), 'click', async () => {
    if (!rtcAvailable()) { note('This browser cannot open a direct connection.'); return; }
    if (host) { note('You are hosting. Apply the reply on this computer.'); return; }
    let got;
    try {
      got = await unpackCode(joinIn.value, 'invite');
    } catch (err) {
      note(err && err.message ? err.message : 'That code could not be read.');
      return;
    }
    if (guest || sessions.length) {
      releaseSent();
      stopNotes();
      dropLinks();
    }
    let session = null;
    try {
      session = createPeerSession(sessionOpts({ polite: true }));
      if (!session) { note('This browser cannot open a direct connection.'); return; }
      if (micTrack && session.setMic) await session.setMic(micTrack);
      const desc = await session.answer(got.payload.desc);
      sessions = [session];
      guest = createGuestRoom({
        link: session.link,
        name: nameInput.value || 'Guest',
        onNote: playRemote,
        onChat: (msg) => addLine(`${personName(msg.from)}: ${msg.text}`),
        onRoster: (msg) => renderRoster(msg.peers),
        onBye: () => silenceJam(),
        onSys: (msg) => { if (msg && msg.kind === 'leave' && msg.who) silenceFrom(msg.who); },
        onPong: (msg) => {
          clock.add(msg.t0, msg.t1, msg.t2, performance.now());
          if (pingTimer && pingFn) {
            clearInterval(pingTimer);
            pingTimer = setInterval(pingFn, pingInterval(clock.count));
          }
          if (clock.rtt != null) note(`Connected. About ${Math.round(clock.rtt)} ms round trip.`);
        },
      });
      host = null;
      rememberSession();
      watchLocalNotes();
      if (pingTimer) clearInterval(pingTimer);
      const ping = () => { if (guest) guest.send({ t: 'ping', id: pingId++, t0: performance.now() }); };
      pingFn = ping;
      ping();
      pingTimer = setInterval(ping, pingInterval(clock.count));
      const code = await packCode('reply', { v: 1, jam: got.payload.jam, slot: got.payload.slot || 'p1', desc });
      replyOut.hidden = false;
      replyOut.value = code;
      const replyHint = el.querySelector('.jam-reply');
      if (replyHint) replyHint.hidden = false;
      note('Send this reply back to the host.');
    } catch (err) {
      if (session && !sessions.includes(session)) {
        try { session.link.close(); } catch { /* already */ }
      }
      releaseSent();
      stopNotes();
      dropLinks();
      restoreSession();
      note(err && err.message ? err.message : 'That code could not be read.');
    }
  });
  scope.on(el.querySelector('.jam-reply-apply'), 'click', async () => {
    if (!host) { note('Start a jam, then paste the reply here.'); return; }
    try {
      const got = await unpackCode(joinIn.value, 'reply');
      const reply = readReply(got.payload);
      const session = (reply && pendingBySlot.get(reply.slot)) || pending;
      if (!session) { note('Start a jam, then paste the reply here.'); return; }
      await session.acceptReply((reply && reply.desc) || got.payload.desc);
      if (reply) pendingBySlot.delete(reply.slot);
      if (pending === session) pending = null;
      note('Reply applied. Chat and played notes use the direct connection.');
    } catch (err) {
      note(err && err.message ? err.message : 'That reply could not be read.');
    }
  });
  scope.on(el.querySelector('.jam-send'), 'click', () => {
    const text = chatInput.value;
    if (!text.trim()) return;
    if (host) {
      const posted = host.postLocal(text);
      if (posted && posted.ok) addLine(`You: ${text}`);
      else note('That message was not sent.');
    } else if (guest) {
      guest.say(text);
      addLine(`You: ${text}`);
    } else addLine(text);
    chatInput.value = '';
  });
  const voiceBtn = el.querySelector('.jam-voice-join');
  const muteBtn = el.querySelector('.jam-mute');
  const deafBtn = el.querySelector('.jam-deafen');
  function paintVoiceButtons() {
    voiceBtn.setAttribute('aria-pressed', voice.joined ? 'true' : 'false');
    muteBtn.setAttribute('aria-pressed', voice.muted ? 'true' : 'false');
    deafBtn.setAttribute('aria-pressed', voice.deaf ? 'true' : 'false');
  }
  scope.on(voiceBtn, 'click', async () => {
    if (voice.joined) {
      voice.join(false);
      await releaseMic();
      paintVoiceButtons();
      note('Voice is off.');
      return;
    }
    const devices = typeof navigator !== 'undefined' && navigator.mediaDevices;
    if (!devices || typeof devices.getUserMedia !== 'function') {
      note('This browser has no microphone.');
      return;
    }
    try {
      micStream = await devices.getUserMedia({ audio: voice.constraints });
      micTrack = micStream.getAudioTracks()[0] || null;
      voice.join(true);
      await pushMic();
      paintVoiceButtons();
      note(voice.mode === 'open' ? 'Voice is on. The mic is open. Headphones recommended.' : 'Voice is on. Hold the key to talk. Headphones recommended.');
    } catch {
      voice.join(false);
      await releaseMic();
      paintVoiceButtons();
      note('The microphone could not be opened.');
    }
  });
  scope.on(el, 'change', (e) => {
    const mode = e.target && e.target.dataset && e.target.dataset.mode;
    if (mode !== 'ptt' && mode !== 'open') return;
    voice.setMode(mode);
    applySend();
    if (voice.joined) note(mode === 'open' ? 'The mic is open.' : 'Hold the key to talk.');
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
    applySend();
  }
  document.addEventListener('keydown', onTalkKey);
  document.addEventListener('keyup', onTalkKey);
  scope.add(() => {
    document.removeEventListener('keydown', onTalkKey);
    document.removeEventListener('keyup', onTalkKey);
  });
  scope.on(muteBtn, 'click', () => {
    voice.setMuted(!voice.muted);
    applySend();
    paintVoiceButtons();
    note(voice.muted ? 'Your mic is muted.' : 'Your mic is unmuted.');
  });
  scope.on(deafBtn, 'click', () => {
    voice.setDeaf(!voice.deaf);
    applySend();
    paintVoiceButtons();
    note(voice.deaf ? 'Their voices are off.' : 'Their voices are on.');
  });
  scope.on(modBox, 'click', (e) => {
    const act = e.target && e.target.dataset ? e.target.dataset.act : '';
    if (!act || !host) { note('Only the host can do that.'); return; }
    if (act === 'lock') { host.mod.act('h', host.mod.locked() ? 'unlock' : 'lock'); note(host.mod.locked() ? 'The jam is locked.' : 'The jam is open.'); return; }
    if (act === 'clearChat') { host.chat.clear(); log.replaceChildren(); addLine('Chat cleared.'); return; }
    if (act === 'reclaim') { host.mod.act('h', 'reclaim'); note('Tracks belong to the host again.'); return; }
    if (!selectedPeer || selectedPeer === 'h') { note('Choose a person in the list first.'); return; }
    if (act === 'muteChat') { host.muteChat(selectedPeer); addLine('Chat muted for that person.'); }
    else if (act === 'muteMic') { host.mod.act('h', 'muteMic', { target: selectedPeer }); addLine('Mic muted for that person.'); }
    else if (act === 'remove') {
      host.drop(selectedPeer);
      sessions = sessions.filter((s) => s.peerId !== selectedPeer);
      another.hidden = sessions.length >= 5;
      selectedPeer = '';
    }
    else if (act === 'ban') {
      const person = host.roster().find((p) => p.id === selectedPeer);
      if (person && person.fp) host.ban(person.fp);
      host.drop(selectedPeer);
      sessions = sessions.filter((s) => s.peerId !== selectedPeer);
      another.hidden = sessions.length >= 5;
      selectedPeer = '';
      addLine('That person is banned for this jam.');
    }
  });
  scope.on(el.querySelector('.jam-leave'), 'click', async () => {
    releaseSent();
    stopNotes();
    await releaseMic();
    dropRemoteAudio();
    dropLinks();
    host = null;
    people = [];
    voice.keyUp(voice.key);
    voice.setMuted(false);
    voice.setDeaf(false);
    voice.join(false);
    paintVoiceButtons();
    another.hidden = true;
    restoreSession();
    note('You left the jam.');
    setOpen(false);
  });
  // Keep the sink referenced so a later voice path cannot be pointed at the engine.
  sink.play({ kind: 'element' });
  speaking.push(0);

  return {
    el, button, voice, sink,
    open: () => setOpen(true), close: () => setOpen(false), dispose: scope.dispose,
  };
}
