// v2.9 secrets. Small, quiet surprises that never get in the way: none of
// them reacts while a text field has focus, none blocks a key from what it
// normally does, and none changes the sound or the session unless the person
// deliberately takes the offer (a button in a toast, a switch in Settings).
// Nothing here flashes or moves. Each records itself with found('secret', id)
// (src/core/fun.js); the list with hints is src/core/fun-catalog.js.
//
// The recognisers are pure and exported for the tests; installEggs() wires
// them into the app, and installConsoleEgg() greets people in the console.

import { isTypingTarget } from './dom.js';
import { found, has, list, onFun, funData, setFunData } from '../core/fun.js';
import { findName, progress } from '../core/fun-catalog.js';
import { SHORT_CIRCUIT_DMG } from '../dsp/damage.js';
import { ACID_PATCH } from '../presets/hidden-patches.js';

export const KONAMI = ['ArrowUp', 'ArrowUp', 'ArrowDown', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'ArrowLeft', 'ArrowRight', 'b', 'a'];
export const LOGO_TAPS = 7;
export const LOGO_WINDOW_MS = 3000;
export const DROP_COUNT = 10;
export const DROP_WINDOW_MS = 30000;
export const TEMPO_303_DELAY_MS = 800;

/** The key a keydown counts as for the sequence: arrows by name, letters lower-cased. */
function seqKey(e) {
  const k = e.key || '';
  if (k.startsWith('Arrow')) return k;
  if (k.length === 1) return k.toLowerCase();
  if (/^Key[A-Z]$/.test(e.code || '')) return e.code.slice(3).toLowerCase();
  return k;
}

/**
 * Recognises the sequence passively: feed() never prevents or stops an
 * event, so note keys and shortcuts keep working. A key typed into a field,
 * a modifier chord or any key off the sequence starts it over.
 */
export function createKonami(onMatch) {
  let i = 0;
  return {
    feed(e) {
      if (!e || e.repeat) return false;
      if (e.ctrlKey || e.metaKey || e.altKey || isTypingTarget(e.target)) { i = 0; return false; }
      const k = seqKey(e);
      if (k === KONAMI[i]) i++;
      // a wrong key resets; "Up" after "Up Up" keeps the last two
      else i = k === KONAMI[0] ? (i === 2 ? 2 : 1) : 0;
      if (i < KONAMI.length) return false;
      i = 0;
      if (onMatch) onMatch();
      return true;
    },
    reset() { i = 0; },
    position: () => i,
    /** True when `e` would continue or complete a sequence already under way (read before feed()). */
    continues(e) {
      if (!e || e.repeat || i === 0) return false;
      if (e.ctrlKey || e.metaKey || e.altKey || isTypingTarget(e.target)) return false;
      return seqKey(e) === KONAMI[i];
    },
  };
}

/**
 * Remembers whether the latest B press belonged to the Konami sequence, so the
 * looper's "Nothing to undo" toast (B is the looper undo key) stays quiet for
 * that press. Any B press outside the sequence clears it again.
 */
export function createUndoKeyGuard(konami) {
  let claimed = false;
  return {
    note(e) { if (e && !e.repeat && seqKey(e) === 'b') claimed = konami.continues(e); },
    claimed: () => claimed,
  };
}

/** True once `count` events land within `windowMs` of each other; then starts over. */
export function createBurstCounter(count, windowMs) {
  let times = [];
  return {
    hit(t = Date.now()) {
      times = times.filter(x => t - x < windowMs);
      times.push(t);
      if (times.length < count) return false;
      times = [];
      return true;
    },
    reset() { times = []; },
    size: () => times.length,
  };
}

export const createLogoCounter = () => createBurstCounter(LOGO_TAPS, LOGO_WINDOW_MS);
export const createDropCounter = () => createBurstCounter(DROP_COUNT, DROP_WINDOW_MS);

/**
 * A tempo field parser that knows one missing tempo: typing 404 calls
 * onNotFound and returns NaN, so the field keeps the tempo it had.
 */
export function tempoParser(onNotFound) {
  return (text) => {
    const s = String(text).trim();
    if (s === '404') { if (onNotFound) onNotFound(); return NaN; }
    return parseFloat(s.replace(',', '.'));
  };
}

