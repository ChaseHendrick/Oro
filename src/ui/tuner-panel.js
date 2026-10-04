// Settings > Voice tuner. Listens to the voice tap. Never writes audio,
// never touches the looper, bounce, recorder, or effects.

import { h, createScope, setText } from './dom.js';
import { addLoop } from './frame.js';
import { sanitizeTuning } from '../dsp/tuning.js';
import { createTuner, hzToNote, TUNER_TEXT, CLEAR_CONFIDENCE } from '../audio/tuner.js';

const FOLLOW = 0.2;
const HOLD_FRAMES = 8;
const LIVE_MS = 250;
const IN_TUNE_CENTS = 5;
const FFT = 2048;

function readRef(store) {
  if (!store || typeof store.get !== 'function') return 440;
  let src = null;
  try { src = store.get('tuning'); } catch { return 440; }
  const t = sanitizeTuning(src);
  const ref = t && t.ref;
  return typeof ref === 'number' && Number.isFinite(ref) && ref > 0 ? ref : 440;
}

function voiceOn(ctx) {
  const rig = ctx && ctx.voice;
  if (!rig) return false;
  const prefs = rig.prefs;
  return !!(prefs && prefs.enabled);
}

/**
 * Side chain on the existing mono voice tap (after input gain, before
 * processing). The analyser is not connected onward, so it cannot change
 * what is heard. Returns null when there is no tap to read.
 */
function attachTap(ctx) {
  const host = ctx && ctx.voice && ctx.voice.host;
  const tap = host && host.nodes && host.nodes.tap;
  const ac = tap && tap.context;
  if (!tap || !ac || typeof ac.createAnalyser !== 'function' || typeof tap.connect !== 'function') return null;
  let analyser = null;
  try {
    analyser = ac.createAnalyser();
    analyser.fftSize = FFT;
    analyser.smoothingTimeConstant = 0;
    tap.connect(analyser);
  } catch {
    return null;
  }
  const rate = ac.sampleRate > 0 ? ac.sampleRate : 48000;
  return { tap, analyser, sampleRate: rate };
}

function centsWord(cents) {
  if (Math.abs(cents) <= IN_TUNE_CENTS) return TUNER_TEXT.inTune;
  return cents < 0 ? TUNER_TEXT.flat : TUNER_TEXT.sharp;
}

function liveLine(name, octave, cents) {
  if (!name) return '';
  const word = centsWord(cents);
  if (word === TUNER_TEXT.inTune) return `${name}${octave}, in tune`;
  const n = Math.abs(cents).toFixed(1);
  return word === TUNER_TEXT.flat ? `${name}${octave}, ${n} cents flat` : `${name}${octave}, ${n} cents sharp`;
}

/**
 * @param {object} ctx app context (voice rig, store)
 * @returns {{el: HTMLElement, dispose: Function}}
 */
