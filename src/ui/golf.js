// Golf (v2.9): rounds of 9 or 18 holes on the map with the Roll marble, and
// a driving range. The rules, course and scores are in core/golf.js; the map
// draws the hole, the aim line and the range flags (visual/fun-layer.js).
// This file runs a game: the panel over the map, pointer and keyboard aiming,
// the chord on a sink, the range notes, the scorecard and the saved bests.
//
// Nothing here edits the session. The golf feel is an override in the dot
// simulation (the stored dot settings never change), the ball moves like any
// Roll marble (source 'physics', not undoable), and quitting puts the dot
// back exactly where it was in the mode it had.

import { h, setText } from './dom.js';
import { addLoop } from './frame.js';
import { stepToMidi } from '../core/params.js';
import { found, funData, setFunData } from '../core/fun.js';
import {
  MAX_SHOT, MAX_STROKES, GOLF_PHYSICS, layoutCourse, roundName, sinks, torusDist, createRest, restStep,
  holeMessage, holeBadges, roundBadges, recordHole, recordRound, golfScores, bestTotal, sumStrokes,
  rangeTee, rangeFlags, createCarry, carryStep, carryYards, recordDrive, driveDegree,
} from '../core/golf.js';

const AIM_DRAG = 3.5;          // world units of drag for full power
const CHARGE_MS = 1300;        // holding Space this long gives full power
const NEXT_HOLE_MS = 2600;
const RANGE_RESET_MS = 2200;
const DEG = Math.PI / 180;
const META = Object.freeze({ source: 'physics', user: false });
const yardText = (n) => `${n} yard${n === 1 ? '' : 's'}`;

let active = null;

export function golfActive() { return !!active; }

