// Match a song (2.12): choose or drop an audio file, or record about 10
// seconds from the microphone, and Oro works out the tempo and key on this
// computer (src/music/song-match.js; nothing is uploaded). Apply sets the
// global tempo, key and scale as one undo step. The file can keep playing as a
// simple backing track (straight to the speakers, not recorded). Loaded from
// the Seq tab's global bar when the button is first used.

import { h, setText } from './dom.js';
import { openPopover } from './layers.js';
import { found } from '../core/fun.js';
import { SCALE_NAMES } from '../core/params.js';
import { analyseSong, describeResult, keyName, toMono, LOW_CONFIDENCE } from '../music/song-match.js';

export const RECORD_SECONDS = 10;
const MAX_BYTES = 200 * 1024 * 1024;
const META = Object.freeze({ source: 'ui' });

// the backing track survives the popover closing
const backing = { buffer: null, name: '', node: null, gain: null, volume: 0.6 };

/** Global tempo, key and scale from a result, as one undo step. */
export function applyMatch(store, { bpm = null, key = null } = {}) {
  const tempo = Number.isFinite(bpm) ? Math.max(40, Math.min(240, Math.round(bpm))) : null;
  const type = key ? SCALE_NAMES.indexOf(key.mode === 'major' ? 'Major' : 'Minor') : -1;
  store.batch(() => {
    if (tempo !== null) store.set('global.tempo', tempo, META);
    if (key && type >= 0) {
      store.set('global.scaleRoot', key.root, META);
      store.set('global.scaleType', type, META);
    }
  });
  if (tempo !== null || key) found('badge', 'auto-key');
}

/** Decode an encoded file (ArrayBuffer) to an AudioBuffer, off the audio engine. */
async function decode(bytes) {
  const AC = globalThis.OfflineAudioContext || globalThis.webkitOfflineAudioContext;
  if (!AC) throw new Error('This browser cannot decode audio files');
  const ac = new AC(1, 1, 44100);
  return await new Promise((resolve, reject) => {
    const p = ac.decodeAudioData(bytes, resolve, reject);
    if (p && typeof p.then === 'function') p.then(resolve, reject);
  });
}

function stopBacking() {
  if (backing.node) { try { backing.node.stop(); } catch { /* already */ } try { backing.node.disconnect(); } catch { /* ignore */ } }
  backing.node = null;
}

