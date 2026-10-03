// v2.9 coin slot (Settings > Operator > Coin slot). With Free Play on (the
// default) nothing here runs and the note path is untouched. With it off,
// the router's note gate (src/music/coin-gate.js) keeps every note-on from
// the keys, MIDI and the sequencer silent until a coin goes in: C on the
// computer keyboard (it lowers the keyboard velocity otherwise) or the Insert
// coin button. A small static status says INSERT COIN or how many credits
// are left; nothing blinks.

import { h, setText } from './dom.js';
import { createCoinGate, CREDIT_MS, formatLeft } from '../music/coin-gate.js';
import { OPERATOR_DEFAULTS, sanitizeOperator } from '../dsp/damage.js';

const freePlayOn = (store) => (sanitizeOperator(store.get('operator')) || OPERATOR_DEFAULTS).freePlay !== 0;

/** ctx: { store, music, root, eggs?, announce? }. Returns ctx.coins. */
export function createCoinSlot(ctx, { now = () => Date.now() } = {}) {
  const { store } = ctx;
  const router = ctx.music && ctx.music.router;
  const gate = createCoinGate({ now });
  const listeners = new Set();
  let on = false;       // Free Play off: the gate is in
  let timer = 0;
  let blockedSaid = 0;

  const coinBtn = h('button', { type: 'button', class: 'btn btn--sm coin-btn', 'aria-label': 'Insert coin (C key)' }, 'Insert coin');
  const label = h('span', { class: 'coin-label' });
  const credits = h('span', { class: 'coin-credits' });
  const status = h('div', { class: 'coin-status', role: 'status', 'aria-live': 'polite', hidden: true }, label, credits, coinBtn);
  coinBtn.addEventListener('click', () => insert());
  if (ctx.root) ctx.root.appendChild(status);

  function text() {
    const n = gate.credits();
    const left = gate.left();
    return { label: n > 0 ? (left > 0 ? `${formatLeft(left)} left` : 'Ready') : 'INSERT COIN', credits: `Credits: ${n}` };
  }
  function render() {
    status.hidden = !on;
    if (!on) return;
    const t = text();
    setText(label, t.label);
    setText(credits, t.credits);
    status.classList.toggle('is-empty', gate.credits() === 0);
    for (const fn of listeners) { try { fn(); } catch { /* ignore */ } }
  }

  function allow(part, note, source) {
    if (source === 'bounce') return true;
    const ok = gate.allow();
    if (!ok) {
      const t = now();
      if (t - blockedSaid > 10000) { blockedSaid = t; ctx.announce?.('Insert coin to play'); }
    }
    if (ok && gate.left() > CREDIT_MS - 1500) render();   // a credit just started
    return ok;
  }

  function sync() {
    const want = !freePlayOn(store);
    if (want === on) return;
    on = want;
    if (router && typeof router.setGate === 'function') router.setGate(on ? allow : null);
    clearInterval(timer);
    if (on) timer = setInterval(render, 1000);
    else gate.reset();
    render();
  }

  function insert() {
    if (!on) return false;
    const coins = gate.insert();
    render();
    ctx.announce?.(`Coin inserted. Credits: ${gate.credits()}`);
    if (coins === 1 && ctx.eggs) ctx.eggs.reveal('insert-coin', 'Credit added', 'Each coin is 3 minutes of play, counted from the first note.');
    return true;
  }

  const offA = store.subscribe('operator', sync);
  const offB = store.subscribe('', (path) => { if (path === '') sync(); });
  sync();

  return {
    insert,
    /** True while Free Play is off, so C inserts a coin instead of lowering the velocity. */
    coinKey: () => on,
    active: () => on,
    credits: () => gate.credits(),
    left: () => gate.left(),
    text,
    onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    dispose() {
      offA(); offB(); clearInterval(timer);
      if (on && router && typeof router.setGate === 'function') router.setGate(null);
      status.remove();
    },
  };
}
