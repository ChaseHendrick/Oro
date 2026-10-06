// Global keyboard shortcuts and the list shown in Settings and Help.

import { isTypingTarget } from './dom.js';

export const SHORTCUTS = [
  { group: 'Playing', items: [
    { keys: ['Space'], text: 'Play / stop' },
    { keys: ['A', 'W', 'S', 'E', 'D', 'F', 'T', 'G', 'Y', 'H', 'U', 'J', 'K', 'O', 'L', 'P', ';', "'"], text: 'Play notes (C up to F an octave higher)', compact: 'A ... \'' },
    { keys: ['Z', 'X'], text: 'Keyboard octave down / up' },
    { keys: ['C', 'V'], text: 'Keyboard velocity down / up' },
    { keys: ['R'], text: 'Record on / off (saves a WAV)' },
    { keys: ['Shift', 'P'], text: 'Preview the selected part with a short phrase (P alone plays a note)', join: '+' },
    { keys: ['Shift', 'L'], text: 'Live mode: full-screen pads, setlist and big controls', join: '+' },
    { keys: ['N'], text: 'Jam voice: hold to talk while voice is on (push to talk). Change the key in Jam.' },
  ] },
  { group: 'Looper', items: [
    { keys: ['Q'], text: 'Loop: record, then play, then overdub' },
    { keys: ['Shift', 'Q'], text: 'Stop or restart the loop', join: '+' },
    { keys: ['B'], text: 'Undo the last overdub layer' },
    { keys: ['Shift', 'B'], text: 'Clear the loop', join: '+' },
    { keys: ['M'], text: 'Mute or unmute the loop' },
  ] },
  { group: 'Navigating', items: [
    { keys: ['1', '2', '3', '4', '5', '6', '7', '8', '9'], text: 'Select track 1 to 9', compact: '1 ... 9' },
    { keys: ['['], text: 'Previous patch (Size of the orbit when the map has focus)' },
    { keys: [']'], text: 'Next patch (Size of the orbit when the map has focus)' },
    { keys: [','], text: 'Settings' },
    { keys: ['?'], text: 'Help' },
    { keys: ['Esc'], text: 'Close menus and dialogs, cancel MIDI learn' },
  ] },
  { group: 'Live mode', items: [
    { keys: ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0', 'Q', 'W', 'E', 'R', 'T', 'Y'], text: 'Play pads 1 to 16 (in live mode the note keys are off)', compact: '1 ... 0, Q ... Y' },
    { keys: ['Space'], text: 'Play / stop' },
    { keys: ['Left', 'Right'], text: 'Previous / next song in the setlist (Up and Down too)' },
    { keys: ['Esc'], text: 'Leave live mode (also when the lock is on)' },
  ] },
  { group: 'Knobs', items: [
    { keys: ['Drag'], text: 'Up / down (or left / right) to change' },
    { keys: ['Shift', 'Drag'], text: 'Fine adjustment', join: '+' },
    { keys: ['Double-click'], text: 'Reset to default (also Ctrl / Cmd + click)' },
    { keys: ['Arrows'], text: 'Adjust the focused knob; Page Up / Down for big steps' },
    { keys: ['Enter'], text: 'Type an exact value' },
    { keys: ['Right-click'], text: 'Modulate, MIDI Learn, Reset (long-press on touch)' },
  ] },
  { group: 'Map', items: [
    { keys: ['Click'], text: 'Move the dot (or add a waypoint while editing a Tour)' },
    { keys: ['Shift', 'Drag'], text: 'Change the orbit Size', join: '+' },
    { keys: ['Alt', 'Drag'], text: 'Rotate the orbit', join: '+' },
    { keys: ['Wheel'], text: 'Over the dot: Size. Elsewhere: zoom' },
    { keys: ['Drag'], text: 'With Touch: Strum, play the land in key. With Touch: FX, sweep the filter and throw echo (map toolbar)' },
  ] },
  { group: 'Sequencer', items: [
    { keys: ['Arrows'], text: 'Left / right move along a row; up / down change the value' },
    { keys: ['Space'], text: 'Toggle the focused step, accent or slide' },
    { keys: ['Drag'], text: 'Drag across pads or bars to paint them' },
    { keys: ['Shift', 'Click'], text: 'On a Dot cell: move that step\'s dot lock to where the dot is now', join: '+' },
  ] },
];

function activatesOnSpace(el) {
  if (!el || el === document.body) return false;
  const role = el.getAttribute && el.getAttribute('role');
  const tag = el.tagName;
  const isControl = tag === 'BUTTON' || tag === 'SUMMARY' || tag === 'A' || role === 'button' || role === 'radio' || role === 'tab' || role === 'option' || role === 'menuitem' || role === 'checkbox' || role === 'switch';
  if (!isControl) return false;
  // Keyboard users (visible focus) keep the standard "Space activates" behaviour;
  // after a mouse click, Space goes back to being the transport key.
  try { return el.matches(':focus-visible'); } catch { return true; }
}

/**
 * actions: { togglePlay, selectPart(i), help, settings, record, prevPatch, nextPatch, preview,
 *   loopMain, loopStop, loopUndo, loopClear, loopMute, live }
 */
export function installShortcuts({ layers, actions }) {
  function onKey(e) {
    if (e.defaultPrevented) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (isTypingTarget(e.target)) return;
    if (layers && layers.hasModal()) return;
    const key = e.key;
    if (key === ' ' || e.code === 'Space') {
      if (activatesOnSpace(e.target)) return;
      e.preventDefault();
      if (!e.repeat) actions.togglePlay();
      return;
    }
    if (e.repeat) return;
    if (/^[1-9]$/.test(key)) { e.preventDefault(); actions.selectPart(Number(key) - 1); return; }
    if (key === '?') { e.preventDefault(); actions.help(); return; }
    if (key === ',') { e.preventDefault(); actions.settings(); return; }
    if (key === '[' || key === ']') {
      // With the map focused, the 3D view uses [ and ] for the orbit size.
      if (e.target && e.target.closest && e.target.closest('[data-viewport]')) return;
      e.preventDefault();
      if (key === '[') actions.prevPatch(); else actions.nextPatch();
      return;
    }
    if (e.code === 'KeyR' && !e.shiftKey) { e.preventDefault(); actions.record(); return; }
    // Looper (v1.2): Q, Shift+Q, B, Shift+B, M are free of the note keys.
    if (e.code === 'KeyQ' && actions.loopMain) { e.preventDefault(); if (e.shiftKey) actions.loopStop(); else actions.loopMain(); return; }
    if (e.code === 'KeyB' && actions.loopUndo) { e.preventDefault(); if (e.shiftKey) actions.loopClear(); else actions.loopUndo(); return; }
    if (e.code === 'KeyM' && !e.shiftKey && actions.loopMute) { e.preventDefault(); actions.loopMute(); return; }
    if (e.code === 'KeyP' && e.shiftKey && actions.preview) { e.preventDefault(); actions.preview(); return; }
    // 2.12 live mode (L alone is a note key)
    if (e.code === 'KeyL' && e.shiftKey && actions.live) { e.preventDefault(); actions.live(); }
  }
  document.addEventListener('keydown', onKey);
  return () => document.removeEventListener('keydown', onKey);
}
