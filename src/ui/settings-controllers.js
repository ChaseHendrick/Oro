// Settings > Controllers (2.12): game controllers and haptics. Loaded when the
// tab is opened. Turning controllers on, the dot speed and deadzone, the
// mapping and the haptics are kept on this computer (localStorage), never in
// the session. The live test reads the pad only while this pane is open.

import { h, setText, createScope } from './dom.js';
import { addLoop } from './frame.js';
import { loadPadHost } from './gamepad-boot.js';
import { padSupport, listPads, canRumble } from './gamepad-host.js';
import {
  PAD_ACTIONS, PAD_ACTION_MAP, defaultPadPrefs, inputName, detectAssign, padSnapshot, BUTTON_NAMES, AXIS_NAMES,
} from '../core/gamepad.js';

const ASSIGN_MS = 8000;

const row = (label, hint, control, cls = '') => h('div', { class: ['setting-row', cls] },
  h('div', { class: 'setting-text' }, h('div', { class: 'setting-label' }, label), hint ? h('div', { class: 'setting-hint' }, hint) : null), control);

function checkbox(id, label, checked, onChange) {
  const box = h('input', { type: 'checkbox', id, checked: !!checked });
  box.addEventListener('change', () => onChange(box.checked));
  return { box, el: h('label', { class: 'pad-check', for: id }, box, h('span', null, label)) };
}

function slider(label, min, max, step, value, format, onInput) {
  const out = h('output', { class: 'pad-out' }, format(value));
  const input = h('input', { type: 'range', min: String(min), max: String(max), step: String(step), value: String(value), 'aria-label': label, class: 'pad-range' });
  input.addEventListener('input', () => { const v = Number(input.value); setText(out, format(v)); onInput(v); });
  return { input, el: h('div', { class: 'inline-controls' }, input, out) };
}