/** Whether a tempo change should offer the acid patch: exactly 303, set by the person. */
export const isAcidTempo = (value, meta) => value === 303 && !!meta && meta.source === 'ui';

// ---------------------------------------------------------------- Phosphor theme

const skinListeners = new Set();
export const PHOSPHOR = 'phosphor';
export function skinOn() { return funData('skin') === PHOSPHOR && has('secret', 'logo-seven'); }
export function applySkin(root = typeof document !== 'undefined' ? document.documentElement : null) {
  if (!root) return;
  if (skinOn()) root.dataset.skin = PHOSPHOR; else delete root.dataset.skin;
}
export function setSkin(on) {
  setFunData('skin', on ? PHOSPHOR : '');
  applySkin();
  for (const fn of skinListeners) { try { fn(); } catch { /* ignore */ } }
}
export function onSkin(fn) { skinListeners.add(fn); return () => skinListeners.delete(fn); }

// ---------------------------------------------------------------- toasts, one at a time

const SEE = 'See Settings > Operator > Bookkeeping.';
function counts() {
  const p = progress('secret', list('secret'));
  return `${p.found} of ${p.total}`;
}

export function createFunToaster(toast, timers = { setTimeout: (f, ms) => setTimeout(f, ms), clearTimeout: (id) => clearTimeout(id) }) {
  const queue = [];
  let busy = false, timer = 0, dismiss = null;
  function next() {
    busy = false; dismiss = null;
    const item = queue.shift();
    if (!item || !toast) return;
    busy = true;
    const timeout = item.opts.timeout || 3200;
    dismiss = toast(item.msg, { kind: 'info', ...item.opts, timeout });
    timer = timers.setTimeout(next, timeout + 250);
  }
  return {
    say(msg, opts = {}) { queue.push({ msg, opts }); if (!busy) next(); },
    pending: () => queue.length,
    dispose() { timers.clearTimeout(timer); queue.length = 0; if (dismiss) dismiss(); },
  };
}

// ---------------------------------------------------------------- the app

/**
 * Wires the secrets into the running app. ctx: { store, music, presets, toast,
 * layers, binder }. Returns { reveal, dropped, spilled, repaired, unlockPath, undoKeyClaimed, dispose }
 * (ctx.eggs), used by the Operator panel and the path picker.
 */