export function createTunerPanel(ctx) {
  const scope = createScope();
  const link = attachTap(ctx);
  const rate = link ? link.sampleRate : 48000;
  const tuner = createTuner(rate, { size: FFT });
  const timeBuf = new Float32Array(link && link.analyser.fftSize ? link.analyser.fftSize : FFT);

  let refHz = readRef(ctx && ctx.store);
  if (ctx && ctx.store && typeof ctx.store.subscribe === 'function') {
    scope.add(ctx.store.subscribe('tuning', () => { refHz = readRef(ctx.store); }));
  }

  const off = h('p', { class: 'setting-hint tuner-off' }, TUNER_TEXT.voiceOff);
  const nameEl = h('div', { class: 'tuner-name' });
  const octEl = h('div', { class: 'tuner-oct' });
  const centsEl = h('div', { class: 'tuner-cents' });
  const wordEl = h('div', { class: 'tuner-word' });
  const needle = h('span', { class: 'tuner-needle' });
  const gauge = h('div', { class: 'tuner-gauge', 'aria-hidden': 'true' },
    h('span', { class: 'tuner-scale' }, TUNER_TEXT.flat),
    h('span', { class: 'tuner-track' }, h('span', { class: 'tuner-center' }), needle),
    h('span', { class: 'tuner-scale' }, TUNER_TEXT.sharp));
  const live = h('div', { class: 'tuner-live', 'aria-live': 'polite' });
  const readout = h('div', { class: 'tuner-readout' }, nameEl, octEl, centsEl, wordEl);
  const el = h('section', { class: 'settings-group tuner-panel', 'aria-labelledby': 'voice-tuner' },
    h('h3', { class: 'group-title', id: 'voice-tuner' }, TUNER_TEXT.title),
    off, readout, gauge, live);

  let smoothMidi = null;
  let heldNote = null;
  let miss = 0;
  let shownCents = 0;
  let lastNameKey = null;
  let lastLive = null;
  let lastLiveAt = 0;
  let sawOn = null;

  function pushLive(text, nameKey, now) {
    const nameChanged = nameKey !== lastNameKey;
    const due = now - lastLiveAt >= LIVE_MS;
    if (!nameChanged && !(due && text !== lastLive)) return;
    lastNameKey = nameKey;
    lastLive = text;
    lastLiveAt = now;
    setText(live, text);
  }

  function placeNeedle(cents) {
    const pos = 50 + (Math.max(-50, Math.min(50, cents)) / 50) * 42;
    needle.style.left = `${pos}%`;
  }

  scope.add(addLoop((t) => {
    const now = typeof t === 'number' && t > 0 ? t : (lastLiveAt + 16);
    const on = voiceOn(ctx);
    if (!on) {
      if (sawOn !== false) {
        smoothMidi = null;
        heldNote = null;
        miss = 0;
        shownCents = 0;
        off.hidden = false;
        readout.hidden = true;
        gauge.hidden = true;
        el.classList.remove('is-in-tune');
        setText(nameEl, '');
        setText(octEl, '');
        setText(centsEl, '');
        setText(wordEl, '');
        needle.style.left = '50%';
        pushLive(TUNER_TEXT.voiceOff, 'off', now);
      }
      sawOn = false;
      return;
    }
    if (sawOn !== true) {
      off.hidden = true;
      readout.hidden = false;
      gauge.hidden = false;
      sawOn = true;
    }

    let hz = 0;
    let confidence = 0;
    if (link) {
      try {
        link.analyser.getFloatTimeDomainData(timeBuf);
        const r = tuner.detect(timeBuf);
        hz = r.hz;
        confidence = r.confidence;
      } catch {
        hz = 0;
        confidence = 0;
      }
    }
    const clear = hz > 0 && confidence >= CLEAR_CONFIDENCE;
    if (clear) {
      miss = 0;
      const midi = 69 + 12 * Math.log2(hz / refHz);
      if (smoothMidi == null || !Number.isFinite(smoothMidi)) smoothMidi = midi;
      else smoothMidi += (midi - smoothMidi) * FOLLOW;
    } else {
      miss += 1;
      if (miss > HOLD_FRAMES) smoothMidi = null;
    }

    if (smoothMidi == null || !Number.isFinite(smoothMidi)) {
      heldNote = null;
      shownCents += (0 - shownCents) * FOLLOW;
      el.classList.remove('is-in-tune');
      setText(nameEl, '');
      setText(octEl, '');
      setText(centsEl, '');
      setText(wordEl, '');
      placeNeedle(shownCents);
      pushLive('', 'idle', now);
      return;
    }

    const rounded = Math.round(smoothMidi);
    if (heldNote == null || Math.abs(smoothMidi - heldNote) >= 0.55) heldNote = rounded;
    const named = hzToNote(refHz * Math.pow(2, (heldNote - 69) / 12), refHz);
    let target = (smoothMidi - heldNote) * 100;
    if (target > 50) target = 50;
    else if (target < -50) target = -50;
    // The pitch one-pole above is the needle smoother. Copy it straight across
    // so a note change does not glide the needle through centre.
    shownCents = target;

    const inTune = Math.abs(shownCents) <= IN_TUNE_CENTS;
    el.classList.toggle('is-in-tune', inTune);
    setText(nameEl, named.name || '');
    setText(octEl, String(named.octave));
    const shown = Math.round(shownCents * 10) / 10;
    const sign = shown > 0 ? '+' : '';
    setText(centsEl, `${sign}${shown.toFixed(1)} cents`);
    setText(wordEl, centsWord(shownCents));
    placeNeedle(shownCents);
    pushLive(liveLine(named.name, named.octave, shown), `${named.name}${named.octave}`, now);
  }));

  if (!voiceOn(ctx)) {
    off.hidden = false;
    readout.hidden = true;
    gauge.hidden = true;
    setText(live, TUNER_TEXT.voiceOff);
    lastLive = TUNER_TEXT.voiceOff;
    lastNameKey = 'off';
  } else {
    off.hidden = true;
  }

  function dispose() {
    scope.dispose();
    if (link) {
      try { link.tap.disconnect(link.analyser); } catch { /* tap already torn down */ }
    }
  }

  return { el, dispose };
}