/** Open Golf on the selected track (a choice of game first). Returns the game, or null. */
export function startGolf(ctx) {
  if (active) return active;
  const { store, binder, visuals } = ctx;
  const fun = visuals && visuals.fun;
  if (!fun) {
    ctx.toast && ctx.toast('Golf needs the 3D map', { kind: 'info', detail: 'The map is not running on this computer.' });
    return null;
  }
  const part = binder.selected();
  const cxPath = `parts.${part}.params.centerX`, cyPath = `parts.${part}.params.centerY`;
  const saved = { cx: store.get(cxPath), cy: store.get(cyPath) };
  const heightAt = (u, v) => fun.height(u, v);

  // ------------------------------------------------------------ panel
  const status = h('div', { class: 'golf-status' });
  const msg = h('p', { class: 'golf-msg', role: 'status', 'aria-live': 'polite' });
  const aimText = h('p', { class: 'golf-aim', 'aria-live': 'polite' });
  const hint = h('p', { class: 'golf-hint' });
  const choose = (label, detail, value) => {
    const b = h('button', { type: 'button', class: 'btn btn--sm golf-choice' }, h('strong', null, label), h('span', null, detail));
    b.addEventListener('click', () => begin(value));
    return b;
  };
  const menu = h('div', { class: 'golf-menu', role: 'group', 'aria-label': 'Choose a game' },
    choose('9 holes', 'Front nine', 9), choose('18 holes', 'Full 18', 18), choose('Driving range', 'Practice shots', 'range'));
  const nextBtn = h('button', { type: 'button', class: 'btn btn--primary btn--sm', hidden: true }, 'Next hole');
  const teeBtn = h('button', { type: 'button', class: 'btn btn--ghost btn--sm', hidden: true }, 'Back to the tee');
  const quitBtn = h('button', { type: 'button', class: 'btn btn--ghost btn--sm' }, 'Quit');
  const card = h('div', { class: 'golf-card', hidden: true });
  const hud = h('section', { class: 'golf-hud', role: 'region', 'aria-label': 'Golf', tabindex: '-1' },
    h('div', { class: 'golf-head' }, h('strong', { class: 'golf-title' }, 'Golf'), status),
    msg, menu, aimText, hint, card,
    h('div', { class: 'golf-actions' }, teeBtn, nextBtn, quitBtn));
  const host = ctx.viewport || (visuals.canvas && visuals.canvas.parentElement) || document.body;
  host.appendChild(hud);

  // ------------------------------------------------------------ state
  let mode = null;               // 9, 18 or 'range'
  let phase = 'menu';            // menu, aim, roll, between, card (rounds); aim, roll, result (range)
  let course = [], holes = 9, holeIdx = 0, strokes = 0;
  let tee = null, carry = createCarry(0, 0);
  let angle = 0, power = 0.5;
  let charging = false, chargeAt = 0, dragging = false;
  let timer = 0, started = false;
  const rest = createRest();
  const ball = { u: 0, v: 0, speed: 0 };
  const aimOut = { dx: 0, dz: 0 };
  let scores = [];

  const range = () => mode === 'range';
  const H = () => course[holeIdx];
  const d = (a, b) => { const x = a - b; return x - Math.round(x); };
  const angleTo = (u, v) => { fun.ball(ball); return Math.atan2(d(v, ball.v), d(u, ball.u)); };
  const defaultAngle = () => (range() ? tee.angle : angleTo(H().hole.u, H().hole.v));

  function renderStatus() {
    if (phase === 'menu') setText(status, 'Choose a game');
    else if (range()) {
      const best = golfScores(funData('golf')).bestDrive;
      setText(status, `Driving range${best ? ` · Best ${yardText(best)}` : ''}`);
    } else if (phase === 'card') setText(status, `${roundName(holes)} complete`);
    else setText(status, `Hole ${holeIdx + 1} of ${holes} · Par ${H().par} · Strokes ${strokes}`);
  }
  function renderAim() {
    if (phase !== 'aim') { setText(aimText, ''); fun.setAim(null); return; }
    fun.setAim(angle, power);
    let off = (angle - defaultAngle()) / DEG;
    off -= 360 * Math.round(off / 360);
    const what = range() ? 'the flags' : 'the hole';
    const side = Math.abs(off) < 0.5 ? `straight at ${what}` : `${Math.round(Math.abs(off))} degrees ${off > 0 ? 'right' : 'left'} of ${what}`;
    setText(aimText, `Aim ${side}, power ${Math.round(power * 100)}%`);
  }

  function begin(value) {
    if (!started) { fun.setOverride(part, GOLF_PHYSICS); started = true; }
    menu.hidden = true;
    mode = value;
    if (range()) {
      tee = rangeTee(heightAt);
      fun.setHole(null);
      teeBtn.hidden = false;
      setText(hint, 'Drag from the marble to aim and let go to shoot, or turn with the arrows and hold Space. R puts the ball back on the tee. Yards here are a game measure. Esc quits.');
      setText(msg, 'Driving range. Hit it as far as you like.');
      toTee();
    } else {
      holes = value === 18 ? 18 : 9;
      course = layoutCourse(heightAt, holes);
      scores = Array(holes).fill(null);
      fun.setFlags(null);
      setText(hint, 'Drag from the marble to aim and let go to shoot. Keys: arrows aim, hold Space to charge, let go to shoot. Esc quits.');
      startHole(0);
    }
    try { hud.focus({ preventScroll: true }); } catch { /* old browsers */ }
  }

  // ------------------------------------------------------------ rounds
  function startHole(i) {
    holeIdx = i; strokes = 0;
    clearTimeout(timer);
    nextBtn.hidden = true;
    fun.place(H().start.u, H().start.v);
    fun.setHole(H().hole.u, H().hole.v);
    phase = 'aim';
    angle = defaultAngle(); power = 0.5;
    setText(msg, `Hole ${i + 1}. Par ${H().par}.`);
    renderStatus(); renderAim();
  }

  function shoot(p) {
    if (phase !== 'aim') return;
    const pw = Math.min(1, Math.max(0.05, p));
    if (!range()) strokes += 1;
    phase = 'roll';
    rest.slow = 0; rest.t = 0;
    fun.setAim(null);
    setText(aimText, '');
    fun.shoot(Math.cos(angle) * pw * MAX_SHOT, Math.sin(angle) * pw * MAX_SHOT);
    renderStatus();
  }

  function play(notes, vel, holdMs, strumMs) {
    const router = ctx.music && ctx.music.router;
    if (!router || typeof router.noteOn !== 'function') return;
    notes.forEach((n, i) => setTimeout(() => { try { router.noteOn(part, n, vel, 'golf'); } catch { /* gone */ } }, i * strumMs));
    setTimeout(() => { for (const n of notes) { try { router.noteOff(part, n, 'golf'); } catch { /* gone */ } } }, holdMs);
  }
  const keyNote = (degree, octave) => {
    const root = Math.round(Number(store.get('global.scaleRoot')) || 0);
    const type = Math.round(Number(store.get('global.scaleType')) || 0);
    return stepToMidi({ degree, octave: 0 }, octave, root, type);
  };

  function award(ids) { for (const id of ids) found('badge', id); }

  function finishHole(sunk) {
    const s = sunk ? strokes : MAX_STROKES;
    scores[holeIdx] = s;
    const par = H().par;
    if (sunk) {
      fun.place(H().hole.u, H().hole.v);
      play([0, 2, 4, 7].map(dg => keyNote(dg, 4)), 0.55, 1200, 70);
      award(holeBadges(s, par));
    }
    const rec = recordHole(funData('golf'), holeIdx, s);
    setFunData('golf', rec.scores);
    phase = 'between';
    setText(msg, (sunk ? holeMessage(holeIdx + 1, s, par) : `Hole ${holeIdx + 1}: picked up after ${MAX_STROKES} strokes (par ${par})`) + (rec.best && sunk ? '. Your best on this hole.' : ''));
    renderStatus(); renderAim();
    nextBtn.hidden = holeIdx + 1 >= holes;
    nextBtn.textContent = 'Next hole';
    timer = setTimeout(() => { if (active === game && phase === 'between') next(); }, NEXT_HOLE_MS);
  }

  function showCard() {
    clearTimeout(timer);
    phase = 'card';
    fun.setHole(null); fun.setAim(null);
    const total = sumStrokes(scores);
    const parTotal = course.reduce((a, c) => a + c.par, 0);
    const rec = recordRound(funData('golf'), total, holes);
    setFunData('golf', rec.scores);
    award(roundBadges(total, parTotal));
    const best = golfScores(rec.scores);
    card.textContent = '';
    const head = h('tr', null, h('th', { scope: 'col' }, 'Hole'), h('th', { scope: 'col' }, 'Par'), h('th', { scope: 'col' }, 'Strokes'), h('th', { scope: 'col' }, 'Best'));
    const rows = course.map((c, i) => h('tr', null, h('th', { scope: 'row' }, String(i + 1)), h('td', null, String(c.par)), h('td', null, String(scores[i] ?? '-')), h('td', null, String(best.bestHoles[i] ?? '-'))));
    const foot = h('tr', { class: 'golf-total' }, h('th', { scope: 'row' }, 'Total'), h('td', null, String(parTotal)), h('td', null, String(total)), h('td', null, String(bestTotal(best, holes) ?? '-')));
    card.appendChild(h('table', { class: 'golf-table' }, h('caption', null, `Scorecard: ${roundName(holes)}`), h('thead', null, head), h('tbody', null, ...rows, foot)));
    card.hidden = false;
    hint.hidden = true;
    const diff = total - parTotal;
    setText(msg, `${roundName(holes)} complete: ${total} strokes, ${diff === 0 ? 'level par' : diff < 0 ? `${-diff} under par` : `${diff} over par`}.${rec.best ? ' A new best round.' : ''}`);
    nextBtn.hidden = false;
    nextBtn.textContent = 'Play again';
    renderStatus();
    nextBtn.focus({ preventScroll: true });
  }

  function next() {
    if (phase === 'between') {
      if (holeIdx + 1 < holes) startHole(holeIdx + 1);
      else showCard();
    } else if (phase === 'card') {
      card.hidden = true; hint.hidden = false;
      begin(holes);
    }
  }

  // ------------------------------------------------------------ driving range
  function toTee() {
    clearTimeout(timer);
    fun.place(tee.u, tee.v);
    fun.setFlags(rangeFlags(tee), tee.u, tee.v);   // set out from this copy of the tee
    carry = createCarry(tee.u, tee.v);
    phase = 'aim';
    angle = tee.angle; power = 0.5;
    renderStatus(); renderAim();
  }

  function rangeResult() {
    const yards = carryYards(carry);
    const height = fun.height(ball.u, ball.v);
    fun.place(ball.u, ball.v);
    const rec = recordDrive(funData('golf'), yards);
    setFunData('golf', rec.scores);
    play([keyNote(driveDegree(yards), 3)], 0.6, 420, 0);
    phase = 'result';
    setText(msg, `${yardText(yards)}, ending at height ${height >= 0 ? '+' : ''}${height.toFixed(2)}.${rec.best ? ' Your longest yet.' : ''}`);
    renderStatus(); renderAim();
    timer = setTimeout(() => { if (active === game && phase === 'result') toTee(); }, RANGE_RESET_MS);
  }

  // ------------------------------------------------------------ frame loop
  let last = performance.now();
  const offLoop = addLoop(() => {
    const now = performance.now();
    const dt = Math.min(2, Math.max(0, (now - last) / 1000));   // real time, so the shot timeout holds on slow frames
    last = now;
    if (phase === 'roll') {
      fun.ball(ball);
      if (range()) carryStep(carry, ball.u, ball.v);
      if (!range() && sinks(torusDist(ball.u, ball.v, H().hole.u, H().hole.v), ball.speed)) { finishHole(true); return; }
      if (restStep(rest, ball.speed, dt)) {
        if (range()) { rangeResult(); return; }
        if (strokes >= MAX_STROKES) { finishHole(false); return; }
        phase = 'aim';
        fun.place(ball.u, ball.v);      // hold it still while aiming
        angle = defaultAngle();
        renderStatus(); renderAim();
      }
    } else if (phase === 'aim' && charging) {
      power = Math.min(1, (now - chargeAt) / CHARGE_MS);
      fun.setAim(angle, power);
    }
  });

  // ------------------------------------------------------------ pointer (from the map)
  fun.setInput((kind, x, y) => {
    if (kind === 'down') {
      if (phase !== 'aim') return false;
      dragging = true;
      return true;
    }
    if (!dragging) return false;
    if (kind === 'move') {
      if (fun.aimAt(x, y, aimOut)) {
        angle = Math.atan2(aimOut.dz, aimOut.dx);
        power = Math.min(1, Math.hypot(aimOut.dx, aimOut.dz) / AIM_DRAG);
        fun.setAim(angle, power);
      }
    } else if (kind === 'up') {
      dragging = false;
      if (power >= 0.04) shoot(power);
      else renderAim();
    } else {
      dragging = false;
      renderAim();
    }
    return true;
  });

  // ------------------------------------------------------------ keyboard
  const typing = (t) => !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
  const inOtherDialog = (t) => !!(t && t.closest && t.closest('[role="dialog"], [role="alertdialog"]') && !hud.contains(t));
  const eat = (e) => { e.preventDefault(); e.stopImmediatePropagation(); };
  const playing = () => phase !== 'menu' && phase !== 'card';
  function onKeyDown(e) {
    if (e.ctrlKey || e.metaKey || e.altKey || typing(e.target) || inOtherDialog(e.target)) return;
    const k = e.key;
    if (k === 'Escape') { eat(e); quit(); return; }
    if (!playing()) return;           // the choice and the scorecard are plain buttons
    if (k === 'Enter' && phase === 'between' && !(e.target && e.target.tagName === 'BUTTON')) { eat(e); next(); return; }
    if ((k === 'r' || k === 'R') && range()) { eat(e); toTee(); return; }
    if (k === 'ArrowLeft' || k === 'ArrowRight' || k === 'ArrowUp' || k === 'ArrowDown') {
      eat(e);
      if (phase !== 'aim') return;
      const step = (k === 'ArrowUp' || k === 'ArrowDown' ? 15 : e.shiftKey ? 1 : 3) * DEG;
      angle += k === 'ArrowRight' || k === 'ArrowDown' ? step : -step;
      renderAim();
      return;
    }
    if (k === ' ' || k === 'Spacebar') {
      eat(e);
      if (phase !== 'aim' || e.repeat || charging) return;
      charging = true; chargeAt = performance.now(); power = 0;
      fun.setAim(angle, 0);
    }
  }
  function onKeyUp(e) {
    if (e.key !== ' ' && e.key !== 'Spacebar') return;
    if (!charging) return;
    eat(e);
    charging = false;
    shoot(power);
  }
  window.addEventListener('keydown', onKeyDown, true);
  window.addEventListener('keyup', onKeyUp, true);
  nextBtn.addEventListener('click', next);
  teeBtn.addEventListener('click', () => { if (range()) toTee(); });
  quitBtn.addEventListener('click', () => quit());

  // The game ends with the track, a session load or the page.
  const offSel = store.subscribe('ui.selectedPart', () => quit());
  const offLoad = store.subscribe('', (path) => { if (path === '') quit(false); });
  const onHide = () => quit();
  window.addEventListener('pagehide', onHide, true);
  window.addEventListener('beforeunload', onHide, true);

  function quit(restorePosition = true) {
    if (active !== game) return;
    active = null;
    clearTimeout(timer);
    offLoop(); offSel(); offLoad();
    window.removeEventListener('keydown', onKeyDown, true);
    window.removeEventListener('keyup', onKeyUp, true);
    window.removeEventListener('pagehide', onHide, true);
    window.removeEventListener('beforeunload', onHide, true);
    fun.setInput(null);
    fun.setAim(null);
    fun.setHole(null);
    fun.setFlags(null);
    if (started) {
      fun.shoot(0, 0);                  // let go of the ball
      // Back where it was, then back to its own mode (the sim starts that mode
      // there). A session that was just loaded already has its own place.
      if (restorePosition) {
        store.batch(() => {
          if (saved.cx !== undefined) store.set(cxPath, saved.cx, META);
          if (saved.cy !== undefined) store.set(cyPath, saved.cy, META);
        });
      }
      fun.setOverride(part, null);
    }
    hud.remove();
  }

  const game = {
    quit: () => quit(), part, begin,
    get mode() { return mode; }, get phase() { return phase; }, get hole() { return holeIdx; }, get strokes() { return strokes; },
  };
  active = game;
  renderStatus();
  setText(msg, 'Play a round, or practise on the driving range.');
  try { menu.querySelector('button').focus({ preventScroll: true }); } catch { /* old browsers */ }
  return game;
}