export function installEggs(ctx) {
  const { store, music, presets } = ctx;
  const subs = [];
  const fun = createFunToaster(ctx.toast);
  subs.push(() => fun.dispose());
  let quiet = false;

  // Finds made elsewhere (badges, other features): one short toast each.
  subs.push(onFun(({ kind, id }) => {
    if (quiet) return;
    if (kind === 'secret') fun.say('Secret found', { detail: `${findName('secret', id)}. ${counts()} found. ${SEE}` });
    else fun.say('Badge earned', { kind: 'success', detail: `${findName('badge', id)}. ${SEE}` });
  }));

  /** Records secret `id` without the generic toast; true the first time. */
  function record(id) {
    quiet = true;
    try { return found('secret', id); } finally { quiet = false; }
  }
  function say(first, message, detail = '', opts = {}) {
    const extra = first ? `Secret ${counts()} found. ${SEE}` : '';
    fun.say(message, { ...opts, detail: [detail, extra].filter(Boolean).join(' ') || undefined });
  }
  /** Records secret `id` and shows `message`, with the count the first time. */
  function reveal(id, message, detail = '', opts = {}) {
    const first = record(id);
    say(first, message, detail, opts);
    return first;
  }

  // The sequence on the computer keyboard, unlocking the Cabinet
  const konami = createKonami(() => {
    const again = has('secret', 'konami');
    reveal('konami', again ? 'The cabinet is already open' : 'Cabinet unlocked',
      'A Cabinet terrain is in the Image library of the map panel and a Cabinet patch is in the patch browser.');
  });
  const undoGuard = createUndoKeyGuard(konami);
  const onKey = (e) => {
    if (ctx.layers && ctx.layers.hasModal && ctx.layers.hasModal()) { konami.reset(); return; }
    undoGuard.note(e);
    konami.feed(e);
  };
  window.addEventListener('keydown', onKey, true);
  subs.push(() => window.removeEventListener('keydown', onKey, true));

  // Seven quick taps on the logo: the Phosphor theme
  const logo = createLogoCounter();
  const onClick = (e) => {
    const t = e.target;
    if (!t || !t.closest || !t.closest('.brand-mark, .brand-word')) return;
    if (!logo.hit(performance.now())) return;
    const first = record('logo-seven');
    const on = !skinOn();
    setSkin(on);
    say(first, on ? 'Phosphor theme on' : 'Phosphor theme off', 'Switch it in Settings > General > Appearance.');
  };
  document.addEventListener('click', onClick);
  subs.push(() => document.removeEventListener('click', onClick));
  applySkin();

  // Exactly 303 BPM, set by hand: offer the acid patch
  let acidTimer = 0;
  if (store) {
    subs.push(store.subscribe('global.tempo', (path, value, meta) => {
      clearTimeout(acidTimer);
      if (!isAcidTempo(value, meta)) return;
      acidTimer = setTimeout(() => {
        if (store.get('global.tempo') !== 303) return;
        reveal('tempo-303', '303 BPM', 'Load a squelchy acid patch onto the selected track?', {
          timeout: 9000,
          action: {
            label: 'Load patch',
            onClick: () => {
              if (presets && presets.loadPatch('sel', ACID_PATCH)) ctx.toast?.(`Loaded ${ACID_PATCH.name}`, { kind: 'success' });
            },
          },
        });
      }, TEMPO_303_DELAY_MS);
    }));
    subs.push(() => clearTimeout(acidTimer));
  }

  // The kill screen, the first time a pattern breaks up
  if (music && music.transport && typeof music.transport.on === 'function') {
    const off = music.transport.on('killscreen', () => reveal('kill-screen', 'Kill screen',
      'A pattern has looped 256 times and is breaking up. Your saved pattern is fine. Stop to reset it.'));
    if (typeof off === 'function') subs.push(off);
  }

  // Operator panel hooks
  const drops = createDropCounter();
  const api = {
    reveal,
    tempoNotFound() { reveal('tempo-404', 'Tempo not found', 'The tempo stays where it was.'); },
    dropped() {
      found('badge', 'first-drop');
      if (drops.hit(Date.now())) reveal('stop-dropping', 'Please stop dropping me.');
    },
    /** After a spill; `op` = operator switches, `state` = { dmg, wet }. */
    spilled(op, state) {
      if (op && op.drop === 1 && op.water === 1 && state && state.dmg >= SHORT_CIRCUIT_DMG) reveal('short-circuit', 'That was not good for the circuits.');
    },
    repaired() { found('badge', 'repair-crew'); },
    /** True while the latest B press was part of the Konami sequence (looper undo stays quiet). */
    undoKeyClaimed: () => undoGuard.claimed(),
    unlockPath() { return reveal('oro-path', 'A new path: Oro', 'It traces the letters O, R and O.'); },
    dispose() { for (const u of subs.splice(0)) { try { u(); } catch { /* ignore */ } } },
  };
  return api;
}

// ---------------------------------------------------------------- the console

const ART = [
  ' ###   ####    ### ',
  '#   #  #   #  #   #',
  '#   #  ####   #   #',
  '#   #  #  #   #   #',
  ' ###   #   #   ### ',
];
export const CONSOLE_HINT = 'Call the machine by its name and ask for its secret().';

/**
 * Greets the console once and exposes window.oro.secret(). 2.17: window.oro
 * is also the agent API (src/agent/api.js), so the secret joins it instead
 * of being skipped when the API got there first.
 */
export function installConsoleEgg(win = typeof window !== 'undefined' ? window : null) {
  if (!win) return;
  const existing = win.oro && typeof win.oro === 'object' ? win.oro : null;
  if (existing && typeof existing.secret === 'function') return;
  try { console.log(`${ART.join('\n')}\n\n${CONSOLE_HINT}`); } catch { /* no console */ }
  const secret = () => {
    found('secret', 'console');
    return 'Thank you for looking under the hood. This one is now in Settings > Operator > Bookkeeping.';
  };
  if (existing) {
    try { Object.defineProperty(existing, 'secret', { value: secret, enumerable: false }); return; } catch { /* frozen: fall through */ }
  }
  if (!existing) win.oro = Object.freeze({ secret });
}