export function openMatchSong(ctx, anchor) {
  const { store, layers } = ctx;
  let pop = null, result = null, recording = null;

  const status = h('p', { class: 'popover-note match-status', role: 'status', 'aria-live': 'polite' });
  const fileInput = h('input', { type: 'file', accept: 'audio/*,.mp3,.wav,.ogg,.flac,.m4a,.aac', class: 'visually-hidden', tabindex: '-1', 'aria-hidden': 'true' });
  const chooseBtn = h('button', { type: 'button', class: 'btn btn--sm' }, 'Choose a file');
  const recBtn = h('button', { type: 'button', class: 'btn btn--ghost btn--sm' }, `Record ${RECORD_SECONDS} seconds`);
  const canRecord = !!(globalThis.navigator?.mediaDevices?.getUserMedia && globalThis.MediaRecorder);
  if (!canRecord) recBtn.hidden = true;
  const drop = h('div', { class: 'match-drop' }, h('span', null, 'Drop an audio file here, or'), chooseBtn, recBtn);
  const out = h('div', { class: 'match-result', hidden: true });

  const body = h('div', { class: 'match-pop' },
    h('div', { class: 'popover-title' }, 'Match a song'),
    h('p', { class: 'popover-note' }, 'Find the tempo and key of a song, then set Oro to match. The audio is analysed on this computer and never uploaded. Only the first 90 seconds are used.'),
    drop, fileInput, status, out,
    canRecord ? null : h('p', { class: 'popover-note' }, 'Recording from the microphone is not supported on this device.'));

  // ------------------------------------------------------------ input
  chooseBtn.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => { const f = fileInput.files && fileInput.files[0]; fileInput.value = ''; if (f) fromFile(f); });
  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('is-over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('is-over'));
  drop.addEventListener('drop', (e) => {
    e.preventDefault(); drop.classList.remove('is-over');
    const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) fromFile(f);
  });
  recBtn.addEventListener('click', () => { if (recording) recording.stop(); else record(); });

  async function fromFile(file) {
    if (file.size > MAX_BYTES) { setText(status, 'That file is too large (over 200 MB).'); return; }
    setText(status, `Reading ${file.name}…`);
    try {
      const buf = await decode(await file.arrayBuffer());
      await analyse(buf, file.name);
    } catch (err) {
      console.warn('[match] could not read', err);
      setText(status, 'Oro could not read that file. Try a WAV, MP3 or another common audio format.');
    }
  }

  async function record() {
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
    } catch {
      setText(status, 'The microphone was not allowed. Allow it in the browser to record, or choose a file.');
      return;
    }
    const chunks = [];
    let rec;
    try { rec = new MediaRecorder(stream); } catch { stream.getTracks().forEach(t => t.stop()); setText(status, 'Recording is not supported on this device.'); return; }
    let left = RECORD_SECONDS, tick = 0;
    const finish = () => { clearInterval(tick); stream.getTracks().forEach(t => t.stop()); recording = null; recBtn.textContent = `Record ${RECORD_SECONDS} seconds`; };
    rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
    rec.onstop = async () => {
      finish();
      try {
        const blob = new Blob(chunks, { type: rec.mimeType || 'audio/webm' });
        await analyse(await decode(await blob.arrayBuffer()), 'the recording');
      } catch (err) {
        console.warn('[match] recording', err);
        setText(status, 'Oro could not read the recording. Try again, or choose a file.');
      }
    };
    recording = { stop: () => { try { rec.stop(); } catch { finish(); } } };
    rec.start();
    recBtn.textContent = 'Stop';
    setText(status, `Recording… ${left} seconds. Play the song near the microphone.`);
    tick = setInterval(() => {
      left -= 1;
      if (left <= 0) recording?.stop();
      else setText(status, `Recording… ${left} seconds.`);
    }, 1000);
  }

  async function analyse(buf, name) {
    setText(status, 'Listening for the beat and the key…');
    await new Promise(r => setTimeout(r, 20));   // let the status paint first
    const chans = [];
    for (let c = 0; c < buf.numberOfChannels; c++) chans.push(buf.getChannelData(c));
    result = analyseSong(toMono(chans), buf.sampleRate);
    stopBacking();
    backing.buffer = result.quiet ? null : buf;
    backing.name = name;
    setText(status, `${name}: ${describeResult(result)}`);
    renderResult();
  }

  // ------------------------------------------------------------ result
  function renderResult() {
    if (!result || result.quiet) { out.hidden = true; out.replaceChildren(); pop?.reposition(); return; }
    const t = result.tempo, k = result.key;
    const bpm = t.bpm ? Math.round(t.bpm) : null;
    const btn = (label, fn, primary = false) => {
      const b = h('button', { type: 'button', class: ['btn', 'btn--sm', primary ? 'btn--primary' : 'btn--ghost'] }, label);
      b.addEventListener('click', () => { fn(); });
      return b;
    };
    const applied = (what) => { setText(status, `${what}. Undo puts it back.`); ctx.announce?.(what); };
    const unsure = (bpm && t.confidence < LOW_CONFIDENCE) || (k.best && k.confidence < LOW_CONFIDENCE);
    const rows = [];
    rows.push(h('dl', { class: 'weather-values' },
      h('dt', null, 'Tempo'), h('dd', null, bpm ? `${bpm} BPM (${Math.round(t.confidence * 100)}% sure)` : 'no steady beat'),
      h('dt', null, 'Key'), h('dd', null, k.best ? `${keyName(k.best)} (${Math.round(k.best.confidence * 100)}% sure)` : 'no clear key'),
      h('dt', null, 'Next best'), h('dd', null, k.next ? `${keyName(k.next)} (${Math.round(k.next.confidence * 100)}% sure)` : '-')));
    if (unsure) rows.push(h('p', { class: 'popover-note' }, 'Low confidence: check by ear before you rely on it.'));
    const actions = [];
    if (bpm && k.best) actions.push(btn('Apply tempo and key', () => { applyMatch(store, { bpm, key: k.best }); applied(`Tempo ${bpm} BPM, key ${keyName(k.best)}`); }, true));
    if (bpm) actions.push(btn('Tempo only', () => { applyMatch(store, { bpm }); applied(`Tempo ${bpm} BPM`); }));
    if (k.best) actions.push(btn('Key only', () => { applyMatch(store, { key: k.best }); applied(`Key ${keyName(k.best)}`); }));
    if (k.next) actions.push(btn(`Use ${keyName(k.next)}`, () => { applyMatch(store, { key: k.next }); applied(`Key ${keyName(k.next)}`); }));
    if (t.alt && t.alt >= 40 && t.alt <= 240) actions.push(btn(`Use ${t.alt} BPM`, () => { applyMatch(store, { bpm: t.alt }); applied(`Tempo ${t.alt} BPM`); }));
    rows.push(h('div', { class: 'btn-row match-actions' }, ...actions));
    rows.push(backingControls());
    out.replaceChildren(...rows);
    out.hidden = false;
    pop?.reposition();
  }

  function backingControls() {
    const ac = ctx.engine && ctx.engine.context;
    if (!backing.buffer) return null;
    if (!ac || !ctx.audioOk?.()) return h('p', { class: 'popover-note' }, 'Start the audio to play the song along as a backing track.');
    const play = h('button', { type: 'button', class: 'btn btn--ghost btn--sm' }, backing.node ? 'Stop the song' : 'Play the song along');
    const vol = h('input', { type: 'range', min: '0', max: '1', step: '0.05', value: String(backing.volume), 'aria-label': 'Backing track volume', class: 'pad-range' });
    play.addEventListener('click', () => {
      if (backing.node) { stopBacking(); play.textContent = 'Play the song along'; return; }
      try {
        if (!backing.gain || backing.gain.context !== ac) { backing.gain = ac.createGain(); backing.gain.connect(ac.destination); }
        backing.gain.gain.value = backing.volume;
        const node = ac.createBufferSource();
        node.buffer = backing.buffer; node.loop = true;
        node.connect(backing.gain);
        node.onended = () => { if (backing.node === node) { backing.node = null; play.textContent = 'Play the song along'; } };
        node.start();
        backing.node = node;
        play.textContent = 'Stop the song';
      } catch (err) { console.warn('[match] backing', err); setText(status, 'The song could not play.'); }
    });
    vol.addEventListener('input', () => { backing.volume = Number(vol.value); if (backing.gain) backing.gain.gain.value = backing.volume; });
    return h('div', { class: 'match-backing' },
      h('div', { class: 'data-row' }, play, h('label', { class: 'match-vol' }, h('span', null, 'Volume'), vol)),
      h('p', { class: 'popover-note' }, 'Loops the song straight to your speakers. It is not recorded and does not follow the tempo.'));
  }

  pop = openPopover(layers, anchor, body, {
    label: 'Match a song', className: 'match-popover',
    onClose: () => { if (recording) recording.stop(); },
  });
  if (backing.buffer && result === null) setText(status, `Backing track: ${backing.name}.`);
  return { el: body, close: () => pop?.close?.(), isOpen: () => !!pop?.isOpen?.(), analyse };
}