export function createControllerSettings(ctx, { nav = globalThis.navigator } = {}) {
  const scope = createScope();
  const root = h('div', { class: 'settings-controllers' });
  const support = padSupport(nav);
  const state = { host: null };

  root.appendChild(h('p', { class: 'settings-note' },
    'Off by default. Play Oro with a game controller: the left stick moves the dot, the right stick is two Link sources (Pad Stick X and Pad Stick Y), the triggers and A, B, X, Y play notes in the key (or drum pads), the D-pad changes octave and track, and Start plays or stops. In Golf the left stick aims, a held trigger charges and letting go shoots. These settings stay on this computer.'));

  const body = h('div');
  root.appendChild(body);
  if (!support.gamepads) {
    body.appendChild(h('p', { class: 'settings-note', role: 'status' }, 'Game controllers are not supported on this device.'));
  } else {
    body.appendChild(h('p', { class: 'settings-note', role: 'status' }, 'Loading…'));
  }
  // Phone pulses work without the Gamepad API, so the haptics group always shows.
  loadPadHost(ctx).then((host) => {
    if (!host || scope.disposed) return;
    state.host = host;
    body.replaceChildren(build(host));
  });

  function build(host) {
    const prefs = () => host.prefs;
    const set = (patch) => { host.setPrefs(patch); renderAll(); };
    const frag = h('div');

    // ------------------------------------------------------------ controllers
    let mapRows = [];
    if (support.gamepads) {
      const on = checkbox('pad-on', 'Use game controllers', prefs().on, (v) => set({ on: v }));
      const list = h('ul', { class: 'pad-list', 'aria-live': 'polite' });
      const speed = slider('Dot speed', 0.05, 2, 0.05, prefs().speed, v => `${Math.round(v * 100)}%`, (v) => host.setPrefs({ speed: v }));
      const dz = slider('Deadzone', 0, 0.5, 0.01, prefs().deadzone, v => v.toFixed(2), (v) => host.setPrefs({ deadzone: v }));
      frag.appendChild(h('section', { class: 'settings-group', 'aria-labelledby': 'pad-main' },
        h('h3', { class: 'group-title', id: 'pad-main' }, 'Game controllers'),
        h('p', { class: 'setting-hint' }, 'Not tested with every controller. Pads with the standard layout work as they are; others may need the mapping below.'),
        row('Controllers', 'Off by default. Polls the controller only while this is on and one is connected.', on.el),
        h('div', { class: 'setting-row setting-row--stack' }, h('div', { class: 'setting-text' }, h('div', { class: 'setting-label' }, 'Connected'), list)),
        row('Dot speed', 'How fast the left stick moves the dot at full tilt.', speed.el, 'setting-row--stack'),
        row('Deadzone', 'Stick movement ignored around the middle, so a resting stick does nothing.', dz.el, 'setting-row--stack')));

      // live test
      const btnCells = BUTTON_NAMES.map((name) => h('span', { class: 'pad-btn', title: name }, name));
      const axisBars = AXIS_NAMES.map((name) => {
        const fill = h('span', { class: 'pad-axis-fill' });
        return { fill, el: h('div', { class: 'pad-axis' }, h('span', { class: 'pad-axis-name' }, name), h('span', { class: 'pad-axis-track' }, fill)) };
      });
      const testNote = h('p', { class: 'setting-hint' }, 'Press buttons and move the sticks to see them here.');
      frag.appendChild(h('section', { class: 'settings-group', 'aria-labelledby': 'pad-test' },
        h('h3', { class: 'group-title', id: 'pad-test' }, 'Input test'), testNote,
        h('div', { class: 'pad-buttons', 'aria-hidden': 'true' }, ...btnCells),
        h('div', { class: 'pad-axes', 'aria-hidden': 'true' }, ...axisBars.map(a => a.el))));

      // mapping
      const tbody = h('tbody');
      mapRows = PAD_ACTIONS.map((a) => {
        const cur = h('td', { class: 'pad-map-cur' });
        const btn = h('button', { type: 'button', class: 'btn btn--ghost btn--sm' }, 'Assign');
        btn.addEventListener('click', () => startAssign(a.id, btn));
        const clearBtn = h('button', { type: 'button', class: 'btn btn--ghost btn--sm', 'aria-label': `Clear ${a.label}` }, 'Clear');
        clearBtn.addEventListener('click', () => set({ map: { [a.id]: -1 } }));
        tbody.appendChild(h('tr', null, h('th', { scope: 'row' }, a.label), cur, h('td', null, h('div', { class: 'btn-row' }, btn, clearBtn))));
        return { a, cur, btn };
      });
      const resetBtn = h('button', { type: 'button', class: 'btn btn--ghost btn--sm' }, 'Reset the mapping');
      resetBtn.addEventListener('click', () => set({ map: defaultPadPrefs().map }));
      const assignStatus = h('p', { class: 'setting-hint', role: 'status', 'aria-live': 'polite' });
      frag.appendChild(h('section', { class: 'settings-group', 'aria-labelledby': 'pad-map' },
        h('h3', { class: 'group-title', id: 'pad-map' }, 'Mapping'),
        h('p', { class: 'setting-hint' }, 'Choose Assign, then press the button (or move the stick) to use. Esc cancels.'),
        h('div', { class: 'pad-map-wrap' }, h('table', { class: 'pad-map' },
          h('thead', null, h('tr', null, h('th', { scope: 'col' }, 'Action'), h('th', { scope: 'col' }, 'Input'), h('th', { scope: 'col' }, h('span', { class: 'visually-hidden' }, 'Change')))), tbody)),
        assignStatus, h('div', { class: 'btn-row' }, resetBtn)));

      // assignment: wait for an input that moved since the button was clicked
      let assign = null;
      function startAssign(id, btn) {
        stopAssign();
        const pad = listPads(nav)[0];
        if (!pad) { setText(assignStatus, 'Connect a controller and press any button first.'); return; }
        const a = PAD_ACTION_MAP[id];
        assign = { id, btn, kind: a.kind, base: padSnapshot(pad), until: performance.now() + ASSIGN_MS };
        host.setAssigning(true);
        btn.textContent = a.kind === 'axis' ? 'Move a stick…' : 'Press a button…';
        setText(assignStatus, `${a.label}: ${a.kind === 'axis' ? 'move a stick' : 'press a button'} now.`);
      }
      function stopAssign(msg) {
        if (!assign) return;
        assign.btn.textContent = 'Assign';
        assign = null;
        host.setAssigning(false);
        if (msg) setText(assignStatus, msg);
      }
      const onKey = (e) => { if (assign && e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); stopAssign('Cancelled.'); } };
      window.addEventListener('keydown', onKey, true);
      scope.add(() => window.removeEventListener('keydown', onKey, true));
      scope.add(() => stopAssign());

      // the pane's own frame loop (only while it is open)
      let lastIds = '';
      scope.add(addLoop(() => {
        const pads = listPads(nav);
        const ids = pads.map(p => `${p.index}:${p.id}:${p.mapping}`).join('|');
        if (ids !== lastIds) {
          lastIds = ids;
          list.replaceChildren(...(pads.length ? pads.map(p => h('li', null,
            h('strong', null, String(p.id || 'Controller').slice(0, 80)),
            h('span', { class: 'setting-hint' }, ` ${p.mapping === 'standard' ? 'Standard layout.' : 'Not the standard layout: check the mapping.'} ${canRumble(p) ? 'Rumble works.' : 'Rumble is not supported on this device.'}`)))
            : [h('li', { class: 'setting-hint' }, 'No controller found. Connect one and press any button.')]));
          host.rescan();
          renderHaptics();
        }
        const pad = pads[0];
        for (let i = 0; i < btnCells.length; i++) {
          const b = pad && pad.buttons[i];
          btnCells[i].classList.toggle('is-down', !!(b && (b.pressed || b.value > 0.5)));
        }
        for (let i = 0; i < axisBars.length; i++) {
          const v = pad && Number.isFinite(pad.axes[i]) ? pad.axes[i] : 0;
          axisBars[i].fill.style.left = `calc(${(50 + Math.max(-1, Math.min(1, v)) * 50).toFixed(1)}% - 4px)`;
        }
        if (assign) {
          const got = pad ? detectAssign(pad, assign.base, assign.kind) : null;
          if (got !== null) {
            const { id, kind } = assign;
            stopAssign(`${PAD_ACTION_MAP[id].label}: ${inputName(kind, got)}.`);
            set({ map: { [id]: got } });
          } else if (performance.now() > assign.until) stopAssign('Nothing pressed. Try again.');
        }
      }));
    }

    // ------------------------------------------------------------ haptics
    const rumbleOn = checkbox('pad-rumble', 'Rumble with the bass', prefs().rumble, (v) => set({ rumble: v }));
    const amount = slider('Rumble strength', 0, 1, 0.05, prefs().rumbleAmount, v => `${Math.round(v * 100)}%`, (v) => host.setPrefs({ rumbleAmount: v }));
    const testBtn = h('button', { type: 'button', class: 'btn btn--ghost btn--sm' }, 'Test rumble');
    testBtn.addEventListener('click', () => {
      const ok = host.prefs.on && host.prefs.rumble && host.rumble('impact', 1);
      setText(rumbleNote, ok ? 'Rumble sent.' : rumbleText());
    });
    const rumbleNote = h('p', { class: 'setting-hint', role: 'status', 'aria-live': 'polite' });
    const beat = checkbox('pad-beat', 'Pulse on the beat', prefs().beat, (v) => set({ beat: v }));
    const beatNote = h('p', { class: 'setting-hint' });
    function rumbleText() {
      if (!support.gamepads) return 'Rumble is not supported on this device.';
      const pads = listPads(nav);
      if (!pads.length) return 'Connect a controller to use rumble.';
      if (!pads.some(canRumble)) return 'Rumble is not supported on this device.';
      if (!host.prefs.on) return 'Turn on controllers above to use rumble.';
      return host.prefs.rumble ? 'A short pulse on notes of the lowest playing track or drum pad 1, and when a golf ball is hit or drops.' : '';
    }
    function renderHaptics() {
      setText(rumbleNote, rumbleText());
      setText(beatNote, !support.vibrate ? 'Not supported on this device.' : 'Phones only: a short pulse on each beat while playing. Never with Reduce motion on, and it stops when Oro is hidden.');
      beat.box.disabled = !support.vibrate;
    }
    frag.appendChild(h('section', { class: 'settings-group', 'aria-labelledby': 'pad-haptics' },
      h('h3', { class: 'group-title', id: 'pad-haptics' }, 'Haptics'),
      h('p', { class: 'setting-hint' }, 'Off by default. Not tested on every controller or phone.'),
      row('Controller rumble', 'Follows the bass or the kick.', h('div', { class: 'inline-controls' }, rumbleOn.el, testBtn)),
      rumbleNote,
      row('Strength', null, amount.el, 'setting-row--stack'),
      row('Phone pulses', null, beat.el), beatNote));

    function renderAll() {
      const p = prefs();
      for (const r of mapRows) setText(r.cur, inputName(r.a.kind, p.map[r.a.id]));
      const onBox = frag.querySelector('#pad-on');
      if (onBox) onBox.checked = p.on;
      rumbleOn.box.checked = p.rumble;
      beat.box.checked = p.beat;
      renderHaptics();
    }
    renderAll();
    return frag;
  }

  return { el: root, dispose: () => { scope.disposed = true; scope.dispose(); } };
}
